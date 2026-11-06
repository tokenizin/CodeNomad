import assert from "node:assert/strict"
import { describe, it as test } from "node:test"

import { LocalEngineReply } from "../lib/local-engine.ts"
import { addInstance, getQuestionQueue, sendQuestionReject, sendQuestionReply } from "./instances.ts"
import { settleLocalQuestions, syncLocalQuestions } from "./local-questions.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { upsertLocalSessions } from "./session-api.ts"
import { syncLocalTaskSessions } from "./local-task-sessions.ts"

const INSTANCE = "inst-questions"
const manager = { sessionId: "ses_lcl_m", assistantId: "msg_la_m" }
const questions = [{ question: "Which format?", header: "Format", options: [{ label: "CSV", description: "plain" }, { label: "JSON", description: "typed" }], multiple: false }]

describe("questions the Claude Code (Rust) agent asks", () => {
  test("shown in the question UI, answered through the server, taken down when the tool call returns", async () => {
    addInstance({ id: INSTANCE, folder: "/work" } as never)
    upsertLocalSessions(INSTANCE, [{ id: "ses_lcl_m", folder: "/work", title: "M", agent: "product_manager", createdAt: 1, updatedAt: 1 }])
    const store = messageStoreBus.getOrCreate(INSTANCE)
    store.upsertMessage({
      id: manager.assistantId, sessionId: manager.sessionId, role: "assistant", status: "streaming", createdAt: 2,
      parts: [{ id: "c1", type: "tool", callID: "c1", tool: "question", state: { status: "running", input: { questions } } } as never],
    })

    const reply = new LocalEngineReply()
    reply.apply({ type: "tool", id: "c1", name: "question", input: { questions } })
    reply.apply({ type: "question", id: "que_1", callId: "c1", questions })
    syncLocalQuestions(INSTANCE, reply, manager)
    const queued = getQuestionQueue(INSTANCE)
    assert.equal(queued.length, 1)
    assert.equal(queued[0].id, "que_1")
    assert.equal(queued[0].sessionID, "ses_lcl_m")
    assert.deepEqual(queued[0].tool, { messageID: "msg_la_m", callID: "c1" })
    assert.ok(store.getQuestionState("msg_la_m", "c1"), "the card of the question tool shows it")

    // The answer goes to this server, not to OpenCode (there is no OpenCode here).
    const calls: Array<{ url: string; body: any }> = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) })
      return new Response(JSON.stringify({ answered: true }), { headers: { "content-type": "application/json" } })
    }) as typeof fetch
    try {
      await sendQuestionReply(INSTANCE, "ses_lcl_m", "que_1", [["JSON"]])
      assert.equal(calls.length, 1)
      assert.ok(calls[0].url.endsWith("/api/local-engine/question"))
      assert.deepEqual(calls[0].body, { sessionKey: "ses_lcl_m", requestId: "que_1", answers: [["JSON"]] })
      assert.equal(getQuestionQueue(INSTANCE).length, 0, "answered: taken down")

      // Dismissing is passed on too.
      reply.apply({ type: "question", id: "que_2", callId: "c2", questions })
      syncLocalQuestions(INSTANCE, reply, manager)
      await sendQuestionReject(INSTANCE, "ses_lcl_m", "que_2")
      assert.deepEqual(calls[1].body, { sessionKey: "ses_lcl_m", requestId: "que_2", dismissed: true })
      assert.equal(getQuestionQueue(INSTANCE).length, 0)
    } finally {
      globalThis.fetch = realFetch
    }

    // When the call returns on its own (answered elsewhere, or the run ended), the question goes.
    reply.apply({ type: "question", id: "que_3", callId: "c3", questions })
    syncLocalQuestions(INSTANCE, reply, manager)
    assert.equal(getQuestionQueue(INSTANCE).length, 1)
    reply.apply({ type: "tool_result", id: "c3", name: "question", output: "x", isError: false })
    syncLocalQuestions(INSTANCE, reply, manager)
    assert.equal(getQuestionQueue(INSTANCE).length, 0)
    reply.apply({ type: "question", id: "que_4", callId: "c4", questions })
    syncLocalQuestions(INSTANCE, reply, manager)
    settleLocalQuestions(INSTANCE, reply, manager)
    assert.equal(getQuestionQueue(INSTANCE).length, 0)
  })

  test("a delegated task's question is shown in the task's own session", () => {
    const instance = "inst-questions-task"
    addInstance({ id: instance, folder: "/work" } as never)
    const reply = new LocalEngineReply()
    reply.apply({ type: "task_start", taskId: "t1", sessionId: "ses_lcl_t_t1", parentSessionId: "ses_lcl_m", parentCallId: "p1", agent: "qa_engineer", description: "d", prompt: "p", assistantMessageId: "msg_ta_t1", userMessageId: "msg_tu_t1" })
    syncLocalTaskSessions(instance, "/work", reply.takeChangedTasks())
    reply.apply({ type: "task_event", taskId: "t1", parentCallId: "p1", event: { type: "question", id: "que_t", callId: "c9", questions } })
    syncLocalQuestions(instance, reply, manager)
    const [request] = getQuestionQueue(instance)
    assert.equal(request.sessionID, "ses_lcl_t_t1")
    assert.deepEqual(request.tool, { messageID: "msg_ta_t1", callID: "c9" })
    reply.apply({ type: "task_end", taskId: "t1", parentCallId: "p1", status: "aborted" })
    syncLocalQuestions(instance, reply, manager)
    assert.equal(getQuestionQueue(instance).length, 0, "a stopped task's question is withdrawn")
  })
})
