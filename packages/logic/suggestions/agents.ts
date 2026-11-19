/**
 * agents.ts — S0 agent contract + Suggestion contract + the canonical
 * `generateSuggestions()` for the dynamic, context-aware suggestion system
 * (SCR-2026-11-18-001).
 *
 * This is the single source of truth for:
 *   - `Agent`      — the agent interface the spec names (id, name, skills,
 *                    memory, conversation of UserPrompt/AssistantText).
 *   - `Suggestion` / `SuggestionPhase` — the output shape, split by phase.
 *   - `generateSuggestions()` — pure, deterministic generator that returns
 *                    phase-appropriate suggestions plus discussion- and
 *                    agent-specific sub-suggestions.
 *
 * The generator is pure: given the same `SuggestionInputs` it always returns
 * the same array. No async, no I/O, no UI — so it is directly unit-testable
 * (S3) and importable from both `packages/logic` and `packages/ui`.
 *
 * State → suggestion map (the product spec):
 *   - running  → Continue, Retry, Stop
 *   - waiting  → Continue, Retry, Stop   (the turn is blocked, not ended)
 *   - stopped  → Ask Follow-up, Summarize, Diagnose, Fix with AI
 *
 * On top of the phase base set, the generator layers:
 *   - discussion sub-suggestions when `context.kind === "discussion"`.
 *   - agent sub-suggestions for each agent visible to the context.
 */

import type {
  Conversation,
  SessionKind,
  SessionPhase,
} from "./conversation";
import type { SessionSnapshot } from "./sessions";

// ── Agent contract ─────────────────────────────────────────────────────

/**
 * An agent's skills — the capability tags the suggestion generator uses to
 * tailor agent-specific sub-suggestions (e.g. an agent that can `diagnose`
 * surfaces a stronger *Diagnose* follow-up).
 */
export type AgentSkill =
  | "code"
  | "review"
  | "test"
  | "diagnose"
  | "document"
  | "design"
  | "research"
  | "deploy";

/**
 * An agent's long-term memory. Kept as an open record so the engine can add
 * fields (summaries, embeddings, episodic log) without a schema bump. The
 * generator only reads `summary` today.
 */
export interface AgentMemory {
  /** A short, rolling summary of the agent's prior work this session. */
  readonly summary?: string;
  /** Forward-compatible memory store (embeddings, episodic log, ...). */
  readonly [key: string]: unknown;
}

/**
 * The Agent interface (spec AC-1): id, name, skills, memory, conversation.
 * `conversation` is the append-only chain of `UserPrompt` / `AssistantText`
 * the agent carries (see `Conversation` in conversation.ts).
 */
export interface Agent {
  /** Stable agent identifier. */
  readonly id: string;
  /** Human-readable name shown in agent sub-suggestions. */
  readonly name: string;
  /** Capability tags the generator tailors suggestions to. */
  readonly skills: readonly AgentSkill[];
  /** Rolling long-term memory for this agent. */
  readonly memory: AgentMemory;
  /** Ordered conversation this agent holds (UserPrompt / AssistantText). */
  readonly conversation: Conversation;
}

/**
 * The set of agents a suggestion context can route to. In a single-agent
 * `user` session this is one entry; in a `discussion` it is the full roster.
 */
export interface AgentRegistry {
  readonly agents: readonly Agent[];
  /** The id of the agent currently owning the turn, if any. */
  readonly activeAgentId?: string;
}

// ── Suggestion contract ────────────────────────────────────────────────

/**
 * A single suggestion's origin scope. `phase` suggestions come from the
 * session phase; `discussion` from being in a discussion thread; `agent`
 * from a specific agent's capability.
 */
export type SuggestionScope = "phase" | "discussion" | "agent";

/**
 * The action a suggestion triggers. The phase base sets use
 * continue|retry|stop (running/waiting) and
 * follow-up|summarize|diagnose|fix (stopped). `route` hands the turn to a
 * named agent; `discussion` advances the thread.
 */
export type SuggestionAction =
  | "continue"
  | "retry"
  | "stop"
  | "follow-up"
  | "summarize"
  | "diagnose"
  | "fix"
  | "route"
  | "discussion";

/**
 * A suggestion the UI renders. `id` is stable (scope+phased+action) so
 * dedup and dismissal work; `phase`/`scope`/`agentId`/`discussion` are the
 * trace fields tests assert on.
 */
export interface Suggestion {
  /** Stable id, e.g. `phase:stopped:diagnose`. */
  readonly id: string;
  /** The label shown to the user. */
  readonly label: string;
  /** 1–line helper text under the label. */
  readonly hint?: string;
  /** The action the UI fires on selection. */
  readonly action: SuggestionAction;
  /** The phase this suggestion belongs to. */
  readonly phase: SessionPhase;
  /** Where the suggestion originated. */
  readonly scope: SuggestionScope;
  /** For `route` actions / agent sub-suggestions: the target agent id. */
  readonly agentId?: string;
  /** True when the suggestion only appears in a discussion thread. */
  readonly discussion?: boolean;
}

