import assert from "node:assert/strict"
import { describe, it as test } from "node:test"

import { buildLocalEnginePrompt, isUnauthorizedError, LocalEngineReply } from "./local-engine.ts"

describe("LocalEngineReply", () => {
  test("appends claude-cli deltas and tool lines", () => {
    const reply = new LocalEngineReply()
    reply.apply({ type: "meta", engine: "claude-cli" })
    reply.apply({ type: "delta", text: "Looking" })
    reply.apply({ type: "tool", name: "Bash", summary: "ls" })
    reply.apply({ type: "delta", text: "Found it." })
    reply.apply({ type: "final", text: "Found it.", isError: false })
    reply.apply({ type: "exit", code: 0 })
    const result = reply.result()
    assert.equal(result.text, "Looking\n\n› Bash ls\n\nFound it.")
    assert.equal(result.isError, false)
  })

  test("appends Rust bridge stdout lines instead of replacing them", () => {
    const reply = new LocalEngineReply()
    reply.apply({ type: "stdout", line: "one" })
    reply.apply({ type: "stdout", line: "two" })
    reply.apply({ type: "exit", code: 0 })
    assert.equal(reply.result().text, "one\ntwo")
  })

  test("shows the error when the engine fails", () => {
    const reply = new LocalEngineReply()
    reply.apply({ type: "meta", engine: "claude-cli", note: 'Agent "x" was not found' })
    reply.apply({ type: "final", text: "Credit balance too low", isError: true })
    reply.apply({ type: "exit", code: 1 })
    const result = reply.result()
    assert.equal(result.isError, true)
    assert.ok(result.text.includes("Credit balance too low"))
    assert.ok(result.text.includes('Agent "x" was not found'))
  })
})

test("buildLocalEnginePrompt includes attachments", () => {
  const prompt = buildLocalEnginePrompt("Review this", [
    { type: "file", url: "file:///Users/me/a%20b.ts", filename: "a b.ts" },
    { type: "text", text: "pasted notes" },
    { type: "file", url: "data:image/png;base64,AAA", filename: "shot.png", mime: "image/png" },
  ])
  assert.ok(prompt.includes("Attached file: /Users/me/a b.ts"))
  assert.ok(prompt.includes("pasted notes"))
  assert.ok(prompt.includes('"shot.png"'))
})

test("isUnauthorizedError", () => {
  assert.equal(isUnauthorizedError(new Error("Unauthorized")), true)
  assert.equal(isUnauthorizedError(new Error("Request failed with 401")), true)
  assert.equal(isUnauthorizedError(new Error("cwd is not a directory")), false)
})
