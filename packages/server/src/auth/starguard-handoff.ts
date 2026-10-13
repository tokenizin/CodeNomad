/**
 * StarGuard SSO handoff → portal session.
 *
 * When the portal opts CodeNomad into handoff (SSO_HANDOFF_AUDIENCES ∋ codeNomad) its launch route
 * redirects to `/auth/starguard?handoff=<60 s single-use JWT>&audience=codeNomad` instead of putting the
 * user's session JWT in the URL. The handoff is NOT a session: CodeNomad swaps it, server-side, for its own
 * portal session via `POST {portal}/api/sso/exchange`, then continues exactly like the legacy
 * `?starguard_token=` flow (verify with AUTH_SECRET, create the CodeNomad session, set the cookie).
 */
import { resolveStarGuardPublicUrl } from "./auth-provider"

/** The `audience` the portal mints for CodeNomad (see HANDOFF_AUDIENCES in the portal's sso-handoff.ts). */
export const CODENOMAD_HANDOFF_AUDIENCE = "codeNomad"

const EXCHANGE_TIMEOUT_MS = 5_000
const MAX_HANDOFF_LENGTH = 4096
const COMPACT_JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

export interface ExchangeOptions {
  /** Portal origin; defaults to the StarGuard portal CodeNomad already redirects visitors to. */
  portalBaseUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * Swap a handoff for a portal session token. Returns null for anything that is not a clean success
 * (malformed token, portal 401/429/5xx, timeout, bad body) so the caller can answer 401 without
 * leaking why — and without redirecting back to /login, which is what made the portal loop.
 */
export async function exchangeStarGuardHandoff(handoff: string, options: ExchangeOptions = {}): Promise<string | null> {
  const token = handoff.trim()
  if (!token || token.length > MAX_HANDOFF_LENGTH || !COMPACT_JWT.test(token)) return null

  const base = (options.portalBaseUrl ?? resolveStarGuardPublicUrl()).replace(/\/+$/, "")
  const doFetch = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? EXCHANGE_TIMEOUT_MS)
  try {
    const res = await doFetch(`${base}/api/sso/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ handoffToken: token, audience: CODENOMAD_HANDOFF_AUDIENCE }),
      cache: "no-store",
      signal: controller.signal,
    })
    if (!res.ok) return null
    const body = (await res.json().catch(() => null)) as { sessionToken?: unknown; audience?: unknown } | null
    if (typeof body?.sessionToken !== "string" || !body.sessionToken) return null
    if (body.audience !== undefined && body.audience !== CODENOMAD_HANDOFF_AUDIENCE) return null
    return body.sessionToken
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
