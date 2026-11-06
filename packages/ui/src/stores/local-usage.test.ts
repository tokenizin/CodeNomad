import assert from "node:assert/strict"
import { describe, it as test } from "node:test"

import { catalogProvider } from "../lib/local-engine.ts"
import { addInstance } from "./instances.ts"
import { recordLocalUsage } from "./local-usage.ts"
import { upsertLocalSessions } from "./session-api.ts"
import { sessionInfoByInstance, setProviders } from "./session-state.ts"
import { syncLocalTaskSessions } from "./local-task-sessions.ts"

const INSTANCE = "inst-usage"

describe("the context meter for Claude Code (Rust) sessions", () => {
  test("Used follows the model calls of a session and of each task; Avail is the model's window", () => {
    addInstance({ id: INSTANCE, folder: "/work" } as never)
    setProviders((prev) => new Map(prev).set(INSTANCE, [{ id: "openai", name: "OpenAI", models: [], defaultModelId: "", variantKeys: [] }, catalogProvider({ version: 1, model: "qwen2.5:14b", models: [{ id: "qwen2.5:14b", context: 32768 }], agents: [], commands: [] })] as never))
    // Sessions made before the catalog loaded name no model: the agent's default decides the window.
    const base = { folder: "/work", agent: "product_manager", createdAt: 1, updatedAt: 1 }
    upsertLocalSessions(INSTANCE, [{ id: "ses_lcl_m", title: "Manager", ...base }])
    const info = (id: string) => sessionInfoByInstance().get(INSTANCE)?.get(id)

    // The manager's calls: the latest one is the context in use (cached prompt tokens count once).
    recordLocalUsage(INSTANCE, "ses_lcl_m", "msg_la_1", { input: 900, output: 40, reasoning: 0, cacheRead: 100 }, "qwen2.5:14b", 10)
    assert.equal(info("ses_lcl_m")?.actualUsageTokens, 1040)
    assert.equal(info("ses_lcl_m")?.contextAvailableTokens, 32768, "Avail shows the model's window")
    recordLocalUsage(INSTANCE, "ses_lcl_m", "msg_la_1", { input: 1500, output: 60, reasoning: 0, cacheRead: 0 }, "qwen2.5:14b", 10)
    assert.equal(info("ses_lcl_m")?.actualUsageTokens, 1560)

    // A delegated task's session has a meter of its own.
    syncLocalTaskSessions(INSTANCE, "/work", [
      {
        taskId: "t1", sessionId: "ses_lcl_t_t1", parentSessionId: "ses_lcl_m", parentCallId: "c1", agent: "qa_engineer", description: "d", model: "qwen2.5:14b",
        prompt: "p", userMessageId: "msg_tu_t1", assistantMessageId: "msg_ta_t1", startedAt: 20, status: "running", parts: [],
        usage: { input: 300, output: 9, reasoning: 0, cacheRead: 20 },
      },
    ])
    assert.equal(info("ses_lcl_t_t1")?.actualUsageTokens, 329)
    assert.equal(info("ses_lcl_m")?.actualUsageTokens, 1560, "the manager's meter is not the task's")
  })
})
