/**
 * Choice Event Producer — publishes chat.choice.asked SSE events.
 *
 * Called by agents, orchestrator, or any producer that needs to present
 * structured choices to the user via the ChoiceBar UI component.
 *
 * Publishes a `chat.choice.asked` event via EventBus for the SSE stream
 * to deliver to the UI. The user's selection is returned via
 * `chat.choice.replied` (through POST /api/choices/reply or directly).
 */

import { randomUUID } from 'node:crypto'
import type { EventBus } from '../../events/bus'
import type { ChatChoiceOption } from '../types'

// ==================== Producer Function ====================

export interface ChoiceAskedOptions {
  /** Unique choice ID (auto-generated if omitted) */
  id?: string
  /** Display title/context heading */
  title?: string
  /** Allow multiple selections (default false) */
  multiple?: boolean
  /** Auto-dismiss timeout in seconds */
  timeout?: number
}

/**
 * Publish a `chat.choice.asked` event for the given instance.
 *
 * The UI ChoiceBar will display the options and allow the user to
 * select. The selection is broadcast back as `chat.choice.replied`.
 *
 * @param instanceId - The workspace/instance ID
 * @param choices - Array of choice options with label and value
 * @param eventBus - The EventBus to publish on
 * @param options - Optional settings (title, multiple, timeout, id)
 * @returns The assigned choice ID
 */
export function publishChoiceAsked(
  instanceId: string,
  choices: ChatChoiceOption[],
  eventBus: EventBus,
  options?: ChoiceAskedOptions,
): string {
  const id = options?.id ?? randomUUID()

  if (!choices || choices.length === 0) {
    throw new Error('publishChoiceAsked: choices array must not be empty')
  }

  if (choices.length > 9) {
    throw new Error('publishChoiceAsked: maximum 9 choices allowed (UI supports keys 1-9)')
  }

  eventBus.publish({
    type: 'instance.event',
    instanceId,
    event: {
      type: 'chat.choice.asked',
      properties: {
        payload: {
          id,
          choices,
          ...(options?.multiple !== undefined ? { multiple: options.multiple } : {}),
          ...(options?.title !== undefined ? { title: options.title } : {}),
          ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
        },
      },
    },
  })

  return id
}

/**
 * Publish a `chat.choice.replied` event — used when the server needs to
 * programmatically submit a choice (e.g., from a timeout fallback).
 *
 * @param instanceId - The workspace/instance ID
 * @param id - The choice ID from the asked event
 * @param value - The selected value(s)
 * @param eventBus - The EventBus to publish on
 */
export function publishChoiceReplied(
  instanceId: string,
  id: string,
  value: string | string[],
  eventBus: EventBus,
): void {
  eventBus.publish({
    type: 'instance.event',
    instanceId,
    event: {
      type: 'chat.choice.replied',
      properties: {
        payload: { id, value },
      },
    },
  })
}

/**
 * Publish a `chat.choice.expired` event — used when a choice has timed out
 * or been invalidated on the server side.
 *
 * @param instanceId - The workspace/instance ID
 * @param id - The choice ID from the asked event
 * @param eventBus - The EventBus to publish on
 */
export function publishChoiceExpired(
  instanceId: string,
  id: string,
  eventBus: EventBus,
): void {
  eventBus.publish({
    type: 'instance.event',
    instanceId,
    event: {
      type: 'chat.choice.expired',
      properties: {
        payload: { id },
      },
    },
  })
}
