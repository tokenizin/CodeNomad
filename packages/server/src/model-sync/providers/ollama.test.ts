import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { after, before, describe, it } from "node:test"

import { fetchOllamaModels, guessOllamaCapabilities, mapOllamaCapabilities } from "./ollama"

// Fake Ollama answering /api/tags and /api/show with real-shaped payloads.
const SHOW: Record<string, unknown> = {
  "qwen3.6:latest": {
    model_info: { "general.architecture": "qwen35", "qwen35.context_length": 262144 },
    parameters: "temperature 1\ntop_k 20",
    capabilities: ["completion", "vision", "tools", "thinking"],
  },
  "llama3.1:8b": {
    model_info: { "llama.context_length": 131072 },
    parameters: 'stop "<|eot_id|>"\nnum_predict 4096',
    capabilities: ["completion", "tools"],
  },
  "all-minilm:33m": {
    model_info: { "bert.context_length": 512 },
    capabilities: ["embedding"],
  },
  "glm-5.2:cloud": {
    model_info: { "glm.context_length": 1048576 },
    capabilities: ["completion", "tools", "thinking"],
    remote_host: "https://ollama.com:443",
  },
  "old-ollama:7b": { model_info: { "llama.context_length": 8192 } },
  // "missing:latest" answers 404 → fallbacks
}

let server: Server
let baseUrl: string

before(async () => {
  server = createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json")
      if (req.url === "/api/tags") {
        const names = [...Object.keys(SHOW), "missing:latest"]
        res.end(JSON.stringify({ models: names.map((name) => ({ name, model: name })) }))
        return
      }
      if (req.url === "/api/show") {
        const show = SHOW[JSON.parse(body).model]
        if (!show) {
          res.statusCode = 404
          res.end(JSON.stringify({ error: "not found" }))
          return
        }
        res.end(JSON.stringify(show))
        return
      }
      res.statusCode = 404
      res.end("{}")
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(() => server.close())

describe("fetchOllamaModels", () => {
  it("uses each model's official limits and capabilities from /api/show", async () => {
    const models = Object.fromEntries((await fetchOllamaModels(baseUrl)).map((m) => [m.id, m]))

    assert.deepEqual(models["qwen3.6:latest"].limit, { context: 262144, input: 262144, output: 262144 })
    assert.deepEqual(models["qwen3.6:latest"].capabilities, {
      tools: true, image: true, video: false, reasoning: true, audio: false, cloud: false,
    })

    assert.deepEqual(models["llama3.1:8b"].limit, { context: 131072, input: 131072, output: 4096 })
    assert.equal(models["llama3.1:8b"].capabilities.image, false)

    // Output is clamped to the context window; embedding models have no tools.
    assert.deepEqual(models["all-minilm:33m"].limit, { context: 512, input: 512, output: 512 })
    assert.equal(models["all-minilm:33m"].capabilities.tools, false)

    assert.equal(models["glm-5.2:cloud"].limit.context, 1048576)
    assert.equal(models["glm-5.2:cloud"].capabilities.cloud, true)

    // No capabilities reported → name-based guess, limits still official.
    assert.equal(models["old-ollama:7b"].limit.context, 8192)
    assert.equal(models["old-ollama:7b"].capabilities.tools, true)

    // /api/show failed → 256K fallback.
    assert.equal(models["missing:latest"].limit.context, 262144)
  })

  it("never gives every model the same window (regression: all showed 33K)", async () => {
    const contexts = new Set((await fetchOllamaModels(baseUrl)).map((m) => m.limit.context))
    assert.ok(contexts.size > 1)
    assert.ok(!contexts.has(32768))
  })
})

describe("capability mapping", () => {
  it("maps Ollama tags", () => {
    assert.deepEqual(mapOllamaCapabilities(["completion", "audio"], false), {
      tools: false, image: false, video: false, reasoning: false, audio: true, cloud: false,
    })
  })

  it("guesses from the name when Ollama reports nothing", () => {
    assert.equal(guessOllamaCapabilities("qwen3-embedding:0.6b", false).tools, false)
    assert.equal(guessOllamaCapabilities("qwen2.5vl:7b", false).image, true)
    assert.equal(guessOllamaCapabilities("deepseek-r1:32b", false).reasoning, true)
  })
})
