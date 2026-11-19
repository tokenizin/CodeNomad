/**
 * S3 — context-aware suggestion tests (SCR-2026-11-18-001).
 *
 * Covers the pure generator + session-chain layer end to end:
 *   - each phase yields its exact base set
 *   - discussion sub-suggestions appear only in discussion sessions
 *   - agent sub-suggestions appear for routing-capable agents
 *   - engine-status → phase projection
 *   - session chain state management
 *
 * Runner: `bun test` (the runner the CodeNomad workspaces already use).
 */

import { describe, expect, it } from "bun:test";

import {
  advanceSessionChain,
  createConversation,
  currentSession,
  deriveConversation,
  generateSuggestions,
  isSessionLive,
  reprojectPhases,
  SESSION_STATUS_TO_PHASE,
  startSessionChain,
  suggestionsByScope,
  suggestionsForSession,
  fromPrompt,
  type Agent,
  type AgentRegistry,
  type Conversation,
  type Suggestion,
  type SuggestionScope,
} from "../index";

// ── helpers ─────────────────────────────────────────────────────────────

const REVIEW_AGENT: Agent = {
  id: "agent-review",
  name: "Reviewer",
  skills: ["review", "diagnose"],
  memory: { summary: "recent work" },
  conversation: createConversation("conv-review"),
};

const PLAIN_AGENT: Agent = {
  id: "agent-plain",
  name: "Helper",
  skills: [],
  memory: {},
  conversation: createConversation("conv-plain"),
};

const _unused: Conversation = createConversation("x"); // exercise type surface

// ── phase-driven base sets ──────────────────────────────────────────────

describe("generateSuggestions — phase base sets", () => {
  it("running → Continue, Retry, Stop", () => {
    const out = generateSuggestions({ phase: "running" });
    expect(out.map((s) => s.label)).toEqual(["Continue", "Retry", "Stop"]);
  });

  it("waiting → Continue, Retry, Stop (turn blocked, not ended)", () => {
    const out = generateSuggestions({ phase: "waiting" });
    expect(out.map((s) => s.label)).toEqual(["Continue", "Retry", "Stop"]);
    expect(out[0].id).toBe("phase:waiting:continue");
  });

  it("stopped → Ask Follow-up, Summarize, Diagnose, Fix with AI", () => {
    const out = generateSuggestions({ phase: "stopped" });
    expect(out.map((s) => s.label)).toEqual([
      "Ask Follow-up",
      "Summarize",
      "Diagnose",
      "Fix with AI",
    ]);
  });

  it("defaults to the stopped phase when no phase is given", () => {
    const out = generateSuggestions();
    expect(out.map((s) => s.action)).toEqual([
      "follow-up",
      "summarize",
      "diagnose",
      "fix",
    ]);
  });

  it("is pure: same inputs yield the same ids in the same order", () => {
    const a = generateSuggestions({ phase: "stopped" }).map((s) => s.id);
    const b = generateSuggestions({ phase: "stopped" }).map((s) => s.id);
    expect(a).toEqual(b);
  });
});

// ── discussion-specific sub-suggestions ─────────────────────────────────

describe("generateSuggestions — discussion scope", () => {
  it("adds discussion sub-suggestions only when kind is 'discussion'", () => {
    const discussion = generateSuggestions({ phase: "stopped", kind: "discussion" });
    const user = generateSuggestions({ phase: "stopped", kind: "user" });

    expect(suggestionsByScope(discussion, "discussion").length).toBeGreaterThan(0);
    expect(suggestionsByScope(user, "discussion").length).toBe(0);
    for (const s of suggestionsByScope(discussion, "discussion")) {
      expect(s.discussion).toBe(true);
    }
  });
});

// ── agent-specific sub-suggestions ──────────────────────────────────────

describe("generateSuggestions — agent scope", () => {
  it("adds a routed suggestion for a routing-capable agent", () => {
    const out = generateSuggestions({
      phase: "stopped",
      registry: { agents: [REVIEW_AGENT] },
    });
    const agentScoped = out.filter((s) => s.scope === "agent");
    expect(agentScoped.length).toBe(1);
    expect(agentScoped[0].agentId).toBe("agent-review");
  });

  it("skips agents with no route skill", () => {
    const out = generateSuggestions({
      phase: "stopped",
      registry: { agents: [PLAIN_AGENT] },
    });
    expect(out.filter((s) => s.scope === "agent").length).toBe(0);
  });

  it("places the active agent first in the roster", () => {
    const registry: AgentRegistry = {
      agents: [PLAIN_AGENT, REVIEW_AGENT],
      activeAgentId: "agent-review",
    };
    const out = generateSuggestions({ phase: "stopped", registry });
    const agentScoped = out.filter((s) => s.scope === "agent");
    expect(agentScoped[0].agentId).toBe("agent-review");
  });
});

