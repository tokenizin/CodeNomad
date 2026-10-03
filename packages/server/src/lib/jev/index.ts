/**
 * Jev tool gate — server-side owner of the TypeSafe credential.
 *
 * The OpenCode plugin never holds `TYPESAFE_API_KEY`; it asks this module over the
 * existing authenticated plugin channel. That keeps the secret in the process that
 * already has the tunnel env, and keeps the gate testable without a live API key.
 */

import type { Logger } from "../../logger.js"
import { createJevClient, JevClientError, type FetchLike, type JevAnswers } from "./client.js"
import { describeMissingConfig, isJevConfigured, parseJevConfig, type JevAction, type JevConfig } from "./config.js"
import { buildGateState, evaluateGate, GATE_QUESTIONS, shouldInspect, type GateVerdict, type PendingAction } from "./gate.js"

export * from "./config.js"
export * from "./gate.js"
export type { JevAnswers, JevQuestion } from "./client.js"

export interface JevToolGateMetrics {
  inspected: number
  skipped: number
  ok: number
  degraded: number
  cacheHits: number
  wouldAsk: number
  wouldDeny: number
  enforced: number
  totalLatencyMs: number
  lastDegradedReason?: string
}

export interface JevToolGateOptions {
  config?: JevConfig
  fetchImpl?: FetchLike
  now?: () => number
  logger?: Pick<Logger, "debug" | "info" | "warn" | "error">
}

interface CacheEntry {
  answers: JevAnswers
  model: string
  expiresAt: number
}

export function createJevToolGate(options: JevToolGateOptions = {}) {
  const config = options.config ?? parseJevConfig()
  const now = options.now ?? (() => Date.now())
  const logger = options.logger
  const client = createJevClient({ config, fetchImpl: options.fetchImpl, now })
  const cache = new Map<string, CacheEntry>()

  const metrics: JevToolGateMetrics = {
    inspected: 0,
    skipped: 0,
    ok: 0,
    degraded: 0,
    cacheHits: 0,
    wouldAsk: 0,
    wouldDeny: 0,
    enforced: 0,
    totalLatencyMs: 0,
  }

  function cacheKey(action: PendingAction): string {
    const state = buildGateState(action, config.maxStateChars)
    let hash = 5381
    for (let i = 0; i < state.length; i += 1) {
      hash = ((hash << 5) + hash + state.charCodeAt(i)) | 0
    }
    return `${action.kind}:${hash}`
  }

  async function loadAnswers(action: PendingAction): Promise<{ answers?: JevAnswers; model?: string; cached: boolean }> {
    const key = cacheKey(action)
    const hit = cache.get(key)
    if (hit && hit.expiresAt > now()) {
      metrics.cacheHits += 1
      return { answers: hit.answers, model: hit.model, cached: true }
    }

    const state = buildGateState(action, config.maxStateChars)
    const response = await client.decide({ state, questions: GATE_QUESTIONS })
    if (config.cacheTtlMs > 0) cache.set(key, { answers: response.answers, model: response.model, expiresAt: now() + config.cacheTtlMs })
    return { answers: response.answers, model: response.model, cached: false }
  }

  /**
   * Inspect one pending action. Never throws: every failure path resolves to a
   * degraded verdict whose `action` is the operator's declared fallback.
   */
  async function evaluate(action: PendingAction, baseline?: JevAction): Promise<GateVerdict> {
    if (!shouldInspect(config, action.kind)) {
      metrics.skipped += 1
      return evaluateGate({ config, status: "disabled", degradedReason: "kind-not-gated", baseline })
    }

    if (!isJevConfigured(config)) {
      metrics.degraded += 1
      const degradedReason = describeMissingConfig(config)
      metrics.lastDegradedReason = degradedReason
      logger?.warn({ degradedReason, kind: action.kind }, "Jev tool gate is configured but unusable")
      return evaluateGate({ config, status: "disabled", degradedReason, baseline })
    }

    metrics.inspected += 1
    const startedAt = now()

    try {
      const { answers, model, cached } = await loadAnswers(action)
      const verdict = evaluateGate({ config, status: "ok", answers, model, cached, latencyMs: now() - startedAt, baseline })
      metrics.ok += 1
      metrics.totalLatencyMs += verdict.latencyMs
      if (config.mode === "shadow") {
        if (verdict.action === "ask") metrics.wouldAsk += 1
        if (verdict.action === "deny") metrics.wouldDeny += 1
      } else if (verdict.enforced && verdict.action !== "allow") {
        metrics.enforced += 1
      }
      if (verdict.action !== "allow" || config.mode === "shadow") {
        logger?.info(
          { kind: action.kind, action: verdict.action, reason: verdict.reason, mode: config.mode, scores: verdict.scores, latencyMs: verdict.latencyMs, cached },
          "Jev tool gate verdict",
        )
      }
      return verdict
    } catch (error) {
      metrics.degraded += 1
      const degradedReason = error instanceof JevClientError ? error.code : "unexpected"
      metrics.lastDegradedReason = degradedReason
      logger?.warn({ degradedReason, kind: action.kind, message: (error as Error)?.message }, "Jev tool gate feed degraded")
      return evaluateGate({ config, status: "degraded", degradedReason, latencyMs: now() - startedAt, baseline })
    }
  }

  return {
    config,
    evaluate,
    isEnabled: () => isJevConfigured(config),
    metrics: () => ({ ...metrics }),
    resetMetrics: () => {
      metrics.inspected = 0
      metrics.skipped = 0
      metrics.ok = 0
      metrics.degraded = 0
      metrics.cacheHits = 0
      metrics.wouldAsk = 0
      metrics.wouldDeny = 0
      metrics.enforced = 0
      metrics.totalLatencyMs = 0
      metrics.lastDegradedReason = undefined
    },
  }
}

export type JevToolGate = ReturnType<typeof createJevToolGate>