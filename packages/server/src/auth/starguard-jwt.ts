import { jwtVerify, type JWTPayload } from "jose"
import type { Logger } from "../logger"

export interface StarGuardPayload extends JWTPayload {
  userId: string
  walletAddress: string
  role: string
  email?: string
}

export class StarGuardJwtHandler {
  private readonly secret: Uint8Array | null

  constructor(authSecret: string | undefined, private readonly logger: Logger) {
    if (authSecret) {
      this.secret = new TextEncoder().encode(authSecret)
    } else {
      this.secret = null
    }
  }

  isEnabled(): boolean {
    return this.secret !== null
  }

  async verify(token: string): Promise<StarGuardPayload | null> {
    if (!this.secret) return null
    try {
      const { payload } = await jwtVerify(token, this.secret)
      return payload as StarGuardPayload
    } catch {
      return null
    }
  }
}

/** Shape shared by Fastify's request and anything else carrying headers + a query object. */
export interface TokenBearingRequest {
  headers: { authorization?: string | string[] }
  query?: unknown
}

/**
 * Extract a StarGuard JWT from a request: `Authorization: Bearer <token>`
 * first, then the `token`/`starguard_token` query params (same fallback the
 * voice WS upgrade and the http-server auth preHandler already use). Pure
 * extraction — does not verify; callers pass the result to
 * `StarGuardJwtHandler.verify`.
 */
export function extractBearerOrQueryToken(request: TokenBearingRequest): string | null {
  const authHeader = Array.isArray(request.headers.authorization)
    ? request.headers.authorization[0]
    : request.headers.authorization
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim()
  }

  const query = request.query as { token?: string; starguard_token?: string } | undefined
  return query?.starguard_token?.trim() || query?.token?.trim() || null
}

/**
 * Resolve the verified StarGuard identity for a request, or null when no
 * token is present, the handler isn't enabled, or verification fails.
 * Shared by the http-server auth preHandler (to decide access) and the
 * speech routes (purely to resolve who to bill — auth itself is already
 * decided by the time these routes run).
 */
export async function resolveStarGuardUser(
  request: TokenBearingRequest,
  handler: StarGuardJwtHandler | undefined,
): Promise<StarGuardPayload | null> {
  if (!handler?.isEnabled()) return null
  const token = extractBearerOrQueryToken(request)
  if (!token) return null
  return handler.verify(token)
}
