/**
 * A scope of a scope contract through the real HTTP route: the runner process is started in the scope's own workspace (a real
 * git worktree), is told where the manager's workflow registry is, and the session stays with the manager's folder.
 * The agent is a shell script, as in workflows-route.test.ts: it plays the Product Manager's process or the runner's.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { execFileSync } from "child_process"
import Fastify from "fastify"
import fs from "fs"
import os from "os"
import path from "path"
import { registerLocalEngineRoutes } from "../../server/routes/local-engine"
import { LocalEngineStore, taskSessionId } from "../store"

const AGENT = String.raw`#!/bin/bash
PROMPT=""
while [ $# -gt 0 ]; do case "$1" in -p) PROMPT="$2"; shift 2;; *) shift;; esac; done
emit() { printf '%s\n' "$1"; }
if [ "$NOMAD_WORKFLOW_RUN" = "1" ]; then
  echo "RUN|$(pwd -P)|$NOMAD_WORKFLOW_REGISTRY|$CODENOMAD_SESSION_KEY|$NOMAD_WORKFLOW_SESSION" >> "$FAKE_AGENT_LOG"
  emit '{"type":"meta","model":"fake","agent":"workflow_runner","protocol":2}'
  emit '{"type":"tool","id":"c1","name":"Task","input":{"subagent_type":"developer","description":"build","prompt":"build it"}}'
  emit '{"type":"task.start","task_id":"task_scope1","parent_call_id":"c1","agent":"developer","description":"build","mode":"subagent","resumed":false}'
  emit '{"type":"task.end","task_id":"task_scope1","parent_call_id":"c1","status":"completed"}'
  emit "{\"type\":\"workflow.done\",\"workflow_id\":\"$NOMAD_WORKFLOW_SESSION\",\"session_id\":\"ses_lcl_$NOMAD_WORKFLOW_SESSION\",\"task_path\":\"$NOMAD_WORKFLOW_TASK_PATH\",\"status\":\"completed\",\"handover\":{\"outcome\":\"completed\",\"path\":\"H.md\",\"revision\":1,\"verification\":\"verified\",\"open_issues\":0,\"markdown\":\"# Handover body\"}}"
  emit '{"type":"final","text":"Scope summary."}'
elif [[ "$PROMPT" == "[NomadFlow"* ]]; then
  echo "NOTIFIED|$CODENOMAD_SESSION_KEY" >> "$FAKE_AGENT_LOG"
  emit '{"type":"meta","model":"fake","agent":"product_manager","protocol":1}'
  emit '{"type":"final","text":"Reviewed."}'
else
  ID="wf_$(echo "$PROMPT" | tr -dc 'a-z0-9')"
  emit '{"type":"meta","model":"fake","agent":"product_manager","protocol":1}'
  emit '{"type":"tool","id":"w1","name":"nomadflow_run_workflow","input":{"task_path":"tasks/todo/T/T.md","instructions":"run it"}}'
  emit '{"type":"workflow.start","workflow_id":"'$ID'","session_id":"ses_lcl_'$ID'","title":"Workflow Run: T.md","task_path":"tasks/todo/T/T.md","track":"implementation","instructions":"run it","prompt":"run it","call_id":"w1","workspace":"'"$FAKE_WORKSPACE"'","scope_id":"api","contract":"TASK-P"}'
  emit '{"type":"tool_result","id":"w1","name":"nomadflow_run_workflow","output":"SUCCESS: Workflow Runner session started.","isError":false}'
  emit '{"type":"final","text":"Started."}'
fi
`

setDefaultTimeout(20000)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until<T>(fn: () => T | undefined | false, ms = 8000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error("timed out waiting")
    await sleep(25)
  }
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-C", cwd, ...args], { stdio: "pipe" })

describe("a scope of a scope contract through the HTTP route", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-scope-")))
  const folder = path.join(root, "work")
  const workspace = path.join(root, "work-api")
  const dataDir = path.join(root, "data")
  const log = path.join(root, "agent.log")
  const saved: Record<string, string | undefined> = {}
  let app: ReturnType<typeof Fastify>
  let store: LocalEngineStore

  beforeAll(async () => {
    fs.mkdirSync(folder, { recursive: true })
    git(folder, "init", "-q")
    fs.writeFileSync(path.join(folder, "README.md"), "# work\n")
    git(folder, "add", ".")
    git(folder, "commit", "-q", "-m", "init")
    git(folder, "worktree", "add", "-q", workspace, "-b", "api")
    const runner = path.join(root, "pg", "playground", "rust", "your_program.sh")
    fs.mkdirSync(path.dirname(runner), { recursive: true })
    fs.writeFileSync(runner, AGENT, { mode: 0o755 })
    fs.writeFileSync(log, "")
    for (const k of ["CLAUDE_CODE_PLAYGROUND", "CLI_WORKSPACE_ROOT", "FAKE_AGENT_LOG", "FAKE_WORKSPACE", "NOMAD_WORKFLOW_MODE"]) saved[k] = process.env[k]
    process.env.CLAUDE_CODE_PLAYGROUND = path.join(root, "pg")
    process.env.CLI_WORKSPACE_ROOT = folder
    process.env.FAKE_AGENT_LOG = log
    delete process.env.NOMAD_WORKFLOW_MODE
    store = new LocalEngineStore(dataDir)
    app = Fastify()
    registerLocalEngineRoutes(app, {
      settings: { getOwner: () => undefined, getDataDir: () => dataDir } as any,
      workspaceManager: { list: () => [] } as any,
      store,
    })
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  })

  const startScope = async (prompt: string, workspaceForRun: string) => {
    process.env.FAKE_WORKSPACE = workspaceForRun
    const manager = store.createSession({ folder, agent: "product_manager" })
    const res = await app.inject({ method: "POST", url: "/api/local-engine/run", payload: { prompt, sessionKey: manager.id, cwd: folder, agent: "product_manager" } })
    const events = res.body.split("\n").filter(Boolean).map((l) => JSON.parse(l))
    return { manager, events }
  }
  const lines = () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean)

  test("the runner runs in the workspace, knows the manager's registry, and its session stays with the manager", async () => {
    const { manager, events } = await startScope("scopeone", workspace)
    expect(events.find((e) => e.type === "workflow_start")).toMatchObject({ workspace, scopeId: "api", contract: "TASK-P" })

    await until(() => store.readHistory(manager.id).length === 4)
    const session = store.getSession("ses_lcl_wf_scopeone")!
    expect(session.folder).toBe(folder) // the session is the manager's, so it is listed with the manager's
    expect(session.workflow).toMatchObject({ status: "idle", workspace, scopeId: "api", contract: "TASK-P" })

    // The process ran in the workspace, and was told where the registry is (never the workspace itself).
    expect(lines()).toContain(`RUN|${workspace}|${folder}|ses_lcl_wf_scopeone|wf_scopeone`)
    expect(fs.existsSync(path.join(workspace, ".codenomad", "runtime", "workflows"))).toBe(false)

    // A subagent of the runner is a session of the manager's folder too, so it is listed with the rest, not under the workspace.
    expect(store.getSession(taskSessionId("task_scope1"))).toMatchObject({ folder, parentId: "ses_lcl_wf_scopeone" })

    // The manager was told, as for any workflow.
    const note = store.readHistory(manager.id)[2].text
    expect(note.startsWith("[NomadFlow Notification] Workflow Runner has finished work for: tasks/todo/T/T.md.")).toBe(true)
    expect(note).toContain("Scope summary.")
    expect(lines()).toContain(`NOTIFIED|${manager.id}`)
  })

  test("a workspace that is not a worktree of the manager's repository is never run in; the manager is told why", async () => {
    const stranger = fs.mkdtempSync(path.join(root, "stranger-"))
    const before = lines().filter((l) => l.startsWith("RUN|")).length
    const { manager } = await startScope("scopetwo", stranger)
    await until(() => store.readHistory(manager.id).length === 4)

    expect(lines().filter((l) => l.startsWith("RUN|")).length).toBe(before) // no runner process was started
    const note = store.readHistory(manager.id)[2].text
    expect(note.startsWith("[NomadFlow Error] Workflow Runner failed for tasks/todo/T/T.md: its workspace")).toBe(true)
    expect(note).toContain(`${stranger} cannot be used: it is not a git worktree of ${folder}`)
    expect(store.getSession("ses_lcl_wf_scopetwo")?.workflow?.status).toBe("failed")
  })
})
