import { describe, it } from "node:test"
import assert from "node:assert/strict"

import type {
  ChatChoiceOption,
  ChatChoiceAskedPayload,
  ChatChoiceRepliedPayload,
  ChatChoiceExpiredPayload,
} from "./notify"

describe("ChatChoice types (UI)", () => {
  // AC-3: ChatChoiceAskedPayload has id, choices, and optional fields
  it("ChatChoiceOption has label and value", () => {
    const o: ChatChoiceOption = { label: "View Balance", value: "balance" }
    assert.equal(o.label, "View Balance")
    assert.equal(o.value, "balance")
  })

  it("ChatChoiceAskedPayload has id and choices", () => {
    const p: ChatChoiceAskedPayload = {
      id: "choice-1",
      choices: [
        { label: "Option A", value: "a" },
        { label: "Option B", value: "b" },
      ],
    }
    assert.equal(p.id, "choice-1")
    assert.equal(p.choices.length, 2)
    assert.equal(p.choices[0].label, "Option A")
    assert.equal(p.choices[1].value, "b")
  })

  it("ChatChoiceAskedPayload accepts optional title, multiple, timeout", () => {
    const p: ChatChoiceAskedPayload = {
      id: "choice-2",
      choices: [{ label: "Only", value: "only" }],
      multiple: true,
      title: "What would you like to do?",
      timeout: 60,
    }
    assert.equal(p.multiple, true)
    assert.equal(p.title, "What would you like to do?")
    assert.equal(p.timeout, 60)
  })

  it("ChatChoiceRepliedPayload holds a single string", () => {
    const p: ChatChoiceRepliedPayload = { id: "c1", value: "yes" }
    assert.equal(p.value, "yes")
  })

  it("ChatChoiceRepliedPayload holds multiple strings", () => {
    const p: ChatChoiceRepliedPayload = { id: "c2", value: ["a", "b"] }
    assert.equal(p.value.length, 2)
  })

  it("ChatChoiceExpiredPayload holds id", () => {
    const p: ChatChoiceExpiredPayload = { id: "c1" }
    assert.equal(p.id, "c1")
  })

  it("types are constructable without as casts", () => {
    // Compile-time check: all fields properly typed
    const asked: ChatChoiceAskedPayload = {
      id: "test",
      choices: [{ label: "Go", value: "go" }],
      multiple: false,
      title: "Ready?",
      timeout: 10,
    }
    const replied: ChatChoiceRepliedPayload = { id: "test", value: "go" }
    const expired: ChatChoiceExpiredPayload = { id: "test" }

    assert.equal(asked.id, "test")
    assert.equal(replied.value, "go")
    assert.equal(expired.id, "test")
  })
})
