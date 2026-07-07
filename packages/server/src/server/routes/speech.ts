import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { SpeechService } from "../../speech/service"
import {
  getDigest as getSharedDigest,
  forceRefresh as forceDigestRefresh,
  getCacheAge,
  isCacheWarm,
  getRefreshInterval,
} from "../../plugins/tokidapp/concierge/knowledge-cache"

interface RouteDeps {
  speechService: SpeechService
}

const TranscribeBodySchema = z.object({
  audioBase64: z.string().min(1, "Audio payload is required"),
  mimeType: z.string().min(1, "Audio MIME type is required"),
  filename: z.string().optional(),
  language: z.string().optional(),
  prompt: z.string().optional(),
})

const SynthesizeBodySchema = z.object({
  text: z.string().trim().min(1, "Text is required"),
  format: z.enum(["mp3", "wav", "opus", "aac"]).optional(),
})

function getSpeechErrorStatus(error: unknown): number {
  if (error instanceof z.ZodError) {
    return 400
  }
  if (error instanceof Error && /not configured/i.test(error.message)) {
    return 503
  }
  return 502
}

function getSpeechErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

export function registerSpeechRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get("/api/speech/capabilities", async () => deps.speechService.getCapabilities())

  app.post("/api/speech/transcribe", async (request, reply) => {
    try {
      const body = TranscribeBodySchema.parse(request.body ?? {})
      return await deps.speechService.transcribe(body)
    } catch (error) {
      request.log.error({ err: error }, "Failed to transcribe audio")
      reply.code(getSpeechErrorStatus(error))
      return { error: getSpeechErrorMessage(error, "Failed to transcribe audio") }
    }
  })

  app.post("/api/speech/synthesize", async (request, reply) => {
    try {
      const body = SynthesizeBodySchema.parse(request.body ?? {})
      return await deps.speechService.synthesize(body)
    } catch (error) {
      request.log.error({ err: error }, "Failed to synthesize audio")
      reply.code(getSpeechErrorStatus(error))
      return { error: getSpeechErrorMessage(error, "Failed to synthesize audio") }
    }
  })

  app.post("/api/speech/synthesize/stream", async (request, reply) => {
    try {
      const body = SynthesizeBodySchema.parse(request.body ?? {})
      const result = await deps.speechService.synthesizeStream(body)
      reply.header("Content-Type", result.mimeType)
      reply.header("Cache-Control", "no-store")
      return reply.send(result.stream)
    } catch (error) {
      request.log.error({ err: error }, "Failed to stream synthesized audio")
      reply.code(getSpeechErrorStatus(error))
      return { error: getSpeechErrorMessage(error, "Failed to stream synthesized audio") }
    }
  })

  /**
   * Knowledge Cache endpoint — shared between Path A (Speech REST) and
   * Path B (Realtime WS). Returns the current warm cache status and the
   * cached digest text, ensuring both paths use the same knowledge snapshot.
   */
  app.get("/api/speech/knowledge", async () => {
    const { digest, fetchedAt, isFresh, age } = await getSharedDigest()
    return {
      digest,
      cachedAt: fetchedAt,
      isFresh,
      ageSeconds: age,
      cacheWarm: isCacheWarm(),
      refreshIntervalMs: getRefreshInterval(),
    }
  })

  /**
   * Force refresh the shared knowledge cache.
   * Useful after significant project state changes (SCR approval, deploy).
   */
  app.post("/api/speech/knowledge/refresh", async () => {
    await forceDigestRefresh()
    const { digest, fetchedAt, isFresh, age } = await getSharedDigest()
    return {
      status: "refreshed",
      digest,
      cachedAt: fetchedAt,
      isFresh,
      ageSeconds: age,
      cacheWarm: isCacheWarm(),
    }
  })
}
