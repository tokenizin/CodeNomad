/**
 * Model Sync pure module tests (SCR-2026-11-23-001, TASK-2026-11-23-004).
 * Using node:test + node:assert/strict as decided by tech lead.
 * No Solid / DOM / fetch runtime dependencies.
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"

// Import using relative paths matching the codebase patterns
import {
  ModelSyncFilter,
  ModelCapabilities,
  SyncedModelRow,
  ProviderGroup,
  ModelFilterOptions,
  CAPABILITY_KEYS,
  DEFAULT_CAPABILITIES,
  formatContext,
  rowsFromSyncResults,
  matchesSearch,
  hasCapability,
  matchesFilter,
  providerGroups,
  inconclusiveKind,
  rowKey,
} from "./filter-models"

// --- formatContext ---
describe("formatContext", () => {
  it("formats large numbers as M", () => {
    // formatContext uses toFixed(1) so 1_000_000 → "1.0M"
    assert.strictEqual(formatContext(1_000_000), "1.0M")
  })

  it("formats medium numbers as K", () => {
    // formatContext uses toFixed(0) so 5_000 → "5K"
    assert.strictEqual(formatContext(5_000), "5K")
  })

  it("formats small numbers as-is", () => {
    assert.strictEqual(formatContext(42), "42")
  })
})

// --- rowsFromSyncResults ---
describe("rowsFromSyncResults", () => {
  it("extracts rows from sync results", () => {
    const results = [
      {
        providerId: "ollama",
        providerName: "Ollama",
        models: [
          {
            id: "qwen3.8:27b",
            name: "Qwen 3.8 27B",
            limit: { context: 1_000_000 },
            capabilities: { tools: true, image: false, video: false, reasoning: false, audio: false, cloud: false },
            status: "available",
            source: "ollama",
            lastTested: Date.now(),
          },
        ],
      },
    ]

    const rows = rowsFromSyncResults(results as any[])
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0].modelId, "qwen3.8:27b")
    assert.strictEqual(rows[0].contextWindow, "1.0M")
  })

  it("handles empty results", () => {
    const rows = rowsFromSyncResults([])
    assert.strictEqual(rows.length, 0)
  })

  it("handles undefined results", () => {
    const rows = rowsFromSyncResults(undefined)
    assert.strictEqual(rows.length, 0)
  })
})

// --- matchesSearch ---
describe("matchesSearch", () => {
  it("returns true for empty query", () => {
    const model: SyncedModelRow = {
      providerId: "ollama",
      providerName: "Ollama",
      modelId: "qwen3.8:27b",
      modelName: "Qwen 3.8 27B",
      contextWindow: "1M",
      capabilities: { tools: true, image: false, video: false, reasoning: false, audio: false, cloud: false },
      status: "available",
      type: "ollama",
      lastTested: Date.now(),
    }
    assert.strictEqual(matchesSearch(model, ""), true)
    assert.strictEqual(matchesSearch(model, undefined), true)
  })

  it("matches provider name", () => {
    const model: SyncedModelRow = {
      providerId: "ollama",
      providerName: "Ollama",
      modelId: "qwen3.8:27b",
      modelName: "Qwen 3.8 27B",
      contextWindow: "1M",
      capabilities: { tools: true, image: false, video: false, reasoning: false, audio: false, cloud: false },
      status: "available",
      type: "ollama",
      lastTested: Date.now(),
    }
    assert.strictEqual(matchesSearch(model, "ollama"), true)
  })

  it("matches model name", () => {
    const model: SyncedModelRow = {
      providerId: "ollama",
      providerName: "Ollama",
      modelId: "qwen3.8:27b",
      modelName: "Qwen 3.8 27B",
      contextWindow: "1M",
      capabilities: { tools: true, image: false, video: false, reasoning: false, audio: false, cloud: false },
      status: "available",
      type: "ollama",
      lastTested: Date.now(),
    }
    assert.strictEqual(matchesSearch(model, "Qwen"), true)
  })

  it("matches model id", () => {
    const model: SyncedModelRow = {
      providerId: "ollama",
      providerName: "Ollama",
      modelId: "qwen3.8:27b",
      modelName: "Qwen 3.8 27B",
      contextWindow: "1M",
      capabilities: { tools: true, image: false, video: false, reasoning: false, audio: false, cloud: false },
      status: "available",
      type: "ollama",
      lastTested: Date.now(),
    }
    assert.strictEqual(matchesSearch(model, "qwen3.8"), true)
  })

  it("matches context window", () => {
    const model: SyncedModelRow = {
      providerId: "ollama",
      providerName: "Ollama",
      modelId: "qwen3.8:27b",
      modelName: "Qwen 3.8 27B",
      contextWindow: "1M",
      capabilities: { tools: true, image: false, video: false, reasoning: false, audio: false, cloud: false },
      status: "available",
      type: "ollama",
      lastTested: Date.now(),
    }
    assert.strictEqual(matchesSearch(model, "1M"), true)
  })

  it("returns false when no match", () => {
    const model: SyncedModelRow = {
      providerId: "ollama",
      providerName: "Ollama",
      modelId: "qwen3.8:27b",
      modelName: "Qwen 3.8 27B",
      contextWindow: "1M",
      capabilities: { tools: true, image: false, video: false, reasoning: false, audio: false, cloud: false },
      status: "available",
      type: "ollama",
      lastTested: Date.now(),
    }
    assert.strictEqual(matchesSearch(model, "nonexistent"), false)
  })
})

// --- hasCapability ---
describe("hasCapability", () => {
  it("returns true when no query and capabilities exist", () => {
    const model: SyncedModelRow = {
      providerId: "ollama",
      providerName: "Ollama",
      modelId: "qwen3.8:27b",
      modelName: "Qwen 3.8 27B",
      contextWindow: "1M",
      capabilities: { tools: true, image: false, video: false, reasoning: false, audio: false, cloud: false },
      status: "available",
      type: "ollama",
      lastTested: Date.now(),
    }
    assert.strictEqual(hasCapability(model), true)
  })

  it("returns true for specific capability", () => {
    const model: SyncedModelRow = {
      providerId: "ollama",
      providerName: "Ollama",
      modelId: "qwen3.8:27b",
      modelName: "Qwen 3.8 27B",
      contextWindow: "1M",
      capabilities: { tools: true, image: false, video: false, reasoning: false, audio: false, cloud: false },
      status: "available",
      type: "ollama",
      lastTested: Date.now(),
    }
    assert.strictEqual(hasCapability(model, "tools"), true)
  })

  it("returns false for missing capability", () => {
    const model: SyncedModelRow = {
      providerId: "ollama",
      providerName: "Ollama",
      modelId: "qwen3.8:27b",
      modelName: "Qwen 3.8 27B",
      contextWindow: "1M",
      capabilities: { tools: true, image: false, video: false, reasoning: false, audio: false, cloud: false },
      status: "available",
      type: "ollama",
      lastTested: Date.now(),
    }
    assert.strictEqual(hasCapability(model, "video"), false)
  })

  it("returns false when no capabilities enabled", () => {
    const model: SyncedModelRow = {
      providerId: "ollama",
      providerName: "Ollama",
      modelId: "qwen3.8:27b",
      modelName: "Qwen 3.8 27B",
      contextWindow: "1M",
      capabilities: { tools: false, image: false, video: false, reasoning: false, audio: false, cloud: false },
      status: "available",
      type: "ollama",
      lastTested: Date.now(),
    }
    assert.strictEqual(hasCapability(model), false)
  })
})

// --- rowKey ---
describe("rowKey", () => {
  it("creates provider/model key", () => {
    assert.strictEqual(rowKey("ollama", "qwen3.8:27b"), "ollama/qwen3.8:27b")
  })
})

// --- providerGroups ---
describe("providerGroups", () => {
  it("groups models by provider", () => {
    const models: SyncedModelRow[] = [
      {
        providerId: "ollama",
        providerName: "Ollama",
        modelId: "qwen3.8:27b",
        modelName: "Qwen 3.8 27B",
        contextWindow: "1M",
        capabilities: { tools: true, image: false, video: false, reasoning: false, audio: false, cloud: false },
        status: "available",
        type: "ollama",
        lastTested: Date.now(),
      },
      {
        providerId: "ollama",
        providerName: "Ollama",
        modelId: "llama3.2:latest",
        modelName: "Llama 3.2",
        contextWindow: "4K",
        capabilities: { tools: false, image: true, video: false, reasoning: false, audio: false, cloud: false },
        status: "available",
        type: "ollama",
        lastTested: Date.now(),
      },
      {
        providerId: "openai",
        providerName: "OpenAI",
        modelId: "gpt-4o",
        modelName: "GPT-4o",
        contextWindow: "128K",
        capabilities: { tools: true, image: true, video: true, reasoning: true, audio: true, cloud: true },
        status: "available",
        type: "openai",
        lastTested: Date.now(),
      },
    ]

    const groups = providerGroups(models)
    assert.strictEqual(groups.length, 2)
    assert.strictEqual(groups[0].providerId, "ollama")
    assert.strictEqual(groups[0].models.length, 2)
    assert.strictEqual(groups[1].providerId, "openai")
    assert.strictEqual(groups[1].models.length, 1)
  })

  it("applies filter and search", () => {
    const models: SyncedModelRow[] = [
      {
        providerId: "ollama",
        providerName: "Ollama",
        modelId: "qwen3.8:27b",
        modelName: "Qwen 3.8 27B",
        contextWindow: "1M",
        capabilities: { tools: true, image: false, video: false, reasoning: false, audio: false, cloud: false },
        status: "available",
        type: "ollama",
        lastTested: Date.now(),
      },
    ]

    const groups = providerGroups(models, { search: "Qwen", filter: "model" })
    assert.strictEqual(groups.length, 1)
    assert.strictEqual(groups[0].models.length, 1)
  })
})

// --- inconclusiveKind ---
describe("inconclusiveKind", () => {
  it("returns null for no errorDetails", () => {
    assert.strictEqual(inconclusiveKind(undefined), null)
    assert.strictEqual(inconclusiveKind(""), null)
  })

  it("returns 'key' for API key errors", () => {
    assert.strictEqual(inconclusiveKind("No API key provided"), "key")
    assert.strictEqual(inconclusiveKind("Authentication error: invalid key"), "key")
  })

  it("returns 'timeout' for timeout errors", () => {
    assert.strictEqual(inconclusiveKind("Timeout while fetching model"), "timeout")
  })

  it("returns 'other' for other errors", () => {
    assert.strictEqual(inconclusiveKind("Some other error"), "other")
  })
})

// --- matchesFilter (REOPEN-AC-3/AC-4 scoped semantics) ---
describe("matchesFilter", () => {
  const base: SyncedModelRow = {
    providerId: "ollama",
    providerName: "Ollama",
    modelId: "qwen3:8b",
    modelName: "Qwen 3 8B",
    contextWindow: "32K",
    capabilities: { tools: true, image: false, video: false, reasoning: true, audio: false, cloud: false },
    status: "available",
    type: "ollama",
    lastTested: Date.now(),
  }

  it("all: applies broad search (P0-a)", () => {
    assert.strictEqual(matchesFilter(base, "all", "qwen", null), true)
    assert.strictEqual(matchesFilter(base, "all", "ollama", null), true)
    assert.strictEqual(matchesFilter(base, "all", "32K", null), true)
    assert.strictEqual(matchesFilter(base, "all", "missing", null), false)
  })

  it("provider: scopes by providerId and ANDs with search (P0-b)", () => {
    assert.strictEqual(matchesFilter(base, "provider", "", "ollama"), true)
    assert.strictEqual(matchesFilter(base, "provider", "", "openai"), false)
    assert.strictEqual(matchesFilter(base, "provider", "qwen", "ollama"), true)
    assert.strictEqual(matchesFilter(base, "provider", "missing", "ollama"), false)
  })

  it("model: field-scoped to model name/id only (REOPEN-AC-3)", () => {
    assert.strictEqual(matchesFilter(base, "model", "qwen", null), true)
    assert.strictEqual(matchesFilter(base, "model", "8b", null), true)
    // Must NOT match provider name or context window (over-broad fallback removed)
    assert.strictEqual(matchesFilter(base, "model", "ollama", null), false)
    assert.strictEqual(matchesFilter(base, "model", "32K", null), false)
    assert.strictEqual(matchesFilter(base, "model", "", null), true)
  })

  it("id: field-scoped to model id only (REOPEN-AC-3)", () => {
    assert.strictEqual(matchesFilter(base, "id", "qwen3:8b", null), true)
    assert.strictEqual(matchesFilter(base, "id", "8b", null), true)
    // Must NOT match model display name-only tokens, provider, or context
    assert.strictEqual(matchesFilter(base, "id", "Ollama", null), false)
    assert.strictEqual(matchesFilter(base, "id", "32K", null), false)
    assert.strictEqual(matchesFilter(base, "id", "", null), true)
  })

  it("category: field-scoped to row.type (source/category) only (REOPEN-AC-3)", () => {
    assert.strictEqual(matchesFilter(base, "category", "ollama", null), true)
    // Must NOT match model name/provider name/context as broad fallback
    assert.strictEqual(matchesFilter(base, "category", "qwen", null), false)
    assert.strictEqual(matchesFilter(base, "category", "32K", null), false)
    assert.strictEqual(matchesFilter(base, "category", "", null), true)
  })

  it("capabilities: empty query means any enabled capability (REOPEN-AC-4)", () => {
    assert.strictEqual(matchesFilter(base, "capabilities", "", null), true)
    const none: SyncedModelRow = {
      ...base,
      capabilities: { tools: false, image: false, video: false, reasoning: false, audio: false, cloud: false },
    }
    assert.strictEqual(matchesFilter(none, "capabilities", "", null), false)
  })

  it("capabilities: query matches enabled capability only (REOPEN-AC-4)", () => {
    assert.strictEqual(matchesFilter(base, "capabilities", "tools", null), true)
    assert.strictEqual(matchesFilter(base, "capabilities", "reasoning", null), true)
    assert.strictEqual(matchesFilter(base, "capabilities", "image", null), false)
    assert.strictEqual(matchesFilter(base, "capabilities", "video", null), false)
  })
})