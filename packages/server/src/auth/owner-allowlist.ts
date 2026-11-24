import type { StarGuardPayload } from "./starguard-jwt"

/**
 * Restricts which StarGuard identities may use this CodeNomad instance (workspaces, API, sidecars, sessions).
 *
 * CODENOMAD_OWNER_EMAILS: comma-separated, case-insensitive email list. When set, a valid portal JWT only
 * grants CodeNomad access if its email is listed; tokens without an email (wallet-only) are refused.
 * When unset, any valid portal JWT is accepted (legacy behaviour) and startup logs a warning.
 *
 * StarWorld chat routes (/api/tokidapp/*) are multi-user by design and authorize per userId, so callers
 * apply this check only to CodeNomad-owner surfaces.
 */
export function resolveOwnerEmails(): string[] {
  return (process.env.CODENOMAD_OWNER_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0)
}

export function isOwnerLockEnabled(): boolean {
  return resolveOwnerEmails().length > 0
}

export function isOwnerIdentity(payload: Pick<StarGuardPayload, "email"> | null | undefined): boolean {
  if (!payload) return false
  const owners = resolveOwnerEmails()
  if (owners.length === 0) return true
  const email = payload.email?.trim().toLowerCase()
  return Boolean(email && owners.includes(email))
}

/** Paths that serve StarWorld chat users (not the instance owner) and keep accepting any valid portal JWT. */
export function isMultiUserChatPath(pathname: string): boolean {
  return pathname === "/api/tokidapp" || pathname.startsWith("/api/tokidapp/")
}
