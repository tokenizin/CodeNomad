/**
 * Shared access to the VoxCPM2 sidecar (contracts repo, scripts/voxcpm-server, :9972) for every CodeNomad consumer:
 * the local/ornith realtime engines (`voxcpm-tts.ts`) and the `/api/speech` provider.
 *
 * @module voxcpm-client
 */

const DEFAULT_URL = "http://127.0.0.1:9972"
const DEFAULT_TIMEOUT_MS = 120_000

export interface VoxCpmConfig {
  baseUrl: string
  apiKey?: string
  timeoutMs: number
}

export function resolveVoxCpmConfig(
  overrides: { baseUrl?: string; apiKey?: string; timeoutMs?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): VoxCpmConfig {
  const baseUrl = (overrides.baseUrl ?? env.VOXCPM_SIDECAR_URL?.trim() ?? "").replace(/\/$/, "") || DEFAULT_URL
  return {
    baseUrl,
    apiKey: overrides.apiKey ?? (env.VOXCPM_SIDECAR_API_KEY?.trim() || undefined),
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
