import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { isDarkOnlySkin, resolveUiSkin, uiSkinScript } from "../ui-skin"

describe("resolveUiSkin", () => {
  it("accepts known skins, case- and space-insensitive", () => {
    assert.equal(resolveUiSkin({ CODENOMAD_UI_SKIN: "matriza" }), "matriza")
    assert.equal(resolveUiSkin({ CODENOMAD_UI_SKIN: "  Matriza " }), "matriza")
  })

  it("returns null when unset or unknown, so nothing is written into the page", () => {
    assert.equal(resolveUiSkin({}), null)
    assert.equal(resolveUiSkin({ CODENOMAD_UI_SKIN: "" }), null)
    assert.equal(resolveUiSkin({ CODENOMAD_UI_SKIN: '"</script><script>alert(1)' }), null)
  })
})

describe("uiSkinScript", () => {
  it("is empty without a skin, so other instances serve unchanged HTML", () => {
    assert.equal(uiSkinScript(null), "")
  })

  it("exposes the skin, marks <html> and locks dark mode for a dark-only skin", () => {
    const script = uiSkinScript("matriza")
    assert.ok(script.includes('window.__CODENOMAD_UI_SKIN__="matriza"'))
    assert.ok(script.includes('document.documentElement.dataset.skin="matriza"'))
    assert.ok(script.includes('setAttribute("data-theme","dark")'))
    assert.equal(isDarkOnlySkin("matriza"), true)
    assert.equal(isDarkOnlySkin(null), false)
  })
})
