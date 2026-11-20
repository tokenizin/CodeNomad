import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, describe, it } from "node:test"

import { getProviderConfigs } from "../service"
import { resetModelCatalogCache, type CatalogFile, type CatalogModel, type TransformedCatalogModel } from "./catalog"
import { getCloudflareAIGatewayModels, transformCloudflareAIGatewayModels } from "./cloudflare-ai-gateway"
import { getCloudflareWorkersAIModels, transformCloudflareWorkersAIModels } from "./cloudflare-workers-ai"
import { getDeepInfraModels, probeDeepInfraModels, transformDeepInfraModels } from "./deepinfra"
import { getGroqModels, probeGroqModels, transformGroqModels } from "./groq"
import { getLongCatModels, transformLongCatModels } from "./longcat"
import { getVercelModels, probeVercelModels, transformVercelModels } from "./vercel"
import { getXaiModels, probeXaiModels, transformXaiModels } from "./xai"

/**
 * Coverage for the seven providers added in TASK-2026-11-20-001.
 *
 * One table-driven file rather than seven near-identical files (DRY): every
 * provider exposes the same `get*Models` / `transform*Models` pair, and the
 * shared catalog transform is exercised in `catalog.test.ts`.
 */

const FIXTURE: CatalogFile = {
  "cloudflare-ai-gateway": {
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
  deepinfra: {
    models: {
      "meta-llama/Meta-Llama-3.1-8B-Instruct": {
        name: "Llama 3.1 8B Instruct",
        limit: { context: 131072, output: 8192 },
        cost: { input: 0.03, output: 0.05 },
        tool_call: true,
      },
    },
  },
  groq: {
    models: {
      "llama-3.3-70b-versatile": {
        name: "Llama 3.3 70B",
        limit: { context: 131072, output: 32768 },
        cost: { input: 0.59, output: 0.79 },
        tool_call: true,
      },
      "whisper-large-v3": {
        name: "Whisper Large v3",
        modalities: { input: ["audio"], output: ["text"] },
      },
    },
  },
  longcat: {
    models: {
      "LongCat-2.0": { name: "LongCat 2.0", limit: { context: 131072, output: 8192 }, tool_call: true, reasoning: true },
      "LongCat-2.5-Preview": { name: "LongCat 2.5 Preview", limit: { context: 131072, output: 8192 }, tool_call: true },
    },
  },
  vercel: {
    models: {
      "openai/gpt-5": { name: "GPT-5", limit: { context: 400000, output: 128000 }, tool_call: true, reasoning: true },
      "google/gemini-3-pro": {
        name: "Gemini 3 Pro",
        limit: { context: 1048576, output: 65536 },
        tool_call: true,
        attachment: true,
      },
    },
  },
  xai: {
    models: {
      "grok-4": { name: "Grok 4", limit: { context: 256000, output: 64000 }, tool_call: true, reasoning: true },
      "grok-2-image": { name: "Grok 2 Image", modalities: { input: ["text"], output: ["image"] } },
    },
  },
}

interface ProviderCase {
  id: string
  get: () => CatalogModel[]
  transform: (models: CatalogModel[]) => TransformedCatalogModel[]
  expectedCount: number
  probe?: () => Promise<{ ids: Set<string> | null; error: string | null }>
  /** Capability that the fixture's first model must advertise. */
  expectTools: boolean
}

const CASES: ProviderCase[] = [
  {
    id: "cloudflare-ai-gateway",
    get: getCloudflareAIGatewayModels,
    transform: transformCloudflareAIGatewayModels,
    expectedCount: 1,
    expectTools: true,
  },
  {
    id: "cloudflare-workers-ai",
    get: getCloudflareWorkersAIModels,
    transform: transformCloudflareWorkersAIModels,
    expectedCount: 2,
    expectTools: true,
  },
  {
    id: "deepinfra",
    get: getDeepInfraModels,
    transform: transformDeepInfraModels,
    expectedCount: 1,
    probe: () => probeDeepInfraModels(""),
    expectTools: true,
  },
  {
    id: "groq",
    get: getGroqModels,
    transform: transformGroqModels,
    expectedCount: 2,
    probe: () => probeGroqModels(""),
    expectTools: true,
  },
  {
    id: "longcat",
    get: getLongCatModels,
    transform: transformLongCatModels,
    expectedCount: 2,
    expectTools: true,
  },
  {
    id: "vercel",
    get: getVercelModels,
    transform: transformVercelModels,
    expectedCount: 2,
    probe: () => probeVercelModels(""),
    expectTools: true,
  },
  {
    id: "xai",
    get: getXaiModels,
    transform: transformXaiModels,
    expectedCount: 2,
    probe: () => probeXaiModels(""),
    expectTools: true,
  },
]

let dir: string
let previousCatalog: string | undefined

before(() => {
  dir = mkdtempSync(join(tmpdir(), "codenomad-providers-"))
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

describe("provider registry", () => {
  it("registers all seven providers as enabled", () => {
    const configs = getProviderConfigs()
    for (const { id } of CASES) {
      const config = configs.find((c) => c.id === id)
      assert.ok(config, `${id} missing from PROVIDER_CONFIGS`)
      assert.equal(config.enabled, true, `${id} should be enabled`)
      assert.ok(config.name.length > 0, `${id} needs a display name`)
    }
  })

  it("keeps the pre-existing providers registered", () => {
    const ids = getProviderConfigs().map((c) => c.id)
    for (const id of [
      "openrouter",
      "anthropic",
      "google",
      "openai",
      "nvidia",
      "nous",
      "opencode-go",
      "openrouter-fallback",
      "ornith",
      "mlx",
      "mlx-deepseek",
      "ollama",
    ]) {
      assert.ok(ids.includes(id), `${id} disappeared`)
    }
    assert.equal(ids.length, 19)
  })
})

for (const providerCase of CASES) {
  describe(providerCase.id, () => {
    it("reads its models from the catalog", () => {
      const models = providerCase.get()
      assert.equal(models.length, providerCase.expectedCount)
      assert.deepEqual(
        models.map((m) => m.id).sort(),
        Object.keys(FIXTURE[providerCase.id].models ?? {}).sort(),
      )
    })

    it("transforms into complete SyncedModel payloads", () => {
      const models = providerCase.transform(providerCase.get())
      assert.equal(models.length, providerCase.expectedCount)

      for (const model of models) {
        assert.equal(typeof model.id, "string")
        assert.ok(model.id.length > 0)
        assert.equal(model.providerId, providerCase.id)
        assert.ok(model.name.length > 0)
        assert.equal(typeof model.limit.context, "number")
        assert.equal(typeof model.limit.input, "number")
        assert.equal(typeof model.limit.output, "number")
        assert.equal(typeof model.cost.input, "number")
        assert.equal(typeof model.cost.output, "number")
        assert.equal(typeof model.capabilities.tools, "boolean")
        assert.equal(typeof model.capabilities.reasoning, "boolean")
        assert.equal(typeof model.capabilities.image, "boolean")
        assert.equal(model.capabilities.cloud, true)
      }
    })

    it("populates tools from the catalog", () => {
      const [first] = providerCase.transform(providerCase.get())
      assert.equal(first.capabilities.tools, providerCase.expectTools)
    })

    it("returns an empty list when the catalog lacks the provider", () => {
      const path = process.env.CODENOMAD_MODELS_CATALOG
      process.env.CODENOMAD_MODELS_CATALOG = join(dir, "empty.json")
      writeFileSync(join(dir, "empty.json"), "{}", "utf-8")
      resetModelCatalogCache()
      try {
        assert.deepEqual(providerCase.get(), [])
        assert.deepEqual(providerCase.transform(providerCase.get()), [])
      } finally {
        process.env.CODENOMAD_MODELS_CATALOG = path
        resetModelCatalogCache()
      }
    })

    if (providerCase.probe) {
      it("reports a missing key as an error instead of throwing", async () => {
        const result = await providerCase.probe!()
        assert.equal(result.ids, null)
        assert.ok(result.error, "expected a probe error")
        assert.match(result.error ?? "", /no API key configured/)
      })
    }
  })
}

describe("capability specifics", () => {
  it("flags groq whisper as audio", () => {
    const whisper = transformGroqModels(getGroqModels()).find((m) => m.id === "whisper-large-v3")
    assert.ok(whisper)
    assert.equal(whisper.capabilities.audio, true)
    assert.equal(whisper.capabilities.tools, false)
  })

  it("flags grok-4 as reasoning", () => {
    const grok = transformXaiModels(getXaiModels()).find((m) => m.id === "grok-4")
    assert.ok(grok)
    assert.equal(grok.capabilities.reasoning, true)
    assert.equal(grok.capabilities.tools, true)
  })

  it("flags image-input models as image capable", () => {
    const gemini = transformVercelModels(getVercelModels()).find((m) => m.id === "google/gemini-3-pro")
    assert.ok(gemini)
    assert.equal(gemini.capabilities.image, true)
  })
})
