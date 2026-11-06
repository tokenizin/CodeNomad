import assert from "node:assert/strict"
import { describe, it as test } from "node:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isRenderableDiffText } from "./diff-utils.ts"

import {
  buildLocalEnginePrompt,
  catalogAgents,
  catalogCommands,
  catalogProvider,
  RUST_DEFAULT_AGENT,
  RUST_PROVIDER_ID,
  toOpencodePart,
  historyToApiMessages,
  isLocalSessionId,
  isUnauthorizedError,
  LocalEngineReply,
  usesRecentModels,
  readLocalEngineStream,
  taskSessionRecord,
  type HistoryPart,
  type LocalEngineEvent,
} from "./local-engine.ts"

describe("LocalEngineReply", () => {
  test("builds ordered text and tool parts from Claude Code (Rust) events", () => {
    const reply = new LocalEngineReply()
    reply.apply({ type: "meta", engine: "rust", model: "qwen3:8b" })
    reply.apply({ type: "delta", text: "Look" })
    reply.apply({ type: "delta", text: "ing" })
    reply.apply({ type: "tool", id: "c1", name: "bash", input: { command: "ls" } })
    reply.apply({ type: "tool_result", id: "c1", name: "bash", output: "a.ts", isError: false })
    reply.apply({ type: "delta", text: "Found it." })
    reply.apply({ type: "final", text: "Found it." })
    reply.apply({ type: "exit", code: 0 })
    const result = reply.result()
    assert.deepEqual(result.parts.map((p) => p.type), ["text", "tool", "text"])
    assert.equal((result.parts[0] as any).text, "Looking")
    assert.equal((result.parts[1] as any).status, "completed")
    assert.equal((result.parts[1] as any).output, "a.ts")
    assert.equal(result.text, "Looking\n\nFound it.")
    assert.equal(result.model, "qwen3:8b")
    assert.equal(result.isError, false)
  })

  test("shows the error when the engine fails and closes unfinished tools", () => {
    const reply = new LocalEngineReply()
    reply.apply({ type: "tool", id: "c1", name: "read", input: { filePath: "x" } })
    reply.apply({ type: "final", text: "endpoint down", isError: true })
    reply.apply({ type: "exit", code: 1 })
    const result = reply.result()
    assert.equal(result.isError, true)
    assert.equal((result.parts[0] as any).status, "error")
    assert.ok(result.text.includes("endpoint down"))
  })
})

describe("OpenCode-shaped parts", () => {
  test("tool parts become tool cards", () => {
    const part = toOpencodePart("s", "m", { type: "tool", id: "c1", tool: "bash", input: { command: "ls" }, status: "completed", output: "a", startedAt: 1, endedAt: 2 }, 0)
    assert.equal(part.type, "tool")
    assert.equal(part.callID, "c1")
    assert.equal(part.state.status, "completed")
    assert.equal(part.state.output, "a")
    const failed = toOpencodePart("s", "m", { type: "tool", id: "c2", tool: "read", input: {}, status: "error", output: "nope", startedAt: 1 }, 1)
    assert.equal(failed.state.error, "nope")
  })

  test("saved assistant parts are used on reload", () => {
    const [msg] = historyToApiMessages("ses_lcl_1", [
      { id: "a1", role: "assistant", text: "Done", createdAt: 1, model: "qwen3:8b", parts: [{ type: "tool", id: "c1", tool: "bash", input: {}, status: "completed", output: "x", startedAt: 1 }, { type: "text", text: "Done" }] },
    ])
    assert.deepEqual(msg.parts.map((p: any) => p.type), ["tool", "text"])
    assert.equal(msg.info.providerID, RUST_PROVIDER_ID)
    assert.equal(msg.info.modelID, "qwen3:8b")
  })
})

