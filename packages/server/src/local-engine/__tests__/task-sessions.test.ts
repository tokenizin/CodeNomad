import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { ReplyParts } from "../reply-parts.js"
import { RustStreamTranslator, toOpencodeTool, type EngineEvent } from "../rust-runner.js"
import { LocalEngineStore, taskSessionId } from "../store.js"
import { TaskSessions } from "../task-sessions.js"

const here = path.dirname(new URL(import.meta.url).pathname)
/** Real output of the Rust agent run with NOMAD_PROTOCOL=2 (see fixtures/). */
const fixture = (name: string) => fs.readFileSync(path.join(here, "fixtures", name), "utf8").split("\n").filter(Boolean)

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-sessions-"))
  return { store: new LocalEngineStore(dir), dir }
}

/** Runs lines through the same pipeline as the run route. */
function replay(lines: string[], options?: { stopAfter?: number; stopped?: boolean }) {
  const { store, dir } = tmpStore()
  const parent = store.createSession({ folder: "/work", agent: "pma" })
  const translator = new RustStreamTranslator()
  const replyParts = new ReplyParts()
  const tasks = new TaskSessions({ store, parentSessionId: parent.id, folder: "/work", parentParts: replyParts })
  const forwarded: EngineEvent[] = []
  for (const line of options?.stopAfter ? lines.slice(0, options.stopAfter) : lines) {
    for (const event of translator.feed(line)) {
      replyParts.apply(event)
      forwarded.push(tasks.apply(event))
    }
  }
  if (options?.stopAfter !== undefined) tasks.finish({ stopped: options.stopped ?? true })
  else tasks.finish({ stopped: false })
  return { store, dir, parent, translator, replyParts, tasks, forwarded }
}

