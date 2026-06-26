import type { FastifyRequest } from "fastify"

/** OpenCode 1.17.x crashes on POST /session with Content-Type: application/json and body `{}`. */
export function isEffectivelyEmptyProxyBody(body: unknown): boolean {
  if (body === undefined || body === null) {
    return true
  }

  if (Buffer.isBuffer(body)) {
    if (body.length === 0) {
      return true
    }
    const text = body.toString("utf-8").trim()
    return text.length === 0 || text === "{}" || text === "[]"
  }

  if (typeof body === "string") {
    const text = body.trim()
    return text.length === 0 || text === "{}" || text === "[]"
  }

  if (typeof body === "object" && typeof (body as { pipe?: unknown }).pipe !== "function") {
    return Object.keys(body as object).length === 0
  }

  return false
}

export function instanceProxyAllowsBody(method: string | undefined): boolean {
  const normalized = (method ?? "GET").toUpperCase()
  return normalized !== "GET" && normalized !== "HEAD" && normalized !== "OPTIONS"
}

export function resolveInstanceProxyContentType(request: FastifyRequest): string | undefined {
  const header = request.headers["content-type"]
  if (typeof header === "string" && header.trim().length > 0) {
    return header
  }
  if (Array.isArray(header) && typeof header[0] === "string" && header[0].trim().length > 0) {
    return header[0]
  }
  return undefined
}

/**
 * OpenCode 1.17.9+ requires a body for POST /session and returns 400 without one.
 * Skip the empty-body check for session creation to allow empty JSON through.
 */
const SESSION_ENDPOINT_REGEX = /\/session$/i

export function resolveInstanceProxyBody(request: FastifyRequest): string | Buffer | undefined {
  const body = request.body

  const urlPath = (request.url ?? "").split("?")[0]
  const isSessionEndpoint = SESSION_ENDPOINT_REGEX.test(urlPath)

  if (isEffectivelyEmptyProxyBody(body) && !isSessionEndpoint) {
    return undefined
  }

  if (Buffer.isBuffer(body)) {
    return body.length > 0 ? body : undefined
  }

  if (typeof body === "string") {
    return body.length > 0 ? body : undefined
  }

  if (typeof body === "object" && typeof (body as { pipe?: unknown }).pipe !== "function") {
    return JSON.stringify(body)
  }

  return undefined
}
