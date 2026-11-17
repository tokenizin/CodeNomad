import { describe, expect, test } from "bun:test"
import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { RustStreamTranslator, toOpencodeTool, type WorkflowDoneEvent, type WorkflowPromptEvent, type WorkflowStartEvent } from "../rust-runner.js"
import { LocalEngineStore } from "../store.js"
import {
  notificationText,
  registryFile,
  releaseRegistryEntry,
  WorkflowSupervisor,
  type ExecuteJob,
  type ExecuteResult,
  type Manager,
} from "../workflows.js"

const line = (value: unknown) => JSON.stringify(value)

// ---------------------------------------------------------------- the agent's events

describe("the agent's workflow events", () => {
  const start = {
    type: "workflow.start",
    workflow_id: "wf_1",
    session_id: "ses_lcl_wf_1",
    title: "Workflow Run: TASK-9.md",
    task_path: "tasks/todo/TASK-9/TASK-9.md",
    track: "implementation",
    instructions: "run the lifecycle",
    prompt: "Task File: tasks/todo/TASK-9/TASK-9.md\n\nInstructions: run the lifecycle",
    call_id: "c1",
  }

  test("workflow.start becomes workflow_start with the ids and texts the supervisor needs", () => {
    const [event] = new RustStreamTranslator().feed(line(start))
    expect(event).toEqual({
      type: "workflow_start",
      workflowId: "wf_1",
      sessionId: "ses_lcl_wf_1",
      title: "Workflow Run: TASK-9.md",
      taskPath: "tasks/todo/TASK-9/TASK-9.md",
      track: "implementation",
      instructions: "run the lifecycle",
      prompt: "Task File: tasks/todo/TASK-9/TASK-9.md\n\nInstructions: run the lifecycle",
      callId: "c1",
    })
  })

  test("workflow.start without ids is ignored; the prompt falls back to the instructions", () => {
    const t = new RustStreamTranslator()
    expect(t.feed(line({ type: "workflow.start", title: "x" }))).toEqual([])
    const [event] = t.feed(line({ ...start, prompt: undefined }))
    expect(event).toMatchObject({ type: "workflow_start", prompt: "run the lifecycle" })
  })

  test("workflow.prompt and workflow.done", () => {
    const t = new RustStreamTranslator()
    expect(t.feed(line({ type: "workflow.prompt", workflow_id: "wf_1", session_id: "ses_lcl_wf_1", text: "fix it", active: true, call_id: "c2" }))).toEqual([
      { type: "workflow_prompt", workflowId: "wf_1", sessionId: "ses_lcl_wf_1", text: "fix it", active: true, callId: "c2" },
    ])
    expect(t.feed(line({ type: "workflow.prompt", session_id: "ses_lcl_wf_1", text: "  " }))).toEqual([])
    const [done] = t.feed(
      line({
        type: "workflow.done",
        workflow_id: "wf_1",
        session_id: "ses_lcl_wf_1",
        task_path: "t.md",
        status: "completed",
        handover: { outcome: "completed", path: "tasks/H.md", revision: 2, verification: "verified", open_issues: ["a"], markdown: "# H" },
      }),
    )
    expect(done).toEqual({
      type: "workflow_done",
      workflowId: "wf_1",
      sessionId: "ses_lcl_wf_1",
      taskPath: "t.md",
      status: "completed",
      handover: { outcome: "completed", path: "tasks/H.md", revision: 2, verification: "verified", openIssues: 1, markdown: "# H" },
    })
    const [failed] = t.feed(line({ type: "workflow.done", session_id: "s", status: "failed", error: "boom", handover: null }))
    expect(failed).toMatchObject({ type: "workflow_done", status: "failed", error: "boom" })
    expect((failed as WorkflowDoneEvent).handover).toBeUndefined()
  })

  test("in the background mode the nomadflow tools are plain tool cards; otherwise they open as a Task", () => {
    const input = { task_path: "tasks/todo/T/T.md", instructions: "go" }
    expect(toOpencodeTool("nomadflow_run_workflow", input, { asyncWorkflows: true })).toEqual({ tool: "nomadflow_run_workflow", input })
    expect(toOpencodeTool("nomadflow_prompt_workflow", { session_id: "s", text: "x" }, { asyncWorkflows: true }).tool).toBe("nomadflow_prompt_workflow")
    expect(toOpencodeTool("nomadflow_run_workflow", input).tool).toBe("task")
    const t = new RustStreamTranslator({ asyncWorkflows: true })
    const [card] = t.feed(line({ type: "tool", id: "c1", name: "nomadflow_run_workflow", input }))
    expect(card).toMatchObject({ type: "tool", name: "nomadflow_run_workflow" })
  })
})

// ---------------------------------------------------------------- the notification

describe("the notification the Product Manager receives", () => {
  const done = (over: Partial<WorkflowDoneEvent> = {}): WorkflowDoneEvent => ({
    type: "workflow_done",
    workflowId: "wf_1",
    sessionId: "ses_lcl_wf_1",
    taskPath: "t.md",
    status: "completed",
    handover: { outcome: "completed", path: "tasks/todo/T/HANDOVER.md", revision: 1, verification: "verified", openIssues: 0, markdown: "# Handover\n**Outcome: completed**\n" },
    ...over,
  })

  test("starts with NomadWorks' words, then the runner's summary, then the handover to evaluate", () => {
    const text = notificationText({ identifier: "tasks/todo/T/T.md", sessionId: "ses_lcl_wf_1", result: { stopped: false, isError: false, finalText: "Export delivered.", workflowDone: done() } })
    expect(text.startsWith("[NomadFlow Notification] Workflow Runner has finished work for: tasks/todo/T/T.md.\n\nFINAL SUMMARY FROM RUNNER:\nExport delivered.")).toBe(true)
    expect(text).toContain("HANDOVER FILED: tasks/todo/T/HANDOVER.md (revision 1, outcome completed, verification verified, 0 open issue(s)).")
    expect(text).toContain("send the workflow back with nomadflow_prompt_workflow (session_id: ses_lcl_wf_1)")
    expect(text).toContain("<handover>\n# Handover\n**Outcome: completed**\n</handover>")
  })

  test("without a handover it is exactly the plugin's message", () => {
    const text = notificationText({ identifier: "ses_lcl_wf_1", sessionId: "ses_lcl_wf_1", result: { stopped: false, isError: false, finalText: "Done.", workflowDone: done({ handover: undefined }) } })
    expect(text).toBe("[NomadFlow Notification] Workflow Runner has finished work for: ses_lcl_wf_1.\n\nFINAL SUMMARY FROM RUNNER:\nDone.")
  })

  test("a runner that failed, was stopped, or crashed is reported as an error that names how to continue", () => {
    const base = { identifier: "t.md", sessionId: "ses_lcl_wf_1" }
    const failed = notificationText({ ...base, result: { stopped: false, isError: true, finalText: "x", workflowDone: done({ status: "failed", error: "the workflow ended without filing a handover", handover: undefined }) } })
    expect(failed.startsWith("[NomadFlow Error] Workflow Runner failed for t.md: the workflow ended without filing a handover")).toBe(true)
    expect(failed).toContain("nomadflow_prompt_workflow")
    expect(notificationText({ ...base, result: { stopped: true, isError: false, finalText: "" } })).toContain("failed for t.md: it was stopped before it finished")
    expect(notificationText({ ...base, result: { stopped: false, isError: true, finalText: "endpoint down" } })).toContain("failed for t.md: endpoint down")
  })
})

