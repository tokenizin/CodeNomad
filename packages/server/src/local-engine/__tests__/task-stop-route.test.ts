/**
 * Stopping one delegated task through the HTTP route, with a stand-in for the agent (a shell script) that
 * runs two tasks and gives up the first only when asked, through the control directory.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import Fastify from "fastify"
import fs from "fs"
import os from "os"
import path from "path"
import { registerLocalEngineRoutes } from "../../server/routes/local-engine"
import { LocalEngineStore } from "../store"

const AGENT = String.raw`#!/bin/bash
emit() { printf '%s\n' "$1"; }
emit '{"type":"meta","model":"fake","agent":"product_manager","protocol":2}'
emit '{"type":"task.start","task_id":"tk_a","parent_call_id":"c1","agent":"qa_engineer","description":"slow one","mode":"subagent","resumed":false}'
emit '{"type":"task.start","task_id":"tk_b","parent_call_id":"c2","agent":"ui_ux_designer","description":"quick one","mode":"subagent","resumed":false}'
echo "$NOMAD_CONTROL_DIR" > "$FAKE_AGENT_LOG"
sleep 0.4
emit '{"type":"delta","task_id":"tk_b","parent_call_id":"c2","text":"design done"}'
emit '{"type":"task.end","task_id":"tk_b","parent_call_id":"c2","status":"completed","summary":"design done"}'
# tk_a goes on until the host drops its stop marker.
for i in $(seq 1 200); do
  if [ -e "$NOMAD_CONTROL_DIR/stop-tk_a" ]; then
    rm -f "$NOMAD_CONTROL_DIR/stop-tk_a"
    emit '{"type":"task.end","task_id":"tk_a","parent_call_id":"c1","status":"aborted","summary":"Stopped by the user"}'
    emit '{"type":"delta","text":"One task was stopped; the other finished."}'
    emit '{"type":"final","text":"One task was stopped; the other finished."}'
    exit 0
  fi
  sleep 0.05
done
emit '{"type":"task.end","task_id":"tk_a","parent_call_id":"c1","status":"completed","summary":"never asked to stop"}'
emit '{"type":"final","text":"nobody stopped it"}'
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

describe("stopping one task of a run", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-stop-"))
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
    for (const k of ["CLAUDE_CODE_PLAYGROUND", "CLI_WORKSPACE_ROOT", "FAKE_AGENT_LOG"]) saved[k] = process.env[k]
    process.env.CLAUDE_CODE_PLAYGROUND = path.join(root, "pg")
    process.env.CLI_WORKSPACE_ROOT = folder
    process.env.FAKE_AGENT_LOG = log
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

  const abort = async (sessionKey: string) => (await app.inject({ method: "POST", url: "/api/local-engine/abort", payload: { sessionKey } })).json() as any

  test("Stop on a task's session ends that task, and the run carries on to its answer", async () => {
    const manager = store.createSession({ folder, agent: "product_manager" })
    const running = app.inject({ method: "POST", url: "/api/local-engine/run", payload: { prompt: "fan out", sessionKey: manager.id, cwd: folder, agent: "product_manager" } })

    // Both tasks have sessions of their own; the quick one finishes, the slow one is still going.
    await until(() => store.getSession("ses_lcl_t_tk_a")?.taskStatus === "running" && store.getSession("ses_lcl_t_tk_b")?.taskStatus === "completed")
    expect(fs.readFileSync(log, "utf8").trim()).toBeTruthy()

    // A finished task, an unknown session and the manager's own session: nothing task-sized to stop.
    expect(await abort("ses_lcl_t_tk_b")).toEqual({ aborted: false })
    expect(await abort("ses_lcl_t_nope")).toEqual({ aborted: false })

    // The slow task: stopped on its own, the process is not killed.
    expect(await abort("ses_lcl_t_tk_a")).toEqual({ aborted: true, task: true })
    const res = await running
    const events = res.body.split("\n").filter(Boolean).map((l) => JSON.parse(l))
    expect(events.at(-1)).toMatchObject({ type: "exit", code: 0 })
    expect(events.find((e) => e.type === "task_end" && e.taskId === "tk_a")).toMatchObject({ status: "aborted" })
    expect(events.find((e) => e.type === "final")).toMatchObject({ text: "One task was stopped; the other finished." })

    expect(store.getSession("ses_lcl_t_tk_a")?.taskStatus).toBe("aborted")
    expect(store.getSession("ses_lcl_t_tk_b")?.taskStatus).toBe("completed")
    const history = store.readHistory(manager.id)
    expect(history.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(history[1].text).toContain("One task was stopped")
    // Its control directory is gone with the run, and a later stop finds nothing to do.
    expect(fs.existsSync(fs.readFileSync(log, "utf8").trim())).toBe(false)
    expect(await abort("ses_lcl_t_tk_a")).toEqual({ aborted: false })
  })
})
