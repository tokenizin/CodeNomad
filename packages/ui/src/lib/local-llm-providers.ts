import type { LocalLlmModelsResponse } from "../../../server/src/api-types"
import type { Provider } from "../types/session"
import { serverApi } from "./api-client"

export const LOCAL_LLM_PROVIDER_ID = "ollama"
export const DEFAULT_LOCAL_LLM_MODEL = "hermes3:latest"

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

/** Strip trailing `:latest` so hermes3 matches hermes3:latest. */
export function normalizeOllamaModelId(id: string): string {
  return id.replace(/:latest$/i, "")
}

/** True when a live /api/tags id matches an OpenCode provider model key. */
export function ollamaModelIdsMatch(liveId: string, configId: string): boolean {
  if (liveId === configId) return true
  const live = normalizeOllamaModelId(liveId)
  const config = normalizeOllamaModelId(configId)
  return live === config || liveId === config || `${config}:latest` === liveId
}

/**
 * Merge live Ollama tags into the OpenCode provider list for the picker.
 *
 * Only models that appear in BOTH OpenCode's catalog (session create / getModel)
 * and live `/api/tags` are shown. Live-only tags (e.g. a 70B pulled but never
 * declared in opencode.json) caused ProviderModelNotFoundError when selected.
 * Keep OpenCode model `id` (catalog key); prefer live display name when present.
 * `:latest` alias matching avoids wiping hermes3 when live only has hermes3:latest.
 */
export function mergeLocalLlmProviders(existing: Provider[], localProvider: Provider | null): Provider[] {
  if (!localProvider) {
    return existing
  }

  const index = existing.findIndex((provider) => provider.id === localProvider.id)
  // No OpenCode ollama provider → do not invent a live-only catalog (inference would fail).
  if (index === -1) {
    return existing
  }

  const current = existing[index]
  const liveModels = localProvider.models
  const intersected = current.models
    .map((configModel) => {
      const liveMatch = liveModels.find((live) => ollamaModelIdsMatch(live.id, configModel.id))
      if (!liveMatch) return null
      return {
        ...configModel,
        // Catalog id must stay OpenCode's key for POST /session { providerID, id }.
        id: configModel.id,
        name: liveMatch.name || configModel.name,
        providerId: localProvider.id,
      }
    })
    .filter((model): model is NonNullable<typeof model> => model !== null)

  const defaultCandidates = [
    current.defaultModelId,
    localProvider.defaultModelId,
    intersected[0]?.id,
  ].filter((id): id is string => Boolean(id))

  const defaultModelId =
    defaultCandidates.find((candidate) =>
      intersected.some((model) => ollamaModelIdsMatch(model.id, candidate) || model.id === candidate),
    ) ?? current.defaultModelId

  return existing.map((provider, providerIndex) =>
    providerIndex === index
      ? {
          ...current,
          name: localProvider.name || current.name,
          defaultModelId,
          models: intersected,
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
