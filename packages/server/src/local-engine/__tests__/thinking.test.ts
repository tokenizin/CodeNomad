import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { thinkingEnv } from "../thinking"

describe("thinkingEnv", () => {
  it("passes the options the agent knows, in lower case", () => {
    assert.deepEqual(thinkingEnv("off"), { NOMAD_THINKING: "off" })
    assert.deepEqual(thinkingEnv("On"), { NOMAD_THINKING: "on" })
    assert.deepEqual(thinkingEnv(" HIGH "), { NOMAD_THINKING: "high" })
    for (const v of ["none", "low", "medium"]) assert.deepEqual(thinkingEnv(v), { NOMAD_THINKING: v })
  })

  it("leaves the agent's own setting alone for nothing, the default, or a value it does not know", () => {
    assert.deepEqual(thinkingEnv(undefined), {})
    assert.deepEqual(thinkingEnv(""), {})
    assert.deepEqual(thinkingEnv("default"), {})
    assert.deepEqual(thinkingEnv("maximum; rm -rf /"), {})
  })
})
