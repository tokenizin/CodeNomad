/**
 * sessions.ts — S0 session-chain state model + pure state-management helpers
 * for the dynamic, context-aware suggestion system (SCR-2026-11-18-001).
 *
 * A "session chain" is the ordered list of turns the engine has executed for
 * one conversation. This module owns:
 *
 *   1. `SessionChainEntry` — the narrow, engine-shaped projection a chain node
 *      exposes, mirroring the fields `packages/logic/suggestions/Context.ts`
 *      historically read (status / prompt / history / model / error).
 *   2. `EngineSessions` — the `{ session, chain }` payload as the engine emits
 *      it (mirrored here so the module has no SDK import).
 *   3. `SessionSnapshot` — the *current* view of a session: its type, the
 *      active conversation pointer, and the phase projected from the latest
 *      chain entry via `phaseForStatus`.
 *   4. Pure, append-only helpers that build and advance a chain. They are
 *      synchronous, allocation-clean, and unit-testable — no I/O, no async.
 *
 * Why synchronous? The historical `sessions()` here returned a `Promise` to
 * model async engine transport, but the *state logic* it performed was pure.
 * Keeping the core synchronous lets the UI call `currentSession()` /
 * `advanceSessionChain()` inline during render without an effect storm, and
 * lets tests assert on plain values. Async transport can wrap these later
 * (S1) in a thin adapter without touching the state model.
 */

import {
  phaseForStatus,
  type ChatMessage,
  type Conversation,
  type EngineSessionStatus,
  type SessionKind,
  type SessionPhase,
  type UserPrompt,
  type AssistantText,
} from "./conversation";

// ── Engine-shaped chain entry ──────────────────────────────────────────

/**
 * A single node in the session chain. Mirrors the engine's chain row
 * (see historical `Context.ts`: status/prompt/history/model/error/sessionId/
 * promptId). `status` is the engine vocabulary; `phase` is the derived
 * product view.
 */
export interface SessionChainEntry {
  readonly id: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The engine status this turn settled into. */
  readonly status: EngineSessionStatus;
  /** The derived product phase, when projected. */
  readonly phase?: SessionPhase;
  readonly prompt?: string | null;
  /** Serialized transcript/history for this turn, when available. */
  readonly history?: string | null;
  readonly error?: string | null;
  readonly model?: string | null;
  readonly sessionId?: string | null;
  readonly promptId?: string | null;
}

/**
 * The engine's raw session emission: one `session` row plus its `chain` of
 * entries. Mirrored locally to keep the module SDK-free.
 */
export interface EngineSessions {
  readonly session: {
    readonly id: number;
    readonly type: SessionKind;
    readonly mode: "agent" | "discussion";
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly sessionId?: string | null;
  };
  readonly chain: readonly SessionChainEntry[];
}

// ── Current-session snapshot ───────────────────────────────────────────

/**
 * The "current session" view the suggestion generator consumes. It is derived
 * from `EngineSessions` but normalised into the product vocabulary
 * (`phase`, `kind`, `activeConversation`).
 */
export interface SessionSnapshot {
  /** Stable UI/engine session id (string). */
  readonly sessionId: string;
  /** `user` (single-agent) or `discussion` (threaded / multi-agent). */
  readonly kind: SessionKind;
  /** Projected phase, from the newest chain entry's status. */
  readonly phase: SessionPhase;
  /** The conversation this session is pointed at (empty when none yet). */
  readonly conversation: Conversation;
  /** The active chain entry, when the chain is non-empty. */
  readonly activeEntry: SessionChainEntry | undefined;
  /** The model this turn is running under, if known. */
  readonly model: string | null;
}

// ── Projection ─────────────────────────────────────────────────────────

/**
 * Project engine session emission into the `SessionSnapshot` the generator
 * consumes. The projected phase comes from the *latest* chain entry — when
 * the chain is empty, the session is `stopped` (nothing to continue).
 *
 * `conversation` is rebuilt from the latest entry's transcript when the
 * entry supplies a `prompt`/`history`; otherwise an empty conversation for
 * that promptId/conversation. This is intentionally best-effort: the UI
 * owns the canonical live conversation and passes a `Conversation` via
 * `withConversation()` below.
 */
