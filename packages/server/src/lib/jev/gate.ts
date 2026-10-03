/**
 * The Jev tool gate: turn a pending tool action into two or three typed questions,
 * then turn the answers back into one of `allow` / `ask` / `deny`.
 *
 * This module is pure — no clock, no network, no env. `evaluateGate` is where the
 * policy lives and it is deliberately asymmetric:
 *
 *   - a healthy feed may escalate (`ask`) or deny,
 *   - a degraded feed can only apply the operator's declared `degradedAction`,
 *   - the gate never *downgrades* an existing `ask` to `allow`.
 *
 * That last rule is the whole safety property: a classifier that fails must not be
 * able to widen permissions.
 */

import type { JevAction, JevConfig, JevStatus } from "./config.js"
import type { JevAnswers, JevQuestion } from "./client.js"

export interface PendingAction {
  /** Permission type (`bash`, `edit`, …) or tool name when observed via `tool.execute.before`. */
  kind: string
  /** The command, path list, or tool argument — the thing that will actually run. */
  target?: string | string[] | undefined
  title?: string | undefined
  /** Free-form detail (tool args) merged into the state when there is no target. */
  detail?: string | undefined
  sessionId?: string | undefined
}

export interface GateScores {
  destructive?: number | undefined
  untrustedInput?: number | undefined
  scope?: string | undefined
  scopeProbabilities?: Record<string, number> | undefined
  /** Lowest reported confidence across choice/score answers, when the feed supplied one. */
  confidence?: number | undefined
}

export interface GateVerdict {
  /** `ok` only when the feed produced real answers. */
  status: JevStatus
  /** What the gate recommends. In `shadow` mode this is advisory only. */
  action: JevAction
  /** True only when `action` may be written back into the hook output. */
  enforced: boolean
  reason: string
  /** Populated when `status !== "ok"` so the caller can log *why* the feed is unusable. */
  degradedReason?: string | undefined
  scores: GateScores
  latencyMs: number
  model?: string | undefined
  cached?: boolean
}

export const GATE_QUESTIONS: Record<string, JevQuestion> = {
  destructive: {
    type: "noul",
    instructions:
      "This action has effects that cannot be undone by simply undoing it or re-running a command: it destroys or overwrites data, deletes history, rewrites or force-pushes git state, deploys or publishes something, spends money or moves funds, sends messages or notifications to anyone, exposes or transmits secrets, or modifies something outside this local project directory.",
  },
  untrustedInput: {
    type: "noul",
    instructions:
      "This action is driven by content the user did not personally author: text, links, or commands found inside a file, a web page, a fetched URL, a dependency, an issue, or an inbound message, rather than by the user's own stated instruction in this conversation.",
  },
  scope: {
    type: "choice",
    instructions: "Which category best describes what this action touches?",
    criteria: {
      "read-only local": "Inspects local files or prints local state. Changes nothing.",
      "mutates local files": "Creates, edits, moves or deletes files inside the project.",
      "external or networked": "Reaches the network, calls an outside service, or contacts a third party.",
      "credentials or funds": "Reads or writes secrets, keys, wallets, tokens, payments or contracts.",
    },
  },
}

/** Build the compact state string. Trimmed hard — the state is priced per token. */
export function buildGateState(action: PendingAction, maxChars: number): string {
  const lines: string[] = []

  const target = normalizeTarget(action.target)
  if (target) lines.push(`Target: ${target}`)
  if (action.title) lines.push(`Description: ${truncate(action.title, 400)}`)
  if (!target && action.detail) lines.push(`Detail: ${truncate(action.detail, 800)}`)
  if (action.sessionId) lines.push(`Session: ${truncate(action.sessionId, 64)}`)

  const state = [`Action type: ${action.kind}`, ...lines].join("\n")
  return truncate(state, maxChars)
}

