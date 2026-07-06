/**
 * Interactive Tools Module — ClickFlow typed wrappers for Interactive Session Manager.
 *
 * Surface A of the ClickFlow integration. Provides 5 typed async functions that
 * wrap `createPrompt()` from interactive-session.ts with prompt ID generation,
 * response validation, and timeout/cancellation handling.
 *
 * Usage:
 *   import { askUserPickOne } from './interactive-tools'
 *   const result = await askUserPickOne({ question: "...", options: [...] }, sendFn)
 *
 * Each function:
 *   1. Generates a unique promptId
 *   2. Calls createPrompt() from T3
 *   3. Returns a typed result with timeout/cancellation booleans
 *
 * @module interactive-tools
 */

import {
  createPrompt,
  type InteractivePromptOption,
  type InteractivePromptConfig,
  type InteractivePromptResponse,
} from './interactive-session'

// ── Shared Helpers ─────────────────────────────────────────────

let promptCounter = 0

function generatePromptId(context?: string): string {
  promptCounter++
  const prefix = context ? context.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) : 'cf'
  return `${prefix}_${Date.now()}_${promptCounter}`
}

function isTimeout(resp: InteractivePromptResponse): boolean {
  return resp.status === 'timeout'
}

function isCancelled(resp: InteractivePromptResponse): boolean {
  return resp.status === 'cancelled'
}

// ── Tool 1: ask_user_pick_one ──────────────────────────────────

export interface PickOneParams {
  question: string
  context?: string
  options: InteractivePromptOption[]
  timeoutMs?: number
}

export interface PickOneResult {
  selected: string | null
  timeout: boolean
  cancelled: boolean
}

/**
 * Present a single-select question with radio-button options.
 * Returns the selected option value, or signals timeout/cancellation.
 */
export async function askUserPickOne(
  params: PickOneParams,
  sendFn: (message: string) => void,
): Promise<PickOneResult> {
  const promptId = generatePromptId(params.context || 'pickone')
  const resp = await createPrompt(
    promptId,
    'pick_one',
    params.question,
    sendFn,
    params.options,
    undefined,
    params.timeoutMs,
  )
  if (resp.status === 'timeout') return { selected: null, timeout: true, cancelled: false }
  if (resp.status === 'cancelled') return { selected: null, timeout: false, cancelled: true }
  return {
    selected: (resp.response.selected as string) ?? null,
    timeout: false,
    cancelled: false,
  }
}

// ── Tool 2: ask_user_pick_many ─────────────────────────────────

export interface PickManyParams {
  question: string
  context?: string
  options: InteractivePromptOption[]
  config?: {
    min?: number
    max?: number
  }
  timeoutMs?: number
}

export interface PickManyResult {
  selected: string[]
  timeout: boolean
  cancelled: boolean
}

/**
 * Present a multi-select question with checkbox options.
 * Configurable min/max selection bounds.
 * Returns the selected option values array, or signals timeout/cancellation.
 */
export async function askUserPickMany(
  params: PickManyParams,
  sendFn: (message: string) => void,
): Promise<PickManyResult> {
  const promptId = generatePromptId(params.context || 'pickmany')
  const resp = await createPrompt(
    promptId,
    'pick_many',
    params.question,
    sendFn,
    params.options,
    params.config as InteractivePromptConfig,
    params.timeoutMs,
  )
  if (resp.status === 'timeout') return { selected: [], timeout: true, cancelled: false }
  if (resp.status === 'cancelled') return { selected: [], timeout: false, cancelled: true }
  return {
    selected: (resp.response.selected as string[]) ?? [],
    timeout: false,
    cancelled: false,
  }
}

// ── Tool 3: ask_user_confirm ───────────────────────────────────

export interface ConfirmParams {
  question: string
  context?: string
  config?: {
    yesLabel?: string
    noLabel?: string
    allowCancel?: boolean
  }
  timeoutMs?: number
}

export interface ConfirmResult {
  choice: 'yes' | 'no' | 'cancel'
  timeout: boolean
  cancelled: boolean
}

/**
 * Present a yes/no/cancel confirmation prompt.
 * Both timeout and cancellation map to `choice: 'cancel'` for ergonomic use.
 */
export async function askUserConfirm(
  params: ConfirmParams,
  sendFn: (message: string) => void,
): Promise<ConfirmResult> {
  const promptId = generatePromptId(params.context || 'confirm')
  const resp = await createPrompt(
    promptId,
    'confirm',
    params.question,
    sendFn,
    undefined,
    params.config as InteractivePromptConfig,
    params.timeoutMs,
  )
  if (resp.status === 'timeout') return { choice: 'cancel', timeout: true, cancelled: false }
  if (resp.status === 'cancelled') return { choice: 'cancel', timeout: false, cancelled: true }
  return {
    choice: (resp.response.choice as 'yes' | 'no' | 'cancel') ?? 'cancel',
    timeout: false,
    cancelled: false,
  }
}

// ── Tool 4: ask_user_text ──────────────────────────────────────

export interface TextParams {
  question: string
  context?: string
  config?: {
    multiline?: boolean
  }
  timeoutMs?: number
}

export interface TextResult {
  text: string | null
  timeout: boolean
  cancelled: boolean
}

/**
 * Ask the user for free-form text input.
 * Supports single-line and multi-line (config.multiline) modes.
 * Returns the entered text, or signals timeout/cancellation.
 */
export async function askUserText(
  params: TextParams,
  sendFn: (message: string) => void,
): Promise<TextResult> {
  const promptId = generatePromptId(params.context || 'text')
  const resp = await createPrompt(
    promptId,
    'ask_text',
    params.question,
    sendFn,
    undefined,
    params.config as InteractivePromptConfig,
    params.timeoutMs,
  )
  if (resp.status === 'timeout') return { text: null, timeout: true, cancelled: false }
  if (resp.status === 'cancelled') return { text: null, timeout: false, cancelled: true }
  return {
    text: (resp.response.text as string) ?? null,
    timeout: false,
    cancelled: false,
  }
}

// ── Tool 5: ask_user_slider ────────────────────────────────────

export interface SliderParams {
  question: string
  context?: string
  config: {
    min: number
    max: number
    step?: number
    defaultValue?: number
  }
  timeoutMs?: number
}

export interface SliderResult {
  value: number | null
  timeout: boolean
  cancelled: boolean
}

/**
 * Ask for a numeric value via a range slider.
 * Configurable min, max, step, and default value.
 * Returns the selected number, or signals timeout/cancellation.
 */
export async function askUserSlider(
  params: SliderParams,
  sendFn: (message: string) => void,
): Promise<SliderResult> {
  const promptId = generatePromptId(params.context || 'slider')
  const resp = await createPrompt(
    promptId,
    'slider',
    params.question,
    sendFn,
    undefined,
    params.config as InteractivePromptConfig,
    params.timeoutMs,
  )
  if (resp.status === 'timeout') return { value: null, timeout: true, cancelled: false }
  if (resp.status === 'cancelled') return { value: null, timeout: false, cancelled: true }
  return {
    value: (resp.response.value as number) ?? null,
    timeout: false,
    cancelled: false,
  }
}
