import assert from "node:assert/strict"
import { describe, it as test } from "node:test"

import { messageStoreBus } from "./message-v2/bus.ts"
import { addInstance } from "./instances.ts"
import { attachLocalRuns } from "./local-run-attach.ts"
import { attachedLocalSessions } from "./local-run-attacher.ts"
import { localRecordIsBusy, upsertLocalSessions } from "./session-api.ts"
import { sessions } from "./session-state.ts"

const INSTANCE = "inst-attach"
const SESSION = "ses_lcl_manager"
const line = (v: unknown) => JSON.stringify(v) + "\n"
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A fetch whose attach answers come from `attaches` in turn (a function gets to hold the stream open), and whose history is `saved`. */
function fakeServer(attaches: Array<(controller: ReadableStreamDefaultController<Uint8Array>) => Promise<void> | void>, saved: unknown[]) {
  const calls: string[] = []
  const enc = new TextEncoder()
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.includes("/api/local-engine/attach")) {
      const play = attaches.shift()
      if (!play) return new Response(line({ type: "idle" }))
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const original = controller.enqueue.bind(controller)
          controller.enqueue = ((chunk: Uint8Array | string) => original(typeof chunk === "string" ? enc.encode(chunk) : chunk)) as typeof controller.enqueue
          await play(controller)
          controller.close()
        },
      })
      return new Response(stream, { headers: { "content-type": "application/x-ndjson" } })
    }
    if (url.includes("/api/local-engine/history")) {
      return new Response(JSON.stringify({ messages: saved, running: false, watching: false }), { headers: { "content-type": "application/json" } })
    }
    return new Response("{}", { headers: { "content-type": "application/json" } })
  }) as typeof fetch
  return { calls, fetchImpl }
}

