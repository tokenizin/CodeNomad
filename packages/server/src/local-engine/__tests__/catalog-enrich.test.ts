import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { enrichRustCatalog, findModelDetails, ollamaHostFromBaseUrl, providerForBaseUrl } from "../catalog-enrich"

const caps = (over: Record<string, boolean> = {}) => ({
  tools: true, image: false, video: false, reasoning: false, audio: false, cloud: false, ...over,
})
const synced = (id: string, context: number, over: Record<string, boolean> = {}, cost = { input: 0, output: 0 }) => ({
  id, name: id, providerId: "x", limit: { context, input: context, output: context }, cost,
  capabilities: caps(over), status: "available" as const, lastTested: 5, source: "live" as const,
})
const syncResults = [
  {
    providerId: "openrouter", providerName: "OpenRouter", added: 0, removed: 0, updated: 0, errors: [],
    models: [synced("qwen3:8b", 1, {}, { input: 1, output: 1 })],
  },
  {
    providerId: "ollama", providerName: "Ollama", added: 0, removed: 0, updated: 0, errors: [],
    models: [synced("qwen3:8b", 40960, { reasoning: true }), synced("gemma4:26b", 262144, { image: true })],
  },
]
const catalog = {
  version: 1,
  model: "qwen3:8b",
  baseUrl: "http://127.0.0.1:11434/v1",
  models: [{ id: "qwen3:8b" }, { id: "gemma4:26b" }, { id: "new-pull:latest" }],
  agents: [],
  commands: [],
}

describe("catalog enrichment", () => {
  it("maps the agent's baseUrl to a model-sync provider", () => {
    assert.equal(providerForBaseUrl("http://127.0.0.1:11434/v1"), "ollama")
    assert.equal(providerForBaseUrl("https://openrouter.ai/api/v1"), "openrouter")
    assert.equal(providerForBaseUrl(undefined), null)
    assert.equal(ollamaHostFromBaseUrl("http://127.0.0.1:11434/v1/"), "http://127.0.0.1:11434")
  })

  it("prefers the baseUrl's provider when several list the same id", () => {
    assert.equal(findModelDetails("qwen3:8b", syncResults as any, "ollama")?.limit.context, 40960)
    assert.equal(findModelDetails("qwen3:8b", syncResults as any, "openrouter")?.limit.context, 1)
    assert.equal(findModelDetails("ollama/gemma4:26b", syncResults as any, "ollama")?.capabilities.image, true)
  })

  it("fills synced models and asks Ollama for the rest", async () => {
    let askedHost: string | undefined
    const result = await enrichRustCatalog(catalog, {
      syncResults: () => syncResults as any,
      fetchOllamaModels: async (host) => {
        askedHost = host
        return [{ id: "new-pull:latest", name: "n", providerId: "ollama", limit: { context: 131072, input: 131072, output: 131072 }, cost: { input: 0, output: 0 }, capabilities: caps({ image: true }) }]
      },
    })
    const byId = Object.fromEntries(result.models.map((m) => [m.id, m]))
    assert.equal(byId["qwen3:8b"].capabilities?.reasoning, true)
    assert.deepEqual(byId["qwen3:8b"].cost, { input: 0, output: 0 })
    assert.equal(byId["qwen3:8b"].status, "available")
    assert.equal(byId["gemma4:26b"].limit?.context, 262144)
    assert.equal(byId["new-pull:latest"].limit?.context, 131072)
    assert.equal(byId["new-pull:latest"].detailsFrom, "ollama")
    assert.equal(askedHost, "http://127.0.0.1:11434")
  })

  it("leaves models bare, without failing, when Ollama is down", async () => {
    const result = await enrichRustCatalog(catalog, {
      syncResults: () => [],
      fetchOllamaModels: async () => { throw new Error("down") },
    })
    assert.equal(result.models.length, 3)
    assert.equal(result.models[0].capabilities, undefined)
  })
})
