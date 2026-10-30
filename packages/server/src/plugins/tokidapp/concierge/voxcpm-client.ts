/**
 * Shared access to the VoxCPM2 sidecar (contracts repo, scripts/voxcpm-server, :9972) for every CodeNomad consumer:
 * the local/ornith realtime engines (`voxcpm-tts.ts`) and the `/api/speech` provider.
 *
 * @module voxcpm-client
 */

import fs from "fs"
import os from "os"
import path from "path"

const DEFAULT_URL = "http://127.0.0.1:9972"
const DEFAULT_TIMEOUT_MS = 120_000

export interface VoxCpmConfig {
  baseUrl: string
  apiKey?: string
  timeoutMs: number
}

/**
 * The sidecar writes its key to scripts/voxcpm-server/engine-data/.api-key in the
 * starworld repo (docs/VOXCPM_SETUP.md). Look there so a local setup needs no key copied.
 */
export function discoverVoxCpmApiKey(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string | undefined {
  const relative = path.join("scripts", "voxcpm-server", "engine-data", ".api-key")
  const roots = [env.STARWORLD, env.CLI_WORKSPACE_ROOT, path.join(os.homedir(), "starworld")]
  let dir = path.resolve(cwd)
  for (let i = 0; i < 6; i += 1) {
    roots.push(dir)
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  for (const root of roots) {
    if (!root?.trim()) continue
    try {
      const key = fs.readFileSync(path.join(root.trim(), relative), "utf8").trim()
      if (key) return key
    } catch {
      /* not here */
    }
  }
  return undefined
}

export function resolveVoxCpmConfig(
  overrides: { baseUrl?: string; apiKey?: string; timeoutMs?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): VoxCpmConfig {
  const baseUrl = (overrides.baseUrl ?? env.VOXCPM_SIDECAR_URL?.trim() ?? "").replace(/\/$/, "") || DEFAULT_URL
  return {
    baseUrl,
    apiKey: overrides.apiKey ?? (env.VOXCPM_SIDECAR_API_KEY?.trim() || discoverVoxCpmApiKey(env)),
    timeoutMs: overrides.timeoutMs ?? (Number(env.VOXCPM_TTS_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS),
  }
}

/** POST /v1/audio/speech. Rejects only on transport errors; HTTP errors come back as a Response for the caller to map. */
export function postSpeech(
  config: VoxCpmConfig,
  body: Record<string, unknown>,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<Response> {
  const timeout = AbortSignal.timeout(config.timeoutMs)
  return (options.fetchImpl ?? fetch)(`${config.baseUrl}/v1/audio/speech`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
  })
}

/** Error text from a failed sidecar response (FastAPI `{"detail": …}` or plain text), capped. */
export async function sidecarErrorDetail(res: Response): Promise<string> {
  const text = await res.text().catch(() => "")
  try {
    const parsed = JSON.parse(text) as { detail?: unknown; error?: unknown }
    return String(parsed.detail ?? parsed.error ?? text).slice(0, 300)
  } catch {
    return text.slice(0, 300)
  }
}
