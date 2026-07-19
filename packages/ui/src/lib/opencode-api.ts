import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"

export class OpencodeApiError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = "OpencodeApiError"
    if (options && "cause" in options) {
      ;(this as any).cause = options.cause
    }
  }
}

type RequestResultLike<T> =
  | {
      data: T
      error?: undefined
    }
  | {
      data?: undefined
      error: unknown
    }

function formatOpencodeErrorCause(error: unknown): string {
  if (error == null) return ""
  if (typeof error === "string") return error
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause
    const fromCause = cause ? formatOpencodeErrorCause(cause) : ""
    return fromCause || error.message
  }
  if (typeof error === "object") {
    const obj = error as Record<string, unknown>
    const data = obj.data
    if (data && typeof data === "object" && typeof (data as { message?: unknown }).message === "string") {
      return (data as { message: string }).message
    }
    if (typeof obj.message === "string") return obj.message
    if (typeof obj.name === "string") return obj.name
    const body = obj.body
    if (body) return formatOpencodeErrorCause(body)
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return String(error)
}

export async function requestData<T>(
  promise: Promise<RequestResultLike<T> | undefined>,
  label: string,
): Promise<T> {
  const result = await promise
  if (!result) {
    throw new OpencodeApiError(`${label} returned no result`)
  }
  if ((result as any).error) {
    const detail = formatOpencodeErrorCause((result as any).error)
    throw new OpencodeApiError(detail ? `${label} failed: ${detail}` : `${label} failed`, {
      cause: (result as any).error,
    })
  }
  return (result as any).data as T
}


export type { OpencodeClient }
