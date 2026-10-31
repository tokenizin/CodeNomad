import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { speechTextFromReply } from "./speech-text"

describe("speechTextFromReply", () => {
  it("prefers a spoken block", () => {
    assert.equal(speechTextFromReply("```spoken\nShort answer.\n```\n\nLong **details**"), "Short answer.")
  })
  it("drops code, tables and markdown syntax", () => {
    const md = "## Result\n\nThe **build** passed, see [the log](http://x/y).\n\n```ts\nconst a = 1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- run `bun test`\n- done"
    assert.equal(speechTextFromReply(md), "Result\nThe build passed, see the log.\nrun bun test\ndone")
  })
  it("caps very long replies at a sentence", () => {
    const out = speechTextFromReply("This is a sentence. ".repeat(400))
    assert.ok(out.length <= 4000 && out.endsWith("."))
  })
})
