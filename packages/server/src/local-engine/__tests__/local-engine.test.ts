import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import {
  failureText,
  OUTDATED_AGENT_MESSAGE,
  parseCatalog,
  rustRunArgs,
  RustStreamTranslator,
  toOpencodeTool,
} from "../rust-runner"
import { ReplyParts } from "../reply-parts"
import { checkCwd, historyForAgent, withToolPaths } from "../../server/routes/local-engine"

const line = (value: unknown) => JSON.stringify(value)

describe("RustStreamTranslator", () => {
  test("passes text through and maps tools to OpenCode tool cards", () => {
    const t = new RustStreamTranslator()
    const out = [
      line({ type: "meta", model: "qwen3:8b", agent: "pma", baseUrl: "http://x/v1" }),
      line({ type: "delta", text: "Let me look." }),
      line({ type: "tool", id: "c1", name: "Read", input: { file_path: "/w/a.ts" } }),
      line({ type: "tool_result", id: "c1", name: "Read", output: "code", isError: false }),
      line({ type: "final", text: "Done.", model: "qwen3:8b" }),
    ].flatMap((l) => t.feed(l))
    expect(out[0]).toEqual({ type: "meta", engine: "rust", model: "qwen3:8b", agent: "pma" })
    expect(out[2]).toEqual({ type: "tool", id: "c1", name: "read", input: { file_path: "/w/a.ts", filePath: "/w/a.ts" }, summary: "/w/a.ts" })
    expect(out[3]).toMatchObject({ type: "tool_result", id: "c1", name: "read", isError: false })
    expect(out[4]).toMatchObject({ type: "final", text: "Done.", isError: false })
    expect(t.model).toBe("qwen3:8b")
  })

  test("error events become a failed final; non-JSON becomes stderr", () => {
    const t = new RustStreamTranslator()
    expect(t.feed(line({ type: "error", message: "endpoint down" }))[0]).toMatchObject({ type: "final", isError: true, text: "endpoint down" })
    expect(t.isError).toBe(true)
    expect(t.feed("Compiling foo")).toEqual([{ type: "stderr", line: "Compiling foo" }])
  })

  test("tool name mapping", () => {
    expect(toOpencodeTool("Bash", { command: "ls" })).toEqual({ tool: "bash", input: { command: "ls" } })
    expect(toOpencodeTool("Write", { file_path: "a", content: "x" }).input.filePath).toBe("a")
    expect(toOpencodeTool("nomad_validate", { x: 1 }).tool).toBe("nomad_validate")
    expect(toOpencodeTool("Task", { subagent_type: "ba", description: "spec" })).toEqual({ tool: "task", input: { subagent_type: "ba", description: "spec" } })
  })
})

describe("run args and catalog", () => {
  test("builds the agent command line", () => {
    expect(rustRunArgs({ prompt: "hi", model: "qwen3:8b", agent: "pma", images: ["/a.png", "/b.png"], historyFile: "/h.json" })).toEqual([
      "-p", "hi", "--output-format", "stream-json", "--model", "qwen3:8b", "--agent", "pma",
      "--image", "/a.png", "--image", "/b.png", "--history", "/h.json",
    ])
    expect(rustRunArgs({ prompt: "hi" })).toEqual(["-p", "hi", "--output-format", "stream-json"])
  })

  test("parses the catalog after build noise", () => {
    const catalog = parseCatalog('warning: x\n{"version":1,"model":"m","models":[{"id":"m"}],"agents":[],"commands":[{"name":"smoke-echo"}]}')
    expect(catalog?.commands[0].name).toBe("smoke-echo")
    expect(parseCatalog("nope")).toBeNull()
    expect(parseCatalog('{"version":1}')).toBeNull()
  })

  test("explains an agent checkout without the CodeNomad interface", () => {
    expect(failureText(2, ["error: unexpected argument '--output-format' found"])).toBe(OUTDATED_AGENT_MESSAGE)
    expect(failureText(1, ["   Compiling x", "LLM: could not reach"])).toBe("LLM: could not reach")
  })
})

describe("history for the agent", () => {
  test("keeps real turns, drops failures and stopped markers, notes attachments", () => {
    const turns = historyForAgent([
      { id: "1", role: "user", text: "look at this", createdAt: 1, attachments: [{ filename: "shot.png" }] },
      { id: "2", role: "assistant", text: "A red square\n\n_(stopped)_", createdAt: 2 },
      { id: "3", role: "user", text: "again", createdAt: 3 },
      { id: "4", role: "assistant", text: "endpoint down", createdAt: 4, isError: true },
    ])
    expect(turns).toEqual([
      { role: "user", content: "look at this\n\n[attached: shot.png]" },
      { role: "assistant", content: "A red square" },
      { role: "user", content: "again" },
    ])
  })
})

describe("ReplyParts", () => {
  test("orders text and tool parts and closes unfinished tools", () => {
    const r = new ReplyParts()
    r.apply({ type: "delta", text: "Checking" })
    r.apply({ type: "delta", text: " files." })
    r.apply({ type: "tool", id: "c1", name: "bash", input: { command: "ls" } })
    r.apply({ type: "tool_result", id: "c1", name: "bash", output: "a.ts", isError: false })
    r.apply({ type: "tool", id: "c2", name: "read", input: { filePath: "a.ts" } })
    const out = r.finish({ stopped: true, isError: false })
    expect(out.parts.map((p) => p.type)).toEqual(["text", "tool", "tool", "text"])
    expect(out.parts[0]).toEqual({ type: "text", text: "Checking files." })
    expect(out.parts[1]).toMatchObject({ status: "completed", output: "a.ts" })
    expect(out.parts[2]).toMatchObject({ status: "error", output: "Stopped" })
    expect(out.text).toBe("Checking files.\n\n_(stopped)_")
  })

  test("shows the error text when a run fails", () => {
    const r = new ReplyParts()
    r.apply({ type: "final", text: "endpoint down", isError: true })
    expect(r.finish({ stopped: false, isError: true }).text).toBe("endpoint down")
  })
})

describe("workspace guard", () => {
  test("only allows folders inside open workspaces", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-engine-"))
    const real = fs.realpathSync(root)
    fs.mkdirSync(path.join(root, "sub"), { recursive: true })
    expect(checkCwd(path.join(root, "sub"), [real])).toBe(path.join(real, "sub"))
    expect(checkCwd(os.tmpdir(), [real])).toBeNull()
    expect(checkCwd(path.join(root, "sub", "..", ".."), [real])).toBeNull()
    expect(checkCwd(path.join(root, "missing"), [real])).toBeNull()
  })
})

describe("agent PATH", () => {
  test("adds existing tool folders (cargo) to a minimal launchd PATH, once", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"))
    fs.mkdirSync(path.join(home, ".cargo", "bin"), { recursive: true })
    const result = withToolPaths("/usr/bin:/bin", home).split(":")
    expect(result.slice(0, 2)).toEqual(["/usr/bin", "/bin"])
    expect(result).toContain(path.join(home, ".cargo", "bin"))
    expect(result).not.toContain(path.join(home, ".bun", "bin"))
    expect(withToolPaths(result.join(":"), home).split(":").filter((p) => p.endsWith(".cargo/bin")).length).toBe(1)
  })
})
