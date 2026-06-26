import { describe, it } from "node:test"
import assert from "node:assert/strict"

import type {
  ChatChoiceOption,
  ChatChoiceAskedPayload,
  ChatChoiceRepliedPayload,
  ChatChoiceExpiredPayload,
} from "../types"

describe("ChatChoice types (server)", () => {
  // AC-9: Server-side choice types are constructable
  it("ChatChoiceOption has label and value", () => {
    const o: ChatChoiceOption = { label: "View Balance", value: "balance" }
    assert.equal(o.label, "View Balance")
    assert.equal(o.value, "balance")
  })

  it("ChatChoiceAskedPayload has id and choices", () => {
    const p: ChatChoiceAskedPayload = {
      id: "choice-1",
      choices: [
        { label: "Yes", value: "yes" },
        { label: "No", value: "no" },
      ],
    }
    assert.equal(p.id, "choice-1")
    assert.equal(p.choices.length, 2)
    assert.equal(p.choices[0].label, "Yes")
    assert.equal(p.choices[1].value, "no")
  })

  it("ChatChoiceAskedPayload accepts optional fields", () => {
    const p: ChatChoiceAskedPayload = {
      id: "choice-2",
      choices: [{ label: "Option A", value: "a" }],
      multiple: true,
      title: "Select an option",
      timeout: 30,
    }
    assert.equal(p.multiple, true)
    assert.equal(p.title, "Select an option")
    assert.equal(p.timeout, 30)
  })

  it("ChatChoiceAskedPayload defaults multiple to undefined", () => {
    const p: ChatChoiceAskedPayload = {
      id: "choice-3",
      choices: [{ label: "Only", value: "only" }],
    }
    assert.equal(p.multiple, undefined)
  })

  it("ChatChoiceRepliedPayload holds a single string value", () => {
    const p: ChatChoiceRepliedPayload = {
      id: "choice-1",
      value: "yes",
    }
    assert.equal(p.id, "choice-1")
    assert.equal(p.value, "yes")
  })

  it("ChatChoiceRepliedPayload holds an array of string values", () => {
    const p: ChatChoiceRepliedPayload = {
      id: "choice-2",
      value: ["a", "b", "c"],
    }
    assert.equal(Array.isArray(p.value), true)
    assert.equal(p.value.length, 3)
    assert.equal(p.value[1], "b")
  })

  it("ChatChoiceExpiredPayload holds an id", () => {
    const p: ChatChoiceExpiredPayload = {
      id: "choice-1",
    }
    assert.equal(p.id, "choice-1")
  })

  it("discriminates replied vs expired by structure", () => {
    const replied: ChatChoiceRepliedPayload = { id: "c1", value: "ok" }
    const expired: ChatChoiceExpiredPayload = { id: "c1" }

    // replied has 'value', expired does not
    assert.ok("value" in replied)
    assert.ok(!("value" in expired))
  })

  it("accepts up to 9 choices", () => {
    const choices: ChatChoiceOption[] = []
    for (let i = 0; i < 9; i++) {
      choices.push({ label: `Option ${i + 1}`, value: `opt-${i + 1}` })
    }
    const p: ChatChoiceAskedPayload = { id: "multi", choices }
    assert.equal(p.choices.length, 9)
    assert.equal(p.choices[8].label, "Option 9")
  })
})