// ---------------------------------------------------------------- the supervisor

function setup(behaviour?: (job: ExecuteJob) => Promise<ExecuteResult> | ExecuteResult) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-sup-"))
  const folder = path.join(dir, "work")
  fs.mkdirSync(folder, { recursive: true })
  const store = new LocalEngineStore(dir)
  const manager: Manager = { key: store.createSession({ folder, agent: "product_manager" }).id, folder, agent: "product_manager", model: "m1" }
  const jobs: ExecuteJob[] = []
  const busy = new Set<string>()
  const supervisor = new WorkflowSupervisor({
    store,
    isBusy: (key) => busy.has(key),
    execute: async (job) => {
      jobs.push(job)
      return (
        (await behaviour?.(job)) ?? {
          stopped: false,
          isError: false,
          finalText: job.history ? "manager reply" : "Runner summary.",
          workflowDone: job.history ? undefined : handoverDone(job.env.NOMAD_WORKFLOW_SESSION ?? ""),
        }
      )
    },
  })
  return { dir, folder, store, manager, supervisor, jobs, busy }
}

const handoverDone = (workflowId: string): WorkflowDoneEvent => ({
  type: "workflow_done",
  workflowId,
  sessionId: `ses_lcl_${workflowId}`,
  taskPath: "tasks/todo/T/T.md",
  status: "completed",
  handover: { outcome: "completed", path: "tasks/todo/T/HANDOVER.md", revision: 1, verification: "verified", openIssues: 0, markdown: "# H" },
})

const startEvent = (over: Partial<WorkflowStartEvent> = {}): WorkflowStartEvent => ({
  type: "workflow_start",
  workflowId: "wf_a1",
  sessionId: "ses_lcl_wf_a1",
  title: "Workflow Run: T.md",
  taskPath: "tasks/todo/T/T.md",
  track: "implementation",
  instructions: "run the lifecycle",
  prompt: "Task File: tasks/todo/T/T.md\n\nInstructions: run the lifecycle",
  callId: "c1",
  ...over,
})

const promptEvent = (over: Partial<WorkflowPromptEvent> = {}): WorkflowPromptEvent => ({
  type: "workflow_prompt",
  workflowId: "wf_a1",
  sessionId: "ses_lcl_wf_a1",
  text: "fix the header",
  active: false,
  callId: "c2",
  ...over,
})

