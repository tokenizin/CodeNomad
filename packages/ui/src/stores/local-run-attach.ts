/**
 * Shows a run this tab did not start, live.
 *
 * A background workflow's notification turn on the Product Manager, a Workflow Runner's own run, or any
 * run that was going when the page was reloaded, has no stream into this tab. The server publishes every
 * run's events (`GET /api/local-engine/attach`); this follows them into the message store the same way a
 * message sent from this tab is shown, using the ids the server will save, so the saved history replaces
 * the live messages instead of doubling them.
 *
 * The call is held open while the session is `watching` (a runner is at work) and ends with `idle` when
 * nothing is pending; each run it streams ends with the history reloaded.
 */

import { localEngineRuns, localRunKey, readLocalEngineStream, toOpencodePart, type HistoryPart, type LocalTaskView } from "../lib/local-engine"
import { serverApi } from "../lib/api-client"
import { getLogger } from "../lib/logger"
import { instances } from "./instances"
import { messageStoreBus } from "./message-v2/bus"
import { syncLocalTaskSessions } from "./local-task-sessions"
import { attachedLocalSessions as attachedSessions, setLocalRunAttacher } from "./local-run-attacher"
import { loadMessages, registerLocalWorkflows, watchLocalWorkflows } from "./session-api"
import { setSessionStatus } from "./session-state"

const log = getLogger("api")

const attaching = new Set<string>()

const RETRY_MS = 2000
/** Attach rounds one call makes at most: each is a run, or a wait for one. */
const MAX_ROUNDS = 1000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Follows the session's runs live until nothing is pending. One call per session at a time.
 * When the server does not know the attach call (an older CodeNomad) the session is looked at by polling instead.
 */
export async function attachLocalRuns(instanceId: string, sessionId: string): Promise<void> {
  const key = localRunKey(instanceId, sessionId)
  if (attaching.has(key)) return
  attaching.add(key)
  try {
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      // This tab's own message is streaming into the session: it shows it, and the next look comes after.
      if (localEngineRuns.has(key)) {
        await sleep(RETRY_MS)
        continue
      }
      const response = await serverApi.attachLocalEngine(sessionId).catch((error) => {
        log.warn("attach: request failed", error)
        return null
      })
      if (!response || response.status === 404 || response.status === 405) {
        // No attach on this server (or it is unreachable): the older way, looking every few seconds.
        watchLocalWorkflows(instanceId, sessionId)
        return
      }
      if (!response.ok) {
        await sleep(RETRY_MS)
        continue
      }
      const ran = await showRun(instanceId, sessionId, response)
      if (!ran) return // idle: nothing pending
    }
  } finally {
    attaching.delete(key)
    attachedSessions.delete(sessionId)
  }
}

/** Draws one run from its attach stream. False when the server said nothing is running or pending. */
async function showRun(instanceId: string, sessionId: string, response: Response): Promise<boolean> {
  const store = messageStoreBus.getOrCreate(instanceId)
  const folder = instances().get(instanceId)?.folder || ""
  let header: { user: { id: string; text: string; createdAt: number }; assistantId: string; startedAt: number } | undefined

  const upsertUser = () => {
    if (!header) return
    store.upsertMessage({
      id: header.user.id,
      sessionId,
      role: "user",
      status: "complete",
      parts: [{ ...toOpencodePart(sessionId, header.user.id, { type: "text", text: header.user.text }, 0), synthetic: false }],
      createdAt: header.user.createdAt,
      updatedAt: Date.now(),
      isEphemeral: true,
    })
  }
  const upsertAssistant = (parts: HistoryPart[], status: "streaming" | "complete" | "error") => {
    if (!header) return
    store.upsertMessage({
      id: header.assistantId,
      sessionId,
      role: "assistant",
      status,
      parts: parts.map((part, index) => ({ ...toOpencodePart(sessionId, header!.assistantId, part, index), synthetic: false })),
      createdAt: header.startedAt + 1,
      updatedAt: Date.now(),
      isEphemeral: true,
    })
  }

  // Re-render at most every 60 ms while the reply streams in, as a message sent from this tab does.
  let pending: HistoryPart[] | null = null
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  const pendingTasks = new Map<string, LocalTaskView>()
  const flush = () => {
    flushTimer = null
    if (pendingTasks.size) {
      const tasks = [...pendingTasks.values()]
      pendingTasks.clear()
      syncLocalTaskSessions(instanceId, folder, tasks)
    }
    if (pending) upsertAssistant(pending, "streaming")
    pending = null
  }

  try {
    const result = await readLocalEngineStream(response, (ev, reply, changed) => {
      if (ev.type === "attach" && !header) {
        header = ev as unknown as NonNullable<typeof header>
        attachedSessions.add(sessionId)
        upsertUser()
        upsertAssistant([], "streaming")
        setSessionStatus(instanceId, sessionId, "working")
        return
      }
      if (!header) return
      for (const task of reply.takeChangedTasks()) pendingTasks.set(task.taskId, task)
      const started = reply.takeNewWorkflows()
      if (started.length > 0) registerLocalWorkflows(instanceId, folder, sessionId, started)
      if (!changed && pendingTasks.size === 0) return
      if (changed) pending = reply.parts.map((p) => ({ ...p }))
      if (!flushTimer) flushTimer = setTimeout(flush, 60)
    })
    if (flushTimer) clearTimeout(flushTimer)
    if (!header) return false
    syncLocalTaskSessions(instanceId, folder, result.tasks)
    pendingTasks.clear()
    upsertAssistant(result.parts, result.isError ? "error" : "complete")
    return true
  } catch (error) {
    if (flushTimer) clearTimeout(flushTimer)
    log.warn("attach: stream broke", error)
    return header !== undefined
  } finally {
    if (header) {
      attachedSessions.delete(sessionId)
      setSessionStatus(instanceId, sessionId, "idle")
      // The server saved the run before it ended the stream: what it saved replaces the live messages.
      await loadMessages(instanceId, sessionId, { force: true, skipChildren: true }).catch(() => undefined)
    }
  }
}

setLocalRunAttacher((instanceId, sessionId) => void attachLocalRuns(instanceId, sessionId))
