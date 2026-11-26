import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { normalizeOllamaHost } from "../plugin/lib/ollama-fallback.ts"

describe("normalizeOllamaHost", () => {
  it("strips a trailing /v1 before appending the native Ollama API path", () => {
    assert.equal(normalizeOllamaHost("https://ollama.tokenizin.com/v1"), "https://ollama.tokenizin.com")
    assert.equal(
      `${normalizeOllamaHost("https://ollama.tokenizin.com/v1")}/api/tags`,
      "https://ollama.tokenizin.com/api/tags",
    )
  })

  it("handles trailing slashes and case-insensitive /V1", () => {
    assert.equal(normalizeOllamaHost("https://ollama.tokenizin.com/v1/"), "https://ollama.tokenizin.com")
    assert.equal(normalizeOllamaHost("https://ollama.tokenizin.com/V1/"), "https://ollama.tokenizin.com")
    assert.equal(normalizeOllamaHost("  https://ollama.tokenizin.com/v1  "), "https://ollama.tokenizin.com")
  })

  it("leaves bare hosts and the default unchanged", () => {
    assert.equal(normalizeOllamaHost("https://ollama.tokenizin.com"), "https://ollama.tokenizin.com")
    assert.equal(normalizeOllamaHost("http://127.0.0.1:11434"), "http://127.0.0.1:11434")
    assert.equal(normalizeOllamaHost(undefined), "http://127.0.0.1:11434")
    assert.equal(normalizeOllamaHost("   "), "http://127.0.0.1:11434")
  })
})