describe("the workflow supervisor", () => {
  test("starting a workflow creates a session of its own and runs the runner in a process of its own", async () => {
    const { store, manager, supervisor, jobs } = setup()
    supervisor.start(manager, startEvent())
    await supervisor.idle()

    const session = store.getSession("ses_lcl_wf_a1")!
    expect(session).toMatchObject({ kind: "workflow", agent: "workflow_runner", title: "Workflow Run: T.md", folder: manager.folder })
    expect(session.parentId).toBeUndefined()
    expect(session.workflow).toMatchObject({ workflowId: "wf_a1", managerSessionId: manager.key, taskPath: "tasks/todo/T/T.md", track: "implementation", status: "idle" })
    // A top-level session: it shows in the ordinary list.
    expect(store.listSessions(manager.folder).map((s) => s.id)).toContain("ses_lcl_wf_a1")

    const runner = jobs[0]
    expect(runner).toMatchObject({
      sessionKey: "ses_lcl_wf_a1",
      prompt: "run the lifecycle",
      displayText: "Task File: tasks/todo/T/T.md\n\nInstructions: run the lifecycle",
      history: false,
      assistantAgent: "workflow_runner",
    })
    expect(runner.env).toEqual({ NOMAD_WORKFLOW_RUN: "1", NOMAD_WORKFLOW_SESSION: "wf_a1", NOMAD_WORKFLOW_TASK_PATH: "tasks/todo/T/T.md" })
  })

  test("when the runner is done the manager gets a notification turn, run like its own messages", async () => {
    const { manager, supervisor, jobs } = setup()
    supervisor.start(manager, startEvent())
    await supervisor.idle()

    expect(jobs).toHaveLength(2)
    const turn = jobs[1]
    expect(turn).toMatchObject({ sessionKey: manager.key, agent: "product_manager", model: "m1", history: true, env: {} })
    expect(turn.prompt).toBe(turn.displayText)
    expect(turn.prompt.startsWith("[NomadFlow Notification] Workflow Runner has finished work for: tasks/todo/T/T.md.\n\nFINAL SUMMARY FROM RUNNER:\nRunner summary.")).toBe(true)
    expect(turn.prompt).toContain("HANDOVER FILED: tasks/todo/T/HANDOVER.md")
  })

  test("the runner starts at once, while the manager is still working; the notification waits for the manager to be free", async () => {
    const { manager, supervisor, jobs, busy } = setup()
    busy.add(manager.key) // the manager's own turn is still running
    supervisor.start(manager, startEvent())
    await supervisor.idle()
    expect(jobs.map((j) => j.sessionKey)).toEqual(["ses_lcl_wf_a1"])
    expect(supervisor.watching(manager.key)).toBe(true)

    busy.delete(manager.key) // its turn ended
    supervisor.sessionIdle(manager.key)
    await supervisor.idle()
    expect(jobs.map((j) => j.sessionKey)).toEqual(["ses_lcl_wf_a1", manager.key])
    expect(supervisor.watching(manager.key)).toBe(false)
  })

  test("two notifications for one manager are delivered one after the other", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { manager, supervisor, jobs } = setup(async (job) => {
      if (job.history && jobs.filter((j) => j.history).length === 1) await gate // the first notification turn is long
      return undefined as unknown as ExecuteResult
    })
    supervisor.start(manager, startEvent())
    supervisor.start(manager, startEvent({ workflowId: "wf_b2", sessionId: "ses_lcl_wf_b2", taskPath: "tasks/todo/U/U.md", track: "spec" }))
    // Let both runners finish and the first notification turn begin.
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 5))
    expect(jobs.filter((j) => j.history)).toHaveLength(1)
    release()
    await supervisor.idle()
    const turns = jobs.filter((j) => j.history)
    expect(turns).toHaveLength(2)
    expect(turns[0].prompt).not.toBe(turns[1].prompt)
  })

  test("a prompt to a finished runner resumes the same session and owes a notification", async () => {
    const { store, manager, supervisor, jobs } = setup()
    supervisor.start(manager, startEvent())
    await supervisor.idle()
    jobs.length = 0

    supervisor.prompt(manager, promptEvent())
    await supervisor.idle()
    expect(jobs[0]).toMatchObject({ sessionKey: "ses_lcl_wf_a1", prompt: "fix the header", displayText: "fix the header", history: false })
    expect(jobs[0].env.NOMAD_WORKFLOW_SESSION).toBe("wf_a1")
    // The notification names the session, as the plugin does for a prompt (no task path to name).
    expect(jobs[1].sessionKey).toBe(manager.key)
    expect(jobs[1].prompt.startsWith("[NomadFlow Notification] Workflow Runner has finished work for: ses_lcl_wf_a1.")).toBe(true)
    expect(store.getSession("ses_lcl_wf_a1")?.workflow?.status).toBe("idle")
  })

  describe("prompts queued behind a working runner", () => {
    /** Runs the start job and holds it until released; every other run answers with its own prompt as its summary. */
    function working(extra?: (job: ExecuteJob) => ExecuteResult | undefined) {
      let release!: () => void
      const gate = new Promise<void>((resolve) => (release = resolve))
      const env = setup(async (job) => {
        if (job.history) return undefined as unknown as ExecuteResult
        if (job.prompt === "run the lifecycle") await gate
        return (extra?.(job) ?? { stopped: false, isError: false, finalText: `Summary of: ${job.prompt}` }) as ExecuteResult
      })
      return { ...env, release }
    }
    const notes = (jobs: ExecuteJob[]) => jobs.filter((j) => j.history).map((j) => j.prompt)

    test("each is run after the one before and each gets its own notification, with its own run's result", async () => {
      const { manager, supervisor, jobs, release, store } = working()
      supervisor.start(manager, startEvent())
      await new Promise((r) => setTimeout(r, 10))
      supervisor.prompt(manager, promptEvent({ active: true, text: "also check the CSV header" }))
      supervisor.prompt(manager, promptEvent({ active: true, text: "and the footer" }))
      expect(jobs.filter((j) => !j.history)).toHaveLength(1) // not run yet: the first run holds the session
      expect(store.getSession("ses_lcl_wf_a1")?.workflow?.queued).toEqual(["also check the CSV header", "and the footer"])

      release()
      await supervisor.idle()
      expect(jobs.filter((j) => !j.history).map((j) => j.prompt)).toEqual(["run the lifecycle", "also check the CSV header", "and the footer"])
      const sent = notes(jobs)
      expect(sent).toHaveLength(3)
      expect(sent[0].startsWith("[NomadFlow Notification] Workflow Runner has finished work for: tasks/todo/T/T.md.")).toBe(true)
      expect(sent[0]).toContain("Summary of: run the lifecycle")
      expect(sent[1].startsWith("[NomadFlow Notification] Workflow Runner has finished work for: ses_lcl_wf_a1.")).toBe(true)
      expect(sent[1]).toContain("Summary of: also check the CSV header")
      expect(sent[2]).toContain("Summary of: and the footer")
      expect(sent[1]).not.toContain("and the footer")
      // The queue is empty again, and the session is idle only once the last run is over.
      expect(store.getSession("ses_lcl_wf_a1")?.workflow).toMatchObject({ status: "idle" })
      expect(store.getSession("ses_lcl_wf_a1")?.workflow?.queued).toBeUndefined()
    })

    test("the runner is still working, and still holds the worktree, between its queued runs", async () => {
      const seen: Array<string | undefined> = []
      const held: string[] = []
      let file = ""
      const { folder, manager, supervisor, release, store } = working((job) => {
        seen.push(store.getSession("ses_lcl_wf_a1")?.workflow?.status)
        held.push(JSON.parse(fs.readFileSync(file, "utf8")).state)
        return undefined
      })
      file = registryFile(folder, "wf_a1")!
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ workflow_id: "wf_a1", task_path: "tasks/todo/T/T.md", track: "implementation", state: "running" }))
      supervisor.start(manager, startEvent())
      await new Promise((r) => setTimeout(r, 10))
      supervisor.prompt(manager, promptEvent({ active: true, text: "second" }))
      release()
      await supervisor.idle()
      expect(seen).toEqual(["running", "running"]) // during the first run, and during the queued one
      expect(held).toEqual(["running", "running"]) // no other implementation workflow could start in between
      expect(store.getSession("ses_lcl_wf_a1")?.workflow?.status).toBe("idle") // only after the last
      expect(JSON.parse(fs.readFileSync(file, "utf8")).state).toBe("idle")
    })

    test("a run that fails does not stop the ones behind it; its own notification says so", async () => {
      const { manager, supervisor, jobs, release } = working((job) => (job.prompt === "second" ? { stopped: false, isError: true, finalText: "endpoint down" } : undefined))
      supervisor.start(manager, startEvent())
      await new Promise((r) => setTimeout(r, 10))
      supervisor.prompt(manager, promptEvent({ active: true, text: "second" }))
      supervisor.prompt(manager, promptEvent({ active: true, text: "third" }))
      release()
      await supervisor.idle()
      const sent = notes(jobs)
      expect(sent).toHaveLength(3)
      expect(sent[0]).toContain("[NomadFlow Notification]")
      expect(sent[1]).toContain("[NomadFlow Error] Workflow Runner failed for ses_lcl_wf_a1: endpoint down")
      expect(sent[2]).toContain("Summary of: third")
    })

    test("a prompt sent to a runner that was idle is one run with one notification, as before", async () => {
      const { manager, supervisor, jobs, release } = working()
      supervisor.start(manager, startEvent())
      release()
      await supervisor.idle()
      jobs.length = 0
      supervisor.prompt(manager, promptEvent({ active: false, text: "again" }))
      await supervisor.idle()
      expect(notes(jobs)).toHaveLength(1)
    })

    test("deleting the runner's session drops its queue", async () => {
      const { manager, supervisor, jobs, release, store } = working()
      supervisor.start(manager, startEvent())
      await new Promise((r) => setTimeout(r, 10))
      supervisor.prompt(manager, promptEvent({ active: true, text: "second" }))
      supervisor.forget("ses_lcl_wf_a1")
      expect(store.getSession("ses_lcl_wf_a1")?.workflow?.queued).toBeUndefined()
      release()
      await supervisor.idle()
      expect(jobs.filter((j) => !j.history).map((j) => j.prompt)).toEqual(["run the lifecycle"])
    })
  })

  test("a stopped or failed runner is reported to the manager as an error, and the session says so", async () => {
    const stopped = setup(() => ({ stopped: true, isError: false, finalText: "" }))
    stopped.supervisor.start(stopped.manager, startEvent())
    await stopped.supervisor.idle()
    expect(stopped.store.getSession("ses_lcl_wf_a1")?.workflow?.status).toBe("aborted")
    expect(stopped.jobs[1].prompt).toContain("[NomadFlow Error] Workflow Runner failed for tasks/todo/T/T.md: it was stopped before it finished")

    const failed = setup(() => ({ stopped: false, isError: true, finalText: "endpoint down" }))
    failed.supervisor.start(failed.manager, startEvent())
    await failed.supervisor.idle()
    expect(failed.store.getSession("ses_lcl_wf_a1")?.workflow?.status).toBe("failed")
    expect(failed.jobs[1].prompt).toContain("failed for tasks/todo/T/T.md: endpoint down")

    const threw = setup(() => {
      throw new Error("spawn failed")
    })
    threw.supervisor.start(threw.manager, startEvent())
    await threw.supervisor.idle()
    expect(threw.jobs[1].prompt).toContain("failed for tasks/todo/T/T.md: spawn failed")
  })

  test("a prompt for a session nobody started tells the manager", async () => {
    const { manager, supervisor, jobs } = setup()
    supervisor.prompt(manager, promptEvent({ sessionId: "ses_lcl_wf_ghost" }))
    await supervisor.idle()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].prompt).toContain("[NomadFlow Error] Workflow Runner failed for ses_lcl_wf_ghost: no such workflow session.")
  })

  test("after a restart a follow-up still finds the session in the store", async () => {
    const first = setup()
    first.supervisor.start(first.manager, startEvent())
    await first.supervisor.idle()
    const jobs: ExecuteJob[] = []
    const second = new WorkflowSupervisor({
      store: new LocalEngineStore(first.dir),
      isBusy: () => false,
      execute: async (job) => {
        jobs.push(job)
        return { stopped: false, isError: false, finalText: "again", workflowDone: job.history ? undefined : handoverDone("wf_a1") }
      },
    })
    second.prompt(first.manager, promptEvent())
    await second.idle()
    expect(jobs[0]).toMatchObject({ sessionKey: "ses_lcl_wf_a1", prompt: "fix the header" })
    expect(jobs[0].env.NOMAD_WORKFLOW_TASK_PATH).toBe("tasks/todo/T/T.md")
  })

  test("deleting the manager drops what was waiting for it; deleting the runner drops its queue", async () => {
    const { manager, supervisor, jobs, busy } = setup()
    busy.add(manager.key)
    supervisor.start(manager, startEvent())
    await supervisor.idle()
    expect(supervisor.watching(manager.key)).toBe(true)
    supervisor.forget(manager.key)
    expect(supervisor.watching(manager.key)).toBe(false)
    busy.delete(manager.key)
    supervisor.sessionIdle(manager.key)
    await supervisor.idle()
    expect(jobs.filter((j) => j.history)).toHaveLength(0)
  })

  test("the worktree's registry entry is released when the runner is done", async () => {
    const { folder, manager, supervisor } = setup()
    const file = registryFile(folder, "wf_a1")!
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ workflow_id: "wf_a1", task_path: "t.md", track: "implementation", state: "running" }))
    supervisor.start(manager, startEvent())
    await supervisor.idle()
    expect(JSON.parse(fs.readFileSync(file, "utf8")).state).toBe("idle")
  })
})