// ── engine-status → phase projection ────────────────────────────────────

describe("SESSION_STATUS_TO_PHASE", () => {
  it("maps engine statuses to product phases", () => {
    expect(SESSION_STATUS_TO_PHASE.working).toBe("running");
    expect(SESSION_STATUS_TO_PHASE.compacting).toBe("running");
    expect(SESSION_STATUS_TO_PHASE["pending-permission"]).toBe("waiting");
    expect(SESSION_STATUS_TO_PHASE["pending-question"]).toBe("waiting");
    expect(SESSION_STATUS_TO_PHASE.retry).toBe("waiting");
    expect(SESSION_STATUS_TO_PHASE.idle).toBe("stopped");
    expect(SESSION_STATUS_TO_PHASE.error).toBe("stopped");
  });
});

// ── session chain state management ──────────────────────────────────────

describe("session chain — advanceSessionChain / currentSession / reprojectPhases", () => {
  it("advances from stopped → running → stopped via status transitions", () => {
    let sessions = startSessionChain("user", "session-a");
    expect(currentSession(sessions).phase).toBe("stopped"); // empty chain

    sessions = advanceSessionChain(sessions, { status: "working", prompt: "do the thing" });
    const live = currentSession(sessions);
    expect(live.phase).toBe("running");
    expect(isSessionLive(live)).toBe(true);
    expect(live.conversation.messages.length).toBeGreaterThan(0);

    sessions = advanceSessionChain(sessions, { status: "idle", history: "done" });
    const closed = currentSession(sessions);
    expect(closed.phase).toBe("stopped");
    expect(isSessionLive(closed)).toBe(false);
  });

  it("reprojectPhases fills in missing phase fields after a table change", () => {
    let sessions = startSessionChain("discussion", "session-b");
    sessions = advanceSessionChain(sessions, { status: "working" });
    const projected = reprojectPhases(sessions);
    for (const entry of projected.chain) {
      if (entry.status === "working") expect(entry.phase).toBe("running");
    }
  });

  it("deriveConversation reconstructs user+assistant turns from an entry", () => {
    const sessions = advanceSessionChain(startSessionChain("user", "session-c"), {
      status: "idle",
      prompt: "hi",
      history: "hello",
    });
    const entry = sessions.chain[sessions.chain.length - 1];
    const conversation = deriveConversation(sessions.session.id, entry!);
    expect(conversation.messages.length).toBe(2);
    expect(conversation.messages[0].role).toBe("user");
    expect(conversation.messages[1].role).toBe("assistant");
  });
});

// ── generator adapter ───────────────────────────────────────────────────

describe("suggestionsForSession", () => {
  const labels = (out: readonly Suggestion[]) => out.map((s) => s.label).sort();
  const scopeCount = (out: readonly Suggestion[], scope: SuggestionScope) =>
    out.filter((s: Suggestion) => s.scope === scope).length;

  it("yields stopped base + discussion + agent subs when phase is stopped in a discussion", () => {
    const sessions = advanceSessionChain(startSessionChain("discussion", "d"), {
      status: "idle",
      prompt: "decide",
      history: "ok",
    });
    const snapshot = currentSession(sessions);
    const out = suggestionsForSession(snapshot, { agents: [REVIEW_AGENT] });
    _unused; // silence no-unused
    expect(scopeCount(out, "phase")).toBe(4);
    expect(scopeCount(out, "discussion")).toBeGreaterThan(0);
    expect(scopeCount(out, "agent")).toBe(1);
  });

  it("yields the running base set when the session is live", () => {
    const sessions = advanceSessionChain(startSessionChain("user", "r"), {
      status: "working",
      prompt: "go",
    });
    const snapshot = currentSession(sessions);
    const out = suggestionsForSession(snapshot);
    expect(labels(out)).toEqual(["Continue", "Retry", "Stop"].sort());
  });
});

// ── Context ingestion — fromPrompt ──────────────────────────────────────

describe("fromPrompt", () => {
  it("projects a prompt-only context with the stopped phase", () => {
    const ctx = fromPrompt({ prompt: "hi", conversationId: 42 });
    expect(ctx.sessionState).toBe("stopped");
    expect(ctx.prompt).toBe("hi");
  });
});