describe("catalog → pickers", () => {
  const catalog = {
    version: 1,
    model: "gemma4:31b-cloud",
    models: [{ id: "gemma4:31b-cloud" }, { id: "qwen3:8b" }],
    agents: [{ name: "pma", description: "Product manager", model: "qwen3:8b" }],
    commands: [{ name: "pma", agent: true }, { name: "smoke-echo", description: "Echo" }],
  }
  test("agents start with the full agent and carry their own model", () => {
    const agents = catalogAgents(catalog)
    assert.deepEqual(agents.map((a) => a.name), [RUST_DEFAULT_AGENT, "pma"])
    assert.deepEqual(agents[1].model, { providerId: RUST_PROVIDER_ID, modelId: "qwen3:8b" })
  })
  test("models become one provider; commands keep descriptions", () => {
    const provider = catalogProvider(catalog)
    assert.equal(provider.defaultModelId, "gemma4:31b-cloud")
    assert.deepEqual(provider.models.map((m) => m.id), ["gemma4:31b-cloud", "qwen3:8b"])
    assert.equal(provider.models[0].capabilities, undefined)
    const commands = catalogCommands(catalog)
    assert.equal(commands[1].description, "Echo")
    assert.ok(commands[0].description.includes("pma"))
  })
})

test("catalog model details reach the picker (icons, Ctx, Free filter)", () => {
  const capabilities = { tools: true, image: true, video: false, reasoning: true, audio: false, cloud: false }
  const provider = catalogProvider({
    version: 1,
    model: "qwen3.6:latest",
    models: [
      { id: "qwen3:8b" },
      {
        id: "qwen3.6:latest",
        limit: { context: 262144, input: 262144, output: 262144 },
        cost: { input: 0, output: 0 },
        capabilities,
        status: "available",
      },
    ],
    agents: [],
    commands: [],
  })
  assert.deepEqual(provider.models.map((m) => m.id), ["qwen3.6:latest", "qwen3:8b"])
  assert.deepEqual(provider.models[0].capabilities, capabilities)
  assert.equal(provider.models[0].limit?.context, 262144)
  assert.deepEqual(provider.models[0].cost, { input: 0, output: 0 })
  assert.equal(provider.models[0].status, "available")
})

test("buildLocalEnginePrompt puts paths in the prompt and uploads pasted data", () => {
  const built = buildLocalEnginePrompt("Review this", [
    { type: "file", url: "file:///Users/me/a%20b.ts", filename: "a b.ts" },
    { type: "text", text: "pasted notes" },
    { type: "file", url: "data:image/png;base64,AAA", filename: "shot.png", mime: "image/png" },
  ])
  assert.ok(built.prompt.includes("Attached file: /Users/me/a b.ts"))
  assert.ok(built.prompt.includes("pasted notes"))
  assert.ok(!built.prompt.includes("data:"))
  assert.deepEqual(built.uploads, [{ filename: "shot.png", mime: "image/png", data: "AAA" }])
  assert.deepEqual(built.attachmentNames, ["a b.ts", "shot.png"])
})

test("buildLocalEnginePrompt encodes non-base64 data URLs", () => {
  const built = buildLocalEnginePrompt("x", [{ type: "file", url: "data:text/plain,h%C3%A9llo", filename: "note.txt" }])
  assert.equal(built.uploads[0].mime, "text/plain")
  assert.equal(new TextDecoder().decode(Uint8Array.from(atob(built.uploads[0].data), (c) => c.charCodeAt(0))), "héllo")
})

test("historyToApiMessages matches the OpenCode message shape", () => {
  const api = historyToApiMessages("ses_lcl_1", [
    { id: "u1", role: "user", text: "hi", createdAt: 1, attachments: [{ filename: "shot.png" }] },
    { id: "a1", role: "assistant", text: "hello", createdAt: 2, agent: "pma" },
  ])
  assert.equal(api[0].info.role, "user")
  assert.equal(api[0].parts[0].text, "hi\n\n📎 shot.png")
  assert.equal(api[1].info.agent, "pma")
  assert.equal(api[1].parts[0].type, "text")
  assert.ok(isLocalSessionId("ses_lcl_abc"))
  assert.ok(!isLocalSessionId("ses_abc"))
})

test("isUnauthorizedError", () => {
  assert.equal(isUnauthorizedError(new Error("Unauthorized")), true)
  assert.equal(isUnauthorizedError(new Error("Request failed with 401")), true)
  assert.equal(isUnauthorizedError(new Error("cwd is not a directory")), false)
})