describe("a server restart while a runner works", () => {
  /** A workflow session the previous server left running, as the store holds it. */
  function interrupted(env: ReturnType<typeof setup>, over: { managerKey?: string } = {}) {
    env.store.upsertWorkflowSession({
      sessionId: "ses_lcl_wf_a1",
      folder: env.folder,
      title: "Workflow Run: T.md",
      workflow: { workflowId: "wf_a1", managerSessionId: over.managerKey ?? env.manager.key, managerAgent: "product_manager", managerModel: "m1", taskPath: "tasks/todo/T/T.md", track: "implementation" },
    })
    const file = registryFile(env.folder, "wf_a1")!
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ workflow_id: "wf_a1", task_path: "tasks/todo/T/T.md", track: "implementation", state: "running" }))
    return file
  }

  test("the manager that was waiting is told, the runner's session says it was cut off, and the worktree is released", async () => {
    const env = setup()
    const file = interrupted(env)
    env.supervisor.recoverInterrupted(env.store.reconcileInterruptedWorkflows())
    await env.supervisor.idle()

    expect(env.jobs).toHaveLength(1)
    expect(env.jobs[0]).toMatchObject({ sessionKey: env.manager.key, agent: "product_manager", model: "m1", history: true })
    expect(env.jobs[0].prompt.startsWith("[NomadFlow Error] Workflow Runner failed for tasks/todo/T/T.md: CodeNomad restarted while it was working")).toBe(true)
    expect(env.jobs[0].prompt).toContain("nomadflow_prompt_workflow")
    expect(env.store.getSession("ses_lcl_wf_a1")?.workflow?.status).toBe("failed")
    expect(JSON.parse(fs.readFileSync(file, "utf8")).state).toBe("idle")
    const note = env.store.readHistory("ses_lcl_wf_a1").at(-1)!
    expect(note).toMatchObject({ role: "assistant", agent: "workflow_runner", isError: true })
    expect(note.text).toContain("CodeNomad restarted while this workflow was running")
  })

  test("each prompt that was queued behind the cut-off run is told it was not run", async () => {
    const env = setup()
    interrupted(env)
    env.store.setWorkflowQueue("ses_lcl_wf_a1", ["also check the CSV header", "and the\nfooter"])
    env.supervisor.recoverInterrupted(env.store.reconcileInterruptedWorkflows())
    await env.supervisor.idle()
    expect(env.jobs).toHaveLength(3)
    expect(env.jobs[0].prompt).toContain("failed for tasks/todo/T/T.md: CodeNomad restarted while it was working")
    expect(env.jobs[1].prompt).toContain("failed for ses_lcl_wf_a1: it was queued behind a run that a CodeNomad restart cut off, and was not run: also check the CSV header")
    expect(env.jobs[2].prompt).toContain("was not run: and the footer")
    expect(env.store.getSession("ses_lcl_wf_a1")?.workflow?.queued).toBeUndefined()
  })

  test("it is told once: the next start finds nothing left to recover", async () => {
    const env = setup()
    interrupted(env)
    env.supervisor.recoverInterrupted(env.store.reconcileInterruptedWorkflows())
    await env.supervisor.idle()
    env.supervisor.recoverInterrupted(env.store.reconcileInterruptedWorkflows())
    await env.supervisor.idle()
    expect(env.jobs).toHaveLength(1)
  })

  test("a manager that no longer exists is not told", async () => {
    const env = setup()
    interrupted(env, { managerKey: "ses_lcl_gone" })
    env.supervisor.recoverInterrupted(env.store.reconcileInterruptedWorkflows())
    await env.supervisor.idle()
    expect(env.jobs).toHaveLength(0)
  })

  test("a manager that is an OpenCode session (only its history is here) is told", async () => {
    const env = setup()
    env.store.appendHistory("ses_opencode_1", [{ id: "m1", role: "user", text: "hi", createdAt: 1 }])
    interrupted(env, { managerKey: "ses_opencode_1" })
    env.supervisor.recoverInterrupted(env.store.reconcileInterruptedWorkflows())
    await env.supervisor.idle()
    expect(env.jobs[0].sessionKey).toBe("ses_opencode_1")
  })

  test("two runners of one manager are reported one after the other; a busy manager is told when it is free", async () => {
    const env = setup()
    interrupted(env)
    env.store.upsertWorkflowSession({
      sessionId: "ses_lcl_wf_b2",
      folder: env.folder,
      title: "Workflow Run: U.md",
      workflow: { workflowId: "wf_b2", managerSessionId: env.manager.key, taskPath: "tasks/todo/U/U.md", track: "spec" },
    })
    env.busy.add(env.manager.key)
    env.supervisor.recoverInterrupted(env.store.reconcileInterruptedWorkflows())
    await env.supervisor.idle()
    expect(env.jobs).toHaveLength(0)
    env.busy.delete(env.manager.key)
    env.supervisor.sessionIdle(env.manager.key)
    await env.supervisor.idle()
    expect(env.jobs.map((j) => j.prompt.match(/failed for (\S+):/)?.[1]).sort()).toEqual(["tasks/todo/T/T.md", "tasks/todo/U/U.md"])
  })

  test("the interrupted runner can be sent a prompt afterwards: its session resumes", async () => {
    const env = setup()
    interrupted(env)
    env.supervisor.recoverInterrupted(env.store.reconcileInterruptedWorkflows())
    await env.supervisor.idle()
    env.jobs.length = 0
    env.supervisor.prompt(env.manager, promptEvent({ text: "carry on" }))
    await env.supervisor.idle()
    expect(env.jobs[0]).toMatchObject({ sessionKey: "ses_lcl_wf_a1", prompt: "carry on" })
    expect(env.jobs[0].env.NOMAD_WORKFLOW_TASK_PATH).toBe("tasks/todo/T/T.md")
  })
})

