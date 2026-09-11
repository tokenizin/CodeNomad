import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  buildOpenCodeOllamaProviderConfig,
  mergeLocalLlmProviders,
  ollamaModelIdsMatch,
} from "./local-llm-providers"
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

describe("ollamaModelIdsMatch", () => {
  it("matches exact and :latest aliases", () => {
    assert.equal(ollamaModelIdsMatch("hermes3:latest", "hermes3"), true)
    assert.equal(ollamaModelIdsMatch("hermes3", "hermes3:latest"), true)
    assert.equal(ollamaModelIdsMatch("qwen3-vl:235b", "qwen3-vl:235b"), true)
    assert.equal(ollamaModelIdsMatch("qwen3:8b", "hermes3"), false)
  })
})

describe("mergeLocalLlmProviders", () => {
  it("intersects OpenCode catalog with live tags (drops live-only)", () => {
    const existing: Provider[] = [
      {
        id: "ollama",
        name: "Ollama (stale)",
        defaultModelId: "hermes3",
        models: [
          { id: "hermes3", name: "Hermes 3", providerId: "ollama" },
          { id: "llama3.2", name: "Llama 3.2", providerId: "ollama" },
          { id: "qwen3-vl:235b", name: "Qwen3 VL", providerId: "ollama" },
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
        // Live-only — must not appear (OpenCode getModel would fail)
        { id: "llama3.1:70b", name: "llama3.1:70b", providerId: "ollama" },
        { id: "qwen3-vl:235b", name: "qwen3-vl:235b", providerId: "ollama" },
      ],
    }

    const merged = mergeLocalLlmProviders(existing, live)
    const ollama = merged.find((provider) => provider.id === "ollama")
    assert.ok(ollama)
    assert.equal(ollama.name, "Ollama (local)")
    // Catalog keys preserved for session create
    assert.deepEqual(
      ollama.models.map((model) => model.id),
      ["hermes3", "llama3.2", "qwen3-vl:235b"],
    )
    assert.equal(merged.find((provider) => provider.id === "openai")?.defaultModelId, "gpt-4o")
  })

  it("drops OpenCode models that are not pulled locally", () => {
    const existing: Provider[] = [
      {
        id: "ollama",
        name: "Ollama",
        defaultModelId: "qwen3.6:latest",
        models: [
          { id: "qwen3.6:latest", name: "qwen3.6", providerId: "ollama" },
          { id: "qwen3-vl:235b", name: "VL", providerId: "ollama" },
        ],
      },
    ]
    const live: Provider = {
      id: "ollama",
      name: "Ollama (local)",
      defaultModelId: "qwen3.6:latest",
      models: [{ id: "qwen3.6:latest", name: "qwen3.6:latest", providerId: "ollama" }],
    }
    const merged = mergeLocalLlmProviders(existing, live)
    const ollama = merged.find((provider) => provider.id === "ollama")
    assert.deepEqual(ollama?.models.map((m) => m.id), ["qwen3.6:latest"])
  })

  it("does not invent ollama when OpenCode has no ollama provider", () => {
    const live: Provider = {
      id: "ollama",
      name: "Ollama (local)",
      defaultModelId: "llama3.2:latest",
      models: [{ id: "llama3.2:latest", name: "llama3.2:latest", providerId: "ollama" }],
    }
    const merged = mergeLocalLlmProviders([], live)
    assert.equal(merged.length, 0)
  })
})
