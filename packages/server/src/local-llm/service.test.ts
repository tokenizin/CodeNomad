import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { listLocalLlmModels } from "./service"

describe("local llm service", () => {
  it("returns an empty provider payload when Ollama is unreachable", async () => {
    const result = await listLocalLlmModels("http://127.0.0.1:1")
    assert.equal(result.available, false)
    assert.equal(result.providerId, "ollama")
    assert.deepEqual(result.models, [])
  })
})