describe("notifications that survive a restart", () => {
  /** A second server on the same data folder. */
  function nextServer(env: ReturnType<typeof setup>, execute?: (job: ExecuteJob) => Promise<ExecuteResult>) {
    const jobs: ExecuteJob[] = []
    const store = new LocalEngineStore(env.dir)
    const supervisor = new WorkflowSupervisor({
      store,
      isBusy: () => false,
      execute:
        execute ??
        (async (job) => {
          jobs.push(job)
          return { stopped: false, isError: false, finalText: "manager reply" }
        }),
    })
    return { supervisor, jobs, store }
  }
  const inboxOf = (env: ReturnType<typeof setup>) => new LocalEngineStore(env.dir).readInbox()

  test("a notification waiting for a busy manager is on disk, and delivered by the next server", async () => {
    const env = setup()
    env.busy.add(env.manager.key)
    env.supervisor.start(env.manager, startEvent())
    await env.supervisor.idle()
    const waiting = inboxOf(env)[env.manager.key]
    expect(waiting.manager).toMatchObject({ key: env.manager.key, agent: "product_manager", model: "m1" })
    expect(waiting.messages).toHaveLength(1)
    expect(waiting.messages[0].startsWith("[NomadFlow Notification] Workflow Runner has finished work for: tasks/todo/T/T.md.")).toBe(true)

    // The server stops here. The next one delivers it, once, and the inbox is empty after.
    const next = nextServer(env)
    next.supervisor.restoreInbox()
    await next.supervisor.idle()
    expect(next.jobs).toHaveLength(1)
    expect(next.jobs[0]).toMatchObject({ sessionKey: env.manager.key, prompt: waiting.messages[0], agent: "product_manager", model: "m1", history: true })
    expect(inboxOf(env)).toEqual({})
    const again = nextServer(env)
    again.supervisor.restoreInbox()
    await again.supervisor.idle()
    expect(again.jobs).toHaveLength(0)
  })

  test("a notification whose turn was cut off by the stop is delivered again; one whose turn was saved is not", async () => {
    const env = setup(async (job) => {
      if (job.history) return new Promise<ExecuteResult>(() => {}) // the manager's turn never finishes: the server dies in it
      return undefined as unknown as ExecuteResult
    })
    env.supervisor.start(env.manager, startEvent())
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 5))
    expect(env.jobs.filter((j) => j.history)).toHaveLength(1)
    expect(inboxOf(env)[env.manager.key].messages).toHaveLength(1) // still owed: its turn was not saved

    const next = nextServer(env)
    next.supervisor.restoreInbox()
    await next.supervisor.idle()
    expect(next.jobs).toHaveLength(1)
    expect(next.jobs[0].prompt.startsWith("[NomadFlow Notification]")).toBe(true)
    expect(inboxOf(env)).toEqual({}) // now its turn was saved
  })

  test("several are delivered in the order they were owed, and before what the restart itself reports", async () => {
    const env = setup()
    env.busy.add(env.manager.key)
    env.supervisor.start(env.manager, startEvent())
    env.supervisor.start(env.manager, startEvent({ workflowId: "wf_b2", sessionId: "ses_lcl_wf_b2", taskPath: "tasks/todo/U/U.md", track: "spec" }))
    await env.supervisor.idle()
    expect(inboxOf(env)[env.manager.key].messages).toHaveLength(2)
    // A third runner was cut off by the same stop.
    env.store.upsertWorkflowSession({
      sessionId: "ses_lcl_wf_c3",
      folder: env.folder,
      title: "Workflow Run: V.md",
      workflow: { workflowId: "wf_c3", managerSessionId: env.manager.key, taskPath: "tasks/todo/V/V.md", track: "spec" },
    })

    const next = nextServer(env)
    next.supervisor.restoreInbox()
    next.supervisor.recoverInterrupted(next.store.reconcileInterruptedWorkflows())
    await next.supervisor.idle()
    const told = next.jobs.map((j) => /for: (\S+\.md)\.|failed for (\S+):/.exec(j.prompt)?.slice(1).find(Boolean))
    expect(told.slice(2)).toEqual(["tasks/todo/V/V.md"])
    expect(told.slice(0, 2).sort()).toEqual(["tasks/todo/T/T.md", "tasks/todo/U/U.md"])
    expect(inboxOf(env)).toEqual({})
  })

  test("a notification that could not be run is kept for the next start, not retried in a loop", async () => {
    // It fails the first three times it is tried (a retry loop would try it again at once, and a fourth time would succeed).
    const env = setup(async (job) => {
      if (job.history && env.jobs.filter((j) => j.history).length <= 3) throw new Error("Claude Code (Rust) not found")
      return undefined as unknown as ExecuteResult
    })
    env.supervisor.start(env.manager, startEvent())
    await env.supervisor.idle()
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 5))
    expect(env.jobs.filter((j) => j.history)).toHaveLength(1)
    expect(inboxOf(env)[env.manager.key].messages).toHaveLength(1)
    const next = nextServer(env)
    next.supervisor.restoreInbox()
    await next.supervisor.idle()
    expect(next.jobs).toHaveLength(1)
  })

  test("what was owed to a deleted or unknown session is dropped; an unreadable inbox is ignored", async () => {
    const env = setup()
    env.busy.add(env.manager.key)
    env.supervisor.start(env.manager, startEvent())
    await env.supervisor.idle()
    env.supervisor.forget(env.manager.key)
    expect(inboxOf(env)).toEqual({})

    // An entry for a session that is not here.
    env.store.writeInbox({ ses_lcl_gone: { manager: { key: "ses_lcl_gone", folder: env.folder }, messages: ["[NomadFlow Notification] x"] } })
    const next = nextServer(env)
    next.supervisor.restoreInbox()
    await next.supervisor.idle()
    expect(next.jobs).toHaveLength(0)
    expect(inboxOf(env)).toEqual({})

    fs.mkdirSync(path.join(env.dir, "local-engine"), { recursive: true })
    fs.writeFileSync(path.join(env.dir, "local-engine", "workflow-inbox.json"), "{not json")
    const third = nextServer(env)
    third.supervisor.restoreInbox()
    await third.supervisor.idle()
    expect(third.jobs).toHaveLength(0)
  })

  test("a notification delivered normally leaves nothing behind", async () => {
    const env = setup()
    env.supervisor.start(env.manager, startEvent())
    await env.supervisor.idle()
    expect(env.jobs.filter((j) => j.history)).toHaveLength(1)
    expect(inboxOf(env)).toEqual({})
    expect(fs.existsSync(path.join(env.dir, "local-engine", "workflow-inbox.json"))).toBe(false)
  })
})

describe("the registry shared with the agent", () => {
  test("only safe ids map to a file, and releasing is harmless when there is nothing to release", () => {
    expect(registryFile("/w", "../x")).toBeNull()
    expect(registryFile("/w", "wf_ok")).toBe("/w/.codenomad/runtime/workflows/wf_ok.json")
    releaseRegistryEntry("/does/not/exist", "wf_ok")
    releaseRegistryEntry("/w", "../x")
  })
})

