import type { FastifyRequest } from "fastify"

/** OpenCode 1.17.x historically crashed / rejected empty JSON `{}` on some routes. */
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
 * OpenCode session create accepts empty/`{}` bodies.
 * Prompt routes must keep a real JSON body (`parts` required) — never strip those.
 */
const SESSION_CREATE_ENDPOINT_REGEX = /\/session\/?$/i

export function isInstanceSessionCreatePath(urlPath: string): boolean {
  return SESSION_CREATE_ENDPOINT_REGEX.test(urlPath)
}

/**
 * Prefer explicit Content-Type; otherwise assume JSON for OpenCode API bodies.
 * Never fall back to application/octet-stream — OpenCode returns 415 for that on prompt_async.
 */
export function resolveInstanceProxyForwardContentType(
  request: FastifyRequest,
  body: string | Buffer | undefined,
): string | undefined {
  if (body === undefined) {
    return undefined
  }

  const explicit = resolveInstanceProxyContentType(request)
  if (explicit) {
    return explicit
  }

  const text = Buffer.isBuffer(body) ? body.toString("utf-8").trim() : body.trim()
  if (text.startsWith("{") || text.startsWith("[")) {
    return "application/json"
  }

  return "application/json"
}

export function resolveInstanceProxyBody(request: FastifyRequest): string | Buffer | undefined {
  const body = request.body

  const urlPath = (request.url ?? "").split("?")[0]
  const isSessionCreate = isInstanceSessionCreatePath(urlPath)

  if (isEffectivelyEmptyProxyBody(body)) {
    // Session create: forward an explicit empty JSON object so OpenCode gets a valid payload
    // and @fastify/reply-from does not JSON.stringify a Buffer via the request.body fallback.
    if (isSessionCreate) {
      return "{}"
    }
    return undefined
  }

  if (Buffer.isBuffer(body)) {
    return body.length > 0 ? body : isSessionCreate ? "{}" : undefined
  }

  if (typeof body === "string") {
    return body.length > 0 ? body : isSessionCreate ? "{}" : undefined
  }

  if (typeof body === "object" && typeof (body as { pipe?: unknown }).pipe !== "function") {
    return JSON.stringify(body)
  }

  return undefined
}