test("usage events reach the reply and saved history (context meter)", () => {
  const reply = new LocalEngineReply()
  reply.apply({ type: "usage", usage: { input: 900, output: 40, reasoning: 0, cacheRead: 100 }, model: "qwen3:8b" })
  reply.apply({ type: "usage", usage: { input: 1500, output: 60, reasoning: 5, cacheRead: 0 } })
  assert.deepEqual(reply.result().usage, { input: 1500, output: 60, reasoning: 5, cacheRead: 0 })
  assert.equal(reply.model, "qwen3:8b")

  const [, assistant] = historyToApiMessages("ses_lcl_1", [
    { id: "u", role: "user", text: "hi", createdAt: 1 },
    { id: "a", role: "assistant", text: "ok", createdAt: 2, model: "qwen3:8b", usage: { input: 1500, output: 60, reasoning: 5, cacheRead: 0 } },
  ])
  assert.deepEqual(assistant.info.tokens, { input: 1500, output: 60, reasoning: 5, cache: { read: 0, write: 0 } })
  assert.equal(assistant.info.modelID, "qwen3:8b")
})

test("Claude Code (Rust) agents don't inherit the last-clicked model", () => {
  assert.equal(usesRecentModels([{ id: "claude-code-rust" }]), false)
  assert.equal(usesRecentModels([{ id: "openrouter" }, { id: "ollama" }]), true)
  assert.equal(usesRecentModels([]), true)
})

// ---------------------------------------------------------------- delegated tasks (protocol 2)

/** What the server really sends the browser for a run (see __fixtures__/): the Rust agent's output, translated. */
function envelopes(name: string): LocalEngineEvent[] {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", name)
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as LocalEngineEvent)
}

function replay(events: LocalEngineEvent[]) {
  const reply = new LocalEngineReply()
  const seen: string[][] = []
  for (const ev of events) {
    reply.apply(ev)
    seen.push(reply.takeChangedTasks().map((t) => t.taskId))
  }
  return { reply, seen }
}

const tool = (parts: HistoryPart[]) => parts.flatMap((p) => (p.type === "tool" ? [p] : []))

