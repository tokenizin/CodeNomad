/**
 * Shows what a Claude Code (Rust) agent asks the user, in the UI OpenCode's own questions and permissions use:
 * its questions (`question` tool) and the permissions it requests (a rule says `ask`). Each is taken down when
 * the tool call returns. The answer goes to CodeNomad's server (instances.ts `sendQuestionReply`,
 * `sendPermissionResponse`), which hands it to the waiting agent.
 */

import type { LocalEngineReply } from "../lib/local-engine"
import type { QuestionRequest } from "../types/question"
import type { PermissionRequest } from "../types/permission"
import { upsertPermissionV2, upsertQuestionV2, removePermissionV2, removeQuestionV2 } from "./message-v2/bridge"
import { addPermissionToQueue, addQuestionToQueue, removePermissionFromQueue, removeQuestionFromQueue } from "./instances"

/**
 * Registers what the reply asked, and clears what it settled, since the last call.
 * `manager`: the run's own session and its assistant message; a task's question is shown in the task's session.
 */
export function syncLocalQuestions(instanceId: string, reply: LocalEngineReply, manager: { sessionId: string; assistantId: string }): void {
  const { asked, settled } = reply.takeQuestionChanges()
  for (const question of asked) {
    const task = question.taskId ? reply.tasks.find((t) => t.taskId === question.taskId) : undefined
    if (question.taskId && !task) continue
    if (question.kind === "permission" && question.permission) {
      const permissionRequest = {
        id: question.id,
        sessionID: task ? task.sessionId : manager.sessionId,
        permission: question.permission.permission,
        patterns: question.permission.patterns,
        always: question.permission.always,
        metadata: {},
        tool: { messageID: task ? task.assistantMessageId : manager.assistantId, callID: question.callId },
      } as unknown as PermissionRequest
      const queued = addPermissionToQueue(instanceId, permissionRequest, "local") ?? permissionRequest
      upsertPermissionV2(instanceId, queued)
      continue
    }
    const request = {
      id: question.id,
      sessionID: task ? task.sessionId : manager.sessionId,
      questions: question.questions.map((q) => ({
        question: q.question,
        header: q.header,
        options: q.options,
        ...(q.multiple ? { multiple: true } : {}),
      })),
      tool: { messageID: task ? task.assistantMessageId : manager.assistantId, callID: question.callId },
    } as unknown as QuestionRequest
    addQuestionToQueue(instanceId, request, "local")
    upsertQuestionV2(instanceId, request)
  }
  for (const id of settled) {
    if (id.startsWith("per_")) {
      removePermissionFromQueue(instanceId, id)
      removePermissionV2(instanceId, id)
    } else {
      removeQuestionFromQueue(instanceId, id)
      removeQuestionV2(instanceId, id)
    }
  }
}

/** The run ended: no question of it can be answered any more. */
export function settleLocalQuestions(instanceId: string, reply: LocalEngineReply, manager: { sessionId: string; assistantId: string }): void {
  reply.settleAllQuestions()
  syncLocalQuestions(instanceId, reply, manager)
}
