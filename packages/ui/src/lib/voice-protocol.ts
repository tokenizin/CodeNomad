/**
 * CodeNomad vs Prestix voice protocol detection and mobile-safe error copy.
 *
 * CodeNomad UI must only open WS `/api/voice/session` (StarGuard JWT).
 * Prestix uses POST `/api/voice/realtime-token` → OpenAI Realtime — different stack.
 */

export type VoiceSystemKind = "codenomad" | "prestix" | "starworld"

const CODENOMAD_HOST_MARKERS = ["codenomad."]
const PRESTIX_HOST_MARKERS = ["prestix.", "prestixvip", "localhost"]

export function detectVoiceSystemFromLocation(loc?: Pick<Location, "hostname" | "port" | "pathname">): VoiceSystemKind {
  if (typeof window === "undefined") return "codenomad"

  const { hostname, port, pathname } = loc ?? window.location
  const host = hostname.toLowerCase()

  if (port === "9899" || CODENOMAD_HOST_MARKERS.some((m) => host.includes(m))) {
    return "codenomad"
  }

  if (
    pathname.includes("/codenomad") ||
    (host === "localhost" && port === "9899")
  ) {
    return "codenomad"
  }

  if (PRESTIX_HOST_MARKERS.some((m) => host.includes(m)) || port === "3000") {
    return "prestix"
  }

  return "starworld"
}

/** Returns a user-visible error when CodeNomad voice is invoked off-tunnel. */
export function assertCodeNomadVoiceContext(loc?: Pick<Location, "hostname" | "port" | "pathname">): string | null {
  const kind = detectVoiceSystemFromLocation(loc)
  if (kind === "codenomad") return null

  if (kind === "prestix") {
    return (
      "CodeNomad voice is not available on Prestix. " +
      "Use the site footer concierge voice (POST /api/voice/realtime-token)."
    )
  }

  return (
    "CodeNomad voice requires the tunnel (codenomad.prestix.vip). " +
    "Open CodeNomad via StarGuard SSO — not a direct URL."
  )
}

export function isMobileVoiceClient(): boolean {
  if (typeof navigator === "undefined") return false
  return /android|iphone|ipad|ipod|mobile|webos|blackberry/i.test(navigator.userAgent)
}

export function isSecureVoiceContext(): boolean {
  if (typeof window === "undefined") return true
  return window.isSecureContext
}

export function formatVoiceMicError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : ""
  const message = err instanceof Error ? err.message : String(err ?? "unknown")

  if (name === "NotAllowedError" || /permission/i.test(message)) {
    return isMobileVoiceClient()
      ? "Microphone blocked — allow mic for this site in browser settings, then reload."
      : "Microphone permission denied."
  }

  if (name === "NotFoundError" || /not found/i.test(message)) {
    return "No microphone found on this device."
  }

  if (name === "NotReadableError" || /could not start/i.test(message)) {
    return isMobileVoiceClient()
      ? "Microphone busy — close other apps using the mic and try again."
      : "Microphone unavailable (another app may be using it)."
  }

  return message || "Microphone permission denied or unavailable."
}

export function formatVoiceWsError(
  reason: "timeout" | "failed" | "closed" | "insecure",
): string {
  switch (reason) {
    case "insecure":
      return isMobileVoiceClient()
        ? "Voice needs HTTPS — open CodeNomad via the secure tunnel URL, not plain HTTP."
        : "Voice requires a secure (HTTPS) context."
    case "timeout":
      return isMobileVoiceClient()
        ? "Voice connection timed out — check mobile network and tunnel health (codenomad.prestix.vip)."
        : "WebSocket connection timed out — check tunnel and OPENAI_API_KEY on CodeNomad."
    case "failed":
      return isMobileVoiceClient()
        ? "Could not connect to voice — use StarGuard SSO to open CodeNomad, then retry on Wi‑Fi if cellular fails."
        : "Could not connect to Realtime voice (check tunnel, StarGuard SSO, and OPENAI_API_KEY)."
    case "closed":
      return "Realtime voice connection closed."
    default:
      return "Realtime voice error."
  }
}

export function buildCodeNomadVoiceSessionWsUrl(baseUrl: string, token: string): string {
  const wsBase = baseUrl.replace(/^http/, "ws")
  return `${wsBase}/api/voice/session?token=${encodeURIComponent(token)}`
}