describe("protocol 2 stream from the real Rust agent", () => {
  test("child events never reach the top-level reply", () => {
    const { replyParts, forwarded, translator } = replay(fixture("rust-protocol2-parallel.ndjson"))
    expect(translator.protocol).toBe(2)
    // Only the parent's own text; the three subagents' answers are not in it.
    expect(replyParts.text()).toBe("ALL DONE")
    // Plain deltas/tools/results in the forwarded stream are the parent's: 3 Task cards + 3 results + 1 text.
    expect(forwarded.filter((e) => e.type === "delta").length).toBe(1)
    expect(forwarded.filter((e) => e.type === "tool").length).toBe(3)
    expect(forwarded.filter((e) => e.type === "tool_result").length).toBe(3)
    // The children arrive as envelopes an old reader ignores.
    expect(forwarded.filter((e) => e.type === "task_start").length).toBe(3)
    expect(forwarded.filter((e) => e.type === "task_event").length).toBe(3)
    expect(forwarded.filter((e) => e.type === "task_end").length).toBe(3)
  })

  test("the task_start sent on to the browser carries the ids the saved history will use", () => {
    const { store, forwarded, parent } = replay(fixture("rust-protocol2-parallel.ndjson"))
    const starts = forwarded.filter((e) => e.type === "task_start")
    expect(starts.length).toBe(3)
    for (const start of starts) {
      if (start.type !== "task_start") continue
      expect(start.sessionId).toBe(taskSessionId(start.taskId))
      expect(start.parentSessionId).toBe(parent.id)
      expect(start.prompt).toMatch(/^do-sub-\d$/)
      // Same ids as the messages written to the task's history, so a reload doesn't duplicate them.
      const [user, assistant] = store.readHistory(start.sessionId!)
      expect(user.id).toBe(start.userMessageId)
      expect(assistant.id).toBe(start.assistantMessageId)
    }
    // Everything else passes through untouched.
    expect(forwarded.filter((e) => e.type === "task_end").length).toBe(3)
  })

  test("each Task card links to its own child session, which holds that task's transcript", () => {
    const { store, replyParts, parent } = replay(fixture("rust-protocol2-parallel.ndjson"))
    const cards = replyParts.parts.filter((p) => p.type === "tool")
    expect(cards.length).toBe(3)
    for (const [i, card] of cards.entries()) {
      if (card.type !== "tool") continue
      expect(card.childSessionId).toBeDefined()
      const child = store.getSession(card.childSessionId!)
      expect(child?.kind).toBe("task")
      expect(child?.parentId).toBe(parent.id)
      expect(child?.parentCallId).toBe(card.id)
      expect(child?.taskStatus).toBe("completed")
      expect(child?.title).toBe(`[worker] job ${i + 1}`)
      const [user, assistant] = store.readHistory(card.childSessionId!)
      expect(user.text).toBe(`do-sub-${i + 1}`) // the prompt on the card
      expect(assistant.text).toBe(`answer-${i + 1}`)
      expect(assistant.agent).toBe("worker")
    }
  })

  test("task sessions are left out of the session list unless asked for", () => {
    const { store, parent } = replay(fixture("rust-protocol2-parallel.ndjson"))
    expect(store.listSessions().map((s) => s.id)).toEqual([parent.id])
    expect(store.listSessions(undefined, { includeTasks: true }).length).toBe(4)
    expect(store.listChildren(parent.id).length).toBe(3)
  })

  test("a failed task is recorded as failed and its siblings are untouched", () => {
    const { store, replyParts } = replay(fixture("rust-protocol2-one-failed.ndjson"))
    const cards = replyParts.parts.flatMap((p) => (p.type === "tool" ? [p] : []))
    const statuses = cards.map((c) => store.getSession(c.childSessionId!)?.taskStatus)
    expect(statuses).toEqual(["completed", "failed", "completed"])
    const failed = store.readHistory(cards[1].childSessionId!)
    expect(failed[1].isError).toBe(true)
    expect(failed[1].text).toContain("failed")
  })

  test("a stopped run keeps what open tasks did", () => {
    // Cut the stream after the three task.start lines and the first delta: nothing has ended.
    const lines = fixture("rust-protocol2-parallel.ndjson")
    const cut = lines.findIndex((l) => l.includes('"task.end"'))
    const { store, replyParts, tasks } = replay(lines, { stopAfter: cut, stopped: true })
    expect(tasks.open).toBe(0)
    const cards = replyParts.parts.flatMap((p) => (p.type === "tool" ? [p] : []))
    const states = cards.map((c) => store.getSession(c.childSessionId!)?.taskStatus)
    expect(states.every((s) => s === "aborted")).toBe(true)
    const [, assistant] = store.readHistory(cards[0].childSessionId!)
    expect(assistant.text).toContain("_(stopped)_")
  })

  test("a crashed run marks open tasks failed, not completed", () => {
    const lines = fixture("rust-protocol2-parallel.ndjson")
    const cut = lines.findIndex((l) => l.includes('"task.end"'))
    const { store, replyParts } = replay(lines, { stopAfter: cut, stopped: false })
    const card = replyParts.parts.find((p) => p.type === "tool")
    expect(store.getSession(card!.type === "tool" ? card!.childSessionId! : "")?.taskStatus).toBe("failed")
  })
})

describe("protocol 1 is unchanged", () => {
  test("a stream without task events behaves exactly as before and creates no sessions", () => {
    const lines = [
      '{"type":"meta","model":"m","agent":"pma","baseUrl":"x"}',
      '{"type":"delta","text":"hi "}',
      '{"type":"tool","id":"c1","name":"Task","input":{"subagent_type":"ba","description":"d","prompt":"p"}}',
      '{"type":"tool_result","id":"c1","name":"Task","output":"task_id: t\\n\\n<task_result>\\nx\\n</task_result>","isError":false}',
      '{"type":"final","text":"hi there","model":"m"}',
    ]
    const { store, replyParts, translator, forwarded, parent } = replay(lines)
    expect(translator.protocol).toBe(1)
    const meta = forwarded[0]
    expect(meta.type === "meta" && "protocol" in meta).toBe(false)
    expect(replyParts.parts.map((p) => p.type)).toEqual(["text", "tool"])
    const card = replyParts.parts[1]
    expect(card.type === "tool" && card.childSessionId).toBeFalsy()
    expect(store.listSessions(undefined, { includeTasks: true }).map((s) => s.id)).toEqual([parent.id])
  })
})

