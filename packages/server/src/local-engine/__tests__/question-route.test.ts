/**
 * A question the agent asks, through the HTTP route, with a stand-in for the agent (a shell script) that asks one
 * and waits for the answer file the route writes into the run's control directory.
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
emit '{"type":"tool","id":"c1","name":"question","input":{"questions":[{"question":"Which format?","header":"Format","options":[{"label":"CSV","description":"plain"},{"label":"JSON","description":"typed"}]}]}}'
emit '{"type":"question","id":"que_1","call_id":"c1","questions":[{"question":"Which format?","header":"Format","options":[{"label":"CSV","description":"plain"},{"label":"JSON","description":"typed"}]}]}'
for i in $(seq 1 200); do
  if [ -e "$NOMAD_CONTROL_DIR/answer-que_1.json" ]; then
    GOT=$(cat "$NOMAD_CONTROL_DIR/answer-que_1.json")
    rm -f "$NOMAD_CONTROL_DIR/answer-que_1.json"
    emit '{"type":"tool_result","id":"c1","name":"question","output":"answered","isError":false}'
    emit "{\"type\":\"final\",\"text\":\"got $(echo "$GOT" | sed 's/"/\\"/g')\"}"
    exit 0
  fi
  sleep 0.05
done
emit '{"type":"final","text":"nobody answered"}'
`

setDefaultTimeout(20000)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("a question the agent asks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "question-"))
  const folder = path.join(root, "work")
  const dataDir = path.join(root, "data")
  const saved: Record<string, string | undefined> = {}
  let app: ReturnType<typeof Fastify>
  let store: LocalEngineStore

  beforeAll(async () => {
    fs.mkdirSync(folder, { recursive: true })
    const runner = path.join(root, "pg", "playground", "rust", "your_program.sh")
    fs.mkdirSync(path.dirname(runner), { recursive: true })
    fs.writeFileSync(runner, AGENT, { mode: 0o755 })
    for (const k of ["CLAUDE_CODE_PLAYGROUND", "CLI_WORKSPACE_ROOT"]) saved[k] = process.env[k]
    process.env.CLAUDE_CODE_PLAYGROUND = path.join(root, "pg")
    process.env.CLI_WORKSPACE_ROOT = folder
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

  const answer = (payload: object) => app.inject({ method: "POST", url: "/api/local-engine/question", payload })
  /** Sends the answer as soon as the run is waiting for it (the route refuses until the run exists). */
  async function answerWhenAsked(sessionKey: string, payload: object) {
    for (let i = 0; i < 200; i += 1) {
      const res = await answer({ sessionKey, requestId: "que_1", ...payload })
      if (res.statusCode === 200) return res
      await sleep(25)
    }
    throw new Error("the run never started")
  }

  test("the question reaches the page, and the answer goes back to the waiting agent", async () => {
    const session = store.createSession({ folder, agent: "product_manager" })
    const running = app.inject({ method: "POST", url: "/api/local-engine/run", payload: { prompt: "export it", sessionKey: session.id, cwd: folder, agent: "product_manager" } })
    expect((await answerWhenAsked(session.id, { answers: [["JSON"]] })).json()).toEqual({ answered: true })
    const events = (await running).body.split("\n").filter(Boolean).map((l) => JSON.parse(l))
    expect(events.find((e) => e.type === "question")).toMatchObject({
      id: "que_1",
      callId: "c1",
      questions: [{ question: "Which format?", header: "Format", options: [{ label: "CSV" }, { label: "JSON" }] }],
    })
    expect(events.find((e) => e.type === "final").text).toContain('"answers":[["JSON"]]')
    expect(events.at(-1)).toMatchObject({ type: "exit", code: 0 })
    // The tool card is in the saved reply, completed.
    const reply = store.readHistory(session.id)[1]
    expect(reply.parts?.find((p: any) => p.type === "tool" && p.tool === "question")).toMatchObject({ status: "completed" })
  })

  test("dismissing is passed back too", async () => {
    const session = store.createSession({ folder, agent: "product_manager" })
    const running = app.inject({ method: "POST", url: "/api/local-engine/run", payload: { prompt: "export it", sessionKey: session.id, cwd: folder, agent: "product_manager" } })
    await answerWhenAsked(session.id, { dismissed: true })
    const events = (await running).body.split("\n").filter(Boolean).map((l) => JSON.parse(l))
    expect(events.find((e) => e.type === "final").text).toContain('"dismissed":true')
  })

  test("no run, or a bad request id, is refused", async () => {
    const idle = store.createSession({ folder, agent: "product_manager" })
    expect((await answer({ sessionKey: idle.id, requestId: "que_1", answers: [["A"]] })).statusCode).toBe(409)
    expect((await answer({ sessionKey: idle.id, requestId: "../escape", answers: [["A"]] })).statusCode).toBe(400)
    expect((await answer({ requestId: "que_1" })).statusCode).toBe(400)
  })
})
