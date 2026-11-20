import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, describe, it } from "node:test"

import {
  catalogCapabilities,
  getCatalogModel,
  getCatalogProviderModels,
  loadModelCatalog,
  modelCatalogPath,
  probeOpenAICompatibleModels,
  resetModelCatalogCache,
  transformCatalogModels,
  type CatalogFile,
} from "./catalog"

/**
 * Fixture shaped like `~/.cache/opencode/models.json` (models.dev). Covers the
 * capability axes the real catalog uses: tool_call, reasoning, attachment and
 * the declared input/output modalities.
 */
const FIXTURE: CatalogFile = {
  groq: {
    id: "groq",
    models: {
      "llama-3.3-70b-versatile": {
        name: "Llama 3.3 70B",
        limit: { context: 131072, output: 32768 },
        cost: { input: 0.59, output: 0.79 },
        tool_call: true,
      },
      "whisper-large-v3": {
        name: "Whisper Large v3",
        limit: { context: 0, output: 0 },
        cost: { input: 0.111, output: 0 },
        modalities: { input: ["audio"], output: ["text"] },
      },
      "meta-llama/llama-4-scout-17b-16e-instruct": {
        name: "Llama 4 Scout",
        limit: { context: 131072, output: 8192 },
        cost: { input: 0.11, output: 0.34 },
        tool_call: true,
        reasoning: false,
        attachment: true,
        modalities: { input: ["text", "image"], output: ["text"] },
      },
    },
  },
  xai: {
    id: "xai",
    models: {
      "grok-4": {
        name: "Grok 4",
        limit: { context: 256000, output: 64000 },
        cost: { input: 3, output: 15 },
        tool_call: true,
        reasoning: true,
        attachment: true,
        modalities: { input: ["text", "image"], output: ["text"] },
      },
      "grok-2-image": {
        name: "Grok 2 Image",
        limit: { context: 8192, output: 0 },
        cost: { input: 2, output: 10 },
        modalities: { input: ["text"], output: ["image"] },
      },
    },
  },
  deepinfra: {
    id: "deepinfra",
    models: {
      "meta-llama/Meta-Llama-3.1-8B-Instruct": {
        name: "Llama 3.1 8B Instruct",
        limit: { context: 131072, output: 8192 },
        cost: { input: 0.03, output: 0.05 },
        tool_call: true,
      },
    },
  },
  vercel: {
    id: "vercel",
    models: {
      "openai/gpt-5": {
        name: "GPT-5",
        limit: { context: 400000, output: 128000 },
        cost: { input: 1.25, output: 10 },
        tool_call: true,
        reasoning: true,
        attachment: true,
      },
      "google/gemini-3-pro": {
        name: "Gemini 3 Pro",
        limit: { context: 1048576, output: 65536 },
        cost: { input: 2, output: 12 },
        tool_call: true,
        reasoning: true,
        attachment: true,
        modalities: { input: ["text", "image", "audio", "video"], output: ["text"] },
      },
    },
  },
  "cloudflare-ai-gateway": {
    id: "cloudflare-ai-gateway",
    models: {
      "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast": {
        name: "Llama 3.3 70B fp8 Fast",
        limit: { context: 24000, output: 0 },
        cost: { input: 0.293, output: 2.253 },
        tool_call: true,
      },
    },
  },
  "cloudflare-workers-ai": {
    id: "cloudflare-workers-ai",
    models: {
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast": {
        name: "Llama 3.3 70B fp8 Fast",
        limit: { context: 24000, output: 0 },
        cost: { input: 0.293, output: 2.253 },
        tool_call: true,
      },
      "@cf/baai/bge-large-en-v1.5": {
        name: "BGE Large EN v1.5",
        limit: { context: 512, output: 0 },
        cost: { input: 0.2, output: 0 },
      },
    },
  },
  longcat: {
    id: "longcat",
    models: {
      "LongCat-2.0": {
        name: "LongCat 2.0",
        limit: { context: 131072, output: 8192 },
        cost: { input: 0.1, output: 0.2 },
        tool_call: true,
        reasoning: true,
        attachment: true,
      },
      "LongCat-2.5-Preview": {
        name: "LongCat 2.5 Preview",
        limit: { context: 131072, output: 8192 },
        cost: { input: 0.2, output: 0.4 },
        tool_call: true,
        reasoning: true,
      },
    },
  },
}

let dir: string
let previousCatalog: string | undefined

before(() => {
  dir = mkdtempSync(join(tmpdir(), "codenomad-catalog-"))
  const path = join(dir, "models.json")
  writeFileSync(path, JSON.stringify(FIXTURE), "utf-8")
  previousCatalog = process.env.CODENOMAD_MODELS_CATALOG
  process.env.CODENOMAD_MODELS_CATALOG = path
  resetModelCatalogCache()
})

after(() => {
  if (previousCatalog === undefined) delete process.env.CODENOMAD_MODELS_CATALOG
  else process.env.CODENOMAD_MODELS_CATALOG = previousCatalog
  resetModelCatalogCache()
  rmSync(dir, { recursive: true, force: true })
})

