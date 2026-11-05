/**
 * Turns a run's task events (protocol 2) into sessions: each delegated task gets
 * its own session, linked to the parent's Task card, holding the task's own
 * transcript (the prompt it was given, then its text and tool calls).
 *
 * The run route feeds every engine event through `apply`, in order; `finish`
 * closes whatever is still open when the run ends (stopped or crashed), so the
 * work a task did is kept either way.
 */

import { ReplyParts } from "./reply-parts.js"
import type { EngineEvent, TaskStatus } from "./rust-runner.js"
import { taskSessionId, type HistoryMessage, type LocalEngineStore } from "./store.js"

type TaskRun = {
  taskId: string
  sessionId: string
  userMessageId: string
  assistantMessageId: string
  prompt: string
  agent: string
  model?: string
  startedAt: number
  parts: ReplyParts
  ended: boolean
}

export class TaskSessions {
  private readonly runs = new Map<string, TaskRun>()

  constructor(
    private readonly deps: {
      store: LocalEngineStore
      /** The session the run belongs to. */
      parentSessionId: string
      folder: string
      /** The top-level reply, to find the Task card (and the prompt it carried). */
      parentParts: ReplyParts
    },
  ) {}

  /** Number of tasks still open. */
  get open(): number {
    return [...this.runs.values()].filter((run) => !run.ended).length
  }

  /** Records the event; returns what to send on to the browser (`task_start` gains its session and message ids). */
  apply(event: EngineEvent): EngineEvent {
    switch (event.type) {
      case "task_start":
        return this.start(event)
      case "task_event":
        this.runs.get(event.taskId)?.parts.apply(event.event)
        break
      case "task_end":
        this.end(event.taskId, event.status, event.error)
        break
    }
    return event
  }

  /** Closes tasks still open at the end of the run. */
  finish(options: { stopped: boolean }): void {
    for (const run of this.runs.values()) {
      if (!run.ended) this.close(run, options.stopped ? "aborted" : "failed", options.stopped ? undefined : "Did not finish")
    }
  }

  private start(event: Extract<EngineEvent, { type: "task_start" }>): EngineEvent {
    // The prompt is on the Task card: the parent's, or — for a task delegated by a task — that task's.
    const parentRun = event.parentTaskId ? this.runs.get(event.parentTaskId) : undefined
    // A task delegated by a task: its card is in that task's transcript, so link it there
    // (the top-level reply, which already saw this event, has no such card).
    parentRun?.parts.apply(event)
    const cardParts = (parentRun?.parts ?? this.deps.parentParts).parts
    const card = cardParts.find((p) => p.type === "tool" && p.id === event.parentCallId)
    const given = card?.type === "tool" ? card.input.prompt : undefined
    const prompt = typeof given === "string" && given.trim() ? given : event.description

    const parentId = event.parentTaskId ? taskSessionId(event.parentTaskId) : this.deps.parentSessionId
    this.deps.store.upsertTaskSession({
      taskId: event.taskId,
      parentId,
      parentCallId: event.parentCallId,
      folder: this.deps.folder,
      title: `[${event.agent}] ${event.description}`.trim(),
      agent: event.agent,
      model: event.model,
    })
    const startedAt = Date.now()
    const run: TaskRun = {
      taskId: event.taskId,
      sessionId: taskSessionId(event.taskId),
      userMessageId: `msg_tu_${event.taskId}_${startedAt.toString(36)}`,
      assistantMessageId: `msg_ta_${event.taskId}_${startedAt.toString(36)}`,
      prompt,
      agent: event.agent,
      model: event.model,
      startedAt,
      parts: new ReplyParts(),
      ended: false,
    }
    this.runs.set(event.taskId, run)
    return {
      ...event,
      sessionId: run.sessionId,
      parentSessionId: parentId,
      prompt,
      userMessageId: run.userMessageId,
      assistantMessageId: run.assistantMessageId,
    }
  }

  private end(taskId: string, status: TaskStatus, error?: string) {
    const run = this.runs.get(taskId)
    if (run && !run.ended) this.close(run, status, error)
  }

  private close(run: TaskRun, status: TaskStatus, error?: string) {
    run.ended = true
    const saved = run.parts.finish({ stopped: status === "aborted", isError: status === "failed", fallbackError: error })
    const failed = status === "failed"
    const messages: HistoryMessage[] = [
      { id: run.userMessageId, role: "user", text: run.prompt, createdAt: run.startedAt },
      {
        id: run.assistantMessageId,
        role: "assistant",
        text: saved.text,
        parts: saved.parts,
        createdAt: Date.now(),
        engine: "claude-code-rust",
        agent: run.agent,
        ...(run.model ? { model: run.model } : {}),
        ...(failed ? { isError: true } : {}),
      },
    ]
    try {
      this.deps.store.appendHistory(run.sessionId, messages)
      this.deps.store.setTaskStatus(run.sessionId, status)
    } catch {
      /* the parent's reply still saves; a task transcript that can't be written is not worth failing the run */
    }
  }
}
