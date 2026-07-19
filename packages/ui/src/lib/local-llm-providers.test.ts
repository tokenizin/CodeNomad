import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { buildOpenCodeOllamaProviderConfig, mergeLocalLlmProviders } from "./local-llm-providers"
import type { Provider } from "../types/session"

describe("buildOpenCodeOllamaProviderConfig", () => {
  it("includes model ids and preserves slash/colon names", () => {
    const config = buildOpenCodeOllamaProviderConfig({
      available: true,
      providerId: "ollama",
      providerName: "Ollama (local)",
      defaultModelId: "gemma4:latest",
      host: "http://localhost:11434",
      models: [
        { id: "gemma4:latest", name: "gemma4:latest" },
        { id: "tokenizin/concierge-web2.5:latest", name: "tokenizin/concierge-web2.5:latest" },
      ],
    })

    assert.equal(config.models["gemma4:latest"].id, "gemma4:latest")
    assert.equal(config.models["tokenizin/concierge-web2.5:latest"].id, "tokenizin/concierge-web2.5:latest")
    assert.equal(config.models["gemma4:latest"].tool_call, true)
  })
})

describe("mergeLocalLlmProviders", () => {
  it("replaces ollama models with live tags instead of intersecting config keys", () => {
    const existing: Provider[] = [
      {
        id: "ollama",
        name: "Ollama (stale)",
        defaultModelId: "hermes3",
        models: [
          { id: "hermes3", name: "Hermes 3", providerId: "ollama" },
          { id: "llama3.2", name: "Llama 3.2", providerId: "ollama" },
        ],
      },
      {
        id: "openai",
        name: "OpenAI",
        defaultModelId: "gpt-4o",
        models: [{ id: "gpt-4o", name: "GPT-4o", providerId: "openai" }],
      },
    ]

    const live: Provider = {
      id: "ollama",
      name: "Ollama (local)",
      defaultModelId: "hermes3:latest",
      models: [
        { id: "hermes3:latest", name: "hermes3:latest", providerId: "ollama" },
        { id: "llama3.2:latest", name: "llama3.2:latest", providerId: "ollama" },
        { id: "qwen3:8b", name: "qwen3:8b", providerId: "ollama" },
      ],
    }

    const merged = mergeLocalLlmProviders(existing, live)
    const ollama = merged.find((provider) => provider.id === "ollama")
    assert.ok(ollama)
    assert.equal(ollama.name, "Ollama (local)")
    assert.equal(ollama.defaultModelId, "hermes3:latest")
    assert.deepEqual(
      ollama.models.map((model) => model.id),
      ["hermes3:latest", "llama3.2:latest", "qwen3:8b"],
    )
    assert.equal(merged.find((provider) => provider.id === "openai")?.defaultModelId, "gpt-4o")
  })

  it("inserts live ollama when missing from OpenCode provider list", () => {
    const live: Provider = {
      id: "ollama",
      name: "Ollama (local)",
      defaultModelId: "llama3.2:latest",
      models: [{ id: "llama3.2:latest", name: "llama3.2:latest", providerId: "ollama" }],
    }
    const merged = mergeLocalLlmProviders([], live)
    assert.equal(merged.length, 1)
    assert.equal(merged[0]?.id, "ollama")
  })
})
