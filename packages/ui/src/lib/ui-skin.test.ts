import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { activeUiSkin, skinLocksDarkMode } from "./ui-skin"

describe("activeUiSkin", () => {
  it("accepts known skins only", () => {
    assert.equal(activeUiSkin("matriza"), "matriza")
    assert.equal(activeUiSkin(" MATRIZA "), "matriza")
    assert.equal(activeUiSkin("unknown"), null)
    assert.equal(activeUiSkin(undefined), null)
    assert.equal(activeUiSkin(42), null)
  })

  it("locks dark mode for the dark-only matriza skin and not without a skin", () => {
    assert.equal(skinLocksDarkMode("matriza"), true)
    assert.equal(skinLocksDarkMode(null), false)
  })
})