/**
 * The inputs to `generateSuggestions()`. Any subset may be provided; the
 * generator fills defaults. `snapshot` is the projected session view;
 * `context` is the canonical context object (see Context.ts).
 */
export interface SuggestionInputs {
  /** The current session phase. Defaults to `stopped`. */
  readonly phase?: SessionPhase;
  /** The session kind. Defaults to `user`. */
  readonly kind?: SessionKind;
  /** The agent registry (roster + active agent). */
  readonly registry?: AgentRegistry;
  /** The whole context object, when available (preferred). */
  readonly context?: SuggestionContext;
}

/**
 * The canonical context object the generator consumes — agent + user +
 * history, in one shape. Mirrors `Context` in Context.ts.
 */
export interface SuggestionContext {
  readonly sessionKind: SessionKind;
  readonly sessionPhase: SessionPhase;
  readonly agent?: AgentRegistry;
  readonly conversation?: Conversation;
}

// ── Phase-driven base sets ─────────────────────────────────────────────

/**
 * Per-phase base suggestions.
 *
 *   running / waiting → Continue, Retry, Stop
 *   stopped           → Ask Follow-up, Summarize, Diagnose, Fix with AI
 */
const PHASE_SUGGESTIONS: Readonly<Record<SessionPhase, Suggestion[]>> = {
  running: [
    {
      id: "phase:running:continue",
      label: "Continue",
      hint: "Let the agent keep working through the current turn.",
      action: "continue",
      phase: "running",
      scope: "phase",
    },
    {
      id: "phase:running:retry",
      label: "Retry",
      hint: "Re-run the current turn from its start.",
      action: "retry",
      phase: "running",
      scope: "phase",
    },
    {
      id: "phase:running:stop",
      label: "Stop",
      hint: "Halt the agent mid-turn.",
      action: "stop",
      phase: "running",
      scope: "phase",
    },
  ],
  // Waiting = the turn is alive but blocked on the user (permission/question/
  // retry). The same three controls apply — you can push through, restart, or
  // abort a blocked turn — so waiting shares running's set.
  waiting: [
    {
      id: "phase:waiting:continue",
      label: "Continue",
      hint: "Resolve the block and let the agent continue.",
      action: "continue",
      phase: "waiting",
      scope: "phase",
    },
    {
      id: "phase:waiting:retry",
      label: "Retry",
      hint: "Re-try the blocked step.",
      action: "retry",
      phase: "waiting",
      scope: "phase",
    },
    {
      id: "phase:waiting:stop",
      label: "Stop",
      hint: "Abort the blocked turn.",
      action: "stop",
      phase: "waiting",
      scope: "phase",
    },
  ],
  stopped: [
    {
      id: "phase:stopped:follow-up",
      label: "Ask Follow-up",
      hint: "Ask a follow-up question about the result.",
      action: "follow-up",
      phase: "stopped",
      scope: "phase",
    },
    {
      id: "phase:stopped:summarize",
      label: "Summarize",
      hint: "Get a concise summary of what just happened.",
      action: "summarize",
      phase: "stopped",
      scope: "phase",
    },
    {
      id: "phase:stopped:diagnose",
      label: "Diagnose",
      hint: "Diagnose why the turn ended the way it did.",
      action: "diagnose",
      phase: "stopped",
      scope: "phase",
    },
    {
      id: "phase:stopped:fix",
      label: "Fix with AI",
      hint: "Have AI fix the last issue end-to-end.",
      action: "fix",
      phase: "stopped",
      scope: "phase",
    },
  ],
} as const;

// ── Discussion- & agent-specific sub-suggestions ───────────────────────

/**
 * Sub-suggestions that appear *only* in a discussion thread (kind =
 * "discussion"). These advance the thread rather than a single turn.
 */
const DISCUSSION_SUGGESTIONS: readonly Suggestion[] = [
  {
    id: "discussion:continue-thread",
    label: "Continue the discussion",
    hint: "Keep the conversation going across agents.",
    action: "discussion",
    phase: "stopped",
    scope: "discussion",
    discussion: true,
  },
  {
    id: "discussion:summarize-thread",
    label: "Summarize the discussion",
    hint: "Collapse the thread into a single summary.",
    action: "summarize",
    phase: "stopped",
    scope: "discussion",
    discussion: true,
  },
  {
    id: "discussion:decide",
    label: "Decide next step",
    hint: "Vote on which agent's result to act on next.",
    action: "route",
    phase: "stopped",
    scope: "discussion",
    discussion: true,
  },
];

