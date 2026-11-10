import assert from "node:assert/strict"
import { describe, it as test } from "node:test"

import { liveTaskSessions, type LocalTaskView } from "../lib/local-engine.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { syncLocalTaskSessions } from "./local-task-sessions.ts"
import { addInstance } from "./instances.ts"
import { loadMessages } from "./session-api.ts"
import { messagesLoaded, sessions } from "./session-state.ts"

const INSTANCE = "inst-task-sync"

function task(overrides: Partial<LocalTaskView> = {}): LocalTaskView {
  return {
    taskId: "task_a",
    sessionId: "ses_lcl_t_task_a",
    parentSessionId: "ses_lcl_parent",
    parentCallId: "call_1",
    agent: "worker",
    description: "job 1",
    model: "m",
    prompt: "do-sub-1",
    userMessageId: "msg_tu_a",
    assistantMessageId: "msg_ta_a",
    startedAt: 1000,
    status: "running",
    parts: [],
    ...overrides,
  }
}

describe("syncLocalTaskSessions", () => {
  test("a running task becomes a working child session with its prompt and a streaming reply", () => {
    syncLocalTaskSessions(INSTANCE, "/work", [task({ parts: [{ type: "text", text: "partial" }] })])

    const session = sessions().get(INSTANCE)?.get("ses_lcl_t_task_a")
    assert.ok(session, "the task has a session")
    assert.equal(session.parentId, "ses_lcl_parent")
    assert.equal(session.status, "working")
    assert.equal(session.title, "[worker] job 1")
    assert.ok(liveTaskSessions.has("ses_lcl_t_task_a"))

    const store = messageStoreBus.getOrCreate(INSTANCE)
    assert.deepEqual(store.getSessionMessageIds("ses_lcl_t_task_a"), ["msg_tu_a", "msg_ta_a"])
    assert.equal(store.getMessage("msg_ta_a")?.status, "streaming")
  })

  test("later updates fill the same messages in; they are not added twice", () => {
    const store = messageStoreBus.getOrCreate(INSTANCE)
    syncLocalTaskSessions(INSTANCE, "/work", [task({ parts: [{ type: "text", text: "partial more" }] })])
    assert.equal(store.getSessionMessageIds("ses_lcl_t_task_a").length, 2)
    const part = Object.values(store.getMessage("msg_ta_a")?.parts ?? {})[0]?.data as { text?: string } | undefined
    assert.equal(part?.text, "partial more")
  })

  test("when the task ends its session goes idle and is no longer live", () => {
    syncLocalTaskSessions(INSTANCE, "/work", [task({ status: "completed", endedAt: 2000, parts: [{ type: "text", text: "done" }] })])
    const session = sessions().get(INSTANCE)?.get("ses_lcl_t_task_a")
    assert.equal(session?.status, "idle")
    assert.equal(liveTaskSessions.has("ses_lcl_t_task_a"), false)
    assert.equal(messageStoreBus.getOrCreate(INSTANCE).getMessage("msg_ta_a")?.status, "complete")
  })

  test("a failed task ends with an error reply", () => {
    syncLocalTaskSessions(INSTANCE, "/work", [task({ taskId: "task_b", sessionId: "ses_lcl_t_task_b", userMessageId: "msg_tu_b", assistantMessageId: "msg_ta_b", status: "failed", endedAt: 3000 })])
    assert.equal(sessions().get(INSTANCE)?.get("ses_lcl_t_task_b")?.status, "idle")
    assert.equal(messageStoreBus.getOrCreate(INSTANCE).getMessage("msg_ta_b")?.status, "error")
  })

  test("a task delegated by a task hangs under that task", () => {
    syncLocalTaskSessions(INSTANCE, "/work", [
      task({ taskId: "task_c", sessionId: "ses_lcl_t_task_c", userMessageId: "msg_tu_c", assistantMessageId: "msg_ta_c", parentSessionId: "ses_lcl_t_task_a", parentTaskId: "task_a", startedAt: 1500 }),
    ])
    assert.equal(sessions().get(INSTANCE)?.get("ses_lcl_t_task_c")?.parentId, "ses_lcl_t_task_a")
  })

  test("nothing to sync is a no-op", () => {
    syncLocalTaskSessions(INSTANCE, "/work", [])
  })
})

describe("a Task card opening a task session while the task is still running", () => {
  test("loading its (not yet saved) history does not mark the running task idle", async () => {
    const instanceId = "inst-task-load"
    addInstance({ id: instanceId, folder: "/work" } as never)
    syncLocalTaskSessions(instanceId, "/work", [
      task({ taskId: "task_live", sessionId: "ses_lcl_t_task_live", userMessageId: "msg_tu_live", assistantMessageId: "msg_ta_live", parts: [{ type: "text", text: "so far" }] }),
    ])
    assert.equal(sessions().get(instanceId)?.get("ses_lcl_t_task_live")?.status, "working")

    // The server has nothing saved for a task that has not ended: an empty history, no run of its own.
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ messages: [], running: false }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch
    try {
      await loadMessages(instanceId, "ses_lcl_t_task_live")
    } finally {
      globalThis.fetch = realFetch
    }

    const session = sessions().get(instanceId)?.get("ses_lcl_t_task_live")
    assert.equal(session?.status, "working", "still working: the run is live in this tab")
    assert.ok(messagesLoaded().get(instanceId)?.has("ses_lcl_t_task_live"), "marked loaded, so the card shows the live steps")
    // The live messages were not wiped by the empty load.
    const store = messageStoreBus.getOrCreate(instanceId)
    assert.deepEqual(store.getSessionMessageIds("ses_lcl_t_task_live"), ["msg_tu_live", "msg_ta_live"])
  })
})
