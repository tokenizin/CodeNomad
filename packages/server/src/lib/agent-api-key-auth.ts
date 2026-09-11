import { promisify } from "node:util"
import { scrypt as scryptCallback, timingSafeEqual } from "node:crypto"
import type { FastifyRequest } from "fastify"
import { findActiveAgentApiKeys, type AgentApiKeyRecord } from "./db.js"

const scrypt = promisify(scryptCallback)

export type AgentApiKeyAuth = AgentApiKeyRecord

function bearerToken(request: FastifyRequest): string | null {
  const value = Array.isArray(request.headers.authorization)
    ? request.headers.authorization[0]
    : request.headers.authorization
  if (!value || !/^Bearer\s+\S+$/i.test(value)) return null
  const token = value.replace(/^Bearer\s+/i, "").trim()
  return token || null
}

/** Parse and verify the StarWorld scrypt$base64url$base64url format. */
export async function verifyAgentApiKey(
  plaintext: string,
  lookup: () => Promise<AgentApiKeyRecord[]> = findActiveAgentApiKeys,
): Promise<AgentApiKeyAuth | null> {
  if (!plaintext.startsWith("sk_agent_")) return null
  for (const candidate of await lookup()) {
    if (!candidate.revokedAt && await verifyTokenAgainstRecord(plaintext, candidate)) return candidate
  }
  return null
}

export async function authenticateAgentApiKey(
  request: FastifyRequest,
  lookupByHash: () => Promise<AgentApiKeyRecord[]> = findActiveAgentApiKeys,
): Promise<AgentApiKeyAuth | null> {
  const token = bearerToken(request)
  if (!token) return null
  return authenticateToken(token, lookupByHash)
}

/**
 * Verify a token against a supplied candidate record. Useful for tests and
 * for deployments that use a lookup-by-id/index adapter.
 */
export async function verifyTokenAgainstRecord(token: string, record: AgentApiKeyRecord): Promise<boolean> {
  const match = record.hashedKey.match(/^scrypt\$([^$]+)\$([^$]+)$/)
  if (!match) return false
  try {
    const salt = Buffer.from(match[1]!, "base64url")
    const expected = Buffer.from(match[2]!, "base64url")
    if (salt.length !== 16 || expected.length !== 64) return false
    const actual = (await scrypt(token, salt, expected.length)) as Buffer
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

/**
 * Database lookup adapter. Since the persisted format is salted, the narrow
 * query returns only the fields required for verification and authorization.
 */
async function authenticateToken(
  token: string,
  lookupByHash: () => Promise<AgentApiKeyRecord[]>,
): Promise<AgentApiKeyAuth | null> {
  return verifyAgentApiKey(token, lookupByHash)
}

export function hasScope(auth: AgentApiKeyAuth, scope: string): boolean {
  return auth.scopes.includes(scope)
}
