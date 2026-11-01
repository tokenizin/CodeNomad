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
  /** The sidecar's own key, when the key above came from settings and differs: tried if that one is refused. */
  fallbackApiKey?: string
  timeoutMs: number
}

/**
 * Where the sidecar's key lives, for error messages.
 *
 * The full lookup chain CodeNomad uses: the key saved in Speech settings, then
 * VOXCPM_SIDECAR_API_KEY in the CodeNomad server env, then the sidecar's own
 * key (VOXCPM_API_KEY in the starworld repo's .env.local/.env, otherwise
 * scripts/voxcpm-server/engine-data/.api-key).
 */
export const VOXCPM_KEY_HINT =
  "The sidecar's key is VOXCPM_SIDECAR_API_KEY in the CodeNomad server env, or VOXCPM_API_KEY in ~/starworld/.env.local (or .env) if set, otherwise scripts/voxcpm-server/engine-data/.api-key"

function readEnvFileValue(file: string, name: string): string | undefined {
  try {
    const line = fs.readFileSync(file, "utf8").split(/\r?\n/).find((l) => l.startsWith(`${name}=`))
    const value = line?.slice(name.length + 1).trim().replace(/^(["'])(.*)\1$/, "$2")
    return value || undefined
  } catch {
    return undefined
  }
}

/**
 * The sidecar's own key, found the way its launcher (scripts/voxcpm-sidecar-launchd-wrapper.sh) picks it:
 * VOXCPM_API_KEY in the starworld repo's .env.local, then .env, then scripts/voxcpm-server/engine-data/.api-key.
 * A local setup then needs no key copied.
 *
 * Lookup order: an explicit STARWORLD/CLI_WORKSPACE_ROOT root, then the repo the
 * process actually runs in (walking up from the working directory), then ~/starworld
 * as a last resort. The working directory comes before ~/starworld so the checkout
 * the server was started from always wins over a hardcoded home path.
 */
export function discoverVoxCpmApiKey(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string | undefined {
  const relative = path.join("scripts", "voxcpm-server", "engine-data", ".api-key")
  const roots = [env.STARWORLD, env.CLI_WORKSPACE_ROOT]
  let dir = path.resolve(cwd)
  for (let i = 0; i < 6; i += 1) {
    roots.push(dir)
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  roots.push(path.join(os.homedir(), "starworld"))
  for (const root of roots) {
    if (!root?.trim()) continue
    const base = root.trim()
    if (!fs.existsSync(path.join(base, "scripts", "voxcpm-server"))) continue
    const fromEnv = readEnvFileValue(path.join(base, ".env.local"), "VOXCPM_API_KEY") ?? readEnvFileValue(path.join(base, ".env"), "VOXCPM_API_KEY")
    if (fromEnv) return fromEnv
    try {
      const key = fs.readFileSync(path.join(base, relative), "utf8").trim()
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
  const ownKey = env.VOXCPM_SIDECAR_API_KEY?.trim() || discoverVoxCpmApiKey(env)
  const apiKey = overrides.apiKey?.trim() || ownKey
  return {
    baseUrl,
    apiKey,
    ...(ownKey && apiKey !== ownKey ? { fallbackApiKey: ownKey } : {}),
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
