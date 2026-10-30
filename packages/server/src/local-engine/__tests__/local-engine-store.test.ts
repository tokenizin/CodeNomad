import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { LocalEngineStore, LOCAL_SESSION_PREFIX, safeKey } from "../store"
import { ReplyText } from "../reply-text"
import { rustPrompt, withConversationContext } from "../rust-runner"
import { claudeArgs, claudeInput } from "../../server/routes/local-engine"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "local-engine-store-"))

describe("LocalEngineStore", () => {
  test("creates, lists, renames and deletes sessions", () => {
    const dir = tmp()
    const store = new LocalEngineStore(dir)
    const a = store.createSession({ folder: "/work/a", agent: "pma" })
    const b = store.createSession({ folder: "/work/b" })
    expect(a.id.startsWith(LOCAL_SESSION_PREFIX)).toBe(true)
    expect(store.listSessions("/work/a").map((s) => s.id)).toEqual([a.id])
    expect(store.listSessions().length).toBe(2)

    store.updateSession(a.id, { title: "Renamed" })
    // A fresh store reads what was written to disk.
    expect(new LocalEngineStore(dir).getSession(a.id)?.title).toBe("Renamed")

    expect(store.deleteSession(b.id)).toBe(true)
    expect(store.getSession(b.id)).toBeUndefined()
  })

  test("saves history and names the session after the first prompt", () => {
    const store = new LocalEngineStore(tmp())
    const s = store.createSession({ folder: "/work" })
    store.appendHistory(s.id, [
      { id: "u1", role: "user", text: "Fix the   login bug", createdAt: 1 },
      { id: "a1", role: "assistant", text: "Done", createdAt: 2 },
    ])
    store.appendHistory(s.id, [{ id: "u2", role: "user", text: "Thanks", createdAt: 3 }])
    expect(store.readHistory(s.id).map((m) => m.id)).toEqual(["u1", "a1", "u2"])
    expect(store.getSession(s.id)?.title).toBe("Fix the login bug")

    // OpenCode session ids get history too, without a session record.
    store.appendHistory("ses_opencode123", [{ id: "x", role: "user", text: "hi", createdAt: 1 }])
    expect(store.readHistory("ses_opencode123").length).toBe(1)

    store.deleteSession(s.id)
    expect(store.readHistory(s.id)).toEqual([])
  })

  test("keeps keys and attachment names to safe file names", () => {
    expect(safeKey("../../etc/passwd")).toBeNull()
    expect(safeKey("ses_ok-1")).toBe("ses_ok-1")
    const store = new LocalEngineStore(tmp())
    const file = store.saveAttachment("ses_x", "../../evil name.png", Buffer.from("png"))
    expect(path.dirname(file)).toBe(store.attachmentsDir("ses_x"))
    expect(path.basename(file)).toMatch(/evil_name\.png$/)
    expect(fs.readFileSync(file, "utf8")).toBe("png")
  })
})

describe("rust runner helpers", () => {
  test("agent becomes a slash role", () => {
    expect(rustPrompt("plan the sprint", "pma")).toBe("/pma plan the sprint")
    expect(rustPrompt("/ceo hi", "pma")).toBe("/ceo hi")
    expect(rustPrompt("hi")).toBe("hi")
  })

  test("earlier turns are put in front, newest kept", () => {
    const history = [
      { id: "1", role: "user" as const, text: "My name is Ada", createdAt: 1 },
      { id: "2", role: "assistant" as const, text: "Hi Ada", createdAt: 2 },
      { id: "3", role: "assistant" as const, text: "boom", createdAt: 3, isError: true },
    ]
    const prompt = withConversationContext("What is my name?", history)
    expect(prompt).toContain("User: My name is Ada")
    expect(prompt).toContain("Assistant: Hi Ada")
    expect(prompt).not.toContain("boom")
    expect(prompt.endsWith("What is my name?")).toBe(true)
    expect(withConversationContext("hi", [])).toBe("hi")
  })
})

describe("claude input", () => {
  const plan = {
    bin: "claude",
    cwd: "/w",
    prompt: "What is this?",
    images: [{ type: "image" as const, source: { type: "base64" as const, media_type: "image/png", data: "AAA" } }],
    addDirs: ["/data/attachments/s1"],
    agentArgs: [],
  }

  test("sends text and images as one stream-json user message", () => {
    const msg = JSON.parse(claudeInput(plan))
    expect(msg.type).toBe("user")
    expect(msg.message.content).toEqual([{ type: "text", text: "What is this?" }, plan.images[0]])
  })

  test("adds the attachments folder and picks a session id for new conversations", () => {
    const args = claudeArgs(plan, true)
    expect(args).toContain("--input-format")
    expect(args.slice(args.indexOf("--add-dir"), args.indexOf("--add-dir") + 2)).toEqual(["--add-dir", "/data/attachments/s1"])
    expect(args).toContain("--session-id")
    expect(claudeArgs({ ...plan, resumeId: "abc" }, true)).toContain("--resume")
  })
})

describe("ReplyText", () => {
  test("builds the saved reply like the UI shows it", () => {
    const r = new ReplyText()
    r.apply({ type: "delta", text: "Looking" })
    r.apply({ type: "tool", name: "Read", summary: "a.ts" })
    r.apply({ type: "delta", text: "Done." })
    expect(r.finish({ stopped: false, isError: false })).toBe("Looking\n\n› Read a.ts\n\nDone.")
  })

  test("marks stopped runs and shows errors", () => {
    const stopped = new ReplyText()
    stopped.apply({ type: "delta", text: "Partial" })
    expect(stopped.finish({ stopped: true, isError: false })).toBe("Partial\n\n_(stopped)_")
    const failed = new ReplyText()
    failed.apply({ type: "final", text: "Credit balance too low", isError: true })
    expect(failed.finish({ stopped: false, isError: true })).toBe("Credit balance too low")
  })
})
