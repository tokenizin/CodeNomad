/**
 * Jev (TypeSafe AI "System One") tool-gate configuration.
 *
 * Defaults are deliberately OFF. The gate is a new authority over tool execution,
 * so it earns that authority incrementally: off -> shadow (observe) -> enforce.
 */

export type JevMode = "off" | "shadow" | "enforce"

/** What the gate does with a pending permission. Mirrors the OpenCode hook output. */
export type JevAction = "allow" | "ask" | "deny"

/**
 * A degraded feed must never be indistinguishable from a clean pass.
 * `disabled` = no gate configured; `degraded` = configured but the feed is unusable
 * (no key, timeout, upstream error, malformed response).
 */
export type JevStatus = "ok" | "degraded" | "disabled"

export interface JevConfig {
  mode: JevMode
  apiKey?: string
  endpoint: string
  model: string
  timeoutMs: number
  /** Probability at or above which a destructive action is escalated to a human. */
  destructiveThreshold: number
  /** Probability at or above which untrusted-input provenance is escalated to a human. */
  untrustedThreshold: number
  /** Probability at or above which the gate actively denies (never allows) the action. */
  denyThreshold: number
  /** Action taken when the feed is degraded. Must be declared, never implicit. */
  degradedAction: JevAction
  /** Permission types the gate inspects. Anything else passes through untouched. */
  permissionTypes: string[]
  maxStateChars: number
  cacheTtlMs: number
}

export const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone"
export const DEFAULT_MODEL = "jev-latest"

export const DEFAULT_PERMISSION_TYPES = ["bash", "edit", "write", "patch", "webfetch"]

const MODES: JevMode[] = ["off", "shadow", "enforce"]
const ACTIONS: JevAction[] = ["allow", "ask", "deny"]

export function parseJevConfig(env: NodeJS.ProcessEnv = process.env): JevConfig {
  const mode = parseEnum(env.JEV_TOOL_GATE, MODES, "off")
  return {
    mode,
    apiKey: env.TYPESAFE_API_KEY?.trim() || undefined,
    endpoint: env.JEV_BASE_URL?.trim() || DEFAULT_ENDPOINT,
    model: env.JEV_MODEL?.trim() || DEFAULT_MODEL,
    timeoutMs: parseNumber(env.JEV_TIMEOUT_MS, 1500, 100, 30_000),
    destructiveThreshold: parseProbability(env.JEV_DESTRUCTIVE_THRESHOLD, 0.6),
    untrustedThreshold: parseProbability(env.JEV_UNTRUSTED_THRESHOLD, 0.75),
    denyThreshold: parseProbability(env.JEV_DENY_THRESHOLD, 0.95),
    degradedAction: parseEnum(env.JEV_DEGRADED_ACTION, ACTIONS, "allow"),
    permissionTypes: parseList(env.JEV_PERMISSION_TYPES, DEFAULT_PERMISSION_TYPES),
    maxStateChars: parseNumber(env.JEV_MAX_STATE_CHARS, 2000, 200, 100_000),
    cacheTtlMs: parseNumber(env.JEV_CACHE_TTL_MS, 30_000, 0, 600_000),
  }
}

export function isJevConfigured(config: JevConfig): boolean {
  return config.mode !== "off" && Boolean(config.apiKey)
}

/** Reasons the gate cannot produce a verdict, in operator-facing language. */
export function describeMissingConfig(config: JevConfig): string {
  if (config.mode === "off") return "jev-tool-gate-disabled"
  if (!config.apiKey) return "typesafe-api-key-missing"
  return ""
}

function parseEnum<T extends string>(raw: string | undefined, allowed: T[], fallback: T): T {
  const value = raw?.trim().toLowerCase()
  if (!value) return fallback
  const match = allowed.find((candidate) => candidate === value)
  if (!match) {
    throw new Error(`Invalid value "${raw}" — expected one of: ${allowed.join(", ")}`)
  }
  return match
}

function parseNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = raw?.trim()
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid number "${raw}" — expected ${min}..${max}`)
  }
  return parsed
}

function parseProbability(raw: string | undefined, fallback: number): number {
  return parseNumber(raw, fallback, 0, 1)
}

function parseList(raw: string | undefined, fallback: string[]): string[] {
  const value = raw?.trim()
  if (!value) return fallback
  const items = value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
  return items.length > 0 ? items : fallback
}