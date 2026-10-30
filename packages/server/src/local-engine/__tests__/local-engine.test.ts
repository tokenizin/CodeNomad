import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { ClaudeStreamTranslator } from "../claude-stream"
import { resolveNomadAgent } from "../agents"
import { checkCwd, planClaudeAgent } from "../../server/routes/local-engine"

const line = (value: unknown) => JSON.stringify(value)

describe("ClaudeStreamTranslator", () => {
  test("streams text deltas and reads the final result", () => {
    const t = new ClaudeStreamTranslator()
    const out = [
      line({ type: "system", subtype: "init", session_id: "s-1" }),
      line({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } }, session_id: "s-1" }),
      line({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "po" } } }),
      line({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "ng" } } }),
      // The full assistant message repeats the streamed text; it must not be added twice.
      line({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "pong" }] } }),
      line({ type: "result", subtype: "success", is_error: false, result: "pong", session_id: "s-1", total_cost_usd: 0.1 }),
    ].flatMap((l) => t.feed(l))

    expect(out[0]).toEqual({ type: "meta", engine: "claude-cli", sessionId: "s-1" })
    expect(out.filter((e) => e.type === "delta").map((e: any) => e.text).join("")).toBe("pong")
    expect(out.at(-1)).toMatchObject({ type: "final", text: "pong", isError: false, sessionId: "s-1" })
    expect(t.sessionId).toBe("s-1")
  })

  test("falls back to assistant text without partial messages and reports tools", () => {
    const t = new ClaudeStreamTranslator()
    const out = [
      line({
        type: "assistant",
        message: { id: "m1", content: [{ type: "text", text: "Checking." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -la" } }] },
      }),
      line({ type: "assistant", message: { id: "m2", content: [{ type: "text", text: "Done." }] } }),
    ].flatMap((l) => t.feed(l))

    expect(out).toContainEqual({ type: "tool", name: "Bash", summary: "ls -la" })
    expect(t.streamedText).toBe("Checking.\n\nDone.")
  })

  test("ignores sub-agent messages and turns errors into a final error", () => {
    const t = new ClaudeStreamTranslator()
    expect(t.feed(line({ type: "assistant", parent_tool_use_id: "x", message: { content: [{ type: "text", text: "inner" }] } }))).toEqual([])
    const out = t.feed(
      line({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["No conversation found with session ID: abc"] }),
    )
    expect(out[0]).toMatchObject({ type: "final", isError: true, text: "No conversation found with session ID: abc" })
  })

  test("non-JSON lines become stderr events", () => {
    expect(new ClaudeStreamTranslator().feed("warning: something")).toEqual([{ type: "stderr", line: "warning: something" }])
  })
})

describe("agents", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-engine-"))
  fs.mkdirSync(path.join(root, ".nomadworks", "agents"), { recursive: true })
  fs.writeFileSync(path.join(root, ".nomadworks", "agents", "pma.md"), "---\ndescription: ignored\n---\nYou are the PMA.")
  fs.writeFileSync(
    path.join(root, "opencode.json"),
    `{
      // comments and trailing commas are allowed
      "agent": {
        "pma": { "description": "Product manager", "prompt": "{file:.nomadworks/agents/pma.md}", },
        "inline": { "prompt": "Inline prompt" },
        "missing": { "prompt": "{file:nope.md}" },
      },
    }`,
  )
  fs.mkdirSync(path.join(root, ".opencode", "agent"), { recursive: true })
  fs.writeFileSync(path.join(root, ".opencode", "agent", "writer.md"), "---\ndescription: Writes docs\n---\nYou write docs.")

  test("reads opencode.json agents with {file:} prompts", () => {
    expect(resolveNomadAgent("pma", root)).toMatchObject({ description: "Product manager", prompt: "You are the PMA." })
    expect(resolveNomadAgent("inline", root)).toMatchObject({ description: "inline", prompt: "Inline prompt" })
    expect(resolveNomadAgent("missing", root)).toBeNull()
  })

  test("reads markdown agents and rejects odd names", () => {
    expect(resolveNomadAgent("writer", root)).toMatchObject({ description: "Writes docs", prompt: "You write docs." })
    expect(resolveNomadAgent("../etc/passwd", root)).toBeNull()
  })

  test("maps OpenCode agents onto Claude Code flags", () => {
    expect(planClaudeAgent("build", root, null)).toEqual({ args: [] })
    expect(planClaudeAgent("plan", root, null)).toMatchObject({ permissionMode: "plan" })
    const pma = planClaudeAgent("pma", root, null)
    expect(pma.args[0]).toBe("--agents")
    expect(JSON.parse(pma.args[1])).toEqual({ pma: { description: "Product manager", prompt: "You are the PMA." } })
    expect(pma.args.slice(2)).toEqual(["--agent", "pma"])
    expect(planClaudeAgent("nobody", root, null).note).toContain("nobody")
  })

  test("only allows folders inside open workspaces", () => {
    const real = fs.realpathSync(root)
    fs.mkdirSync(path.join(root, "sub"), { recursive: true })
    expect(checkCwd(path.join(root, "sub"), [real])).toBe(path.join(real, "sub"))
    expect(checkCwd(os.tmpdir(), [real])).toBeNull()
    expect(checkCwd(path.join(root, "sub", "..", ".."), [real])).toBeNull()
    expect(checkCwd(path.join(root, "does-not-exist"), [real])).toBeNull()
  })
})