export function currentSession(
  sessions: EngineSessions,
  conversation?: Conversation,
): SessionSnapshot {
  const session = sessions.session;
  const entries = sessions.chain ?? [];
  const activeEntry = entries.length > 0 ? entries[entries.length - 1] : undefined;

  const phase = activeEntry ? (activeEntry.phase ?? phaseForStatus(activeEntry.status)) : "stopped";

  const conv: Conversation =
    conversation ??
    (activeEntry?.prompt
      ? deriveConversation(session.id, activeEntry)
      : emptyConversation(session.id));

  return {
    sessionId: session.sessionId ?? String(session.id),
    kind: session.type,
    phase,
    conversation: conv,
    activeEntry,
    model: activeEntry?.model ?? null,
  };
}

/** Build an empty conversation keyed by the session/engine conversation id. */
export function emptyConversation(conversationId: string | number): Conversation {
  return { conversationId: String(conversationId), messages: [] };
}

/** Reconstruct a conversation from a chain entry's prompt/history (best-effort). */
export function deriveConversation(
  conversationId: string | number,
  entry: SessionChainEntry,
): Conversation {
  const messages: ChatMessage[] = [];
  if (entry.prompt) {
    messages.push({
      role: "user",
      content: entry.prompt,
      at: entry.createdAt,
      phaseBefore: entry.phase,
    } satisfies UserPrompt);
  }
  if (entry.history) {
    messages.push({
      role: "assistant",
      content: entry.history,
      at: entry.updatedAt,
      phaseAfter: entry.phase,
    } satisfies AssistantText);
  }
  return { conversationId: String(conversationId), messages };
}

// ── Chain state management (pure, append-only) ─────────────────────────

/**
 * Advance a chain by appending a new entry and returning the new
 * `EngineSessions` payload. The new entry's `phase` is projected from its
 * `status` so the chain is internally consistent.
 */
export function advanceSessionChain(
  sessions: EngineSessions,
  next: {
    readonly status: EngineSessionStatus;
    readonly now?: string;
    readonly prompt?: string | null;
    readonly history?: string | null;
    readonly error?: string | null;
    readonly model?: string | null;
  },
): EngineSessions {
  const now = next.now ?? new Date().toISOString();
  const nextId =
    sessions.chain.reduce((max, e) => Math.max(max, e.id), 0) + 1;

  const entry: SessionChainEntry = {
    id: nextId,
    createdAt: now,
    updatedAt: now,
    status: next.status,
    phase: phaseForStatus(next.status),
    prompt: next.prompt ?? null,
    history: next.history ?? null,
    error: next.error ?? null,
    model: next.model ?? null,
  };

  return {
    ...sessions,
    session: {
      ...sessions.session,
      updatedAt: now,
    },
    chain: [...sessions.chain, entry],
  };
}

/**
 * Start a fresh session chain for a conversation. Returns an `EngineSessions`
 * snapshot with an empty chain, `stopped` phase — the "no active turn yet"
 * state the generator treats as "stopped / fresh" for its follow-up
 * suggestions.
 */
export function startSessionChain(kind: SessionKind, sessionId: string): EngineSessions {
  const now = new Date().toISOString();
  return {
    session: {
      id: 0,
      type: kind,
      mode: kind === "discussion" ? "discussion" : "agent",
      createdAt: now,
      updatedAt: now,
      sessionId,
    },
    chain: [],
  };
}

/**
 * Re-project every chain entry's `phase` from its `status`. Useful when the
 * `SESSION_STATUS_TO_PHASE` table changes or when an ingested chain predates
 * phase projection. Returns a new payload; does not mutate.
 */
export function reprojectPhases(sessions: EngineSessions): EngineSessions {
  return {
    ...sessions,
    chain: sessions.chain.map((e) =>
      e.phase ? e : { ...e, phase: phaseForStatus(e.status) },
    ),
  };
}

/**
 * Whether the session has a live, non-closed turn. Mirrors the product's
 * "is the agent busy?" question the suggestion UI asks.
 */
export function isSessionLive(snapshot: SessionSnapshot): boolean {
  return snapshot.phase === "running" || snapshot.phase === "waiting";
}
