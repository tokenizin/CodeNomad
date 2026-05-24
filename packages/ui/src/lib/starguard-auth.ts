const STORAGE_KEY = "starguard_jwt"
const DEFAULT_STARGUARD_PUBLIC_URL = "https://starguard.vercel.app"

declare global {
  interface Window {
    __STARGUARD_PUBLIC_URL__?: string
  }
}

/** StarGuard portal base URL (tunnel SSO return target). */
export function getStarGuardPublicUrl(): string {
  if (typeof window !== "undefined") {
    const injected = window.__STARGUARD_PUBLIC_URL__?.trim()
    if (injected?.startsWith("http")) return injected.replace(/\/$/, "")
  }
  const vite = import.meta.env.VITE_STARGUARD_PUBLIC_URL
  if (typeof vite === "string" && vite.startsWith("http")) {
    return vite.replace(/\/$/, "")
  }
  return DEFAULT_STARGUARD_PUBLIC_URL
}

/** Same-tab return link to StarGuard with JWT for session continuity. */
export function starGuardReturnHref(): string {
  const url = new URL("/", `${getStarGuardPublicUrl()}/`)
  const token = getStarGuardBearerToken()
  if (token) url.searchParams.set("token", token)
  return url.toString()
}

/** Persist JWT from /auth/starguard redirect hash (#starguard_token=...). */
export function captureStarGuardTokenFromHash(): void {
  if (typeof window === "undefined") return
  const rawHash = window.location.hash?.replace(/^#/, "")
  if (!rawHash) return

  const token = new URLSearchParams(rawHash).get("starguard_token")?.trim()
  if (!token) return

  sessionStorage.setItem(STORAGE_KEY, token)
  const url = new URL(window.location.href)
  url.hash = ""
  history.replaceState(null, "", `${url.pathname}${url.search}`)
}

export function getStarGuardBearerToken(): string | null {
  if (typeof window === "undefined") return null
  const token = sessionStorage.getItem(STORAGE_KEY)?.trim()
  return token || null
}

export function clearStarGuardBearerToken(): void {
  if (typeof window === "undefined") return
  sessionStorage.removeItem(STORAGE_KEY)
}

/** EventSource cannot send Authorization; append token as query param when present. */
export function appendStarGuardTokenToUrl(url: URL): void {
  const token = getStarGuardBearerToken()
  if (!token) return
  if (!url.searchParams.has("starguard_token") && !url.searchParams.has("token")) {
    url.searchParams.set("starguard_token", token)
  }
}
