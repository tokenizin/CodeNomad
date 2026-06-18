import type { FastifyRequest } from "fastify"

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

export function resolveInstanceProxyBody(request: FastifyRequest): string | Buffer | undefined {
  const body = request.body
  if (body === undefined || body === null) {
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
