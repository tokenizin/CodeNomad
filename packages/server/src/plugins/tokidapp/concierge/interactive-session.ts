/**
 * Interactive Session Manager — waiter pattern for ClickFlow interactive prompts.
 *
 * Modeled after the approval-queue.ts waiter pattern:
 * - Prompts are stored in a Map keyed by promptId
 * - Each prompt has a resolver that unblocks the awaiting promise
 * - Timeout auto-cancels unresolved prompts
 *
 * @module interactive-session
 */

// ── Types ──────────────────────────────────────────────────────

export type InteractivePromptType = 'pick_one' | 'pick_many' | 'confirm' | 'ask_text' | 'slider'

export interface InteractivePromptOption {
  value: string
  label: string
  description?: string
}

export interface InteractivePromptConfig {
  min?: number
  max?: number
  step?: number
  defaultValue?: number
  multiline?: boolean
  yesLabel?: string
  noLabel?: string
  allowCancel?: boolean
  recommended?: string
}

export interface InteractivePromptResponse {
  promptId: string
  response: Record<string, unknown>
  status: 'answered' | 'timeout' | 'cancelled'
}

/**
 * Internal waiter entry stored for each active prompt.
 */
export interface InteractivePromptWaiter {
  promptId: string
  promptType: InteractivePromptType
  question: string
  options?: InteractivePromptOption[]
  config?: InteractivePromptConfig
  status: 'pending' | 'answered' | 'timeout' | 'cancelled'
  createdAt: number
  resolve: (response: InteractivePromptResponse) => void
  reject: (reason: string) => void
  /** The send function used to deliver the prompt to the client. */
  sendFn: (message: string) => void
}

// ── Defaults ───────────────────────────────────────────────────

/** Default timeout for interactive prompts (5 minutes). */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

// ── Module-level state (singleton) ─────────────────────────────

/** Active interactive prompts keyed by promptId. */
const activePrompts = new Map<string, InteractivePromptWaiter>()

/** Timeout handles keyed by promptId for cleanup. */
const promptTimeouts = new Map<string, ReturnType<typeof setTimeout>>()

// ── Public API ─────────────────────────────────────────────────

/**
 * Create a new interactive prompt and send it to the client.
 *
 * @param promptId - Unique identifier for this prompt
 * @param promptType - Type of interactive prompt
 * @param question - The question to display to the user
 * @param sendFn - Function to send the prompt message over the WebSocket
 * @param options - Selection options (required for pick_one, pick_many)
 * @param config - Configuration for the prompt (slider bounds, text options, etc.)
 * @param timeoutMs - Timeout in milliseconds (defaults to 5 minutes)
 * @returns A Promise that resolves with the user's response, a timeout, or cancellation
 */
export function createPrompt(
  promptId: string,
  promptType: InteractivePromptType,
  question: string,
  sendFn: (message: string) => void,
  options?: InteractivePromptOption[],
  config?: InteractivePromptConfig,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<InteractivePromptResponse> {
  // Remove any existing prompt with the same ID
  cancelPrompt(promptId, 'overwritten')

  return new Promise<InteractivePromptResponse>((resolve, reject) => {
    const createdAt = Date.now()

    // Create the waiter entry
    const waiter: InteractivePromptWaiter = {
      promptId,
      promptType,
      question,
      options,
      config,
      status: 'pending',
      createdAt,
      sendFn,
      resolve: (response: InteractivePromptResponse) => {
        waiter.status = response.status
        resolve(response)
      },
      reject: (reason: string) => {
        waiter.status = 'cancelled'
        reject(new Error(reason))
      },
    }

    activePrompts.set(promptId, waiter)

    // Set up timeout
    if (timeoutMs > 0) {
      const timeoutHandle = setTimeout(() => {
        // Only auto-cancel if still pending
        const existing = activePrompts.get(promptId)
        if (existing && existing.status === 'pending') {
          existing.status = 'timeout'
          existing.resolve({
            promptId,
            response: {},
            status: 'timeout',
          })
          activePrompts.delete(promptId)
          promptTimeouts.delete(promptId)
        }
      }, timeoutMs)

      promptTimeouts.set(promptId, timeoutHandle)
    }

    // Send the prompt to the client
    const message = JSON.stringify({
      type: 'interactive_prompt',
      promptId,
      promptType,
      question,
      options,
      config,
      timeout: timeoutMs,
    })

    sendFn(message)
  })
}

/**
 * Resolve an interactive prompt with the user's response.
 *
 * @param promptId - The prompt to resolve
 * @param response - The structured response from the user
 * @returns true if the prompt was found and resolved, false if not found
 */
export function resolvePrompt(
  promptId: string,
  response: Record<string, unknown>,
): boolean {
  const waiter = activePrompts.get(promptId)
  if (!waiter || waiter.status !== 'pending') return false

  // Clear the timeout
  clearPromptTimeout(promptId)

  waiter.resolve({
    promptId,
    response,
    status: 'answered',
  })

  activePrompts.delete(promptId)
  return true
}

/**
 * Cancel a pending interactive prompt.
 *
 * @param promptId - The prompt to cancel
 * @param reason - Optional reason for cancellation
 * @returns true if the prompt was found and cancelled, false if not found
 */
export function cancelPrompt(
  promptId: string,
  reason?: string,
): boolean {
  const waiter = activePrompts.get(promptId)
  if (!waiter) return false

  // Clear the timeout
  clearPromptTimeout(promptId)

  waiter.resolve({
    promptId,
    response: {},
    status: 'cancelled',
  })

  activePrompts.delete(promptId)
  return true
}

/**
 * Check if a prompt is currently active (pending).
 */
export function hasActivePrompt(promptId: string): boolean {
  const waiter = activePrompts.get(promptId)
  return !!waiter && waiter.status === 'pending'
}

/**
 * Get the number of active (pending) prompts.
 */
export function activePromptCount(): number {
  let count = 0
  for (const waiter of activePrompts.values()) {
    if (waiter.status === 'pending') count++
  }
  return count
}

/**
 * Get all active prompt IDs.
 */
export function getActivePromptIds(): string[] {
  const ids: string[] = []
  for (const [id, waiter] of activePrompts.entries()) {
    if (waiter.status === 'pending') ids.push(id)
  }
  return ids
}

// ── Internal Helpers ───────────────────────────────────────────

function clearPromptTimeout(promptId: string): void {
  const handle = promptTimeouts.get(promptId)
  if (handle) {
    clearTimeout(handle)
    promptTimeouts.delete(promptId)
  }
}
