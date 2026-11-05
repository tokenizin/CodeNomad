/**
 * The whole background-workflow path through the real HTTP route, with a stand-in for the agent
 * (a shell script that plays the Product Manager's process or the Workflow Runner's, by environment).
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import Fastify from "fastify"
import fs from "fs"
import os from "os"
import path from "path"
import { registerLocalEngineRoutes } from "../../server/routes/local-engine"
import { LocalEngineStore } from "../store"

const AGENT = String.raw`#!/bin/bash
PROMPT=""
while [ $# -gt 0 ]; do case "$1" in -p) PROMPT="$2"; shift 2;; *) shift;; esac; done
emit() { printf '%s\n' "$1"; }
if [ "$NOMAD_WORKFLOW_RUN" = "1" ]; then
  # Env seen by the runner is part of the test.
  echo "$NOMAD_WORKFLOW_SESSION|$NOMAD_WORKFLOW_TASK_PATH|$CODENOMAD_SESSION_KEY|$NOMAD_WORKFLOW_MODE" >> "$FAKE_AGENT_LOG"
  WAIT="$FAKE_RUNNER_SECONDS"; [ -z "$WAIT" ] && WAIT=0.3
  sleep "$WAIT"
  emit '{"type":"meta","model":"fake","agent":"workflow_runner","protocol":1}'
  emit '{"type":"delta","text":"working on it"}'
  emit '{"type":"tool","id":"h1","name":"handover","input":{"outcome":"completed"}}'
  emit '{"type":"tool_result","id":"h1","name":"handover","output":"Handover filed","isError":false}'
  emit "{\"type\":\"workflow.done\",\"workflow_id\":\"$NOMAD_WORKFLOW_SESSION\",\"session_id\":\"ses_lcl_$NOMAD_WORKFLOW_SESSION\",\"task_path\":\"$NOMAD_WORKFLOW_TASK_PATH\",\"status\":\"completed\",\"handover\":{\"outcome\":\"completed\",\"path\":\"H.md\",\"revision\":1,\"verification\":\"verified\",\"open_issues\":[],\"markdown\":\"# Handover body\"}}"
  emit '{"type":"final","text":"Runner summary: export delivered."}'
elif [[ "$PROMPT" == "[NomadFlow"* ]]; then
  echo "NOTIFIED|$CODENOMAD_SESSION_KEY" >> "$FAKE_AGENT_LOG"
  emit '{"type":"meta","model":"fake","agent":"product_manager","protocol":1}'
  emit '{"type":"delta","text":"Reviewed the handover: "}'
  sleep 0.7
  emit '{"type":"delta","text":"accepted."}'
  emit '{"type":"final","text":"Reviewed the handover: accepted."}'
else
  ID="wf_$(echo "$PROMPT" | tr -dc 'a-z0-9')"
  emit '{"type":"meta","model":"fake","agent":"product_manager","protocol":1}'
  emit '{"type":"tool","id":"w1","name":"nomadflow_run_workflow","input":{"task_path":"tasks/todo/T/T.md","instructions":"run it"}}'
  emit '{"type":"workflow.start","workflow_id":"'$ID'","session_id":"ses_lcl_'$ID'","title":"Workflow Run: T.md","task_path":"tasks/todo/T/T.md","track":"implementation","instructions":"run it","prompt":"Task File: tasks/todo/T/T.md\n\nInstructions: run it","call_id":"w1"}'
  emit '{"type":"tool_result","id":"w1","name":"nomadflow_run_workflow","output":"SUCCESS: Workflow Runner session started.","isError":false}'
  emit '{"type":"final","text":"Workflow started; I will review it when it reports."}'
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

describe("a background workflow through the HTTP route", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-route-"))
  const folder = path.join(root, "work")
  const dataDir = path.join(root, "data")
  const log = path.join(root, "agent.log")
  const saved: Record<string, string | undefined> = {}
  let app: ReturnType<typeof Fastify>
  let store: LocalEngineStore

  beforeAll(async () => {
    fs.mkdirSync(folder, { recursive: true })
    const runner = path.join(root, "pg", "playground", "rust", "your_program.sh")
    fs.mkdirSync(path.dirname(runner), { recursive: true })
    fs.writeFileSync(runner, AGENT, { mode: 0o755 })
    fs.writeFileSync(log, "")
    for (const k of ["CLAUDE_CODE_PLAYGROUND", "CLI_WORKSPACE_ROOT", "FAKE_AGENT_LOG", "NOMAD_WORKFLOW_MODE"]) saved[k] = process.env[k]
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

  const history = async (key: string) => (await app.inject({ method: "GET", url: `/api/local-engine/history?sessionKey=${key}` })).json() as any

  test("the call returns, the runner works on its own, and the manager is told", async () => {
    const manager = store.createSession({ folder, agent: "product_manager" })
    const res = await app.inject({
      method: "POST",
      url: "/api/local-engine/run",
      payload: { prompt: "run1", sessionKey: manager.id, cwd: folder, agent: "product_manager" },
    })
    const events = res.body.split("\n").filter(Boolean).map((l) => JSON.parse(l))

    // 1. The manager's own turn is over, and shows a plain tool card that only started the workflow.
    expect(events.find((e) => e.type === "tool")).toMatchObject({ name: "nomadflow_run_workflow" })
    expect(events.find((e) => e.type === "workflow_start")).toMatchObject({ sessionId: "ses_lcl_wf_run1", title: "Workflow Run: T.md" })
    expect(events.at(-1)).toMatchObject({ type: "exit", code: 0 })
    const early = await history(manager.id)
    expect(early.messages.map((m: any) => m.role)).toEqual(["user", "assistant"])
    expect(early.running).toBe(false)
    expect(early.watching).toBe(true) // the page should keep looking: a runner is at work

    // 2. The runner has a session of its own, listed like any other.
    const session = store.getSession("ses_lcl_wf_run1")!
    expect(session).toMatchObject({ kind: "workflow", agent: "workflow_runner", folder })
    const listed = (await app.inject({ method: "GET", url: `/api/local-engine/sessions?folder=${folder}` })).json() as any
    expect(listed.sessions.map((s: any) => s.id)).toContain("ses_lcl_wf_run1")

    // 3. When the runner is done, a notification arrives in the manager's session and gets a turn.
    await until(() => store.readHistory(manager.id).length === 4)
    const messages = store.readHistory(manager.id)
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"])
    expect(messages[2].text.startsWith("[NomadFlow Notification] Workflow Runner has finished work for: tasks/todo/T/T.md.\n\nFINAL SUMMARY FROM RUNNER:\nRunner summary: export delivered.")).toBe(true)
    expect(messages[2].text).toContain("HANDOVER FILED: H.md (revision 1, outcome completed, verification verified, 0 open issue(s)).")
    expect(messages[2].text).toContain("# Handover body")
    expect(messages[3].text).toBe("Reviewed the handover: accepted.")
    expect(messages[3].agent).toBe("product_manager")

    // 4. The runner's session holds its own run: the first message it was shown, then what it did.
    const runnerMessages = store.readHistory("ses_lcl_wf_run1")
    expect(runnerMessages[0]).toMatchObject({ role: "user", text: "Task File: tasks/todo/T/T.md\n\nInstructions: run it" })
    expect(runnerMessages[1]).toMatchObject({ role: "assistant", agent: "workflow_runner" })
    expect(runnerMessages[1].text).toContain("working on it")
    expect(runnerMessages[1].parts?.some((p: any) => p.type === "tool" && p.tool === "handover" && p.status === "completed")).toBe(true)
    expect(store.getSession("ses_lcl_wf_run1")?.workflow?.status).toBe("idle")

    // 5. The runner process saw the identifiers it needs; the notification went to the manager's session.
    const lines = fs.readFileSync(log, "utf8").split("\n").filter(Boolean)
    expect(lines).toContain("wf_run1|tasks/todo/T/T.md|ses_lcl_wf_run1|async")
    expect(lines).toContain(`NOTIFIED|${manager.id}`)

    // Nothing is left to wait for.
    await sleep(100)
    const late = await history(manager.id)
    expect(late.running).toBe(false)
    expect(late.watching).toBe(false)
  })

  test("Stop on the runner's session ends it and the manager is told it failed", async () => {
    process.env.FAKE_RUNNER_SECONDS = "5"
    try {
      const manager = store.createSession({ folder, agent: "product_manager" })
      await app.inject({ method: "POST", url: "/api/local-engine/run", payload: { prompt: "run2", sessionKey: manager.id, cwd: folder, agent: "product_manager" } })
      await until(() => store.getSession("ses_lcl_wf_run2")?.workflow?.status === "running")
      await sleep(300) // the runner process is up
      const abort = await app.inject({ method: "POST", url: "/api/local-engine/abort", payload: { sessionKey: "ses_lcl_wf_run2" } })
      expect(abort.json()).toEqual({ aborted: true })
      await until(() => store.readHistory(manager.id).length === 4)
      expect(store.readHistory(manager.id)[2].text).toContain("[NomadFlow Error] Workflow Runner failed for tasks/todo/T/T.md: it was stopped before it finished")
      expect(store.getSession("ses_lcl_wf_run2")?.workflow?.status).toBe("aborted")
    } finally {
      delete process.env.FAKE_RUNNER_SECONDS
    }
  })

  test("a runner the last server left working is reported to its manager at startup", async () => {
    // What a killed server leaves behind: a session marked running, a registry entry, a manager waiting.
    const dir2 = path.join(root, "data2")
    const store2 = new LocalEngineStore(dir2)
    const manager = store2.createSession({ folder, agent: "product_manager" })
    store2.upsertWorkflowSession({
      sessionId: "ses_lcl_wf_cut",
      folder,
      title: "Workflow Run: T.md",
      workflow: { workflowId: "wf_cut", managerSessionId: manager.id, managerAgent: "product_manager", taskPath: "tasks/todo/T/T.md", track: "implementation" },
    })
    const entry = path.join(folder, ".codenomad", "runtime", "workflows", "wf_cut.json")
    fs.mkdirSync(path.dirname(entry), { recursive: true })
    fs.writeFileSync(entry, JSON.stringify({ workflow_id: "wf_cut", task_path: "tasks/todo/T/T.md", track: "implementation", state: "running" }))

    const restarted = Fastify()
    registerLocalEngineRoutes(restarted, { settings: { getOwner: () => undefined, getDataDir: () => dir2 } as any, workspaceManager: { list: () => [] } as any, store: store2 })
    await restarted.ready()
    try {
      await until(() => store2.readHistory(manager.id).length === 2)
      const [told, turn] = store2.readHistory(manager.id)
      expect(told.text.startsWith("[NomadFlow Error] Workflow Runner failed for tasks/todo/T/T.md: CodeNomad restarted while it was working")).toBe(true)
      expect(turn.text).toBe("Reviewed the handover: accepted.")
      expect(store2.getSession("ses_lcl_wf_cut")?.workflow?.status).toBe("failed")
      expect(JSON.parse(fs.readFileSync(entry, "utf8")).state).toBe("idle")
      expect(fs.readFileSync(log, "utf8")).toContain(`NOTIFIED|${manager.id}`)
    } finally {
      await restarted.close()
    }
  })

  test("a notification the last server had not delivered is delivered at startup", async () => {
    const dir3 = path.join(root, "data3")
    const store3 = new LocalEngineStore(dir3)
    const manager = store3.createSession({ folder, agent: "product_manager" })
    store3.writeInbox({ [manager.id]: { manager: { key: manager.id, folder, agent: "product_manager" }, messages: ["[NomadFlow Notification] Workflow Runner has finished work for: tasks/todo/T/T.md.\n\nFINAL SUMMARY FROM RUNNER:\nDone."] } })
    const restarted = Fastify()
    registerLocalEngineRoutes(restarted, { settings: { getOwner: () => undefined, getDataDir: () => dir3 } as any, workspaceManager: { list: () => [] } as any, store: store3 })
    await restarted.ready()
    try {
      await until(() => store3.readHistory(manager.id).length === 2)
      const [owed, turn] = store3.readHistory(manager.id)
      expect(owed.text.startsWith("[NomadFlow Notification] Workflow Runner has finished work for: tasks/todo/T/T.md.")).toBe(true)
      expect(turn.text).toBe("Reviewed the handover: accepted.")
      await until(() => Object.keys(store3.readInbox()).length === 0)
    } finally {
      await restarted.close()
    }
  })

  describe("watching a run the page did not start", () => {
    type Line = { t: number; ev: any }
    /** Reads an NDJSON stream to its end, noting when each line arrived. */
    async function readAll(url: string): Promise<{ lines: Line[]; ms: number }> {
      const started = Date.now()
      const res = await fetch(url)
      const lines: Line[] = []
      const reader = res.body!.getReader()
      const dec = new TextDecoder()
      let buf = ""
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const parts = buf.split("\n")
        buf = parts.pop() ?? ""
        for (const p of parts) if (p.trim()) lines.push({ t: Date.now() - started, ev: JSON.parse(p) })
      }
      return { lines, ms: Date.now() - started }
    }
    let base = ""
    beforeAll(async () => {
      const address = await app.listen({ port: 0, host: "127.0.0.1" })
      base = address
    })
    const attach = (key: string, wait = true) => `${base}/api/local-engine/attach?sessionKey=${key}${wait ? "&wait=1" : ""}`

    test("the manager's notification turn is followed live, and draws the messages that get saved", async () => {
      process.env.FAKE_RUNNER_SECONDS = "1"
      try {
        const manager = store.createSession({ folder, agent: "product_manager" })
        await app.inject({ method: "POST", url: "/api/local-engine/run", payload: { prompt: "run4", sessionKey: manager.id, cwd: folder, agent: "product_manager" } })
        // The manager's own turn is over; its runner is working. Hold on for the notification turn.
        const watched = await readAll(attach(manager.id))
        const header = watched.lines[0].ev
        expect(header).toMatchObject({ type: "attach", sessionKey: manager.id, agent: "product_manager" })
        expect(header.user.text.startsWith("[NomadFlow Notification] Workflow Runner has finished work for: tasks/todo/T/T.md.")).toBe(true)
        const deltas = watched.lines.filter((l) => l.ev.type === "delta")
        expect(deltas.map((l) => l.ev.text).join("")).toBe("Reviewed the handover: accepted.")
        // Live: the second half arrived well after the first, not all at the end.
        expect(deltas.length).toBe(2)
        expect(deltas[1].t - deltas[0].t).toBeGreaterThan(400)
        expect(watched.lines.at(-1)!.ev).toMatchObject({ type: "exit", code: 0 })

        // The stream ends once the history is saved, with the ids it announced.
        const saved = store.readHistory(manager.id)
        expect(saved).toHaveLength(4)
        expect(saved[2].id).toBe(header.user.id)
        expect(saved[3].id).toBe(header.assistantId)
        // And nothing is pending any more.
        const after = await readAll(attach(manager.id))
        expect(after.lines.map((l) => l.ev.type)).toEqual(["idle"])
      } finally {
        delete process.env.FAKE_RUNNER_SECONDS
      }
    })

    test("a page that comes late is given what the run has said so far, then the rest", async () => {
      process.env.FAKE_RUNNER_SECONDS = "0.2"
      try {
        const manager = store.createSession({ folder, agent: "product_manager" })
        await app.inject({ method: "POST", url: "/api/local-engine/run", payload: { prompt: "run5", sessionKey: manager.id, cwd: folder, agent: "product_manager" } })
        // Wait until the notification turn is running and has said its first words.
        await until(async () => (await (await fetch(`${base}/api/local-engine/history?sessionKey=${manager.id}`)).json() as any).running)
        await sleep(250)
        const late = await readAll(attach(manager.id, false))
        expect(late.lines[0].ev.type).toBe("attach")
        const deltas = late.lines.filter((l) => l.ev.type === "delta")
        // The first words arrive at once (replayed), the rest when they are said.
        expect(deltas[0].ev.text).toBe("Reviewed the handover: ")
        expect(deltas[0].t).toBeLessThan(300)
        expect(deltas.map((l) => l.ev.text).join("")).toBe("Reviewed the handover: accepted.")
        expect(late.lines.at(-1)!.ev.type).toBe("exit")
      } finally {
        delete process.env.FAKE_RUNNER_SECONDS
      }
    })

    test("the runner's own run can be followed too", async () => {
      process.env.FAKE_RUNNER_SECONDS = "1"
      try {
        const manager = store.createSession({ folder, agent: "product_manager" })
        await app.inject({ method: "POST", url: "/api/local-engine/run", payload: { prompt: "run6", sessionKey: manager.id, cwd: folder, agent: "product_manager" } })
        const runnerKey = "ses_lcl_wf_run6"
        const watched = await readAll(attach(runnerKey, false))
        expect(watched.lines[0].ev).toMatchObject({ type: "attach", sessionKey: runnerKey, agent: "workflow_runner" })
        expect(watched.lines[0].ev.user.text).toBe("Task File: tasks/todo/T/T.md\n\nInstructions: run it")
        expect(watched.lines.some((l) => l.ev.type === "delta" && l.ev.text === "working on it")).toBe(true)
        expect(watched.lines.some((l) => l.ev.type === "tool" && l.ev.name === "handover")).toBe(true)
        await until(() => store.readHistory(manager.id).length === 4)
      } finally {
        delete process.env.FAKE_RUNNER_SECONDS
      }
    })

    test("with nothing running or pending the answer is idle at once, waiting or not", async () => {
      const manager = store.createSession({ folder, agent: "product_manager" })
      for (const wait of [true, false]) {
        const res = await readAll(attach(manager.id, wait))
        expect(res.lines.map((l) => l.ev.type)).toEqual(["idle"])
        expect(res.ms).toBeLessThan(1000)
      }
      const bad = await fetch(`${base}/api/local-engine/attach`)
      expect(bad.status).toBe(400)
    })
  })

  test("deleting the manager does not delete the runner's session", async () => {
    const manager = store.createSession({ folder, agent: "product_manager" })
    await app.inject({ method: "POST", url: "/api/local-engine/run", payload: { prompt: "run3", sessionKey: manager.id, cwd: folder, agent: "product_manager" } })
    await until(() => store.readHistory(manager.id).length === 4)
    await app.inject({ method: "DELETE", url: `/api/local-engine/sessions/${manager.id}` })
    expect(store.getSession(manager.id)).toBeUndefined()
    expect(store.getSession("ses_lcl_wf_run3")).toBeDefined()
  })
})
