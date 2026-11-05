/**
 * Background workflows: OpenCode's NomadWorks flow on the local engine.
 *
 * In OpenCode `nomadflow_run_workflow` returns at once; the Workflow Runner works in a
 * session of its own; when it is done a `[NomadFlow Notification] …` user message appears
 * in the Product Manager's session and starts a new turn there. The Rust agent is one
 * process per message, so it cannot keep a runner alive after its own turn ends. This is the
 * part that does: the agent says what to start (`workflow_start` / `workflow_prompt` events),
 * and this supervisor runs the runner in a second agent process (`NOMAD_WORKFLOW_RUN=1`) and
 * posts the notification.
 *
 *   manager run ──workflow_start──▶ session ses_lcl_wf_… created, runner process started
 *   manager run ends (or not: both run at once)
 *   runner process ends ──▶ notification queued for the manager ──▶ manager turn when idle
 *
 * The runner's process also files the structured handover; the notification carries it after the
 * runner's own final summary, so the manager still has something to validate.
 */

import fs from "fs"
import path from "path"
import type { WorkflowDoneEvent, WorkflowPromptEvent, WorkflowStartEvent } from "./rust-runner.js"
import { safeKey, type InboxEntry, type LocalEngineStore, type LocalSession, type WorkflowStatus } from "./store.js"

/** The session that started a workflow and is told when it is done. */
export type Manager = { key: string; folder: string; agent?: string; model?: string }

/** One agent run for a session, to the end, saved to its history. */
export type ExecuteJob = {
  sessionKey: string
  folder: string
  /** What the agent is given. */
  prompt: string
  /** What the session's history shows as the user message. */
  displayText: string
  agent?: string
  model?: string
  /** Earlier turns go to the agent (the manager). The runner's conversation is in its task store instead. */
  history: boolean
  env: Record<string, string>
  /** Agent name saved on the reply when the process was not started with `--agent`. */
  assistantAgent?: string
}

export type ExecuteResult = {
  stopped: boolean
  isError: boolean
  finalText: string
  workflowDone?: WorkflowDoneEvent
}

export type SupervisorDeps = {
  store: LocalEngineStore
  execute: (job: ExecuteJob) => Promise<ExecuteResult>
  /** True while a run is going for the session (a user's, or a notification's). */
  isBusy: (sessionKey: string) => boolean
  warn?: (message: string, detail?: unknown) => void
}

type Job = { text: string; display: string; notify: boolean; identifier: string }

type Runner = {
  key: string
  workflowId: string
  folder: string
  taskPath: string
  manager?: Manager
  queue: Job[]
  running: boolean
}

// ---------------------------------------------------------------- registry (shared with the agent)

/** Where the agent keeps one file per workflow in the worktree (see playground/rust/src/workflows.rs). */
export function registryFile(folder: string, workflowId: string): string | null {
  return /^[A-Za-z0-9_-]{1,100}$/.test(workflowId) ? path.join(folder, ".codenomad", "runtime", "workflows", `${workflowId}.json`) : null
}

/** Marks a workflow idle in the worktree's registry: its runner is not working, so it no longer owns the worktree. */
export function releaseRegistryEntry(folder: string, workflowId: string): void {
  const file = registryFile(folder, workflowId)
  if (!file) return
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"))
    if (doc.state === "idle") return
    fs.writeFileSync(file, JSON.stringify({ ...doc, state: "idle" }))
  } catch {
    /* no entry (an agent without the registry), or not readable: nothing to release */
  }
}

// ---------------------------------------------------------------- the messages