describe("workflow sessions in the store", () => {
  test("a runner that was working when the server stopped is marked failed, once", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-store-"))
    const store = new LocalEngineStore(dir)
    const workflow = { workflowId: "wf_x", managerSessionId: "m", taskPath: "t.md", track: "implementation" }
    store.upsertWorkflowSession({ sessionId: "ses_lcl_wf_x", folder: "/w", title: "Workflow Run: t.md", workflow })
    store.upsertWorkflowSession({ sessionId: "ses_lcl_wf_y", folder: "/w", title: "y", workflow: { ...workflow, workflowId: "wf_y" } })
    store.setWorkflowStatus("ses_lcl_wf_y", "idle")
    const changed = store.reconcileInterruptedWorkflows()
    expect(changed.map((s) => s.id)).toEqual(["ses_lcl_wf_x"])
    expect(store.getSession("ses_lcl_wf_x")?.workflow?.status).toBe("failed")
    expect(store.getSession("ses_lcl_wf_y")?.workflow?.status).toBe("idle")
    expect(store.reconcileInterruptedWorkflows()).toEqual([])
    expect(new LocalEngineStore(dir).getSession("ses_lcl_wf_x")?.workflow?.status).toBe("failed")
  })

  test("a workflow session is not a child of its manager: deleting the manager leaves it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-store-"))
    const store = new LocalEngineStore(dir)
    const manager = store.createSession({ folder: "/w" })
    store.upsertWorkflowSession({
      sessionId: "ses_lcl_wf_z",
      folder: "/w",
      title: "z",
      workflow: { workflowId: "wf_z", managerSessionId: manager.id, taskPath: "t.md", track: "spec" },
    })
    store.deleteSession(manager.id)
    expect(store.getSession("ses_lcl_wf_z")).toBeDefined()
  })

  test("an unsafe session id is refused", () => {
    const store = new LocalEngineStore(fs.mkdtempSync(path.join(os.tmpdir(), "wf-store-")))
    expect(() => store.upsertWorkflowSession({ sessionId: "../evil", folder: "/w", title: "x", workflow: { workflowId: "w", managerSessionId: "m", taskPath: "t", track: "spec" } })).toThrow()
  })
})

