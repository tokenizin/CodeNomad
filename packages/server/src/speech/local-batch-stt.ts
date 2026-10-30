/**
 * Batch transcription for `/api/speech/transcribe` on the local faster-whisper server.
 *
 * One Python process per model stays warm between requests (loading large-v3 takes many seconds), so dictation
 * segments come back quickly. It closes after a few idle minutes and restarts on the next request.
 *
 * @module local-batch-stt
 */

import { createLocalSTTConnection, type LocalSTTConnection } from "../plugins/tokidapp/concierge/local-stt"
import { toPcm16Mono24k } from "./audio-to-pcm"

const IDLE_CLOSE_MS = 10 * 60_000
/** The first request also waits for the model to load. */
const FIRST_REQUEST_TIMEOUT_MS = 180_000
const REQUEST_TIMEOUT_MS = 60_000

interface Warm {
  connection: LocalSTTConnection
  idleTimer?: ReturnType<typeof setTimeout>
  used: boolean
  /** Requests run one at a time, in order. */
  queue: Promise<unknown>
}

const warm = new Map<string, Warm>()

export type ConnectionFactory = (model: string) => LocalSTTConnection

const defaultFactory: ConnectionFactory = (model) => createLocalSTTConnection({ model })

function acquire(model: string, factory: ConnectionFactory): Warm {
  let entry = warm.get(model)
  if (!entry || entry.connection.isClosed) {
    entry = { connection: factory(model), used: false, queue: Promise.resolve() }
    warm.set(model, entry)
  }
  if (entry.idleTimer) clearTimeout(entry.idleTimer)
  return entry
}

function scheduleIdleClose(model: string, entry: Warm) {
  if (entry.idleTimer) clearTimeout(entry.idleTimer)
  entry.idleTimer = setTimeout(() => {
    if (warm.get(model) === entry) warm.delete(model)
    entry.connection.close()
  }, IDLE_CLOSE_MS)
  entry.idleTimer.unref?.()
}

export async function transcribeLocally(
  input: { audioBase64: string; mimeType: string; language?: string; model: string },
  factory: ConnectionFactory = defaultFactory,
): Promise<{ text: string; language?: string }> {
  const pcm = await toPcm16Mono24k(Buffer.from(input.audioBase64, "base64"), input.mimeType)
  const entry = acquire(input.model, factory)
  const timeoutMs = entry.used ? REQUEST_TIMEOUT_MS : FIRST_REQUEST_TIMEOUT_MS
  const run = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        entry.connection.transcribeOnce(pcm.toString("base64"), input.language),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Local transcription timed out after ${timeoutMs / 1000}s`)), timeoutMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
      entry.used = true
      scheduleIdleClose(input.model, entry)
    }
  }
  const result = entry.queue.then(run, run)
  entry.queue = result.catch(() => undefined)
  return result
}

/** Test hook. */
export function closeLocalBatchStt(): void {
  for (const entry of warm.values()) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.connection.close()
  }
  warm.clear()
}