/** The message the manager receives when a runner is done: NomadWorks' plugin's, then the handover. */
export function notificationText(input: { identifier: string; sessionId: string; result: ExecuteResult }): string {
  const { identifier, sessionId, result } = input
  const done = result.workflowDone
  const failure = result.stopped ? "it was stopped before it finished" : done?.error ?? (result.isError ? result.finalText || "the runner failed" : undefined)
  if (failure) {
    return `[NomadFlow Error] Workflow Runner failed for ${identifier}: ${failure}\n\nIts session (${sessionId}) keeps its progress; send it a prompt with nomadflow_prompt_workflow to continue.`
  }
  const lines = [`[NomadFlow Notification] Workflow Runner has finished work for: ${identifier}.`, "", "FINAL SUMMARY FROM RUNNER:", result.finalText]
  const h = done?.handover
  if (h) {
    lines.push(
      "",
      `HANDOVER FILED: ${h.path} (revision ${h.revision}, outcome ${h.outcome}, verification ${h.verification}, ${h.openIssues} open issue(s)).`,
      `Evaluate it against the task's requirements. Accept it, or send the workflow back with nomadflow_prompt_workflow (session_id: ${sessionId}).`,
      "",
      "<handover>",
      h.markdown.trim(),
      "</handover>",
    )
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------- the supervisor

export class WorkflowSupervisor {
  private readonly runners = new Map<string, Runner>()
  private readonly inbound = new Map<string, string[]>()
  /** The notification being delivered now, per manager: still on disk until its turn has been saved. */
  private readonly inflight = new Map<string, string>()
  /** Notifications that could not be run (no agent to run them with): kept on disk for the next start, not retried now. */
  private readonly parked = new Map<string, string[]>()
  private readonly delivering = new Set<string>()
  private readonly work = new Set<Promise<unknown>>()

  constructor(private readonly deps: SupervisorDeps) {}

  /** The manager started a workflow: its session now exists and its runner is under way. */
  start(manager: Manager, ev: WorkflowStartEvent): void {
    if (!safeKey(ev.sessionId)) {
      this.deps.warn?.("workflow session id is not a safe key", ev.sessionId)
      return
    }
    this.deps.store.upsertWorkflowSession({
      sessionId: ev.sessionId,
      folder: manager.folder,
      title: ev.title,
      workflow: {
        workflowId: ev.workflowId,
        managerSessionId: manager.key,
        managerAgent: manager.agent,
        managerModel: manager.model,
        taskPath: ev.taskPath,
        track: ev.track,
      },
    })
    const runner: Runner = { key: ev.sessionId, workflowId: ev.workflowId, folder: manager.folder, taskPath: ev.taskPath, manager, queue: [], running: false }
    this.runners.set(runner.key, runner)
    runner.queue.push({ text: ev.instructions, display: ev.prompt, notify: true, identifier: ev.taskPath || ev.sessionId })
    this.track(this.drain(runner))
  }

  /** The manager sent text to a runner: queued behind its current work, or a new run of the same session. */
  prompt(manager: Manager, ev: WorkflowPromptEvent): void {
    const runner = this.runnerFor(ev.sessionId, manager)
    if (!runner) {
      this.deps.warn?.("prompt for a workflow session that does not exist", ev.sessionId)
      this.deliver(manager, `[NomadFlow Error] Workflow Runner failed for ${ev.sessionId}: no such workflow session.`)
      return
    }
    runner.manager = manager
    runner.queue.push({ text: ev.text, display: ev.text, notify: true, identifier: ev.sessionId })
    this.syncQueue(runner)
    this.deps.store.setWorkflowStatus(runner.key, "running")
    this.track(this.drain(runner))
  }

  /**
   * Runners the last server stopped under (`store.reconcileInterruptedWorkflows` just marked them failed): their
   * registry entries are released, the runner's session says it was cut off, and the manager that was waiting for
   * a notification gets the error it would have got had the runner failed.
   */
  recoverInterrupted(sessions: LocalSession[]): void {
    for (const session of sessions) {
      const info = session.workflow
      if (!info) continue
      releaseRegistryEntry(session.folder, info.workflowId)
      try {
        this.deps.store.appendHistory(session.id, [
          {
            id: `msg_lw_${Date.now().toString(36)}_${info.workflowId.slice(-6)}`,
            role: "assistant",
            text: "_(interrupted: CodeNomad restarted while this workflow was running. Send it a prompt to continue.)_",
            createdAt: Date.now(),
            engine: "claude-code-rust",
            agent: "workflow_runner",
            isError: true,
          },
        ])
      } catch (error) {
        this.deps.warn?.("could not note the interruption in the runner's session", error)
      }
      // A manager that no longer exists has nobody to tell.
      const known = this.deps.store.getSession(info.managerSessionId) || this.deps.store.readHistory(info.managerSessionId).length > 0
      if (!known) continue
      const manager: Manager = { key: info.managerSessionId, folder: session.folder, agent: info.managerAgent, model: info.managerModel }
      const result: ExecuteResult = { stopped: false, isError: true, finalText: "CodeNomad restarted while it was working" }
      this.deliver(manager, notificationText({ identifier: info.taskPath || session.id, sessionId: session.id, result }))
      // Each prompt that was waiting behind it was promised a notification too: it is told it was not run.
      for (const text of info.queued ?? []) {
        const skipped: ExecuteResult = { stopped: false, isError: true, finalText: `it was queued behind a run that a CodeNomad restart cut off, and was not run: ${text.replace(/\s+/g, " ").slice(0, 200)}` }
        this.deliver(manager, notificationText({ identifier: session.id, sessionId: session.id, result: skipped }))
      }
      this.deps.store.setWorkflowQueue(session.id, [])
    }
  }

  /** A run for the session just ended: whatever was waiting for it can be delivered. */
  sessionIdle(sessionKey: string): void {
    this.pump(sessionKey)
  }

  /** The manager has a runner at work, or a notification not yet delivered: its page should keep looking. */
  watching(sessionKey: string): boolean {
    if ((this.inbound.get(sessionKey)?.length ?? 0) > 0 || this.delivering.has(sessionKey)) return true
    for (const runner of this.runners.values()) {
      if (runner.manager?.key === sessionKey && (runner.running || runner.queue.length > 0)) return true
    }
    return false
  }

  /**
   * Notifications the last server had not delivered (queued behind a busy manager, or cut off mid-turn) are
   * delivered now, oldest first. Call before `recoverInterrupted`, whose errors are newer.
   */
  restoreInbox(): void {
    const inbox = this.deps.store.readInbox()
    for (const [key, entry] of Object.entries(inbox)) {
      const known = this.deps.store.getSession(key) || this.deps.store.readHistory(key).length > 0
      if (!known || !Array.isArray(entry.messages) || entry.messages.length === 0 || !entry.manager) continue
      this.managers.set(key, entry.manager)
      this.inbound.set(key, entry.messages.filter((m) => typeof m === "string"))
    }
    this.persist()
    for (const key of this.inbound.keys()) this.pump(key)
  }

  /** A session was deleted: its queued work is dropped, and runners stop reporting to it. */
  forget(sessionKey: string): void {
    this.inbound.delete(sessionKey)
    this.parked.delete(sessionKey)
    this.inflight.delete(sessionKey)
    this.persist()
    const runner = this.runners.get(sessionKey)
    if (runner) {
      runner.queue.length = 0
      this.deps.store.setWorkflowQueue(runner.key, [])
      this.runners.delete(sessionKey)
    }
    for (const other of this.runners.values()) if (other.manager?.key === sessionKey) other.manager = undefined
  }

  /** Resolves when nothing is running in the background (tests). */
  async idle(): Promise<void> {
    while (this.work.size > 0) await Promise.allSettled([...this.work])
  }

  // ------------------------------------------------------------ internals

  private track<T>(promise: Promise<T>): void {
    this.work.add(promise)
    void promise.finally(() => this.work.delete(promise))
  }

  private runnerFor(sessionId: string, manager: Manager): Runner | undefined {
    const known = this.runners.get(sessionId)
    if (known) return known
    // Known from the store (the server restarted since): rebuild what a follow-up needs.
    const session = this.deps.store.getSession(sessionId)
    if (!session?.workflow) return undefined
    const runner: Runner = {
      key: session.id,
      workflowId: session.workflow.workflowId,
      folder: session.folder,
      taskPath: session.workflow.taskPath,
      manager,
      queue: [],
      running: false,
    }
    this.runners.set(runner.key, runner)
    return runner
  }

  /** Remembers the prompts waiting behind the current run, so a restart can say they were not run. */
  private syncQueue(runner: Runner): void {
    try {
      this.deps.store.setWorkflowQueue(runner.key, runner.queue.map((job) => job.text))
    } catch (error) {
      this.deps.warn?.("could not save the runner's queue", error)
    }
  }

  private async drain(runner: Runner): Promise<void> {
    if (runner.running) return
    runner.running = true
    try {
      while (runner.queue.length > 0) {
        const job = runner.queue.shift()!
        this.syncQueue(runner)
        this.deps.store.setWorkflowStatus(runner.key, "running")
        let result: ExecuteResult
        try {
          result = await this.deps.execute({
            sessionKey: runner.key,
            folder: runner.folder,
            prompt: job.text,
            displayText: job.display,
            agent: undefined,
            history: false,
            assistantAgent: "workflow_runner",
            env: {
              NOMAD_WORKFLOW_RUN: "1",
              NOMAD_WORKFLOW_SESSION: runner.workflowId,
              NOMAD_WORKFLOW_TASK_PATH: runner.taskPath,
            },
          })
        } catch (error) {
          result = { stopped: false, isError: true, finalText: error instanceof Error ? error.message : String(error) }
        }
        // Each prompt that promised a notification gets its own, with its own run's result, as soon as that run is over.
        const more = runner.queue.length > 0
        if (!more) {
          const status: WorkflowStatus = result.stopped ? "aborted" : result.isError ? "failed" : "idle"
          this.deps.store.setWorkflowStatus(runner.key, status)
          releaseRegistryEntry(runner.folder, runner.workflowId)
        }
        if (job.notify && runner.manager) {
          this.deliver(runner.manager, notificationText({ identifier: job.identifier, sessionId: runner.key, result }))
        }
      }
    } finally {
      runner.running = false
    }
  }

  private deliver(manager: Manager, text: string): void {
    const queue = this.inbound.get(manager.key) ?? []
    queue.push(text)
    this.inbound.set(manager.key, queue)
    this.managers.set(manager.key, manager)
    this.persist()
    this.pump(manager.key)
  }

  /** Writes what is owed to disk: a message leaves it only when its turn has been saved to the manager's history. */
  private persist(): void {
    const inbox: Record<string, InboxEntry> = {}
    const keys = new Set([...this.inbound.keys(), ...this.inflight.keys(), ...this.parked.keys()])
    for (const key of keys) {
      const manager = this.managers.get(key)
      const messages = [...(this.inflight.has(key) ? [this.inflight.get(key)!] : []), ...(this.inbound.get(key) ?? []), ...(this.parked.get(key) ?? [])]
      if (manager && messages.length > 0) inbox[key] = { manager, messages }
    }
    try {
      this.deps.store.writeInbox(inbox)
    } catch (error) {
      this.deps.warn?.("could not save the undelivered workflow notifications", error)
    }
  }

  private readonly managers = new Map<string, Manager>()

  private pump(managerKey: string): void {
    const queue = this.inbound.get(managerKey)
    const manager = this.managers.get(managerKey)
    if (!queue?.length || !manager || this.delivering.has(managerKey) || this.deps.isBusy(managerKey)) return
    const text = queue.shift()!
    if (queue.length === 0) this.inbound.delete(managerKey)
    this.delivering.add(managerKey)
    this.inflight.set(managerKey, text)
    this.persist()
    const run = this.deps
      .execute({
        sessionKey: manager.key,
        folder: manager.folder,
        prompt: text,
        displayText: text,
        agent: manager.agent,
        model: manager.model,
        history: true,
        env: {},
      })
      .then(
        () => undefined,
        (error) => {
          // It could not even be run: keep it for the next start rather than lose it or retry in a loop.
          this.deps.warn?.("could not deliver a workflow notification", error)
          this.parked.set(managerKey, [...(this.parked.get(managerKey) ?? []), text])
        },
      )
      .finally(() => {
        this.delivering.delete(managerKey)
        this.inflight.delete(managerKey)
        this.persist()
        this.pump(managerKey)
      })
    this.track(run)
  }
}