describe("delegated tasks in the live reply", () => {
  test("three parallel tasks each get a view with their own prompt, ids and parts", () => {
    const { reply } = replay(envelopes("task-envelopes-parallel.ndjson"))
    assert.equal(reply.tasks.length, 3)
    for (const [i, task] of reply.tasks.entries()) {
      assert.equal(task.agent, "worker")
      assert.equal(task.status, "completed")
      assert.match(task.sessionId, /^ses_lcl_t_task_/)
      assert.equal(task.prompt, `do-sub-${task.parentCallId.at(-1)}`)
      assert.equal(task.userMessageId.startsWith("msg_tu_"), true)
      assert.equal(task.assistantMessageId.startsWith("msg_ta_"), true)
      assert.deepEqual(task.parts, [{ type: "text", text: `answer-${task.parentCallId.at(-1)}` }], `task ${i}`)
    }
    // Distinct sessions, one per task.
    assert.equal(new Set(reply.tasks.map((t) => t.sessionId)).size, 3)
  })

  test("each Task card is linked to its own task session, and the subagents' text stays out of the reply", () => {
    const { reply } = replay(envelopes("task-envelopes-parallel.ndjson"))
    const cards = tool(reply.parts)
    assert.equal(cards.length, 3)
    for (const card of cards) {
      const task = reply.tasks.find((t) => t.parentCallId === card.id)
      assert.ok(task, `a task for ${card.id}`)
      assert.equal(card.childSessionId, task!.sessionId)
    }
    assert.equal(reply.text, "ALL DONE")
    assert.ok(!reply.result().text.includes("answer-"))
  })

  test("the cards hand the renderer the session id it looks for", () => {
    const { reply } = replay(envelopes("task-envelopes-parallel.ndjson"))
    for (const card of tool(reply.result().parts)) {
      const part = toOpencodePart("ses_parent", "msg_a", card, 0)
      assert.equal(part.state.metadata.sessionId, card.childSessionId)
    }
  })

  test("a card that is still running links too, and a plain tool does not", () => {
    const running = toOpencodePart("s", "m", { type: "tool", id: "c", tool: "task", input: {}, status: "running", startedAt: 1, childSessionId: "ses_lcl_t_x" }, 0)
    assert.equal(running.state.status, "running")
    assert.equal(running.state.metadata.sessionId, "ses_lcl_t_x")
    const failed = toOpencodePart("s", "m", { type: "tool", id: "c", tool: "task", input: {}, status: "error", output: "x", startedAt: 1, childSessionId: "ses_lcl_t_x" }, 0)
    assert.equal(failed.state.metadata.sessionId, "ses_lcl_t_x")
    const plain = toOpencodePart("s", "m", { type: "tool", id: "c", tool: "bash", input: {}, status: "completed", output: "ok", startedAt: 1 }, 0)
    assert.deepEqual(plain.state.metadata, {})
  })

  test("saved history keeps the link, so a reloaded Task card still opens its session", () => {
    const [message] = historyToApiMessages("ses_parent", [
      {
        id: "a1",
        role: "assistant",
        text: "x",
        createdAt: 1,
        parts: [{ type: "tool", id: "c1", tool: "task", input: {}, status: "completed", output: "ok", startedAt: 1, childSessionId: "ses_lcl_t_z" }],
      },
    ])
    assert.equal(message.parts[0].state.metadata.sessionId, "ses_lcl_t_z")
  })

  test("only the tasks that changed are reported, once", () => {
    const { seen, reply } = replay(envelopes("task-envelopes-parallel.ndjson"))
    // The three task_start lines each report their own task; a later event only its task.
    const starts = seen.filter((ids) => ids.length > 0)
    assert.ok(starts.every((ids) => ids.length === 1), JSON.stringify(starts))
    assert.equal(new Set(starts.flat()).size, 3)
    assert.deepEqual(reply.takeChangedTasks(), [])
  })

  test("a failed task is failed, its siblings are not", () => {
    const { reply } = replay(envelopes("task-envelopes-one-failed.ndjson"))
    assert.deepEqual(
      reply.tasks.map((t) => [t.parentCallId, t.status]),
      [["call_1", "completed"], ["call_2", "failed"], ["call_3", "completed"]],
    )
    assert.ok(reply.tasks[1].endedAt)
  })

  test("a stream cut before the tasks end leaves them open until they are closed", () => {
    const all = envelopes("task-envelopes-parallel.ndjson")
    const firstEnd = all.findIndex((e) => e.type === "task_end")
    const { reply } = replay(all.slice(0, firstEnd))
    assert.deepEqual(reply.tasks.map((t) => t.status), ["running", "running", "running"])
    const closed = reply.closeOpenTasks("aborted")
    assert.equal(closed.length, 3)
    assert.ok(closed.every((t) => t.status === "aborted" && t.endedAt))
    assert.deepEqual(reply.takeChangedTasks().length, 3)
    // Closing again finds nothing to close.
    assert.deepEqual(reply.closeOpenTasks("failed"), [])
  })

  test("a task's running tools are closed with it", () => {
    const { reply } = replay([
      { type: "tool", id: "c1", name: "task", input: { prompt: "p" } },
      { type: "task_start", taskId: "t1", parentCallId: "c1", agent: "ba", description: "d", sessionId: "ses_lcl_t_t1", parentSessionId: "ses_p", prompt: "p", userMessageId: "u", assistantMessageId: "a" },
      { type: "task_event", taskId: "t1", parentCallId: "c1", event: { type: "tool", id: "x", name: "bash", input: { command: "ls" } } },
    ])
    reply.closeOpenTasks("aborted")
    const part = reply.tasks[0].parts[0]
    assert.equal(part.type === "tool" && part.status, "error")
    assert.equal(part.type === "tool" && part.output, "Stopped")
  })

  test("a task delegated by a task is linked inside that task, not in the run's reply", () => {
    const { reply } = replay([
      { type: "tool", id: "c1", name: "task", input: { prompt: "lead" } },
      { type: "task_start", taskId: "tl", parentCallId: "c1", agent: "tl", description: "lead", sessionId: "ses_lcl_t_tl", parentSessionId: "ses_p", prompt: "lead", userMessageId: "u1", assistantMessageId: "a1" },
      { type: "task_event", taskId: "tl", parentCallId: "c1", event: { type: "tool", id: "c2", name: "task", input: { prompt: "build" } } },
      { type: "task_start", taskId: "dev", parentTaskId: "tl", parentCallId: "c2", agent: "dev", description: "build", sessionId: "ses_lcl_t_dev", parentSessionId: "ses_lcl_t_tl", prompt: "build", userMessageId: "u2", assistantMessageId: "a2" },
    ])
    const inner = tool(reply.tasks[0].parts)
    assert.equal(inner[0].childSessionId, "ses_lcl_t_dev")
    assert.equal(tool(reply.parts)[0].childSessionId, "ses_lcl_t_tl")
    assert.equal(reply.tasks[1].parentTaskId, "tl")
  })

  test("a server that sends no session id (older, or no session) leaves the run exactly as before", () => {
    const plain = new LocalEngineReply()
    const old = new LocalEngineReply()
    const parent: LocalEngineEvent[] = [
      { type: "tool", id: "c1", name: "task", input: { subagent_type: "ba", prompt: "p" } },
      { type: "tool_result", id: "c1", name: "task", output: "done", isError: false },
      { type: "delta", text: "ALL DONE" },
    ]
    for (const ev of parent) plain.apply(ev)
    old.apply(parent[0])
    for (const ev of [
      { type: "task_start", taskId: "t", parentCallId: "c1", agent: "ba", description: "d" },
      { type: "task_event", taskId: "t", parentCallId: "c1", event: { type: "delta", text: "SUBAGENT TEXT" } },
      { type: "task_end", taskId: "t", parentCallId: "c1", status: "completed" },
    ] as LocalEngineEvent[]) assert.equal(old.apply(ev), false)
    old.apply(parent[1])
    old.apply(parent[2])
    assert.equal(old.tasks.length, 0)
    assert.equal(old.text, "ALL DONE")
    assert.deepEqual(
      old.result().parts.map((p) => ({ ...p, startedAt: 0, endedAt: 0 })),
      plain.result().parts.map((p) => ({ ...p, startedAt: 0, endedAt: 0 })),
    )
  })

  test("the task session record is what the server lists for it", () => {
    const { reply } = replay(envelopes("task-envelopes-parallel.ndjson"))
    const task = reply.tasks[0]
    const record = taskSessionRecord(task, "/work")
    assert.equal(record.id, task.sessionId)
    assert.equal(record.parentId, task.parentSessionId)
    assert.equal(record.kind, "task")
    assert.equal(record.taskStatus, "completed")
    assert.equal(record.title, "[worker] job " + task.parentCallId.at(-1))
    assert.deepEqual(record.model, { providerId: RUST_PROVIDER_ID, modelId: "m" })
  })

  test("a stream that ends with a task still open closes it as failed", async () => {
    const all = envelopes("task-envelopes-parallel.ndjson")
    const cut = all.slice(0, all.findIndex((e) => e.type === "task_end"))
    const body = new Response(cut.map((e) => JSON.stringify(e)).join("\n") + "\n")
    const result = await readLocalEngineStream(body)
    assert.deepEqual(result.tasks.map((t) => t.status), ["failed", "failed", "failed"])
    // And the card still links to the (failed) task's session.
    assert.ok(tool(result.parts).every((c) => c.childSessionId))
  })
})

