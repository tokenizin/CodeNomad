/**
 * Context.ts — the engine-projection layer for the dynamic, context-aware
 * suggestion system (SCR-2026-11-18-001).
 *
 * Layering (S0):
 *   - This module mirrors the *engine-shaped* session emission and projects it
 *     into a single, product-consumable `Context`.
 *   - `agents.ts` is the *product contract* (Agent, Suggestion,
 *     `generateSuggestions()`) and is self-contained; it does NOT depend on
 *     this module. This module is the seam between raw engine data and the
 *     product contract — it produces `Context`, which the UI folds into a
 *     `SessionSnapshot` / `SuggestionContext` for `generateSuggestions()`.
 *
 * `Context` is the final, fully-projected object. `FromContext`,
 * `FromPrompt`, and `FromContextHistory` are the three ingestion shapes the
 * engine (or a test) can hand to the builders below:
 *
 *   - `fromContext()`            — from a full engine `{ session, chain }`.
 *   - `fromPrompt()`             — from prompt + conversationId only.
 *   - `fromContextHistory()`     — from a session + its serialized history.
 *
 * All builders are synchronous and pure: the historical async signatures
 * modelled engine transport, but the *projection* is pure, so the UI can
 * call them inline.
 */

import {
  type EngineSessions,
  type SessionSnapshot,
  currentSession,
} from "./sessions";
import type {
  Conversation,
  SessionKind,
  SessionPhase,
} from "./conversation";

// ── The product-consumable Context ─────────────────────────────────────

/**
 * The fully-projected context that downstream code (UI, generator adapter)
 * consumes. Every field is derived from the engine emission; nothing here
 * reaches into the SDK.
 */
export interface Context {
  /** The user's original/last prompt. */
  readonly prompt: string | null;
  /** The conversation id (groups messages and replies). */
  readonly conversationId: string;
  /** The last assistant history for this session, when available. */
  readonly history: string | null;
  /** The engine/session id (string). */
  readonly sessionId: string | null;
  /** The active chain entry id, when the chain is non-empty. */
  readonly chainId: number | null;
  /** The session kind. */
  readonly sessionType: SessionKind;
  /** The projected session phase (running/waiting/stopped). */
  readonly sessionState: SessionPhase;
  /** The model this turn is running under, if known. */
  readonly model: string | null;
  /** True once context has been projected from the engine. */
  readonly isContextGenerated: true;
}

// ── Ingestion shapes ───────────────────────────────────────────────────

/** Full engine emission: one `session` + its `chain` of entries. */
export type FromContext = EngineSessions;

/** Minimal prompt-only projection. */
export interface FromPrompt {
  readonly prompt: string | null;
  readonly conversationId: number | string;
}

/** A session + its serialized history, no chain. */
export interface FromContextHistory {
  readonly session: {
    readonly id: number;
    readonly type: SessionKind;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly sessionId?: string | null;
  };
  readonly history: string | null;
}

// ── Builders ───────────────────────────────────────────────────────────

/**
 * Project a full engine emission into `Context` via the session-chain layer
 * (sessions.ts). Re-exports the canonical `currentSession` projection so all
 * three ingestion paths agree on phase/kind handling.
 */
export function fromContext(from: FromContext, conversation?: Conversation): Context {
  const snapshot: SessionSnapshot = currentSession(from, conversation);
  return {
    prompt: snapshot.conversation.messages.length > 0
      ? String(snapshot.conversation.messages[0].content)
      : null,
    conversationId: snapshot.conversation.conversationId,
    history: snapshot.activeEntry?.history ?? null,
    sessionId: snapshot.sessionId,
    chainId: snapshot.activeEntry?.id ?? null,
    sessionType: snapshot.kind,
    sessionState: snapshot.phase,
    model: snapshot.model,
    isContextGenerated: true,
  };
}

/**
 * Minimal projection: prompt + conversation id only. The session has not yet
 * advanced, so phase is `stopped` and the session type defaults to `user`.
 */
export function fromPrompt(from: FromPrompt): Context {
  const prompt = from.prompt ?? null;
  return {
    prompt,
    conversationId: String(from.conversationId),
    history: null,
    sessionId: null,
    chainId: null,
    sessionType: "user",
    sessionState: "stopped",
    model: null,
    isContextGenerated: true,
  };
}

/**
 * Project a session + its serialized history (no chain) into `Context`.
 * With no chain the session is `stopped`; the history is recorded as-is.
 */
export function fromContextHistory(from: FromContextHistory): Context {
  return {
    prompt: null,
    conversationId: String(from.session.id),
    history: from.history,
    sessionId: from.session.sessionId ?? String(from.session.id),
    chainId: null,
    sessionType: from.session.type === "user" ? "user" : "discussion",
    sessionState: "stopped",
    model: null,
    isContextGenerated: true,
  };
}

/**
 * Bridge from a projected `Context` into the product `SuggestionContext`
 * shape the generator (agents.ts) consumes. Kept here so the engine layer
 * owns the fold and the product contract stays SDK-free.
 */
export function toSuggestionContext(ctx: Context): {
  sessionKind: SessionKind;
  sessionPhase: SessionPhase;
} {
  return {
    sessionKind: ctx.sessionType,
    sessionPhase: ctx.sessionState,
  };
}
