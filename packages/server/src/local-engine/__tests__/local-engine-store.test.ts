import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { LocalEngineStore, LOCAL_SESSION_PREFIX, safeKey } from "../store"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "local-engine-store-"))

describe("LocalEngineStore", () => {
  test("fork copies history before a message; revert truncates; delete removes one", () => {
    const store = new LocalEngineStore(tmp())
    const s = store.createSession({ folder: "/w" })
    store.appendHistory(s.id, [
      { id: "u1", role: "user", text: "one", createdAt: 1 },
      { id: "a1", role: "assistant", text: "1", createdAt: 2 },
      { id: "u2", role: "user", text: "two", createdAt: 3 },
      { id: "a2", role: "assistant", text: "2", createdAt: 4 },
    ])
    expect(store.copyHistory(s.id, "ses_lcl_fork", "u2")).toBe(2)
    expect(store.readHistory("ses_lcl_fork").map((m) => m.id)).toEqual(["u1", "a1"])
    fs.mkdirSync(store.tasksDir(s.id), { recursive: true })
    fs.writeFileSync(path.join(store.tasksDir(s.id), "task_1.json"), "{}")
    expect(store.copyHistory(s.id, "ses_lcl_all")).toBe(4)
    expect(fs.existsSync(path.join(store.tasksDir("ses_lcl_all"), "task_1.json"))).toBe(true)
    expect(store.deleteHistoryMessage(s.id, "a1")).toBe(true)
    expect(store.truncateHistory(s.id, "u2")).toBe(2)
    expect(store.readHistory(s.id).map((m) => m.id)).toEqual(["u1"])
    expect(store.truncateHistory(s.id, "missing")).toBe(0)
    store.deleteSession(s.id)
    expect(fs.existsSync(store.tasksDir(s.id))).toBe(false)
  })

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
