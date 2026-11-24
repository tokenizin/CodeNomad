import type { FastifyReply, FastifyRequest } from "fastify"
import type { AuthManager } from "./manager"

/**
 * - starguard: remote visitors sign in through the StarWorld portal (tokenizin.com SSO).
 * - cloudflare-access: Cloudflare Access authenticates at the edge (Prestix).
 * - password: remote visitors get CodeNomad's own username/password page; StarGuard JWTs are ignored.
 *   Used for per-person instances (e.g. one macOS user per CodeNomad) on their own hostname.
 */
export type CodeNomadAuthProvider = "starguard" | "cloudflare-access" | "password"

const CLOUDFLARE_ACCESS_EMAIL_HEADER = "cf-access-authenticated-user-email"

export function resolveAuthProvider(): CodeNomadAuthProvider {
  const explicit = process.env.CODENOMAD_AUTH_PROVIDER?.trim().toLowerCase()
  if (explicit === "cloudflare-access" || explicit === "cloudflare") {
    return "cloudflare-access"
  }
  if (explicit === "starguard") {
    return "starguard"
  }
  if (explicit === "password" || explicit === "local") {
    return "password"
  }

  const publicUrl = (
    process.env.CODENOMAD_PUBLIC_URL ??
    process.env.CLI_PUBLIC_URL ??
    ""
  ).toLowerCase()
  if (publicUrl.includes("prestix.vip")) {
    return "cloudflare-access"
  }

  return "starguard"
}

export function shouldRedirectLoginToStarGuard(): boolean {
  return resolveAuthProvider() === "starguard"
}

/** StarGuard JWTs grant access only when the instance is not in password-only mode. */
export function isStarGuardJwtAllowed(): boolean {
  return resolveAuthProvider() !== "password"
}

export function resolveStarGuardPublicUrl(): string {
  const configured = process.env.STARGUARD_PUBLIC_URL?.trim()
  if (configured?.startsWith("http")) {
    return configured.replace(/\/$/, "")
  }
  if (resolveAuthProvider() === "cloudflare-access") {
    const prestix = process.env.CODENOMAD_PUBLIC_URL?.trim()
    if (prestix?.startsWith("http")) {
      return prestix.replace(/\/$/, "")
    }
    return "https://prestix.vip"
  }
  // Prefer www — apex tokenizin.com 308s and SSO cookies are host-scoped to www.
  return "https://www.tokenizin.com"
}

export function readCloudflareAccessEmail(request: FastifyRequest): string | null {
  const raw = request.headers[CLOUDFLARE_ACCESS_EMAIL_HEADER]
  const value = Array.isArray(raw) ? raw[0] : raw
  const email = value?.trim()
  return email || null
}

export function tryBootstrapCloudflareAccessSession(
  request: FastifyRequest,
  reply: FastifyReply,
  authManager: AuthManager,
): boolean {
  if (resolveAuthProvider() !== "cloudflare-access") {
    return false
  }

  const email = readCloudflareAccessEmail(request)
  if (!email) {
    return false
  }

  const session = authManager.createSession(email)
  authManager.setSessionCookieWithOptions(reply, session.id, {
    secure: isSecureRequest(request),
  })
  return true
}

function isSecureRequest(request: FastifyRequest): boolean {
  const forwarded = request.headers?.["x-forwarded-proto"]
  if (typeof forwarded === "string" && forwarded.split(",")[0]?.trim().toLowerCase() === "https") {
    return true
  }
  if (request.protocol === "https") {
    return true
  }
  return Boolean(request.raw?.socket && (request.raw.socket as { encrypted?: boolean }).encrypted)
}
