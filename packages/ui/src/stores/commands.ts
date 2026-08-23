import { createSignal } from "solid-js"
import type { Command as SDKCommand } from "@opencode-ai/sdk/v2"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { requestData } from "../lib/opencode-api"

const [commandMap, setCommandMap] = createSignal<Map<string, SDKCommand[]>>(new Map())

// Built-in slash commands (CodeNomad-specific, not OpenCode custom commands).
// These appear in the slash picker and can be run from the prompt input.
const [builtInCommandMap, setBuiltInCommandMap] = createSignal<
  Map<string, { label: string; description: string; action: () => void | Promise<void> }>
>(new Map())

export async function fetchCommands(instanceId: string, client: OpencodeClient): Promise<void> {
  const commands = await requestData<SDKCommand[]>(client.command.list(), "command.list").catch(() => [])
  setCommandMap((prev) => {
    const next = new Map(prev)
    next.set(instanceId, commands)
    return next
  })
}

export function getCommands(instanceId: string): SDKCommand[] {
  return commandMap().get(instanceId) ?? []
}

export function getBuiltInCommands(): Map<string, { label: string; description: string; action: () => void | Promise<void> }> {
  return builtInCommandMap()
}

export function registerBuiltInCommand(
  name: string,
  config: { label: string; description: string; action: () => void | Promise<void> },
): void {
  setBuiltInCommandMap((prev) => {
    const next = new Map(prev)
    next.set(name.toLowerCase(), config)
    return next
  })
}

export function unregisterBuiltInCommand(name: string): void {
  setBuiltInCommandMap((prev) => {
    const next = new Map(prev)
    next.delete(name.toLowerCase())
    return next
  })
}

export function clearCommands(instanceId: string): void {
  setCommandMap((prev) => {
    if (!prev.has(instanceId)) return prev
    const next = new Map(prev)
    next.delete(instanceId)
    return next
  })
}

export { commandMap as commands }