describe("a workflow session (orchestrator) in the live reply", () => {
  test("its card opens a session holding the instructions and the handover call", () => {
    const { reply } = replay(envelopes("task-envelopes-workflow.ndjson"))
    // The card is a Task card (the translator presents workflow tools as tasks), linked to the workflow's session.
    const card = tool(reply.parts)[0]
    assert.equal(card.tool, "task")
    assert.equal(card.input.subagent_type, "workflow_runner")
    const task = reply.tasks[0]
    assert.equal(card.childSessionId, task.sessionId)
    assert.equal(task.agent, "workflow_runner")
    assert.equal(task.status, "completed")
    assert.equal(task.prompt, "do it")
    assert.match(task.sessionId, /^ses_lcl_t_wf_/)

    const handover = tool(task.parts).find((p) => p.tool === "handover")
    assert.ok(handover, "the handover call is in the workflow's own transcript")
    assert.equal(handover!.status, "completed")
    assert.match(handover!.output ?? "", /^Handover filed: tasks\/todo\/TASK-9\/HANDOVER\.md/)
    // The manager's reply is its own.
    assert.equal(reply.text, "PMA DONE")
  })

  test("the card the browser draws for it points at the session the task renderer will open", () => {
    const { reply } = replay(envelopes("task-envelopes-workflow.ndjson"))
    const part = toOpencodePart("ses_parent", "msg_a", tool(reply.result().parts)[0], 0)
    assert.equal(part.tool, "task")
    assert.equal(part.state.metadata.sessionId, reply.tasks[0].sessionId)
  })
})