/**
 * Skill → agent sub-suggestion. An agent that *can* do a capability surfaces
 * a tailored entry. Only phase-stopped makes routing meaningful (the turn is
 * closed, so you hand off to another agent).
 */
const SKILL_ROUTE: Readonly<Record<AgentSkill, { label: string; action: SuggestionAction }>> = {
  code: { label: "Route to coding agent", action: "route" },
  review: { label: "Route to review agent", action: "route" },
  test: { label: "Route to test agent", action: "route" },
  diagnose: { label: "Route to diagnosis agent", action: "route" },
  document: { label: "Route to docs agent", action: "route" },
  design: { label: "Route to design agent", action: "route" },
  research: { label: "Route to research agent", action: "route" },
  deploy: { label: "Route to deploy agent", action: "route" },
};

/**
 * Build an agent-specific sub-suggestion for one agent, picking the most
 * relevant skill as its label. Returns `undefined` when the agent has no
 * route skill, so agents with no routing capability add no noise.
 */
function agentSubSuggestion(agent: Agent, phase: SessionPhase): Suggestion | undefined {
  const route = agent.skills.map((s) => SKILL_ROUTE[s]).find(Boolean);
  if (!route) return undefined;
  return {
    id: `agent:${agent.id}:${route.action}`,
    label: route.label,
    hint: `Hand the turn to ${agent.name}.`,
    action: route.action,
    phase,
    scope: "agent",
    agentId: agent.id,
  };
}

// ── The generator ──────────────────────────────────────────────────────

/**
 * Generate context-aware suggestions.
 *
 * Order of assembly:
 *   1. Phase base set (the running/waiting/stopped rows above).
 *   2. Discussion sub-suggestions, when in a discussion thread.
 *   3. Agent sub-suggestions, one per routing-capable agent in the registry,
 *      active agent first.
 *
 * Returns a fresh, sorted, de-duped array. Pure and deterministic.
 */
export function generateSuggestions(inputs: SuggestionInputs = {}): Suggestion[] {
  const context = inputs.context;
  const phase = inputs.phase ?? context?.sessionPhase ?? "stopped";
  const kind = inputs.kind ?? context?.sessionKind ?? "user";
  const registry = inputs.registry ?? context?.agent;

  const out: Suggestion[] = [];

  // 1. Phase base
  for (const s of PHASE_SUGGESTIONS[phase]) out.push({ ...s });

  // 2. Discussion sub-suggestions
  if (kind === "discussion") {
    for (const s of DISCUSSION_SUGGESTIONS) out.push({ ...s });
  }

  // 3. Agent sub-suggestions (active agent first, then the rest in roster order)
  if (registry && registry.agents.length > 0) {
    const ordered = orderAgentsFirst(registry, "stopped" === phase ? "stopped" : undefined);
    for (const agent of ordered) {
      const sub = agentSubSuggestion(agent, phase);
      if (sub) out.push(sub);
    }
  }

  return dedupeById(out);
}

/** Place the active agent first, then keep the original roster order for the rest. */
function orderAgentsFirst(registry: AgentRegistry, _phase: SessionPhase | undefined): readonly Agent[] {
  if (!registry.activeAgentId) return registry.agents;
  const idx = registry.agents.findIndex((a) => a.id === registry.activeAgentId);
  if (idx < 0) return registry.agents;
  return [registry.agents[idx], ...registry.agents.slice(0, idx), ...registry.agents.slice(idx + 1)];
}

/** Stable, id-keyed de-duplication preserving first-seen order. */
function dedupeById(list: readonly Suggestion[]): Suggestion[] {
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  for (const s of list) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

/**
 * Convenience adapter: build suggestions from a projected `SessionSnapshot`
 * (sessions.ts) plus an optional registry. This is the seam the UI calls.
 */
export function suggestionsForSession(
  snapshot: SessionSnapshot,
  registry?: AgentRegistry,
): Suggestion[] {
  return generateSuggestions({
    phase: snapshot.phase,
    kind: snapshot.kind,
    registry,
    context: {
      sessionKind: snapshot.kind,
      sessionPhase: snapshot.phase,
      agent: registry,
      conversation: snapshot.conversation,
    },
  });
}

/**
 * Filter suggestions to a single scope — used by UI variants that show, e.g.,
 * only agent sub-suggestions or only discussion sub-suggestions.
 */
export function suggestionsByScope(
  suggestions: readonly Suggestion[],
  scope: SuggestionScope,
): Suggestion[] {
  return suggestions.filter((s) => s.scope === scope);
}

/**
 * Whether a given suggestion is currently *discussable* (i.e. relevant to a
 * discussion thread). Useful for the discussion-only UI variant.
 */
export function isDiscussable(suggestion: Suggestion): boolean {
  return suggestion.scope === "discussion" || suggestion.action === "discussion";
}