describe("scopes of a scope contract", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-C", cwd, ...args], { stdio: "pipe" })

  /** `setup()`, with the manager's folder made a git repository that has one worktree per name given. */
  function withWorktrees(names: string[], behaviour?: Parameters<typeof setup>[0]) {
    const env = setup(behaviour)
    git(env.folder, "init", "-q")
    fs.writeFileSync(path.join(env.folder, "README.md"), "# work\n")
    git(env.folder, "add", ".")
    git(env.folder, "commit", "-q", "-m", "init")
    const workspaces: Record<string, string> = {}
    for (const name of names) {
      const target = path.join(env.dir, `ws-${name}`)
      git(env.folder, "worktree", "add", "-q", target, "-b", name)
      workspaces[name] = fs.realpathSync(target)
    }
    return { ...env, folder: fs.realpathSync(env.folder), workspaces }
  }

  const scopeEvent = (id: string, workspace: string | undefined, over: Partial<WorkflowStartEvent> = {}) =>
    startEvent({ workflowId: `wf_${id}`, sessionId: `ses_lcl_wf_${id}`, ...(workspace ? { workspace } : {}), scopeId: id, contract: "TASK-P", ...over })

  test("the workspace, scope and contract reach the supervisor from the agent's event", () => {
    const [event] = new RustStreamTranslator().feed(
      JSON.stringify({ type: "workflow.start", workflow_id: "wf_1", session_id: "ses_lcl_wf_1", task_path: "t.md", track: "implementation", instructions: "go", workspace: "/w/api", scope_id: "api", contract: "TASK-P", call_id: "c" }),
    )
    expect(event).toMatchObject({ type: "workflow_start", workspace: "/w/api", scopeId: "api", contract: "TASK-P" })
    const [plain] = new RustStreamTranslator().feed(JSON.stringify({ type: "workflow.start", workflow_id: "wf_1", session_id: "ses_lcl_wf_1", task_path: "t.md", track: "implementation", instructions: "go", workspace: "", call_id: "c" }))
    expect(plain).not.toHaveProperty("workspace")
    expect(plain).not.toHaveProperty("scopeId")
  })

  test("the runner runs in the scope's workspace and is told where the manager's registry is; its session stays with the manager", async () => {
    const { folder, workspaces, manager, supervisor, jobs, store } = withWorktrees(["api"])
    supervisor.start(manager, scopeEvent("api", workspaces.api))
    await supervisor.idle()
    const run = jobs.find((j) => !j.history)!
    expect(run.folder).toBe(folder)
    expect(run.workspace).toBe(workspaces.api)
    expect(run.env.NOMAD_WORKFLOW_REGISTRY).toBe(folder)
    expect(run.env.NOMAD_WORKFLOW_SESSION).toBe("wf_api")
    expect(store.getSession("ses_lcl_wf_api")).toMatchObject({ folder, workflow: { workspace: workspaces.api, scopeId: "api", contract: "TASK-P", status: "idle" } })
  })

  test("a workflow that is not a scope runs exactly as before: no workspace, no registry variable", async () => {
    const { folder, manager, supervisor, jobs } = setup()
    supervisor.start(manager, startEvent())
    await supervisor.idle()
    const run = jobs.find((j) => !j.history)!
    expect(run.folder).toBe(folder)
    expect(run).not.toHaveProperty("workspace")
    expect(run.env).not.toHaveProperty("NOMAD_WORKFLOW_REGISTRY")
  })

  test("the registry entry is released in the manager's worktree, and nothing is written in the workspace", async () => {
    const { folder, workspaces, manager, supervisor } = withWorktrees(["api"])
    const file = registryFile(folder, "wf_api")!
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ workflow_id: "wf_api", task_path: "t.md", track: "implementation", state: "running" }))
    supervisor.start(manager, scopeEvent("api", workspaces.api))
    await supervisor.idle()
    expect(JSON.parse(fs.readFileSync(file, "utf8")).state).toBe("idle")
    expect(fs.existsSync(path.join(workspaces.api, ".codenomad"))).toBe(false)
  })

  test("two implementation scopes in their own workspaces work at the same time, each in its own folder", async () => {
    let inside = 0
    let most = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { workspaces, manager, supervisor, jobs } = withWorktrees(["api", "ui"], async (job) => {
      if (job.history) return undefined as unknown as ExecuteResult
      inside += 1
      most = Math.max(most, inside)
      await gate
      inside -= 1
      return { stopped: false, isError: false, finalText: `done in ${job.workspace}` }
    })
    supervisor.start(manager, scopeEvent("api", workspaces.api))
    supervisor.start(manager, scopeEvent("ui", workspaces.ui))
    await new Promise((r) => setTimeout(r, 30))
    const running = jobs.filter((j) => !j.history)
    expect(running.map((j) => j.workspace).sort()).toEqual([workspaces.api, workspaces.ui].sort()) // both started before either finished
    expect(most).toBe(2)
    release()
    await supervisor.idle()
    const told = jobs.filter((j) => j.history).map((j) => j.prompt)
    expect(told).toHaveLength(2)
    expect(told.some((t) => t.includes(`done in ${workspaces.api}`)) && told.some((t) => t.includes(`done in ${workspaces.ui}`))).toBe(true)
  })

  test("a workspace that cannot be used is never run in: the manager is told why, the session fails, the registry is released", async () => {
    const stranger = fs.mkdtempSync(path.join(os.tmpdir(), "wf-stranger-"))
    const cases: Array<[string, (w: Record<string, string>) => string, string]> = [
      ["relative", () => "relative/dir", "it is not an absolute path"],
      ["missing", () => path.join(os.tmpdir(), "wf-no-such-folder"), "it does not exist"],
      ["manager", (w) => w.__folder, "it is the manager's own worktree"],
      ["stranger", () => stranger, "it is not a git worktree of"],
    ]
    for (const [name, pick, why] of cases) {
      const env = withWorktrees([])
      const file = registryFile(env.folder, `wf_${name}`)!
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ workflow_id: `wf_${name}`, task_path: "t.md", track: "implementation", state: "running" }))
      env.supervisor.start(env.manager, scopeEvent(name, pick({ __folder: env.folder })))
      await env.supervisor.idle()
      expect(env.jobs.filter((j) => !j.history)).toHaveLength(0) // the runner was never started
      const note = env.jobs.filter((j) => j.history).map((j) => j.prompt)
      expect(note).toHaveLength(1)
      expect(note[0].startsWith("[NomadFlow Error] Workflow Runner failed for tasks/todo/T/T.md: its workspace")).toBe(true)
      expect(note[0]).toContain(why)
      expect(env.store.getSession(`ses_lcl_wf_${name}`)?.workflow?.status).toBe("failed")
      expect(JSON.parse(fs.readFileSync(file, "utf8")).state).toBe("idle")
    }
    fs.rmSync(stranger, { recursive: true, force: true })
  })

  test("a workspace that has gone by the time a follow-up comes is not run in", async () => {
    const { folder, workspaces, manager, supervisor, jobs } = withWorktrees(["api"])
    supervisor.start(manager, scopeEvent("api", workspaces.api))
    await supervisor.idle()
    git(folder, "worktree", "remove", "--force", workspaces.api)
    const before = jobs.filter((j) => !j.history).length
    supervisor.prompt(manager, promptEvent({ workflowId: "wf_api", sessionId: "ses_lcl_wf_api", text: "fix the header" }))
    await supervisor.idle()
    expect(jobs.filter((j) => !j.history)).toHaveLength(before)
    const last = jobs.filter((j) => j.history).at(-1)!.prompt
    expect(last).toContain("[NomadFlow Error]")
    expect(last).toContain(`its workspace ${workspaces.api} cannot be used: it does not exist`)
  })

  test("after a server restart a follow-up still runs in the scope's workspace", async () => {
    const env = withWorktrees(["api"])
    env.supervisor.start(env.manager, scopeEvent("api", env.workspaces.api))
    await env.supervisor.idle()

    // A new server: a new supervisor over the same store.
    const jobs: ExecuteJob[] = []
    const restarted = new WorkflowSupervisor({
      store: env.store,
      isBusy: () => false,
      execute: async (job) => {
        jobs.push(job)
        return { stopped: false, isError: false, finalText: "ok" }
      },
    })
    restarted.prompt(env.manager, promptEvent({ workflowId: "wf_api", sessionId: "ses_lcl_wf_api", text: "second round" }))
    await restarted.idle()
    const run = jobs.find((j) => !j.history)!
    expect(run.workspace).toBe(env.workspaces.api)
    expect(run.env.NOMAD_WORKFLOW_REGISTRY).toBe(env.folder)
  })

  // ------------------------------------------------------------ the acceptance check and restart recovery of scopes

  /** The contract's normalized copy, as `bun run scope:check` writes it (shape: the standard §4.1). */
  const installCopy = (folder: string, scopes: Array<{ id: string; track?: string; workspace: string; paths: string[]; taskPath?: string }>) => {
    const dir = path.join(folder, ".codenomad", "runtime", "scope-contracts")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, "TASK-P.json"),
      JSON.stringify({
        scope_contract_version: 1,
        parent_task: "TASK-P",
        source: "tasks/todo/TASK-P/TASK-P.md",
        limits: { max_concurrency: 2 },
        scopes: scopes.map((s) => ({ scope_id: s.id, track: s.track ?? "implementation", task_path: s.taskPath ?? `tasks/todo/TASK-P/${s.id}/TASK-P-${s.id}.md`, workspace: s.workspace, spawn_depth: 0, paths: s.paths, lease_id: `lease-${s.id}` })),
      }),
    )
  }

  /** Writes files into a workspace (relative paths), making folders as needed. */
  const writeIn = (workspace: string, files: Record<string, string>) => {
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(workspace, name)), { recursive: true })
      fs.writeFileSync(path.join(workspace, name), text)
    }
  }

  /** `withWorktrees(["api"])` whose scope runner does `act(workspace)` when it runs. */
  function scopeRun(act: (workspace: string, job: ExecuteJob) => void | Promise<void>, over: { paths?: string[]; copy?: boolean } = {}) {
    const env = withWorktrees(["api"], async (job) => {
      if (job.history) return undefined as unknown as ExecuteResult
      await act(job.workspace!, job)
      return { stopped: false, isError: false, finalText: "scope done", workflowDone: handoverDone(job.env.NOMAD_WORKFLOW_SESSION ?? "") }
    })
    if (over.copy !== false) installCopy(env.folder, [{ id: "api", workspace: env.workspaces.api, paths: over.paths ?? ["src/api/**"] }])
    return env
  }
  const startApi = (env: ReturnType<typeof withWorktrees>) => env.supervisor.start(env.manager, scopeEvent("api", env.workspaces.api, { taskPath: "tasks/todo/TASK-P/api/TASK-P-api.md" }))
  const told = (env: ReturnType<typeof withWorktrees>) => env.jobs.filter((j) => j.history).map((j) => j.prompt)

  test("a scope that kept to its lease adds nothing to the notification", async () => {
    const env = scopeRun((ws) => writeIn(ws, { "src/api/orders.ts": "x", "src/api/deep/more.ts": "y" }))
    startApi(env)
    await env.supervisor.idle()
    const [note] = told(env)
    expect(note.startsWith("[NomadFlow Notification] Workflow Runner has finished work for:")).toBe(true)
    expect(note).not.toContain("SCOPE CHECK")
  })

  test("a scope that changed files outside its lease is reported, with the files, in the notification the manager evaluates from", async () => {
    const env = scopeRun((ws) => {
      writeIn(ws, { "src/api/ok.ts": "ok", "src/ui/stray.ts": "stray", "NEW-ROOT-FILE.md": "x" })
      fs.writeFileSync(path.join(ws, "README.md"), "# changed\n") // a tracked file
    })
    startApi(env)
    await env.supervisor.idle()
    const [note] = told(env)
    expect(note).toContain("SCOPE CHECK (scope `api` of contract TASK-P): 3 file(s) changed in")
    expect(note).toContain("outside its lease (src/api/**):")
    expect(note).toContain("  - NEW-ROOT-FILE.md\n  - README.md\n  - src/ui/stray.ts")
    expect(note).not.toContain("src/api/ok.ts")
    // It comes before the handover, which is what the manager reads next.
    expect(note.indexOf("SCOPE CHECK")).toBeLessThan(note.indexOf("HANDOVER FILED"))
  })

  test("commits and deletions since the start count, a file added to .gitignore does not, and the task file and the filed handover are always allowed", async () => {
    const env = scopeRun((ws) => {
      fs.writeFileSync(path.join(ws, ".gitignore"), "ignored.log\n")
      writeIn(ws, { "ignored.log": "x", "src/api/a.ts": "a", "tasks/todo/TASK-P/api/TASK-P-api.md": "updated", "tasks/todo/T/HANDOVER.md": "# handover" })
      git(ws, "add", "src/api/a.ts")
      git(ws, "commit", "-q", "-m", "work") // committed, not just changed
      fs.rmSync(path.join(ws, "README.md")) // deleted, tracked
    })
    startApi(env)
    await env.supervisor.idle()
    const [note] = told(env)
    // .gitignore itself is new and outside the lease; ignored.log is ignored; src/api/a.ts is inside; README.md was deleted; the task file and handover are allowed.
    expect(note).toContain("2 file(s) changed in")
    expect(note).toContain("  - .gitignore\n  - README.md")
    expect(note).not.toContain("ignored.log")
    expect(note).not.toContain("HANDOVER.md\n")
  })

  test("a follow-up is compared with the commit the scope started from, which is recorded once and survives a restart", async () => {
    let round = 0
    const env = scopeRun((ws) => {
      round += 1
      writeIn(ws, { "src/api/a.ts": "a", "docs/first-stray.md": "stray" })
      git(ws, "add", ".")
      git(ws, "commit", "-q", "-m", "first round") // committed, so a check that only looked at uncommitted changes would miss it
    })
    startApi(env)
    await env.supervisor.idle()
    const base = env.store.getSession("ses_lcl_wf_api")?.workflow?.baseRef
    expect(base).toMatch(/^[0-9a-f]{40}$/)
    expect(told(env)[0]).toContain("SCOPE CHECK (scope `api` of contract TASK-P): 1 file(s)")
    expect(told(env)[0]).toContain("  - docs/first-stray.md")

    // A new server. Round two adds another stray file; the first one is still outside the lease, so it is still reported.
    const restarted = new WorkflowSupervisor({
      store: env.store,
      isBusy: () => false,
      execute: async (job) => {
        env.jobs.push(job)
        if (job.history) return { stopped: false, isError: false, finalText: "ok" }
        writeIn(job.workspace!, { "docs/second-stray.md": "stray" })
        return { stopped: false, isError: false, finalText: "round two" }
      },
    })
    restarted.prompt(env.manager, promptEvent({ workflowId: "wf_api", sessionId: "ses_lcl_wf_api", text: "round two" }))
    await restarted.idle()
    const second = told(env).at(-1)!
    expect(second).toContain("SCOPE CHECK (scope `api` of contract TASK-P): 2 file(s)")
    expect(second).toContain("  - docs/first-stray.md\n  - docs/second-stray.md")
    expect(second).not.toContain("src/api/a.ts")
    expect(env.store.getSession("ses_lcl_wf_api")?.workflow?.baseRef).toBe(base) // not moved by the second round
    expect(round).toBe(1)
  })

  test("when the check cannot be made, the notification says so instead of staying silent", async () => {
    const noCopy = scopeRun(() => undefined, { copy: false })
    startApi(noCopy)
    await noCopy.supervisor.idle()
    expect(told(noCopy)[0]).toContain("SCOPE CHECK (scope `api` of contract TASK-P): could not be made: the contract's normalized copy (")
    expect(told(noCopy)[0]).toContain("bun run scope:check")

    const noScope = scopeRun(() => undefined)
    installCopy(noScope.folder, [{ id: "other", workspace: noScope.workspaces.api, paths: ["x/**"] }])
    startApi(noScope)
    await noScope.supervisor.idle()
    expect(told(noScope)[0]).toContain("scope `api` is not in the contract's normalized copy")
  })

  test("a scope in the manager's shared worktree is said not to be checkable if it implements, and is left alone otherwise", async () => {
    for (const track of ["implementation", "spec"]) {
      const env = setup()
      installCopy(env.folder, [{ id: "api", track, workspace: "shared", paths: ["src/api/**"] }])
      env.supervisor.start(env.manager, startEvent({ workflowId: "wf_api", sessionId: "ses_lcl_wf_api", scopeId: "api", contract: "TASK-P" }))
      await env.supervisor.idle()
      const [note] = env.jobs.filter((j) => j.history).map((j) => j.prompt)
      if (track === "implementation") expect(note).toContain("SCOPE CHECK (scope `api` of contract TASK-P): not made: the scope works in the manager's shared worktree")
      else expect(note).not.toContain("SCOPE CHECK")
    }
  })

  test("a run that failed still reports what it changed outside its lease", async () => {
    const env = withWorktrees(["api"], async (job) => {
      if (job.history) return undefined as unknown as ExecuteResult
      writeIn(job.workspace!, { "src/ui/stray.ts": "x" })
      return { stopped: false, isError: true, finalText: "the build failed" }
    })
    installCopy(env.folder, [{ id: "api", workspace: env.workspaces.api, paths: ["src/api/**"] }])
    startApi(env)
    await env.supervisor.idle()
    const [note] = told(env)
    expect(note.startsWith("[NomadFlow Error] Workflow Runner failed for")).toBe(true)
    expect(note).toContain("SCOPE CHECK (scope `api` of contract TASK-P): 1 file(s)")
  })

  describe("after the runner's process is over, nothing it started is left holding the worktree", () => {
    const writeEntry = (folder: string, id: string, extra: Record<string, unknown> = {}) => {
      const file = registryFile(folder, id)!
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ workflow_id: id, task_path: "t.md", track: "implementation", state: "running", ...extra }))
      return file
    }
    const state = (file: string) => JSON.parse(fs.readFileSync(file, "utf8")).state

    test("a run that ends releases the runner's entry and every workflow under it, and only those", async () => {
      const env = withWorktrees(["api"])
      const own = writeEntry(env.folder, "wf_api", { workspace: env.workspaces.api, contract: "TASK-P", scope_id: "api" })
      const child = writeEntry(env.folder, "wf_child", { parent: "wf_api", pid: 99999999 })
      const grandchild = writeEntry(env.folder, "wf_grandchild", { parent: "wf_child" })
      const other = writeEntry(env.folder, "wf_other") // another workflow of the manager's, not under it
      installCopy(env.folder, [{ id: "api", workspace: env.workspaces.api, paths: ["src/api/**"] }])
      startApi(env)
      await env.supervisor.idle()
      expect([state(own), state(child), state(grandchild)]).toEqual(["idle", "idle", "idle"])
      expect(state(other)).toBe("running")
    })

    test("a restart releases each interrupted scope's entry, and what it started, in the manager's registry, and tells the manager once per scope", async () => {
      const env = withWorktrees(["api", "ui"])
      const files: Record<string, string> = {}
      for (const id of ["api", "ui"]) {
        env.store.upsertWorkflowSession({
          sessionId: `ses_lcl_wf_${id}`,
          folder: env.folder,
          title: `Workflow Run: ${id}`,
          workflow: { workflowId: `wf_${id}`, managerSessionId: env.manager.key, managerAgent: "product_manager", managerModel: "m1", taskPath: `tasks/todo/TASK-P/${id}/x.md`, track: "implementation", workspace: env.workspaces[id], scopeId: id, contract: "TASK-P" },
        })
        files[id] = writeEntry(env.folder, `wf_${id}`, { workspace: env.workspaces[id], contract: "TASK-P", scope_id: id })
        files[`${id}-nested`] = writeEntry(env.folder, `wf_${id}_nested`, { parent: `wf_${id}` })
      }
      const idle = writeEntry(env.folder, "wf_unrelated")
      env.supervisor.recoverInterrupted(env.store.reconcileInterruptedWorkflows())
      await env.supervisor.idle() // the notifications are delivered to the manager one after the other

      for (const file of Object.values(files)) expect(state(file)).toBe("idle")
      expect(state(idle)).toBe("running")
      const notes = told(env)
      expect(notes).toHaveLength(2)
      expect(notes.filter((n) => n.includes("[NomadFlow Error]") && n.includes("CodeNomad restarted while it was working"))).toHaveLength(2)
      expect(notes.some((n) => n.includes("tasks/todo/TASK-P/api/x.md")) && notes.some((n) => n.includes("tasks/todo/TASK-P/ui/x.md"))).toBe(true)
      for (const id of ["api", "ui"]) expect(fs.existsSync(path.join(env.workspaces[id], ".codenomad"))).toBe(false) // nothing is kept in a workspace
    })
  })
})
