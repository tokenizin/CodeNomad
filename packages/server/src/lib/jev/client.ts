/**
 * Thin HTTP client for the TypeSafe AI System One endpoint.
 *
 * `POST {endpoint}` with `{ state, model, questions }` returns
 * `{ model, answers: { [key]: { type, noul?, choice?, score?, probabilities?, confidence? } }, usage }`.
 *
 * There is no text to parse: `answers` is keyed by question key and each answer is
 * already one of the three declared primitives. Every failure mode here throws a
 * `JevClientError` carrying an operator-readable `code`, so the caller can report a
 * degraded feed instead of silently treating it as a clean answer.
 */

import type { JevConfig } from "./config.js"

export type JevQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }

export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence: number; legend: Record<string, string> }

export type JevAnswers = Record<string, JevAnswer>

export interface JevResponse {
  model: string
  answers: JevAnswers
  inputTokens?: number
}

export type JevClientErrorCode =
  | "not-configured"
  | "timeout"
  | "network"
  | "http-error"
  | "malformed-response"

export class JevClientError extends Error {
  constructor(
    readonly code: JevClientErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = "JevClientError"
  }
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export interface JevClientOptions {
  config: JevConfig
  fetchImpl?: FetchLike
  now?: () => number
}

export interface DecideInput {
  state: string
  questions: Record<string, JevQuestion>
}

export function createJevClient(options: JevClientOptions) {
  const { config } = options
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
  const now = options.now ?? (() => Date.now())

  async function decide(input: DecideInput): Promise<JevResponse> {
    if (config.mode === "off") throw new JevClientError("not-configured", "JEV_TOOL_GATE is off")
    if (!config.apiKey) throw new JevClientError("not-configured", "TYPESAFE_API_KEY is not set")

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.timeoutMs)
    const startedAt = now()

    let response: Response
    try {
      response = await fetchImpl(config.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ state: input.state, model: config.model, questions: input.questions }),
        signal: controller.signal,
      })
    } catch (error) {
      const aborted = controller.signal.aborted || (error as { name?: string })?.name === "AbortError"
      if (aborted) {
        throw new JevClientError("timeout", `Jev did not answer within ${config.timeoutMs}ms`)
      }
      throw new JevClientError("network", `Jev request failed: ${(error as Error)?.message ?? error}`)
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "")
      throw new JevClientError("http-error", `Jev responded ${response.status}: ${body.slice(0, 200)}`, response.status)
    }

    const latencyMs = now() - startedAt
    const payload = await response.json().catch(() => {
      throw new JevClientError("malformed-response", "Jev response body was not JSON")
    })

    const answers = normalizeAnswers(payload)
    if (!answers) {
      throw new JevClientError("malformed-response", "Jev response missing a usable `answers` object")
    }

    return {
      model: typeof payload?.model === "string" ? payload.model : config.model,
      answers,
      inputTokens: readUsage(payload?.usage),
    }
  }

  return { decide, latencyMs: (startedAt: number) => now() - startedAt }
}

function normalizeAnswers(payload: unknown): JevAnswers | null {
  if (!payload || typeof payload !== "object") return null
  const rawAnswers = (payload as { answers?: unknown }).answers
  if (!rawAnswers || typeof rawAnswers !== "object") return null

  const out: JevAnswers = {}
  for (const [key, value] of Object.entries(rawAnswers as Record<string, unknown>)) {
    const answer = normalizeAnswer(value)
    if (answer) out[key] = answer
  }
  return Object.keys(out).length > 0 ? out : null
}

function normalizeAnswer(value: unknown): JevAnswer | null {
  if (!value || typeof value !== "object") return null
  const answer = value as Record<string, unknown>

  if (answer.type === "noul" && isProbability(answer.noul)) {
    return { type: "noul", noul: answer.noul }
  }

  if (answer.type === "choice" && typeof answer.choice === "string") {
    return {
      type: "choice",
      choice: answer.choice,
      probabilities: readProbabilities(answer.probabilities),
      confidence: isProbability(answer.confidence) ? answer.confidence : 0,
    }
  }

  if (answer.type === "score" && typeof answer.score === "number") {
    return {
      type: "score",
      score: answer.score,
      probabilities: readProbabilities(answer.probabilities),
      confidence: isProbability(answer.confidence) ? answer.confidence : 0,
      legend: readStringRecord(answer.legend),
    }
  }

  return null
}

function readProbabilities(value: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!value || typeof value !== "object") return out
  for (const [key, probability] of Object.entries(value as Record<string, unknown>)) {
    if (typeof probability === "number" && Number.isFinite(probability)) out[key] = probability
  }
  return out
}

function readStringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!value || typeof value !== "object") return out
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") out[key] = entry
  }
  return out
}

function readUsage(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined
  const tokens = (value as { input_tokens?: unknown }).input_tokens
  return typeof tokens === "number" && Number.isFinite(tokens) ? tokens : undefined
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
}