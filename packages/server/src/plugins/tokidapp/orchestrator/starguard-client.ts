const STARGUARD_BASE = process.env.STARGUARD_BASE_URL || 'https://starguard.vercel.app'
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY

function getHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (INTERNAL_API_KEY) headers['x-api-key'] = INTERNAL_API_KEY
  return headers
}

export async function apiPost(path: string, body: unknown): Promise<Response> {
  return fetch(`${STARGUARD_BASE}${path}`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  })
}

export async function apiGet(path: string, params?: Record<string, string>): Promise<Response> {
  const search = params ? `?${new URLSearchParams(params)}` : ''
  return fetch(`${STARGUARD_BASE}${path}${search}`, {
    headers: getHeaders(),
  })
}

export async function apiPut(path: string, body: unknown): Promise<Response> {
  return fetch(`${STARGUARD_BASE}${path}`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(body),
  })
}

export async function apiDelete(path: string): Promise<Response> {
  return fetch(`${STARGUARD_BASE}${path}`, {
    method: 'DELETE',
    headers: getHeaders(),
  })
}

export { STARGUARD_BASE }
