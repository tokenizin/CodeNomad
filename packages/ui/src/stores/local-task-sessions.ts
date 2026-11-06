/**
 * Keeps delegated tasks (protocol 2) in the session and message stores while a
 * Claude Code (Rust) run streams, so the Task card's child session fills in live,
 * the way an OpenCode subagent session does.
 *
 * Each task becomes a session under the one that dispatched it, holding the prompt
 * it was given and its own reply. The ids are the server's, so when the server's
 * saved history is loaded later it replaces these messages rather than doubling them.
 */

import {
  liveTaskSessions,
  taskSessionRecord,
  toOpencodePart,
  type HistoryPart,
  type LocalTaskStatus,
  type LocalTaskView,
} from "../lib/local-engine"
import { messageStoreBus } from "./message-v2/bus"
import { upsertLocalSessions } from "./session-api"
import { setSessionStatus } from "./session-state"
import { recordLocalUsage } from "./local-usage"

/** The status each task session was last given, so the session list is only touched on a change. */
const lastStatus = new Map<string, LocalTaskStatus>()
const statusKey = (instanceId: string, sessionId: string) => `${instanceId}\u0000${sessionId}`

function asMessagePart(sessionId: string, messageId: string, part: HistoryPart, index: number) {
  // Not synthetic: the message view hides synthetic assistant text.
  return { ...toOpencodePart(sessionId, messageId, part, index), synthetic: false }
}

/** Creates or updates the sessions and messages of these tasks. Call it before the parent's Task card is rendered. */
export function syncLocalTaskSessions(instanceId: string, folder: string, tasks: LocalTaskView[]): void {
  if (tasks.length === 0) return
  const store = messageStoreBus.getOrCreate(instanceId)

  // Parents before the tasks they delegated (a session must exist before its children load).
  const ordered = [...tasks].sort((a, b) => a.startedAt - b.startedAt)
  const changed = ordered.filter((task) => lastStatus.get(statusKey(instanceId, task.sessionId)) !== task.status)
  if (changed.length > 0) {
    upsertLocalSessions(
      instanceId,
      changed.map((task) => taskSessionRecord(task, folder)),
    )
  }

  for (const task of ordered) {
    if (task.status === "running") liveTaskSessions.add(task.sessionId)

    store.upsertMessage({
      id: task.userMessageId,
      sessionId: task.sessionId,
      role: "user",
      status: "complete",
      parts: [asMessagePart(task.sessionId, task.userMessageId, { type: "text", text: task.prompt }, 0)],
      createdAt: task.startedAt,
      updatedAt: Date.now(),
      isEphemeral: true,
    })
    store.upsertMessage({
      id: task.assistantMessageId,
      sessionId: task.sessionId,
      role: "assistant",
      status: task.status === "running" ? "streaming" : task.status === "completed" ? "complete" : "error",
      parts: task.parts.map((part, index) => asMessagePart(task.sessionId, task.assistantMessageId, part, index)),
      // After its prompt, whatever the clocks say.
      createdAt: task.startedAt + 1,
      updatedAt: Date.now(),
      isEphemeral: true,
    })

    recordLocalUsage(instanceId, task.sessionId, task.assistantMessageId, task.usage, task.model, task.startedAt + 1)

    const key = statusKey(instanceId, task.sessionId)
    if (lastStatus.get(key) !== task.status) {
      lastStatus.set(key, task.status)
      setSessionStatus(instanceId, task.sessionId, task.status === "running" ? "working" : "idle")
    }
    if (task.status !== "running") liveTaskSessions.delete(task.sessionId)
  }
}
