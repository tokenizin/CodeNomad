import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  DEFAULT_OLLAMA_CONTEXT_LIMIT,
  extractOllamaContextLength,
  extractOllamaMaxOutput,
  getOllamaModelLimits,
  listLocalLlmModels,
} from "./service"

describe("local llm service", () => {
  it("returns an empty provider payload when Ollama is unreachable", async () => {
    const result = await listLocalLlmModels("http://127.0.0.1:1")
    assert.equal(result.available, false)
    assert.equal(result.providerId, "ollama")
    assert.deepEqual(result.models, [])
  })
})

describe("extractOllamaContextLength", () => {
  it("reads the architecture-prefixed context_length from model_info", () => {
    const modelInfo = {
      "qwen3.context_length": 262144,
      "qwen3.embedding_length": 40960,
      "general.architecture": "qwen3",
    }
    assert.equal(extractOllamaContextLength(modelInfo), 262144)
  })

  it("falls back to general.context_length when no architecture key exists", () => {
    assert.equal(extractOllamaContextLength({ "general.context_length": 131072 }), 131072)
  })

  it("returns null when no context_length is advertised", () => {
    assert.equal(extractOllamaContextLength({ "general.architecture": "llama" }), null)
    assert.equal(extractOllamaContextLength(undefined), null)
    assert.equal(extractOllamaContextLength(null), null)
  })
})

describe("extractOllamaMaxOutput", () => {
  it("parses num_predict from the parameters string", () => {
    assert.equal(extractOllamaMaxOutput("stop \"<|eot_id|>\"\nnum_predict 4096\n"), 4096)
  })

  it("returns null when num_predict is absent", () => {
    assert.equal(extractOllamaMaxOutput("stop \"<|eot_id|>\"\n"), null)
    assert.equal(extractOllamaMaxOutput(undefined), null)
  })
})

describe("getOllamaModelLimits", () => {
  it("falls back to the Ollama maximum when /api/show is unreachable", async () => {
    const limits = await getOllamaModelLimits("qwen3.6:latest", "http://127.0.0.1:1")
    assert.equal(limits.context, DEFAULT_OLLAMA_CONTEXT_LIMIT)
    assert.equal(limits.output, DEFAULT_OLLAMA_CONTEXT_LIMIT)
  })
})
