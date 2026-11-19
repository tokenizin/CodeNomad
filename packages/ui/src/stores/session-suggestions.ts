/**
 * session-suggestions.ts — S1 seam wiring the context-aware suggestion engine
 * (packages/logic/suggestions, S0) to the CodeNomad UI store layer
 * (SCR-2026-11-18-001, TASK-2026-11-18-suggestions-context-aware).
 *
 * What this file does
 * -------------------
 *   1. Reads a *structural slice* of the live engine session (status + the
 *      client-side block signals `pendingPermission` / `pendingQuestion` /
 *      `retry`) and projects it to a product `SessionPhase` via the
 *      single-source-of-truth `SESSION_STATUS_TO_PHASE` table the S0 layer
 *      owns.
 *   2. Maps the UI's roster of `Agent`s (name/description/mode) into the S0
 *      `Agent` contract (id/name/skills/memory/conversation) so the generator
 *      can produce agent-scoped sub-suggestions.
 *   3. Calls the pure `generateSuggestions()` / `suggestionsForEngineSession()`
 *      to yield the phase-appropriate suggestion list the prompt bar renders.
 *
 * Why a store, not inline in the component
 * ----------------------------------------
 *   The prompt-input surface already watches a busy → idle transition and
 *   generates prompt recommendations in `prompt-recommendations.ts`. This seam
 *   is the bridge so that, on the same transition, phase-aware suggestions
 *   (running/waiting → Continue/Retry/Stop; stopped → Follow-up/Summarize/
 *   Diagnose/Fix) flow in. It stays Solid-free in the *pure* helpers so the
 *   projection is unit-testable; only `updateSessionSuggestions()` touches a
 *   signal.
 *
 * Dependency discipline (mirror of packages/logic)
 * ------------------------------------------------
 *   The engine's session shape is *mirrored*, never imported from the OpenCode
 *   SDK, so this module stays transport-free. The phase vocabulary is imported
 *   from the S0 logic barrel and never re-declared here (SSOT).
 */

import {
  generateSuggestions,
  phaseForStatus,
  type EngineSessionStatus,
  type SessionPhase,
  type SessionKind,
  type Suggestion,
  type Agent as LogicAgent,
  type AgentRegistry,
  type AgentSkill,
} from "../../../logic/suggestions/index.ts"

// ── The engine view the seam consumes ─────────────────────────────────

/**
 * The narrow slice of the live engine `Session` the seam reasons over. It is a
 * structural `Pick` over `packages/ui/src/types/session.ts::Session` declared
 * here so this module imports no Solid signal and no SDK type.
 *
 *   - `status`      — engine status (`idle | working | compacting`), which the
 *                     `SESSION_STATUS_TO_PHASE` table projects.
 *   - `pendingPermission` / `pendingQuestion` — client-side "the turn is blocked
 *                     on the user" booleans; together they constitute the
 *                     `waiting` phase (ADR § Discrepancy resolution).
 *   - `retry`       — transient backoff state; its presence keeps the phase
 *                     `waiting` rather than falling through to `stopped`.
 */
export interface EngineSessionView {
  readonly status?: "idle" | "working" | "compacting" | EngineSessionStatus
  readonly pendingPermission?: boolean
  readonly pendingQuestion?: boolean
  readonly retry?: { readonly next?: number } | null
}

/**
 * A UI roster agent as the prompt surface knows it — the minimal projection the
 * seam needs to build the S0 `Agent` contract. Mirrors `Agent` in
 * `packages/ui/src/types/session.ts` without importing it.
 */
export interface UiAgentView {
  readonly name: string
  readonly description?: string
  readonly mode?: string
  readonly hidden?: boolean
}

/**
 * The full context the seam folds into the generator: the engine view, the
 * optional session kind (discussion vs single-agent), the UI agent roster, and
 * the agent currently owning the turn.
 */
export interface SessionSuggestionContext {
  readonly session: EngineSessionView
  readonly kind?: SessionKind
  readonly agents?: readonly UiAgentView[]
  readonly activeAgentName?: string
  /** Clock override for tests; defaults to `Date.now()` where used. */
  readonly now?: number
}

// ── Engine status → phase ─────────────────────────────────────────────