describe("catalog loader", () => {
  it("honours CODENOMAD_MODELS_CATALOG", () => {
    assert.ok(modelCatalogPath().startsWith(dir))
  })

  it("returns every provider in the catalog", () => {
    const catalog = loadModelCatalog()
    assert.deepEqual(
      Object.keys(catalog).sort(),
      [
        "cloudflare-ai-gateway",
        "cloudflare-workers-ai",
        "deepinfra",
        "groq",
        "longcat",
        "vercel",
        "xai",
      ].sort(),
    )
  })

  it("stamps the map key onto each model", () => {
    const models = getCatalogProviderModels("groq")
    assert.equal(models.length, 3)
    for (const model of models) {
      assert.equal(typeof model.id, "string")
      assert.ok(model.id.length > 0)
    }
    assert.deepEqual(
      models.map((m) => m.id).sort(),
      ["llama-3.3-70b-versatile", "meta-llama/llama-4-scout-17b-16e-instruct", "whisper-large-v3"],
    )
  })

  it("returns [] for an unknown provider", () => {
    assert.deepEqual(getCatalogProviderModels("does-not-exist"), [])
  })

  it("looks up a single model by id", () => {
    assert.equal(getCatalogModel("groq", "llama-3.3-70b-versatile")?.name, "Llama 3.3 70B")
    assert.equal(getCatalogModel("groq", "nope"), undefined)
  })

  it("degrades to an empty catalog when the file is unreadable", () => {
    process.env.CODENOMAD_MODELS_CATALOG = join(dir, "missing.json")
    resetModelCatalogCache()
    assert.deepEqual(loadModelCatalog(), {})
    assert.deepEqual(getCatalogProviderModels("groq"), [])

    process.env.CODENOMAD_MODELS_CATALOG = join(dir, "models.json")
    resetModelCatalogCache()
    assert.equal(getCatalogProviderModels("groq").length, 3)
  })
})

describe("catalogCapabilities", () => {
  it("maps tool_call to tools and defaults the rest to false", () => {
    assert.deepEqual(catalogCapabilities({ id: "m", tool_call: true }), {
      tools: true,
      image: false,
      video: false,
      reasoning: false,
      audio: false,
      cloud: true,
    })
  })

  it("maps attachment to image", () => {
    const caps = catalogCapabilities({ id: "m", attachment: true })
    assert.equal(caps.image, true)
    assert.equal(caps.tools, false)
  })

  it("maps reasoning", () => {
    assert.equal(catalogCapabilities({ id: "m", reasoning: true }).reasoning, true)
  })

  it("derives image/video/audio from declared input modalities", () => {
    const caps = catalogCapabilities({
      id: "m",
      modalities: { input: ["text", "image", "audio", "video"], output: ["text"] },
    })
    assert.equal(caps.image, true)
    assert.equal(caps.audio, true)
    assert.equal(caps.video, true)
  })

  it("does not infer image from image-only output", () => {
    const caps = catalogCapabilities({ id: "m", modalities: { input: ["text"], output: ["image"] } })
    assert.equal(caps.image, false)
  })

  it("never reports an empty capability object", () => {
    const caps = catalogCapabilities({ id: "m" })
    assert.equal(caps.cloud, true)
    assert.equal(typeof caps.tools, "boolean")
    assert.equal(typeof caps.reasoning, "boolean")
    assert.equal(typeof caps.image, "boolean")
  })
})

describe("transformCatalogModels", () => {
  it("produces the SyncedModel payload shape", () => {
    const [model] = transformCatalogModels("groq", getCatalogProviderModels("groq"))
    assert.equal(model.id, "llama-3.3-70b-versatile")
    assert.equal(model.providerId, "groq")
    assert.equal(model.name, "Llama 3.3 70B")
    assert.deepEqual(model.limit, { context: 131072, input: 131072, output: 32768 })
    assert.deepEqual(model.cost, { input: 0.59, output: 0.79 })
    assert.equal(model.capabilities.tools, true)
    assert.equal(model.capabilities.cloud, true)
  })

  it("falls back to the id when name is missing and 0 for absent limits", () => {
    const [model] = transformCatalogModels("x", [{ id: "bare" }])
    assert.equal(model.name, "bare")
    assert.deepEqual(model.limit, { context: 0, input: 0, output: 0 })
    assert.deepEqual(model.cost, { input: 0, output: 0 })
  })

  it("preserves every model", () => {
    const models = getCatalogProviderModels("vercel")
    assert.equal(transformCatalogModels("vercel", models).length, models.length)
  })
})

describe("probeOpenAICompatibleModels", () => {
  let server: Server
  let baseUrl: string

  before(async () => {
    server = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json")
      if (req.headers.authorization !== "Bearer good-key") {
        res.statusCode = 401
        res.end(JSON.stringify({ error: { message: "Invalid API Key" } }))
        return
      }
      res.end(JSON.stringify({ object: "list", data: [{ id: "a" }, { id: "b" }] }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/models`
  })

  after(() => {
    server.close()
  })

  it("returns the served ids on success", async () => {
    const result = await probeOpenAICompatibleModels({ url: baseUrl, apiKey: "good-key", label: "Test" })
    assert.equal(result.error, null)
    assert.deepEqual([...(result.ids ?? [])].sort(), ["a", "b"])
  })

  it("reports a rejected key instead of throwing", async () => {
    const result = await probeOpenAICompatibleModels({ url: baseUrl, apiKey: "bad-key", label: "Groq" })
    assert.equal(result.ids, null)
    assert.match(result.error ?? "", /Groq: live model list returned 401/)
  })

  it("reports a missing key without touching the network", async () => {
    const result = await probeOpenAICompatibleModels({ url: baseUrl, apiKey: undefined, label: "Groq" })
    assert.equal(result.ids, null)
    assert.match(result.error ?? "", /Groq: no API key configured/)
  })

  it("reports an unreachable endpoint instead of throwing", async () => {
    const result = await probeOpenAICompatibleModels({
      url: "http://127.0.0.1:1/models",
      apiKey: "good-key",
      label: "Dead",
      timeoutMs: 2000,
    })
    assert.equal(result.ids, null)
    assert.match(result.error ?? "", /^Dead: live model list failed/)
  })
})
