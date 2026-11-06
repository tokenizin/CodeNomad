import assert from "node:assert/strict"
import { describe, it as test } from "node:test"

import { addInstance } from "./instances.ts"
import { abortSession } from "./session-actions.ts"
import { upsertLocalSessions } from "./session-api.ts"

describe("Stop on a local session", () => {
  test("Stop on a delegated task's session asks the server to stop that session only", async () => {
    const instanceId = "inst-task-stop"
    addInstance({ id: instanceId, folder: "/work" } as never)
    const base = { folder: "/work", agent: "qa_engineer", createdAt: 1, updatedAt: 1 }
    upsertLocalSessions(instanceId, [
      { id: "ses_lcl_manager", title: "Manager", ...base, running: true },
      { id: "ses_lcl_t_tk_a", title: "Task", parentId: "ses_lcl_manager", kind: "task", taskStatus: "running", ...base },
    ])
    const calls: Array<{ url: string; body: unknown }> = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("/api/local-engine/abort")) calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) })
      return new Response(JSON.stringify({ aborted: true, task: true }), { headers: { "content-type": "application/json" } })
    }) as typeof fetch
    try {
      await abortSession(instanceId, "ses_lcl_t_tk_a")
      assert.equal(calls.length, 1)
      assert.deepEqual(calls[0].body, { sessionKey: "ses_lcl_t_tk_a" }, "the task's session, not its parent's run")
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
