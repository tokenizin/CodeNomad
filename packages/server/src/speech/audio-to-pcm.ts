/**
 * Turn an uploaded clip into raw 16-bit mono PCM at 24 kHz, the only input the local faster-whisper server reads.
 *
 *   audio/pcm (audio/l16)         → used as is (assumed 24 kHz mono, what the browser dictation sends inside WAV)
 *   audio/wav, 16-bit mono 24 kHz → the data chunk, no conversion
 *   anything else (webm, ogg, mp4, other WAVs) → decoded by ffmpeg on this host
 *
 * @module audio-to-pcm
 */

import { spawn } from "node:child_process"

export const LOCAL_STT_SAMPLE_RATE = 24000

export async function toPcm16Mono24k(audio: Buffer, mimeType: string, spawnImpl: typeof spawn = spawn): Promise<Buffer> {
  const type = mimeType.toLowerCase()
  if (type.startsWith("audio/pcm") || type.startsWith("audio/l16")) return audio
  const direct = pcmFromWav(audio)
  if (direct) return direct
  return ffmpegDecode(audio, spawnImpl)
}

/** The PCM data of a 16-bit mono 24 kHz WAV, or null if it's another kind of file. */
export function pcmFromWav(buf: Buffer): Buffer | null {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null
  let offset = 12
  let format: { channels: number; rate: number; bits: number; codec: number } | null = null
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === "fmt " && body + 16 <= buf.length) {
      format = {
        codec: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      }
    } else if (id === "data") {
      if (!format || format.codec !== 1 || format.channels !== 1 || format.bits !== 16 || format.rate !== LOCAL_STT_SAMPLE_RATE) {
        return null
      }
      // Streamed WAVs carry a placeholder size; take what is there.
      return buf.subarray(body, Math.min(buf.length, body + size))
    }
    offset = body + size + (size % 2)
  }
  return null
}

function ffmpegDecode(audio: Buffer, spawnImpl: typeof spawn): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawnImpl(
      "ffmpeg",
      ["-loglevel", "error", "-i", "pipe:0", "-f", "s16le", "-ac", "1", "-ar", String(LOCAL_STT_SAMPLE_RATE), "pipe:1"],
      { stdio: ["pipe", "pipe", "pipe"] },
    )
    const out: Buffer[] = []
    let stderr = ""
    proc.stdout?.on("data", (d: Buffer) => out.push(d))
    proc.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < 500) stderr += d.toString()
    })
    proc.stdin?.on("error", () => {})
    proc.on("error", (err) =>
      reject(new Error(`Local transcription is not configured for this audio format: ffmpeg is not available (${err.message}). Install it with brew install ffmpeg.`)),
    )
    proc.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out))
      else reject(new Error(`ffmpeg could not decode the audio (code ${code}): ${stderr.trim()}`))
    })
    proc.stdin?.end(audio)
  })
}
