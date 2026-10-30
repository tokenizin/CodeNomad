import assert from "node:assert/strict"
import { describe, it as test } from "node:test"

import {
  buildLocalEnginePrompt,
  catalogAgents,
  catalogCommands,
  catalogProvider,
  RUST_DEFAULT_AGENT,
  RUST_PROVIDER_ID,
  toOpencodePart,
  historyToApiMessages,
  isLocalSessionId,
  isUnauthorizedError,
  LocalEngineReply,
} from "./local-engine.ts"

describe("LocalEngineReply", () => {
  test("builds ordered text and tool parts from Claude Code (Rust) events", () => {
    const reply = new LocalEngineReply()
    reply.apply({ type: "meta", engine: "rust", model: "qwen3:8b" })
    reply.apply({ type: "delta", text: "Look" })
    reply.apply({ type: "delta", text: "ing" })
    reply.apply({ type: "tool", id: "c1", name: "bash", input: { command: "ls" } })
    reply.apply({ type: "tool_result", id: "c1", name: "bash", output: "a.ts", isError: false })
    reply.apply({ type: "delta", text: "Found it." })
    reply.apply({ type: "final", text: "Found it." })
    reply.apply({ type: "exit", code: 0 })
    const result = reply.result()
    assert.deepEqual(result.parts.map((p) => p.type), ["text", "tool", "text"])
    assert.equal((result.parts[0] as any).text, "Looking")
    assert.equal((result.parts[1] as any).status, "completed")
    assert.equal((result.parts[1] as any).output, "a.ts")
    assert.equal(result.text, "Looking\n\nFound it.")
    assert.equal(result.model, "qwen3:8b")
    assert.equal(result.isError, false)
  })

  test("shows the error when the engine fails and closes unfinished tools", () => {
    const reply = new LocalEngineReply()
    reply.apply({ type: "tool", id: "c1", name: "read", input: { filePath: "x" } })
    reply.apply({ type: "final", text: "endpoint down", isError: true })
    reply.apply({ type: "exit", code: 1 })
    const result = reply.result()
    assert.equal(result.isError, true)
    assert.equal((result.parts[0] as any).status, "error")
    assert.ok(result.text.includes("endpoint down"))
  })
})

describe("OpenCode-shaped parts", () => {
  test("tool parts become tool cards", () => {
    const part = toOpencodePart("s", "m", { type: "tool", id: "c1", tool: "bash", input: { command: "ls" }, status: "completed", output: "a", startedAt: 1, endedAt: 2 }, 0)
    assert.equal(part.type, "tool")
    assert.equal(part.callID, "c1")
    assert.equal(part.state.status, "completed")
    assert.equal(part.state.output, "a")
    const failed = toOpencodePart("s", "m", { type: "tool", id: "c2", tool: "read", input: {}, status: "error", output: "nope", startedAt: 1 }, 1)
    assert.equal(failed.state.error, "nope")
  })

  test("saved assistant parts are used on reload", () => {
    const [msg] = historyToApiMessages("ses_lcl_1", [
      { id: "a1", role: "assistant", text: "Done", createdAt: 1, model: "qwen3:8b", parts: [{ type: "tool", id: "c1", tool: "bash", input: {}, status: "completed", output: "x", startedAt: 1 }, { type: "text", text: "Done" }] },
    ])
    assert.deepEqual(msg.parts.map((p: any) => p.type), ["tool", "text"])
    assert.equal(msg.info.providerID, RUST_PROVIDER_ID)
    assert.equal(msg.info.modelID, "qwen3:8b")
  })
})

describe("catalog → pickers", () => {
  const catalog = {
    version: 1,
    model: "gemma4:31b-cloud",
    models: [{ id: "gemma4:31b-cloud" }, { id: "qwen3:8b" }],
    agents: [{ name: "pma", description: "Product manager", model: "qwen3:8b" }],
    commands: [{ name: "pma", agent: true }, { name: "smoke-echo", description: "Echo" }],
  }
  test("agents start with the full agent and carry their own model", () => {
    const agents = catalogAgents(catalog)
    assert.deepEqual(agents.map((a) => a.name), [RUST_DEFAULT_AGENT, "pma"])
    assert.deepEqual(agents[1].model, { providerId: RUST_PROVIDER_ID, modelId: "qwen3:8b" })
  })
  test("models become one provider; commands keep descriptions", () => {
    const provider = catalogProvider(catalog)
    assert.equal(provider.defaultModelId, "gemma4:31b-cloud")
    assert.deepEqual(provider.models.map((m) => m.id), ["gemma4:31b-cloud", "qwen3:8b"])
    const commands = catalogCommands(catalog)
    assert.equal(commands[1].description, "Echo")
    assert.ok(commands[0].description.includes("pma"))
  })
})

test("buildLocalEnginePrompt puts paths in the prompt and uploads pasted data", () => {
  const built = buildLocalEnginePrompt("Review this", [
    { type: "file", url: "file:///Users/me/a%20b.ts", filename: "a b.ts" },
    { type: "text", text: "pasted notes" },
    { type: "file", url: "data:image/png;base64,AAA", filename: "shot.png", mime: "image/png" },
  ])
  assert.ok(built.prompt.includes("Attached file: /Users/me/a b.ts"))
  assert.ok(built.prompt.includes("pasted notes"))
  assert.ok(!built.prompt.includes("data:"))
  assert.deepEqual(built.uploads, [{ filename: "shot.png", mime: "image/png", data: "AAA" }])
  assert.deepEqual(built.attachmentNames, ["a b.ts", "shot.png"])
})

test("buildLocalEnginePrompt encodes non-base64 data URLs", () => {
  const built = buildLocalEnginePrompt("x", [{ type: "file", url: "data:text/plain,h%C3%A9llo", filename: "note.txt" }])
  assert.equal(built.uploads[0].mime, "text/plain")
  assert.equal(new TextDecoder().decode(Uint8Array.from(atob(built.uploads[0].data), (c) => c.charCodeAt(0))), "héllo")
})

test("historyToApiMessages matches the OpenCode message shape", () => {
  const api = historyToApiMessages("ses_lcl_1", [
    { id: "u1", role: "user", text: "hi", createdAt: 1, attachments: [{ filename: "shot.png" }] },
    { id: "a1", role: "assistant", text: "hello", createdAt: 2, agent: "pma" },
  ])
  assert.equal(api[0].info.role, "user")
  assert.equal(api[0].parts[0].text, "hi\n\n📎 shot.png")
  assert.equal(api[1].info.agent, "pma")
  assert.equal(api[1].parts[0].type, "text")
  assert.ok(isLocalSessionId("ses_lcl_abc"))
  assert.ok(!isLocalSessionId("ses_abc"))
})

test("isUnauthorizedError", () => {
  assert.equal(isUnauthorizedError(new Error("Unauthorized")), true)
  assert.equal(isUnauthorizedError(new Error("Request failed with 401")), true)
  assert.equal(isUnauthorizedError(new Error("cwd is not a directory")), false)
})
