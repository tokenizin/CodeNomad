/**
 * Live transcode of a raw 16-bit mono PCM stream to mp3 / aac (ADTS) with ffmpeg.
 *
 * VoxCPM2 can only stream WAV or raw PCM, but the UI's streaming playback goes through MediaSource, which cannot play
 * WAV. Transcoding on the CodeNomad host keeps one continuous stream (no per-sentence encoder gaps) in a format the
 * browser can append. Closing the returned stream stops ffmpeg and destroys the source, which cancels the sidecar request.
 *
 * @module pcm-transcode
 */

import { createRequire } from "node:module"
import { PassThrough, type Readable } from "node:stream"
import type { spawn, spawnSync } from "node:child_process"

export type TranscodeFormat = "mp3" | "aac"

/**
 * The real child_process entry points, read from the CJS registry.
 *
 * bun's `mock.module("node:child_process", …)` replaces the module process-wide, so a test
 * double would silently take over ffmpeg spawning — and the availability probe — for every
 * importer in the run. `createRequire` reads the builtin from the CJS registry, which the
 * mock does not touch, so ffmpeg is always the real binary.
 */
const childProcess = createRequire(import.meta.url)("node:child_process") as {
  spawn: typeof spawn
  spawnSync: typeof spawnSync
}

const FORMAT_ARGS: Record<TranscodeFormat, string[]> = {
  mp3: ["-f", "mp3", "-codec:a", "libmp3lame", "-b:a", "128k"],
  aac: ["-f", "adts", "-codec:a", "aac", "-b:a", "128k"],
}

export const TRANSCODE_MIME: Record<TranscodeFormat, string> = { mp3: "audio/mpeg", aac: "audio/aac" }

let cachedAvailability: boolean | undefined

export function ffmpegAvailable(): boolean {
  if (cachedAvailability === undefined) {
    cachedAvailability = childProcess.spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0
  }
  return cachedAvailability
}

/** Test hook: forget the cached `ffmpeg -version` probe. */
export function resetFfmpegProbe(): void {
  cachedAvailability = undefined
}

export function transcodePcmStream(
  source: Readable,
  options: { sampleRate: number; format: TranscodeFormat; spawnImpl?: typeof childProcess.spawn },
): Readable {
  const proc = (options.spawnImpl ?? childProcess.spawn)(
    "ffmpeg",
    ["-loglevel", "error", "-f", "s16le", "-ar", String(options.sampleRate), "-ac", "1", "-i", "pipe:0", ...FORMAT_ARGS[options.format], "pipe:1"],
    { stdio: ["pipe", "pipe", "pipe"] },
  )
  // Hand callers a stream we own. Under Bun a child's stdout emits only "close" when destroyed with an error (Node emits
  // "error"), so an ffmpeg failure would look like a clean, truncated stream. A PassThrough behaves the same on both.
  const out = new PassThrough()
  proc.stdout?.on("error", (err: Error) => out.destroy(err))
  proc.stdout?.pipe(out)
  let stderr = ""
  proc.stderr?.on("data", (d: Buffer) => {
    if (stderr.length < 500) stderr += d.toString()
  })

  // EPIPE is expected when ffmpeg exits or the listener leaves first.
  proc.stdin?.on("error", () => {})
  proc.on("error", (err) => out.destroy(new Error(`ffmpeg failed to start: ${err.message}`)))
  proc.on("close", (code) => {
    if (code !== 0 && code !== null && !out.destroyed) out.destroy(new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`))
  })

  source.on("error", (err) => {
    proc.stdin?.destroy()
    out.destroy(err)
  })
  source.pipe(proc.stdin!)

  out.on("close", () => {
    source.destroy()
    proc.kill("SIGKILL")
  })
  return out
}