describe("following a run this tab did not start", () => {
  test("the manager's notification turn appears as it is said, with the ids the server saves, and is not doubled when history loads", async () => {
    addInstance({ id: INSTANCE, folder: "/work" } as never)
    upsertLocalSessions(INSTANCE, [{ id: SESSION, folder: "/work", title: "Manager", agent: "product_manager", createdAt: 1, updatedAt: 1 }])
    const notification = "[NomadFlow Notification] Workflow Runner has finished work for: t.md.\n\nFINAL SUMMARY FROM RUNNER:\nDone."
    const saved = [
      { id: "msg_lu_note", role: "user", text: notification, createdAt: 1000 },
      { id: "msg_la_note", role: "assistant", text: "Reviewed it.", createdAt: 1001, parts: [{ type: "text", text: "Reviewed it." }] },
    ]
    let releaseSecondHalf!: () => void
    const gate = new Promise<void>((resolve) => (releaseSecondHalf = resolve))
    const { calls, fetchImpl } = fakeServer(
      [
        async (c) => {
          c.enqueue(line({ type: "attach", sessionKey: SESSION, startedAt: 1000, user: { id: "msg_lu_note", text: notification, createdAt: 1000 }, assistantId: "msg_la_note" }) as never)
          c.enqueue(line({ type: "delta", text: "Reviewed " }) as never)
          await gate
          c.enqueue(line({ type: "delta", text: "it." }) as never)
          c.enqueue(line({ type: "final", text: "Reviewed it." }) as never)
          c.enqueue(line({ type: "exit", code: 0 }) as never)
        },
      ],
      saved,
    )
    const realFetch = globalThis.fetch
    globalThis.fetch = fetchImpl
    try {
      const attached = attachLocalRuns(INSTANCE, SESSION)
      await sleep(200)

      // Mid-turn: the notification and the first words are on screen, the session is working.
      const store = messageStoreBus.getOrCreate(INSTANCE)
      assert.deepEqual(store.getSessionMessageIds(SESSION), ["msg_lu_note", "msg_la_note"])
      assert.equal(sessions().get(INSTANCE)?.get(SESSION)?.status, "working")
      assert.ok(attachedLocalSessions.has(SESSION))
      const partsOf = (id: string) => Object.values(store.getMessage(id)?.parts ?? {}).map((p) => (p.data as { text?: string }).text)
      assert.deepEqual(partsOf("msg_lu_note"), [notification])
      assert.deepEqual(partsOf("msg_la_note"), ["Reviewed "])
      assert.equal(store.getMessage("msg_la_note")?.status, "streaming")

      releaseSecondHalf()
      await attached

      // Done: complete, idle, the saved messages are the same ones, once each.
      assert.equal(store.getMessage("msg_la_note")?.status, "complete")
      assert.deepEqual(partsOf("msg_la_note"), ["Reviewed it."])
      assert.deepEqual(store.getSessionMessageIds(SESSION), ["msg_lu_note", "msg_la_note"])
      assert.equal(sessions().get(INSTANCE)?.get(SESSION)?.status, "idle")
      assert.equal(attachedLocalSessions.has(SESSION), false)
      // It asked again after the run, was told idle, and stopped; the history was reloaded in between.
      const attachCalls = calls.filter((u) => u.includes("/attach"))
      assert.equal(attachCalls.length, 2)
      assert.ok(attachCalls[0].includes(`sessionKey=${SESSION}`) && attachCalls[0].includes("wait=1"))
      assert.ok(calls.some((u) => u.includes("/api/local-engine/history")))
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("after a reload the list marks busy sessions working and follows them; the mark comes down when they are done", async () => {
    const instanceId = "inst-attach-reload"
    addInstance({ id: instanceId, folder: "/work" } as never)
    assert.equal(localRecordIsBusy({ id: "a", folder: "/work", title: "", agent: "", createdAt: 1, updatedAt: 1 }), false)
    assert.equal(localRecordIsBusy({ id: "a", folder: "/work", title: "", agent: "", createdAt: 1, updatedAt: 1, running: true }), true)
    assert.equal(localRecordIsBusy({ id: "a", folder: "/work", title: "", agent: "", createdAt: 1, updatedAt: 1, taskStatus: "running" }), true)
    assert.equal(
      localRecordIsBusy({ id: "a", folder: "/work", title: "", agent: "", createdAt: 1, updatedAt: 1, workflow: { workflowId: "w", managerSessionId: "m", taskPath: "t", track: "implementation", status: "running" } }),
      true,
    )
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { calls, fetchImpl } = fakeServer(
      [
        async (c) => {
          c.enqueue(line({ type: "attach", sessionKey: "ses_lcl_busy", startedAt: 1, user: { id: "msg_lu_b", text: "go", createdAt: 1 }, assistantId: "msg_la_b" }) as never)
          await gate
          c.enqueue(line({ type: "final", text: "ok" }) as never)
          c.enqueue(line({ type: "exit", code: 0 }) as never)
        },
      ],
      [],
    )
    const realFetch = globalThis.fetch
    globalThis.fetch = fetchImpl
    try {
      const base = { folder: "/work", agent: "", createdAt: 1, updatedAt: 1 }
      upsertLocalSessions(instanceId, [
        { id: "ses_lcl_busy", title: "Busy", running: true, ...base },
        { id: "ses_lcl_calm", title: "Calm", ...base },
        { id: "ses_lcl_t_kid", title: "Kid", parentId: "ses_lcl_busy", kind: "task", taskStatus: "running", ...base },
      ])
      assert.equal(sessions().get(instanceId)?.get("ses_lcl_busy")?.status, "working")
      assert.equal(sessions().get(instanceId)?.get("ses_lcl_t_kid")?.status, "working")
      assert.equal(sessions().get(instanceId)?.get("ses_lcl_calm")?.status, "idle")
      await sleep(100)
      // Only the busy one is followed.
      assert.deepEqual([...new Set(calls.filter((u) => u.includes("/attach")).map((u) => new URL(u, "http://x").searchParams.get("sessionKey")))], ["ses_lcl_busy"])
      release()
      await sleep(300)
      assert.equal(sessions().get(instanceId)?.get("ses_lcl_busy")?.status, "idle")
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("when nothing is pending the answer is idle and nothing is drawn", async () => {
    const instanceId = "inst-attach-idle"
    addInstance({ id: instanceId, folder: "/work" } as never)
    upsertLocalSessions(instanceId, [{ id: "ses_lcl_quiet", folder: "/work", title: "Quiet", agent: "", createdAt: 1, updatedAt: 1 }])
    const { calls, fetchImpl } = fakeServer([], [])
    const realFetch = globalThis.fetch
    globalThis.fetch = fetchImpl
    try {
      await attachLocalRuns(instanceId, "ses_lcl_quiet")
      assert.equal(calls.filter((u) => u.includes("/attach")).length, 1)
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds("ses_lcl_quiet"), [])
      assert.equal(sessions().get(instanceId)?.get("ses_lcl_quiet")?.status ?? "idle", "idle")
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("a server without the attach call falls back to looking at the history", async () => {
    const instanceId = "inst-attach-old"
    addInstance({ id: instanceId, folder: "/work" } as never)
    upsertLocalSessions(instanceId, [{ id: "ses_lcl_old", folder: "/work", title: "Old", agent: "", createdAt: 1, updatedAt: 1 }])
    const calls: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.includes("/attach")) return new Response(JSON.stringify({ error: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } })
      return new Response(JSON.stringify({ messages: [], running: false, watching: false }), { headers: { "content-type": "application/json" } })
    }) as typeof fetch
    try {
      await attachLocalRuns(instanceId, "ses_lcl_old")
      // The older watcher takes over: it looks at the history after a few seconds. Here it is enough that attach gave way without throwing.
      assert.equal(calls.filter((u) => u.includes("/attach")).length, 1)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
