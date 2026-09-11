/**
 * Voice WebSocket URL resolution for TokiDAPP sessions.
 * Ported from scripts/tokidapp-server/lib/voice-ws-url.ts so CodeNomad can mint
 * WS URLs without proxying session creation to the :8548 sidecar.
 *
 * Voice realtime lives on CodeNomad (:9940/tunnel), not the HTTP sidecar.
 */

const CODENOMAD_BASE = process.env.NEXT_PUBLIC_CODENOMAD_URL || '/codenomad'

function looksLikeJwt(token: string): boolean {
  return token.length > 50 && token.split('.').length === 3
}

/** Prefer JWT; fall back to userId for legacy callers. */
function resolveVoiceWsToken(userId: string, jwt?: string | null): string {
  const trimmed = typeof jwt === 'string' ? jwt.trim() : ''
  if (trimmed && looksLikeJwt(trimmed)) return trimmed
  return userId
}

/** Build a `wss://host/...` URL from host + protocol + token. */
export function buildVoiceWsUrl(
  host: string,
  wsProtocol: 'ws' | 'wss',
  token: string,
): string {
  return `${wsProtocol}://${host}/api/tokidapp/ws?token=${encodeURIComponent(token)}`
}

export interface CodenomadTunnelHealth {
  ok: boolean
  statusCode: number | null
  reason: string
}

const PROBE_TIMEOUT_MS = 8_000
const PROBE_RETRIES = 2

/** Probe CodeNomad's /api/auth/status to detect tunnel degradation. */
export async function probeCodenomadTunnelHealth(
  baseUrl: string,
): Promise<CodenomadTunnelHealth> {
  const trimmed = baseUrl.replace(/\/$/, '')
  if (!trimmed.startsWith('http')) {
    return { ok: false, statusCode: null, reason: 'relative_codenomad_url' }
  }

  const url = `${trimmed}/api/auth/status`
  let lastReason = 'fetch_failed'
  let lastStatus: number | null = null

  for (let attempt = 1; attempt <= PROBE_RETRIES; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)

    try {
      const res = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        cache: 'no-store',
      })
      lastStatus = res.status
      if (res.ok) {
        return { ok: true, statusCode: res.status, reason: 'ok' }
      }
      lastReason = `http_${res.status}`
    } catch (err) {
      lastReason = err instanceof Error ? err.message : 'fetch_failed'
      lastStatus = null
    } finally {
      clearTimeout(timer)
    }

    if (attempt < PROBE_RETRIES) {
      await new Promise((r) => setTimeout(r, 400))
    }
  }

  return { ok: false, statusCode: lastStatus, reason: lastReason }
}

/** Return the configured public CodeNomad base, or null if not absolute. */
export function codenomadPublicBase(): string | null {
  const base = process.env.NEXT_PUBLIC_CODENOMAD_URL?.trim() || ''
  if (!base.startsWith('http')) return null
  return base.replace(/\/$/, '')
}

/**
 * Always prefer a public CodeNomad base when configured.
 * Health probe is advisory — return a URL even when the tunnel is unhealthy
 * so the client can attempt WS and surface a real connection error.
 */
export async function resolveVoiceWsUrl(
  userId: string,
  jwt?: string | null,
): Promise<string | null> {
  if (!userId) return null
  const token = resolveVoiceWsToken(userId, jwt)

  const publicBase = codenomadPublicBase()
  if (publicBase) {
    try {
      const health = await probeCodenomadTunnelHealth(publicBase)
      if (!health.ok) {
        void safeEnqueueCodenomadTunnelRestart(health.reason, 'tokidapp_voice_url')
      }
      const parsed = new URL(publicBase)
      const wsProtocol = parsed.protocol === 'https:' ? 'wss' : 'ws'
      return buildVoiceWsUrl(parsed.host, wsProtocol, token)
    } catch {
      void safeEnqueueCodenomadTunnelRestart('probe_error', 'tokidapp_voice_url')
      try {
        const parsed = new URL(publicBase)
        const wsProtocol = parsed.protocol === 'https:' ? 'wss' : 'ws'
        return buildVoiceWsUrl(parsed.host, wsProtocol, token)
      } catch {
        return null
      }
    }
  }

  if (CODENOMAD_BASE.startsWith('http')) {
    const parsed = new URL(CODENOMAD_BASE)
    const wsProtocol = parsed.protocol === 'https:' ? 'wss' : 'ws'
    return buildVoiceWsUrl(parsed.host, wsProtocol, token)
  }

  return null
}

// ── Restart signal (stub — mirrors scripts/tokidapp-server/lib/restart-signal.ts)

export interface EnqueueRestartResult {
  enqueued: boolean
  requestedAt: number | null
  skipped?: string
  error?: string
}

/** Safe no-op: logs restart reason but never enqueues (Vercel Blob unavailable on Mac Studio). */
export async function safeEnqueueCodenomadTunnelRestart(
  reason: string,
  source: string,
): Promise<EnqueueRestartResult> {
  console.warn(
    `[tokidapp/voice-ws-url] Tunnel restart requested (reason=${reason}, source=${source}) — ` +
    `Vercel Blob signals are not available in CodeNomad. ` +
    `Mac Studio watchdog handles tunnel health independently.`,
  )
  return { enqueued: false, requestedAt: null, skipped: 'no_blob_sidecar' }
}