describe("translator edge cases", () => {
  const feed = (line: unknown) => new RustStreamTranslator().feed(JSON.stringify(line))

  test("stamped events are never forwarded as plain events", () => {
    for (const type of ["delta", "tool", "tool_result"]) {
      const out = feed({ type, text: "x", id: "i", name: "Bash", input: {}, output: "o", task_id: "task_a", parent_call_id: "c" })
      expect(out.every((e) => e.type === "task_event")).toBe(true)
    }
  })

  test("a stamped final/error/meta cannot end or change the top-level run", () => {
    const t = new RustStreamTranslator()
    expect(t.feed(JSON.stringify({ type: "final", text: "x", task_id: "task_a" }))).toEqual([])
    expect(t.feed(JSON.stringify({ type: "error", message: "x", task_id: "task_a" }))).toEqual([])
    expect(t.sawFinal).toBe(false)
    expect(t.isError).toBe(false)
  })

  test("usage and unknown stamped events are dropped; nesting is kept", () => {
    expect(feed({ type: "usage", input: 1, task_id: "task_a" })).toEqual([])
    const [e] = feed({ type: "delta", text: "x", task_id: "task_b", parent_task_id: "task_a", parent_call_id: "c9" })
    expect(e.type === "task_event" && e.parentTaskId).toBe("task_a")
  })

  test("an unknown task.end status counts as failed", () => {
    const [e] = feed({ type: "task.end", status: "weird", task_id: "task_a", parent_call_id: "c" })
    expect(e.type === "task_end" && e.status).toBe("failed")
  })

  test("a nested task hangs under the task that delegated it", () => {
    const { store, dir } = tmpStore()
    const parent = store.createSession({ folder: "/work" })
    const parts = new ReplyParts()
    const tasks = new TaskSessions({ store, parentSessionId: parent.id, folder: "/work", parentParts: parts })
    const t = new RustStreamTranslator()
    const lines = [
      { type: "tool", id: "c1", name: "Task", input: { subagent_type: "tl", description: "lead", prompt: "lead it" } },
      { type: "task.start", task_id: "task_tl", parent_call_id: "c1", agent: "tl", description: "lead", mode: "subagent", resumed: false },
      { type: "tool", id: "c2", name: "Task", input: { subagent_type: "dev", description: "build", prompt: "build it" }, task_id: "task_tl", parent_call_id: "c1" },
      { type: "task.start", task_id: "task_dev", parent_task_id: "task_tl", parent_call_id: "c2", agent: "dev", description: "build", mode: "subagent", resumed: false },
      { type: "task.end", task_id: "task_dev", parent_task_id: "task_tl", parent_call_id: "c2", status: "completed" },
      { type: "task.end", task_id: "task_tl", parent_call_id: "c1", status: "completed" },
    ]
    const sent: EngineEvent[] = []
    for (const l of lines) for (const e of t.feed(JSON.stringify(l))) { parts.apply(e); sent.push(tasks.apply(e)) }
    // A task delegated by a task reports the task, not the top-level session, as its parent.
    const nested = sent.find((e) => e.type === "task_start" && e.taskId === "task_dev")
    expect(nested?.type === "task_start" && nested.parentSessionId).toBe(taskSessionId("task_tl"))
    expect(store.getSession(taskSessionId("task_dev"))?.parentId).toBe(taskSessionId("task_tl"))
    expect(store.getSession(taskSessionId("task_tl"))?.parentId).toBe(parent.id)
    // The nested task's prompt comes from the Task card inside its parent task.
    expect(store.readHistory(taskSessionId("task_dev"))[0].text).toBe("build it")
    // The nested card is linked inside the parent task's transcript, not the top-level reply.
    const lead = store.readHistory(taskSessionId("task_tl"))[1]
    expect(lead.parts?.some((p) => p.type === "tool" && p.childSessionId === taskSessionId("task_dev"))).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe("task sessions in the store", () => {
  test("deleting the parent deletes its task sessions (and theirs), nothing else", () => {
    const { store, parent } = replay(fixture("rust-protocol2-parallel.ndjson"))
    const other = store.createSession({ folder: "/work", title: "unrelated" })
    store.appendHistory(other.id, [{ id: "m1", role: "user", text: "x", createdAt: 1 }])
    expect(store.deleteSession(parent.id)).toBe(true)
    expect(store.listSessions(undefined, { includeTasks: true }).map((s) => s.id)).toEqual([other.id])
    expect(store.readHistory(other.id).length).toBe(1)
  })

  test("deleting one task session leaves the parent and its siblings", () => {
    const { store, parent, replyParts } = replay(fixture("rust-protocol2-parallel.ndjson"))
    const [first, second] = replyParts.parts.flatMap((p) => (p.type === "tool" ? [p.childSessionId!] : []))
    store.deleteSession(first)
    expect(store.getSession(first)).toBeUndefined()
    expect(store.getSession(second)).toBeDefined()
    expect(store.getSession(parent.id)).toBeDefined()
  })

  test("reverting a turn deletes the task sessions it created", () => {
    const { store, parent, replyParts } = replay(fixture("rust-protocol2-parallel.ndjson"))
    store.appendHistory(parent.id, [
      { id: "u1", role: "user", text: "go", createdAt: 1 },
      { id: "a1", role: "assistant", text: "ALL DONE", createdAt: 2, parts: replyParts.parts },
    ])
    expect(store.listChildren(parent.id).length).toBe(3)
    store.truncateHistory(parent.id, "u1")
    expect(store.listChildren(parent.id).length).toBe(0)
  })

  test("a task session still linked from a kept message survives the removal of an older one", () => {
    const { store, parent } = tmpStoreWithParent()
    const id = taskSessionId("task_x")
    store.upsertTaskSession({ taskId: "task_x", parentId: parent.id, parentCallId: "c", folder: "/work", title: "t", agent: "a" })
    const card = { type: "tool" as const, id: "c", tool: "task", input: {}, status: "completed" as const, startedAt: 1, childSessionId: id }
    store.appendHistory(parent.id, [
      { id: "a1", role: "assistant", text: "first", createdAt: 1, parts: [card] },
      { id: "a2", role: "assistant", text: "resumed", createdAt: 2, parts: [card] },
    ])
    store.deleteHistoryMessage(parent.id, "a1")
    expect(store.getSession(id)).toBeDefined()
    store.deleteHistoryMessage(parent.id, "a2")
    expect(store.getSession(id)).toBeUndefined()
  })

  test("a fork copies the turns without the original's task links", () => {
    const { store, parent, replyParts } = replay(fixture("rust-protocol2-parallel.ndjson"))
    store.appendHistory(parent.id, [{ id: "a1", role: "assistant", text: "x", createdAt: 1, parts: replyParts.parts }])
    const fork = store.createSession({ folder: "/work" })
    store.copyHistory(parent.id, fork.id)
    const copied = store.readHistory(fork.id)[0].parts ?? []
    expect(copied.filter((p) => p.type === "tool").length).toBe(3)
    expect(copied.some((p) => p.type === "tool" && p.childSessionId)).toBe(false)
    // The original keeps its links.
    expect(store.readHistory(parent.id)[0].parts?.some((p) => p.type === "tool" && p.childSessionId)).toBe(true)
  })

  test("resuming a task reuses its session and appends to its transcript", () => {
    const { store, parent } = tmpStoreWithParent()
    const input = { taskId: "task_r", parentId: parent.id, parentCallId: "c", folder: "/work", title: "t", agent: "a" }
    expect(store.upsertTaskSession(input).created).toBe(true)
    store.appendHistory(taskSessionId("task_r"), [{ id: "m1", role: "user", text: "first", createdAt: 1 }])
    const again = store.upsertTaskSession({ ...input, parentCallId: "c2" })
    expect(again.created).toBe(false)
    expect(again.session.id).toBe(taskSessionId("task_r"))
    expect(store.readHistory(taskSessionId("task_r")).length).toBe(1)
  })

  test("a task id that is not a safe key is refused", () => {
    const { store, parent } = tmpStoreWithParent()
    expect(() =>
      store.upsertTaskSession({ taskId: "../evil", parentId: parent.id, parentCallId: "c", folder: "/work", title: "t", agent: "a" }),
    ).toThrow()
  })
})

function tmpStoreWithParent() {
  const { store, dir } = tmpStore()
  return { store, dir, parent: store.createSession({ folder: "/work" }) }
}

describe("a workflow session (orchestrator) from the real agent", () => {
  const lines = () => fixture("rust-protocol2-workflow.ndjson")

  test("it is a task in orchestrator mode, shown on the same card as a Task", () => {
    const { forwarded, replyParts } = replay(lines())
    const start = forwarded.find((e) => e.type === "task_start")
    expect(start?.type === "task_start" && start.mode).toBe("orchestrator")
    expect(start?.type === "task_start" && start.agent).toBe("workflow_runner")
    const card = replyParts.parts.find((p) => p.type === "tool")
    expect(card?.type === "tool" && card.tool).toBe("task")
    expect(card?.type === "tool" && card.input.subagent_type).toBe("workflow_runner")
    expect(card?.type === "tool" && card.input.description).toBe("Workflow TASK-9")
    expect(card?.type === "tool" && card.input.prompt).toBe("do it")
    expect(card?.type === "tool" && card.childSessionId).toBeDefined()
    expect(replyParts.text()).toBe("PMA DONE")
  })

  test("the orchestrator's session holds its instructions and the handover it filed", () => {
    const { store, replyParts } = replay(lines())
    const card = replyParts.parts.find((p) => p.type === "tool")
    const sessionId = card?.type === "tool" ? card.childSessionId! : ""
    const session = store.getSession(sessionId)
    expect(session?.kind).toBe("task")
    expect(session?.taskStatus).toBe("completed")
    expect(session?.title).toBe("[workflow_runner] Workflow TASK-9")
    const [user, assistant] = store.readHistory(sessionId)
    expect(user.text).toBe("do it")
    const handover = assistant.parts?.find((p) => p.type === "tool" && p.tool === "handover")
    expect(handover?.type === "tool" && handover.status).toBe("completed")
    expect(handover?.type === "tool" && handover.output).toContain("Handover filed: tasks/todo/TASK-9/HANDOVER.md (revision 1")
    expect(handover?.type === "tool" && (handover.input.requirements as unknown[]).length).toBe(1)
    expect(assistant.text).toContain("closing note")
  })

  test("a follow-up to a workflow is the same kind of card", () => {
    expect(toOpencodeTool("nomadflow_prompt_workflow", { session_id: "wf_1", text: "fix the header" })).toEqual({
      tool: "task",
      input: { session_id: "wf_1", text: "fix the header", subagent_type: "workflow_runner", description: "Workflow follow-up wf_1", prompt: "fix the header" },
    })
    expect(toOpencodeTool("nomadflow_run_workflow", { task_path: "tasks/todo/TASK-9/TASK-9.md", instructions: "go" }).input.description).toBe("Workflow TASK-9")
    // Other NomadWorks tools are untouched.
    expect(toOpencodeTool("nomadworks_validate", { mode: "phase0" }).tool).toBe("nomadworks_validate")
  })
})
