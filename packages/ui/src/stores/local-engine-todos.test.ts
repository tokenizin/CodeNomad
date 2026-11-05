import assert from "node:assert/strict"
import { describe, it as test } from "node:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { LocalEngineReply, toOpencodePart, type LocalEngineEvent } from "../lib/local-engine.ts"
import { messageStoreBus } from "./message-v2/bus.ts"

/** Real agent output for a run that planned, edited, searched and fetched (see lib/__fixtures__/). */
function toolRun() {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "__fixtures__", "task-envelopes-tools.ndjson")
  const reply = new LocalEngineReply()
  for (const line of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) reply.apply(JSON.parse(line) as LocalEngineEvent)
  return reply.result()
}

describe("a Claude Code (Rust) plan in the Status tab", () => {
  test("a TodoWrite from the real agent becomes the session's latest todo snapshot, readable the way the plan panel reads it", () => {
    const instanceId = "inst-todos"
    const sessionId = "ses_lcl_todos"
    const store = messageStoreBus.getOrCreate(instanceId)
    const result = toolRun()
    store.upsertMessage({
      id: "msg_a",
      sessionId,
      role: "assistant",
      status: "complete",
      parts: result.parts.map((part, index) => ({ ...toOpencodePart(sessionId, "msg_a", part, index), synthetic: false })),
      createdAt: 1,
      updatedAt: 2,
    })

    const snapshot = store.state.latestTodos[sessionId]
    assert.ok(snapshot, "the store recorded a todo snapshot")
    // The plan panel finds the part by the snapshot and reads its metadata.
    const part = store.getMessage(snapshot.messageId)?.parts?.[snapshot.partId]?.data as any
    assert.equal(part.tool, "todowrite")
    assert.equal(part.state.status, "completed")
    assert.deepEqual(part.state.metadata.todos.map((t: any) => t.status), ["in_progress", "pending"])
  })

  test("a run with no todo list records no snapshot", () => {
    const instanceId = "inst-notodos"
    const sessionId = "ses_lcl_none"
    const store = messageStoreBus.getOrCreate(instanceId)
    const result = toolRun()
    const withoutTodo = result.parts.filter((p) => !(p.type === "tool" && p.tool.startsWith("todo")))
    store.upsertMessage({
      id: "msg_b",
      sessionId,
      role: "assistant",
      status: "complete",
      parts: withoutTodo.map((part, index) => ({ ...toOpencodePart(sessionId, "msg_b", part, index), synthetic: false })),
      createdAt: 1,
      updatedAt: 2,
    })
    assert.equal(store.state.latestTodos[sessionId], undefined)
  })
})
