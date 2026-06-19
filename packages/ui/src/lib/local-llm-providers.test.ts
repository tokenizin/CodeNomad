import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { buildOpenCodeOllamaProviderConfig } from "./local-llm-providers"

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