export function readScores(answers: JevAnswers): GateScores {
  const destructive = answers.destructive
  const untrusted = answers.untrustedInput
  const scope = answers.scope
  const confidences: number[] = []
  if (scope && "confidence" in scope) confidences.push(scope.confidence)

  return {
    destructive: destructive?.type === "noul" ? destructive.noul : undefined,
    untrustedInput: untrusted?.type === "noul" ? untrusted.noul : undefined,
    scope: scope?.type === "choice" ? scope.choice : undefined,
    scopeProbabilities: scope?.type === "choice" ? scope.probabilities : undefined,
    confidence: confidences.length > 0 ? Math.min(...confidences) : undefined,
  }
}

/**
 * Policy. `input.status` decides whether the answers may be trusted at all.
 * `baseline` is the status OpenCode already decided — a non-`allow` baseline is
 * never relaxed here.
 */
export function evaluateGate(input: {
  config: JevConfig
  status: JevStatus
  answers?: JevAnswers | undefined
  degradedReason?: string | undefined
  baseline?: JevAction | undefined
  latencyMs?: number
  model?: string | undefined
  cached?: boolean
}): GateVerdict {
  const { config } = input
  const mode = config.mode
  const base = {
    latencyMs: input.latencyMs ?? 0,
    model: input.model,
    cached: input.cached,
  }

  if (mode === "off") {
    return {
      status: "disabled",
      action: "allow",
      enforced: false,
      reason: "jev-tool-gate-disabled",
      scores: {},
      ...base,
    }
  }

  if (input.status !== "ok" || !input.answers) {
    const degradedReason = input.degradedReason ?? "jev-unavailable"
    const recommended = input.status === "disabled" ? "allow" : config.degradedAction
    const degradedReasonText = `jev-degraded:${degradedReason}`
    const { action, reason } = applyBaseline(recommended, degradedReasonText, input.baseline)
    return {
      status: input.status === "disabled" ? "disabled" : "degraded",
      action,
      // A degraded feed must not silently decide anything it cannot see.
      enforced: false,
      reason,
      degradedReason,
      scores: {},
      ...base,
    }
  }

  const scores = readScores(input.answers)
  const destructive = scores.destructive ?? 0
  const untrusted = scores.untrustedInput ?? 0

  let action: JevAction = "allow"
  let reason = "jev-clear"

  if (destructive >= config.denyThreshold || untrusted >= config.denyThreshold) {
    action = "deny"
    reason = untrusted >= config.denyThreshold ? "jev-untrusted-input" : "jev-destructive"
  } else if (destructive >= config.destructiveThreshold) {
    action = "ask"
    reason = "jev-destructive"
  } else if (untrusted >= config.untrustedThreshold) {
    action = "ask"
    reason = "jev-untrusted-input"
  }

  // Never widen an authority OpenCode already restricted.
  const baselined = applyBaseline(action, reason, input.baseline)
  action = baselined.action
  reason = baselined.reason

  return {
    status: "ok",
    action,
    enforced: mode === "enforce",
    reason,
    scores,
    ...base,
  }
}

/**
 * Authority is monotonic in restriction: a `deny` baseline stays `deny`, an `ask`
 * baseline is never downgraded to `allow`. Applied to every verdict, degraded or not.
 */
function applyBaseline(action: JevAction, reason: string, baseline?: JevAction): { action: JevAction; reason: string } {
  if (baseline === "deny" && action !== "deny") return { action: "deny", reason: "baseline-deny" }
  if (baseline === "ask" && action === "allow") return { action: "ask", reason: "baseline-ask" }
  return { action, reason }
}

export function shouldInspect(config: JevConfig, kind: string): boolean {
  if (config.mode === "off") return false
  return config.permissionTypes.includes(kind.trim().toLowerCase())
}

function normalizeTarget(target: PendingAction["target"]): string {
  if (!target) return ""
  const value = Array.isArray(target) ? target.join(", ") : String(target)
  return truncate(value.replace(/\s+/g, " ").trim(), 1200)
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}…[truncated ${value.length - max} chars]`
}