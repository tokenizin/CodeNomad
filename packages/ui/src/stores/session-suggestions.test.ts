import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  engineSessionPhase,
  inferAgentSkills,
  suggestionsForEngineSession,
  toSuggestionRegistry,
  type EngineSessionView,
  type UiAgentView,
} from "./session-suggestions.ts"

const labels = (out: readonly { label: string }[]) => out.map((s) => s.label)
const scopeCount = (out: readonly { scope: string }[], scope: string) =>
  out.filter((s) => s.scope === scope).length

// ── engineSessionPhase — the engine→phase fold (ADR discrepancy) ──────

describe("engineSessionPhase — engine status → product phase", () => {
  it("projects working / compacting to running", () => {
    assert.equal(engineSessionPhase({ status: "working" }), "running")
    assert.equal(engineSessionPhase({ status: "compacting" }), "running")
  })

  it("projects idle (and missing status) to stopped", () => {
    assert.equal(engineSessionPhase({ status: "idle" }), "stopped")
    assert.equal(engineSessionPhase({}), "stopped")
  })

  it("folds the client-side block signals into waiting, ahead of status", () => {
    // pendingPermission / pendingQuestion are booleans on the client Session,
    // not status strings — they must force `waiting` even when status is idle.
    assert.equal(engineSessionPhase({ status: "idle", pendingPermission: true }), "waiting")
    assert.equal(engineSessionPhase({ status: "idle", pendingQuestion: true }), "waiting")
    // A transient retry backoff is a live, blocked turn → waiting.
    assert.equal(engineSessionPhase({ status: "idle", retry: { next: Date.now() + 1000 } }), "waiting")
  })

  it("block signals take precedence over an active status (waiting beats running)", () => {
    assert.equal(engineSessionPhase({ status: "working", pendingPermission: true }), "waiting")
  })

  it("an empty retry state is a no-op, not waiting", () => {
    assert.equal(engineSessionPhase({ status: "idle", retry: null }), "stopped")
  })
})

// ── inferAgentSkills — keyword → skill inference ───────────────────────

describe("inferAgentSkills", () => {
  it("infers review from a reviewer-named agent", () => {
    const skills = inferAgentSkills({ name: "Reviewer", description: "reviews code" })
    assert.ok(skills.includes("review"), skills.join(","))
  })

  it("infers test from a 'write tests' description", () => {
    const skills = inferAgentSkills({ name: "Qa", description: "writes tests and asserts" })
    assert.ok(skills.includes("test"), skills.join(","))
  })

  it("falls back to default route skills for an agent with no keyword match", () => {
    const skills = inferAgentSkills({ name: "Helper", description: "just helps out" })
    assert.ok(skills.length > 0, "never returns zero skills")
    // default primary route set — code and review are always inferred
    assert.ok(skills.includes("code"))
    assert.ok(skills.includes("review"))
  })
})

// ── toSuggestionRegistry — roster → S0 registry ────────────────────────

describe("toSuggestionRegistry", () => {
  it("drops subagents and hidden agents, keeps primaries", () => {
    const roster: UiAgentView[] = [
      { name: "build", mode: "primary", hidden: false },
      { name: "sub", mode: "subagent", hidden: false },
      { name: "ghost", mode: "primary", hidden: true },
    ]
    const registry = toSuggestionRegistry(roster)
    assert.deepEqual(
      registry.agents.map((a) => a.id),
      ["build"],
    )
  })

  it("carries the active agent name through as activeAgentId", () => {
    const registry = toSuggestionRegistry([{ name: "build", mode: "primary" }], "build")
    assert.equal(registry.activeAgentId, "build")
  })

  it("gives every routable agent non-empty skills so it is never silent", () => {
    const registry = toSuggestionRegistry([{ name: "plain", mode: "primary" }])
    assert.ok(registry.agents[0].skills.length > 0)
  })
})

// ── suggestionsForEngineSession — the end-to-end fold + generator ──────

describe("suggestionsForEngineSession — phase-driven base sets", () => {
  it("running view → Continue, Retry, Stop", () => {
    const view: EngineSessionView = { status: "working" }
    assert.deepEqual(labels(suggestionsForEngineSession({ session: view })), [
      "Continue",
      "Retry",
      "Stop",
    ])
  })

  it("blocked-on-user (pendingPermission) → Continue, Retry, Stop (waiting)", () => {
    const view: EngineSessionView = { status: "idle", pendingPermission: true }
    assert.deepEqual(labels(suggestionsForEngineSession({ session: view })), [
      "Continue",
      "Retry",
      "Stop",
    ])
  })

  it("idle view → Ask Follow-up, Summarize, Diagnose, Fix with AI (stopped)", () => {
    const view: EngineSessionView = { status: "idle" }
    assert.deepEqual(labels(suggestionsForEngineSession({ session: view })), [
      "Ask Follow-up",
      "Summarize",
      "Diagnose",
      "Fix with AI",
    ])
  })
})

describe("suggestionsForEngineSession — discussion & agent scopes", () => {
  it("discussion kind adds discussion sub-suggestions", () => {
    const out = suggestionsForEngineSession({
      session: { status: "idle" },
      kind: "discussion",
    })
    assert.ok(scopeCount(out, "discussion") > 0)
  })

  it("user kind produces no discussion sub-suggestions", () => {
    const out = suggestionsForEngineSession({
      session: { status: "idle" },
      kind: "user",
    })
    assert.equal(scopeCount(out, "discussion"), 0)
  })

  it("a UI roster yields agent-scoped sub-suggestions (stopped phase)", () => {
    const out = suggestionsForEngineSession({
      session: { status: "idle" },
      agents: [{ name: "Reviewer", description: "reviews code", mode: "primary" }],
    })
    const agentScoped = out.filter((s) => s.scope === "agent")
    assert.equal(agentScoped.length, 1)
    assert.equal(agentScoped[0].agentId, "Reviewer")
  })

  it("is pure: same context yields the same suggestion ids in the same order", () => {
    const ctx = {
      session: { status: "idle", pendingPermission: true },
      agents: [{ name: "Reviewer", mode: "primary" }],
    } as const
    const a = suggestionsForEngineSession({ ...ctx }).map((s) => s.id)
    const b = suggestionsForEngineSession({ ...ctx }).map((s) => s.id)
    assert.deepEqual(a, b)
  })
})
