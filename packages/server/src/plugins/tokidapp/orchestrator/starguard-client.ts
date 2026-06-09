const STARGUARD_BASE = process.env.STARGUARD_BASE_URL || 'https://star-worlds.vercel.app'
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY

/** Default timeout for outbound fetch calls to StarGuard (ms). */
const FETCH_TIMEOUT_MS = 10_000

function getHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (INTERNAL_API_KEY) headers['x-api-key'] = INTERNAL_API_KEY
  return headers
}

function withTimeout(signal?: AbortSignal): { signal?: AbortSignal; timeoutId: ReturnType<typeof setTimeout> | null } {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  // Chain with caller's signal if provided
  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  return { signal: controller.signal, timeoutId }
}

export async function apiPost(path: string, body: unknown): Promise<Response> {
  const { signal, timeoutId } = withTimeout()
  try {
    return await fetch(`${STARGUARD_BASE}${path}`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(body),
      signal,
    })
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

export async function apiGet(path: string, params?: Record<string, string>): Promise<Response> {
  const search = params ? `?${new URLSearchParams(params)}` : ''
  const { signal, timeoutId } = withTimeout()
  try {
    return await fetch(`${STARGUARD_BASE}${path}${search}`, {
      headers: getHeaders(),
      signal,
    })
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

export async function apiPut(path: string, body: unknown): Promise<Response> {
  const { signal, timeoutId } = withTimeout()
  try {
    return await fetch(`${STARGUARD_BASE}${path}`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify(body),
      signal,
    })
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

export async function apiDelete(path: string): Promise<Response> {
  const { signal, timeoutId } = withTimeout()
  try {
    return await fetch(`${STARGUARD_BASE}${path}`, {
      method: 'DELETE',
      headers: getHeaders(),
      signal,
    })
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

export { STARGUARD_BASE }