describe("OpenCode's tools in the live reply (real agent output)", () => {
  const cards = () => {
    const { reply } = replay(envelopes("task-envelopes-tools.ndjson"))
    return tool(reply.result().parts)
  }

  test("the run shows each tool as the card OpenCode would draw", () => {
    assert.deepEqual(cards().map((c) => c.tool), ["todowrite", "edit", "grep", "glob", "webfetch", "todoread"])
    assert.ok(cards().every((c) => c.status === "completed"))
  })

  test("a todo list is put where the todo card and the plan panel read it", () => {
    const part = toOpencodePart("ses", "msg", cards()[0], 0)
    assert.equal(part.tool, "todowrite")
    assert.equal(part.state.status, "completed")
    assert.deepEqual(part.state.metadata.todos.map((t: any) => [t.content, t.status]), [["Fix the answer", "in_progress"], ["Check it", "pending"]])
  })

  test("a todo list is there while the call is running or failed too", () => {
    const todos = [{ id: "1", content: "x", status: "pending", priority: "low" }]
    for (const status of ["running", "error"] as const) {
      const part = toOpencodePart("s", "m", { type: "tool", id: "c", tool: "todowrite", input: { todos }, status, output: "no", startedAt: 1 }, 0)
      assert.deepEqual(part.state.metadata.todos, todos, status)
    }
  })

  test("an edit's output is a diff the edit card can draw, with the input names it reads", () => {
    const edit = cards()[1]
    assert.match(String(edit.input.filePath), /app\.ts$/)
    const part = toOpencodePart("ses", "msg", edit, 0)
    assert.equal(isRenderableDiffText(part.state.output), true)
    assert.equal(part.state.input.oldString, "answer = 41")
  })

  test("other tools get no todo metadata", () => {
    for (const card of cards().slice(1)) assert.equal("todos" in toOpencodePart("s", "m", card, 0).state.metadata, false, card.tool)
    // A todowrite whose input is not a list is not treated as one.
    const odd = toOpencodePart("s", "m", { type: "tool", id: "c", tool: "todowrite", input: { todos: "nope" }, status: "completed", output: "", startedAt: 1 }, 0)
    assert.deepEqual(odd.state.metadata, {})
  })
})

test("a model's context window becomes its limit, so the meter can show what is left", () => {
  const provider = catalogProvider({ version: 1, model: "m", models: [{ id: "m", context: 32768 }, { id: "n" }], agents: [], commands: [] })
  assert.deepEqual(provider.models.map((m) => m.limit), [{ context: 32768 }, undefined])
})

test("usage reaches the reply, the saved history and a task's own view (context meter)", () => {
  const reply = new LocalEngineReply()
  reply.apply({ type: "usage", usage: { input: 900, output: 40, reasoning: 0, cacheRead: 100 }, model: "qwen2.5:14b" })
  reply.apply({ type: "usage", usage: { input: 1500, output: 60, reasoning: 5, cacheRead: 0 } })
  assert.deepEqual(reply.result().usage, { input: 1500, output: 60, reasoning: 5, cacheRead: 0 })
  assert.equal(reply.model, "qwen2.5:14b")

  // A task's usage is the task's, not the run's.
  reply.apply({ type: "task_start", taskId: "t1", sessionId: "ses_lcl_t_t1", parentSessionId: "ses_lcl_1", parentCallId: "c1", agent: "qa_engineer", description: "d", prompt: "p" })
  reply.apply({ type: "task_event", taskId: "t1", parentCallId: "c1", event: { type: "usage", usage: { input: 300, output: 9, reasoning: 0, cacheRead: 20 } } })
  assert.deepEqual(reply.result().usage, { input: 1500, output: 60, reasoning: 5, cacheRead: 0 })
  assert.deepEqual(reply.result().tasks[0].usage, { input: 300, output: 9, reasoning: 0, cacheRead: 20 })
  assert.equal(reply.takeChangedTasks().length, 1)

  const [, assistant] = historyToApiMessages("ses_lcl_1", [
    { id: "u", role: "user", text: "hi", createdAt: 1 },
    { id: "a", role: "assistant", text: "ok", createdAt: 2, model: "qwen2.5:14b", usage: { input: 1500, output: 60, reasoning: 5, cacheRead: 0 } },
  ])
  assert.deepEqual((assistant.info as any).tokens, { input: 1500, output: 60, reasoning: 5, cache: { read: 0, write: 0 } })
})
