import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { buildOpencodeConfigContent, mergeOpencodeConfigLayers } from "./opencode-plugin"

describe("buildOpencodeConfigContent", () => {
  it("creates config content with the CodeNomad plugin", () => {
    const content = buildOpencodeConfigContent(undefined, "file:///plugin.tgz")

    assert.deepEqual(JSON.parse(content), {
      "$schema": "https://opencode.ai/config.json",
      plugin: ["file:///plugin.tgz"],
    })
  })

  it("merges with existing JSONC content", () => {
    const content = buildOpencodeConfigContent(
      `{
        // user plugin
        "plugin": ["npm:user-plugin",],
        "model": "test-model",
      }`,
      "file:///plugin.tgz",
    )

    assert.deepEqual(JSON.parse(content), {
      "$schema": "https://opencode.ai/config.json",
      plugin: ["npm:user-plugin", "file:///plugin.tgz"],
      model: "test-model",
    })
  })

  it("does not duplicate the CodeNomad plugin", () => {
    const content = buildOpencodeConfigContent('{"plugin":["file:///plugin.tgz"]}', "file:///plugin.tgz")

    assert.deepEqual(JSON.parse(content).plugin, ["file:///plugin.tgz"])
  })
})

describe("mergeOpencodeConfigLayers", () => {
  it("deep-merges mcp enabled flags from the tunnel profile", () => {
    const merged = mergeOpencodeConfigLayers(
      JSON.stringify({
        mcp: {
          "redis-server": { enabled: true },
        },
        lsp: true,
      }),
      JSON.stringify({
        mcp: {
          "redis-server": { enabled: false },
        },
        lsp: false,
      }),
    )

    const parsed = JSON.parse(merged ?? "{}") as { lsp?: boolean; mcp?: Record<string, { enabled?: boolean }> }
    assert.equal(parsed.lsp, false)
    assert.equal(parsed.mcp?.["redis-server"]?.enabled, false)
  })
})