/**
 * Project a live engine session view to its product `SessionPhase`, folding the
 * client-side `pendingPermission` / `pendingQuestion` / `retry` block signals
 * into the `waiting` phase before the status table is consulted.
 *
 * Precedence:
 *   1. `waiting`  — `pendingPermission` or `pendingQuestion` (the turn is alive
 *                   but blocked on the user) OR a transient `retry` backoff.
 *   2. otherwise  — `SESSION_STATUS_TO_PHASE[status]` (working/compacting →
 *                   running; idle/error → stopped; unknown → stopped).
 */
export function engineSessionPhase(
  view: Pick<EngineSessionView, "status" | "pendingPermission" | "pendingQuestion" | "retry">,
): SessionPhase {
  if (view.pendingPermission || view.pendingQuestion) return "waiting"
  if (view.retry != null) return "waiting"
  return phaseForStatus(view.status)
}

// ── UI agent roster → S0 registry ─────────────────────────────────────

/**
 * Default route skills a primary agent carries when its name/description match
 * no capability keyword — so a primary agent is never silent, while no-skill
 * agents contribute nothing (S0 invariant).
 */
const PRIMARY_ROUTE_SKILLS: readonly AgentSkill[] = ["code", "review"]

/**
 * Capability keyword → skill. Scanned against `name + description` (lower-cased)
 * to infer an agent's routing capabilities from the UI roster, which carries no
 * explicit skill tags.
 */
const SKILL_KEYWORDS: Record<AgentSkill, readonly string[]> = {
  code: ["code", "implement", "write", "build", "feature", "develop", "patch"],
  review: ["review", "audit", "check", "quality", "critique"],
  test: ["test", "qa", "verify", "spec", "assert"],
  diagnose: ["diagnos", "debug", "fix", "investigat", "troubleshoot"],
  document: ["document", "doc", "write", "spec", "adrs"],
  design: ["design", "ux", "ui", "visual", "layout"],
  research: ["research", "analy", "investigat", "explore", "study"],
  deploy: ["deploy", "release", "ship", "ci", "cd", "pipeline"],
}

/** Inference for one UI agent: keyword-derived skills, or the default route set. */
export function inferAgentSkills(agent: UiAgentView): AgentSkill[] {
  const haystack = `${agent.name} ${agent.description ?? ""}`.toLowerCase()
  const matched = new Set<AgentSkill>()
  for (const [skill, keywords] of Object.entries(SKILL_KEYWORDS)) {
    for (const kw of keywords) {
      if (haystack.includes(kw)) {
        matched.add(skill as AgentSkill)
      }
    }
  }
  return matched.size > 0 ? [...matched] : [...PRIMARY_ROUTE_SKILLS]
}

/**
 * Whether a UI agent is a routing target (primary, not hidden, not a subagent).
 * Mirrors the UI's primary-agent visibility rule.
 */
function isRoutableAgent(agent: UiAgentView): boolean {
  return !agent.hidden && agent.mode !== "subagent"
}

/**
 * Map the UI agent roster into the S0 `AgentRegistry` the generator consumes.
 * Subagents and hidden agents are dropped; each routable agent gets keyword-
 * inferred skills and an empty conversation/memory (forward-compatible).
 */
export function toSuggestionRegistry(
  agents: readonly UiAgentView[],
  activeAgentName?: string,
): AgentRegistry {
  const roster: LogicAgent[] = agents
    .filter(isRoutableAgent)
    .map((agent) => ({
      id: agent.name,
      name: agent.name,
      skills: inferAgentSkills(agent),
      memory: {},
      conversation: { conversationId: `agent:${agent.name}`, messages: [] },
    }))
  return { agents: roster, activeAgentId: activeAgentName }
}

// ── The fold ──────────────────────────────────────────────────────────

/**
 * Generate phase/context-aware suggestions for a live engine session.
 *
 * Projects the engine view to a phase, adapts the UI roster to the S0 registry
 * (when supplied), and delegates to the pure `generateSuggestions()`. Pure:
 * same context + same roster yields the same suggestion array.
 */
export function suggestionsForEngineSession(ctx: SessionSuggestionContext): Suggestion[] {
  const phase = engineSessionPhase(ctx.session)
  const kind: SessionKind = ctx.kind ?? "user"
  const registry =
    ctx.agents && ctx.agents.length > 0
      ? toSuggestionRegistry(ctx.agents, ctx.activeAgentName)
      : undefined
  return generateSuggestions({ phase, kind, registry })
}
