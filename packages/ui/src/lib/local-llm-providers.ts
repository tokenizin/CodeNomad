import type { LocalLlmModelsResponse } from "../../../server/src/api-types"
import type { Provider } from "../types/session"
import { serverApi } from "./api-client"

export const LOCAL_LLM_PROVIDER_ID = "ollama"
export const DEFAULT_LOCAL_LLM_MODEL = "gemma4:latest"

export interface LocalLlmListedProvider {
  id: string
  name: string
  modelCount: number
  source: "config"
}

export interface OpenCodeOllamaProviderConfig {
  npm: string
  name: string
  options: { baseURL: string }
  models: Record<string, { id: string; name: string; tool_call: boolean }>
}

function toProvider(response: LocalLlmModelsResponse): Provider | null {
  if (!response.available || response.models.length === 0) {
    return null
  }

  return {
    id: response.providerId || LOCAL_LLM_PROVIDER_ID,
    name: response.providerName || "Ollama (local)",
    defaultModelId: response.defaultModelId,
    models: response.models.map((model) => ({
      id: model.id,
      name: model.name,
      providerId: response.providerId || LOCAL_LLM_PROVIDER_ID,
    })),
  }
}

export function buildOpenCodeOllamaProviderConfig(response: LocalLlmModelsResponse): OpenCodeOllamaProviderConfig {
  const host = response.host.replace(/\/+$/, "")
  return {
    npm: "@ai-sdk/openai-compatible",
    name: response.providerName || "Ollama (local)",
    options: { baseURL: `${host}/v1` },
    models: Object.fromEntries(
      response.models.map((model) => [
        model.id,
        { id: model.id, name: model.name, tool_call: true },
      ]),
    ),
  }
}

export function toLocalLlmListedProvider(response: LocalLlmModelsResponse): LocalLlmListedProvider | null {
  if (!response.available || response.models.length === 0) {
    return null
  }

  return {
    id: response.providerId || LOCAL_LLM_PROVIDER_ID,
    name: response.providerName || "Ollama (local)",
    modelCount: response.models.length,
    source: "config",
  }
}

export function mergeLocalLlmListedProviders<T extends { id: string; name: string; modelCount: number }>(
  listed: T[],
  localProvider: LocalLlmListedProvider | null,
): T[] {
  if (!localProvider) {
    return listed
  }

  const next = [...listed]
  const index = next.findIndex((provider) => provider.id === localProvider.id)

  if (index === -1) {
    return [localProvider as unknown as T, ...next]
  }

  next[index] = {
    ...next[index],
    name: localProvider.name || next[index].name,
    modelCount: Math.max(next[index].modelCount, localProvider.modelCount),
  }

  return next
}

export function mergeLocalLlmProviders(existing: Provider[], localProvider: Provider | null): Provider[] {
  if (!localProvider) {
    return existing
  }

  const index = existing.findIndex((provider) => provider.id === localProvider.id)
  if (index === -1) {
    return existing
  }

  const current = existing[index]
  const liveModelIds = new Set(localProvider.models.map((model) => model.id))
  const registeredModels = current.models.filter((model) => liveModelIds.has(model.id))
  const preferredDefault =
    localProvider.defaultModelId && registeredModels.some((model) => model.id === localProvider.defaultModelId)
      ? localProvider.defaultModelId
      : registeredModels[0]?.id ?? current.defaultModelId

  return existing.map((provider, providerIndex) =>
    providerIndex === index
      ? {
          ...current,
          name: localProvider.name || current.name,
          defaultModelId: preferredDefault,
          models: registeredModels,
        }
      : provider,
  )
}

export async function fetchLocalLlmProvider(): Promise<Provider | null> {
  try {
    const response = await serverApi.fetchLocalLlmModels()
    return toProvider(response)
  } catch {
    return null
  }
}

export async function fetchLocalLlmListedProvider(): Promise<LocalLlmListedProvider | null> {
  try {
    const response = await serverApi.fetchLocalLlmModels()
    return toLocalLlmListedProvider(response)
  } catch {
    return null
  }
}

export async function fetchLocalLlmModelsResponse(): Promise<LocalLlmModelsResponse | null> {
  try {
    return await serverApi.fetchLocalLlmModels()
  } catch {
    return null
  }
}
