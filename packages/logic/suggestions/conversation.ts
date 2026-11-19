/**
 * conversation.ts — S0 core types for the conversation / session-chain layer
 * of the dynamic, context-aware suggestion system (SCR-2026-11-18-001).
 *
 * This module owns the *shape of a conversation* and the *session-chain state
 * model* the suggestion generator reasons over. It deliberately has NO runtime
 * dependency on the OpenCode SDK: it mirrors the engine's session status
 * vocabulary (see `EngineSessionStatus` below) so the logic package stays
 * importable in isolation, testable, and free of UI/transport coupling.
 *
 * Vocabulary bridge
 * -----------------
 * The engine (`packages/ui/src/types/session.ts`) models a session with
 * `SessionStatus = "idle" | "working" | "compacting"` plus the side signals
 * `pendingPermission`, `pendingQuestion`, and `retry`. The product spec for
 * this feature, however, is expressed in a three-state *view* model:
 *
 *   running  → the agent has an active turn in flight
 *   waiting  → the turn is blocked on the user (permission / question / retry)
 *   stopped  → the turn has ended (complete / error / idle) and is closed
 *
 * `SessionPhase` is that view model. `SESSION_STATUS_TO_PHASE` is the single
 * source of truth that maps engine status into it — owned here, not in the UI.
 */

// ── Session phase (the product view model) ─────────────────────────────

/** The three product-facing phases a session can present in. */
export type SessionPhase = "running" | "waiting" | "stopped";

/** The kind of session / thread the context belongs to. */
export type SessionKind = "user" | "discussion";

/**
 * Engine-side session status, mirroring the narrow parts of
 * `packages/ui/src/types/session.ts` that affect phase. Kept local and
 * deliberately narrow so the logic module has no SDK import. Extend this
 * union (and the map below) when the engine adds new status semantics.
 */
export type EngineSessionStatus =
  | "idle"
  | "working"
  | "compacting"
  | "pending-permission"
  | "pending-question"
  | "retry"
  | "error";

/**
 * Single source of truth: engine status → product phase.
 *
 * Rationale:
 *  - `working` / `compacting` → `running` (active, streaming work).
 *  - `pending-permission` / `pending-question` / `retry` → `waiting`
 *    (the turn is alive but blocked on the user / a transient backoff).
 *  - `idle` / `error` → `stopped` (the turn has ended and is closed).
 */
export const SESSION_STATUS_TO_PHASE: Readonly<Record<EngineSessionStatus, SessionPhase>> = {
  working: "running",
  compacting: "running",
  "pending-permission": "waiting",
  "pending-question": "waiting",
  retry: "waiting",
  idle: "stopped",
  error: "stopped",
} as const;

// ── Chat message roles ─────────────────────────────────────────────────

/** Roles a message in a conversation chain can take. */
export type ChatRole = "user" | "assistant" | "agent" | "system";

// ── The two message shapes the spec calls out explicitly ───────────────

/**
 * A user turn: the prompt the user submitted.
 *
 * `phaseBefore` records what phase the session was in *when the prompt was
 * sent* — this is what lets the generator offer *follow-up / summarize* style
 * suggestions after a stopped turn, versus *continue / retry* while running.
 */
export interface UserPrompt {
  readonly role: "user";
  readonly content: string;
  /** ISO timestamp the prompt was submitted. */
  readonly at?: string;
  /** The phase the session was in before this prompt advanced the chain. */
  readonly phaseBefore?: SessionPhase;
}

/**
 * An assistant turn: the agent's text response (the "AssistantText" the
 * product spec names). Carries `phaseAfter` so a closed turn can be detected
 * even before the next prompt arrives.
 */
export interface AssistantText {
  readonly role: "assistant";
  readonly content: string;
  /** ISO timestamp the turn completed. */
  readonly at?: string;
  /** The phase the session settled into after this turn. */
  readonly phaseAfter?: SessionPhase;
}

/**
 * Any message in a conversation chain. `UserPrompt | AssistantText` are the
 * two spec-named shapes; a broader `system` / `agent` slot keeps the union
 * forward-compatible with engine-internal turns without breaking the two
 * known shapes.
 */
export type ChatMessage =
  | UserPrompt
  | AssistantText
  | {
      readonly role: "agent";
      readonly content: string;
      readonly agentId?: string;
      readonly at?: string;
    }
  | {
      readonly role: "system";
      readonly content: string;
      readonly at?: string;
    };

/**
 * A conversation is an ordered, append-only chain of messages grouped under a
 * single `conversationId`. This is the "conversation (UserPrompt,
 * AssistantText)" the Agent interface (agents.ts) holds.
 */
export interface Conversation {
  readonly conversationId: string;
  readonly messages: readonly ChatMessage[];
}

// ── Pure helpers (no I/O, unit-testable) ────────────────────────────────

/**
 * Project an engine status to a product phase. Unknown / undefined falls back
 * to `stopped` (the safe, closed state) so a suggestion UI never offers
 * *continue / stop* against a turn it cannot see as live.
 */
export function phaseForStatus(status: EngineSessionStatus | null | undefined): SessionPhase {
  if (status == null) return "stopped";
  return SESSION_STATUS_TO_PHASE[status] ?? "stopped";
}

/** The last message in a conversation, or `undefined` when empty. */
export function lastMessage(conversation: Conversation): ChatMessage | undefined {
  return conversation.messages[conversation.messages.length - 1];
}

/** The most recent `UserPrompt` in a conversation, or `undefined`. */
export function lastUserPrompt(conversation: Conversation): UserPrompt | undefined {
  for (let i = conversation.messages.length - 1; i >= 0; i--) {
    const m = conversation.messages[i];
    if (m.role === "user") return m;
  }
  return undefined;
}

/** The most recent `AssistantText` in a conversation, or `undefined`. */
export function lastAssistantText(conversation: Conversation): AssistantText | undefined {
  for (let i = conversation.messages.length - 1; i >= 0; i--) {
    const m = conversation.messages[i];
    if (m.role === "assistant") return m;
  }
  return undefined;
}

/** Append a message to a conversation, returning a new (immutably-copied) one. */
export function appendMessage(
  conversation: Conversation,
  message: ChatMessage,
): Conversation {
  return { ...conversation, messages: [...conversation.messages, message] };
}

/** A fresh, empty conversation. */
export function createConversation(conversationId: string): Conversation {
  return { conversationId, messages: [] };
}
