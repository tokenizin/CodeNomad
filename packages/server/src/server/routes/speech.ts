import type { FastifyInstance, FastifyRequest } from "fastify"
import { z } from "zod"
import type { SpeechService } from "../../speech/service"
import { resolveStarGuardUser, type StarGuardJwtHandler } from "../../auth/starguard-jwt"

interface RouteDeps {
  speechService: SpeechService
  starGuardJwtHandler?: StarGuardJwtHandler
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

/**
 * Who to bill for this speech call, or null to skip metering entirely.
 *
 * A local CodeNomad session (username/sessionId, checked by the global auth
 * preHandler before this route ever runs) carries no StarGuard identity —
 * CodeNomad's own login has nothing to do with a StarXP-billable account —
 * so only a verified StarGuard JWT resolves a userId here. This re-verifies
 * the same token the preHandler already checked (auth was already decided
 * by the time this runs); the only new thing extracted is who to bill.
 */
async function resolveBillingUserId(
  request: FastifyRequest,
  starGuardJwtHandler?: StarGuardJwtHandler,
): Promise<string | null> {
  const payload = await resolveStarGuardUser(request, starGuardJwtHandler)
  return payload?.userId ?? null
}

export function registerSpeechRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get("/api/speech/capabilities", async () => deps.speechService.getCapabilities())

  app.post("/api/speech/transcribe", async (request, reply) => {
    try {
      const body = TranscribeBodySchema.parse(request.body ?? {})
      const userId = await resolveBillingUserId(request, deps.starGuardJwtHandler)
      return await deps.speechService.transcribe(body, userId)
    } catch (error) {
      request.log.error({ err: error }, "Failed to transcribe audio")
      reply.code(getSpeechErrorStatus(error))
      return { error: getSpeechErrorMessage(error, "Failed to transcribe audio") }
    }
  })

  app.post("/api/speech/synthesize", async (request, reply) => {
    try {
      const body = SynthesizeBodySchema.parse(request.body ?? {})
      const userId = await resolveBillingUserId(request, deps.starGuardJwtHandler)
      return await deps.speechService.synthesize(body, userId)
    } catch (error) {
      request.log.error({ err: error }, "Failed to synthesize audio")
      reply.code(getSpeechErrorStatus(error))
      return { error: getSpeechErrorMessage(error, "Failed to synthesize audio") }
    }
  })

  app.post("/api/speech/synthesize/stream", async (request, reply) => {
    try {
      const body = SynthesizeBodySchema.parse(request.body ?? {})
      const userId = await resolveBillingUserId(request, deps.starGuardJwtHandler)
      const result = await deps.speechService.synthesizeStream(body, userId)
      reply.header("Content-Type", result.mimeType)
      reply.header("Cache-Control", "no-store")
      return reply.send(result.stream)
    } catch (error) {
      request.log.error({ err: error }, "Failed to stream synthesized audio")
      reply.code(getSpeechErrorStatus(error))
      return { error: getSpeechErrorMessage(error, "Failed to stream synthesized audio") }
    }
  })
}
