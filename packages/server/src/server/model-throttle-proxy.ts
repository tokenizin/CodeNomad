import type { FastifyReply, FastifyRequest } from "fastify"
import { fetch } from "undici"
import type { Logger } from "../logger.js"
import { ModelThrottle, type ModelKey } from "../model-throttle.js"

export function isModelRequest(path: string): boolean {
  return /^\/session\/[^/]+\/(?:prompt|prompt_async)$/.test(path)
}

export function resolveModelKey(body: unknown, env: NodeJS.ProcessEnv = process.env): ModelKey {
  const model = body && typeof body === "object" ? (body as any).model : undefined
  const provider = model?.providerID ?? model?.providerId
  const modelId = model?.modelID ?? model?.modelId
  if (typeof provider === "string" && typeof modelId === "string" && provider && modelId) return `${provider}/${modelId}`
  const configured = env.MODEL_THROTTLE_DEFAULT_MODEL?.trim() || "vercel/openai/gpt-5.6-luna"
  return configured.includes("/") ? configured as ModelKey : `vercel/${configured}`
}

export async function proxyModelRequest(args: { request: FastifyRequest; reply: FastifyReply; targetUrl: string; body: string | Buffer | undefined; contentType?: string; authHeader?: string; throttle: ModelThrottle; logger: Logger }) {
  const bodyValue = args.body === undefined ? undefined : Buffer.isBuffer(args.body) ? args.body : Buffer.from(args.body)
  const headers: Record<string, string> = {}
  if (args.contentType) headers["content-type"] = args.contentType
  if (args.authHeader) headers.authorization = args.authHeader
  const result = await args.throttle.execute(resolveModelKey(parseJson(bodyValue)), async () => fetch(args.targetUrl, { method: args.request.method, headers, body: bodyValue as any }), {
    isRateLimited: (response) => response.status === 429 || response.status === 503,
    retryAfterMs: (response) => parseRetryAfter(response.headers.get("retry-after")),
  })
  result.headers.forEach((value, key) => { if (key !== "content-length" && key !== "content-encoding") args.reply.header(key, value) })
  args.reply.code(result.status)
  args.reply.send(result.body ? Buffer.from(await result.arrayBuffer()) : undefined)
}

function parseJson(body: Buffer | undefined): unknown { if (!body) return undefined; try { return JSON.parse(body.toString("utf8")) } catch { return undefined } }
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.min(30_000, Math.max(0, seconds * 1000))
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.min(30_000, Math.max(0, date - Date.now())) : undefined
}
