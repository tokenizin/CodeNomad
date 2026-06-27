import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import type { EventBus } from "../../../events/bus"
import { publishChoiceAsked, publishChoiceReplied, publishChoiceExpired } from "../choices"
import type { ChatChoiceOption } from "../../types"

// ==================== Mock EventBus ====================

class MockEventBus extends EventEmitter {
  published: any[] = []
  publish(event: any): boolean {
    this.published.push(event)
    return true
  }
}

/** Access MockEventBus.published without TS errors (bus is cast to EventBus elsewhere). */
function getPublished(bus: unknown): any[] {
  return (bus as MockEventBus).published
}

// ==================== Fixtures ====================

const INSTANCE_ID = "test-instance"

function makeChoices(): ChatChoiceOption[] {
  return [
    { label: "View Balance", value: "balance" },
    { label: "View History", value: "history" },
    { label: "Settings", value: "settings" },
  ]
}

// ==================== Tests ====================

describe("publishChoiceAsked", () => {
  it("publishes a chat.choice.asked event with auto-generated id", () => {
    const bus = new MockEventBus() as unknown as EventBus
    const choices = makeChoices()

    const id = publishChoiceAsked(INSTANCE_ID, choices, bus)

    assert.equal(typeof id, "string")
    assert.ok(id.length > 0)
    assert.equal(getPublished(bus).length, 1)

    const event = getPublished(bus)[0]
    assert.equal(event.type, "instance.event")
    assert.equal(event.instanceId, INSTANCE_ID)
    assert.equal(event.event.type, "chat.choice.asked")
    assert.equal(event.event.properties.payload.id, id)
    assert.equal(event.event.properties.payload.choices.length, 3)
    assert.equal(event.event.properties.payload.choices[0].label, "View Balance")
  })

  it("publishes with provided id", () => {
    const bus = new MockEventBus() as unknown as EventBus
    const choices = makeChoices()

    const id = publishChoiceAsked(INSTANCE_ID, choices, bus, { id: "custom-id" })

    assert.equal(id, "custom-id")
    assert.equal(getPublished(bus)[0].event.properties.payload.id, "custom-id")
  })

  it("publishes with title, multiple, and timeout", () => {
    const bus = new MockEventBus() as unknown as EventBus
    const choices = makeChoices()

    publishChoiceAsked(INSTANCE_ID, choices, bus, {
      title: "What would you like to do?",
      multiple: true,
      timeout: 30,
    })

    const payload = getPublished(bus)[0].event.properties.payload
    assert.equal(payload.title, "What would you like to do?")
    assert.equal(payload.multiple, true)
    assert.equal(payload.timeout, 30)
  })

  it("throws on empty choices array", () => {
    const bus = new MockEventBus() as unknown as EventBus
    assert.throws(
      () => publishChoiceAsked(INSTANCE_ID, [], bus),
      { message: /choices array must not be empty/ },
    )
  })

  it("throws on more than 9 choices", () => {
    const bus = new MockEventBus() as unknown as EventBus
    const choices: ChatChoiceOption[] = Array.from({ length: 10 }, (_, i) => ({
      label: `Option ${i + 1}`,
      value: `opt-${i + 1}`,
    }))
    assert.throws(
      () => publishChoiceAsked(INSTANCE_ID, choices, bus),
      { message: /maximum 9 choices/ },
    )
  })

  it("accepts exactly 9 choices", () => {
    const bus = new MockEventBus() as unknown as EventBus
    const choices: ChatChoiceOption[] = Array.from({ length: 9 }, (_, i) => ({
      label: `Option ${i + 1}`,
      value: `opt-${i + 1}`,
    }))
    const id = publishChoiceAsked(INSTANCE_ID, choices, bus)
    assert.equal(typeof id, "string")
    assert.equal(getPublished(bus)[0].event.properties.payload.choices.length, 9)
  })

  it("omits optional fields when not provided", () => {
    const bus = new MockEventBus() as unknown as EventBus
    const choices = makeChoices()

    publishChoiceAsked(INSTANCE_ID, choices, bus)

    const payload = getPublished(bus)[0].event.properties.payload
    assert.equal(payload.multiple, undefined)
    assert.equal(payload.title, undefined)
    assert.equal(payload.timeout, undefined)
  })
})

describe("publishChoiceReplied", () => {
  it("publishes a chat.choice.replied event with single value", () => {
    const bus = new MockEventBus() as unknown as EventBus

    publishChoiceReplied(INSTANCE_ID, "choice-1", "balance", bus)

    assert.equal(getPublished(bus).length, 1)
    const event = getPublished(bus)[0]
    assert.equal(event.type, "instance.event")
    assert.equal(event.event.type, "chat.choice.replied")
    assert.equal(event.event.properties.payload.id, "choice-1")
    assert.equal(event.event.properties.payload.value, "balance")
  })

  it("publishes with array value", () => {
    const bus = new MockEventBus() as unknown as EventBus

    publishChoiceReplied(INSTANCE_ID, "choice-2", ["email", "sms"], bus)

    const payload = getPublished(bus)[0].event.properties.payload
    assert.deepEqual(payload.value, ["email", "sms"])
  })
})

describe("publishChoiceExpired", () => {
  it("publishes a chat.choice.expired event", () => {
    const bus = new MockEventBus() as unknown as EventBus

    publishChoiceExpired(INSTANCE_ID, "choice-1", bus)

    assert.equal(getPublished(bus).length, 1)
    const event = getPublished(bus)[0]
    assert.equal(event.type, "instance.event")
    assert.equal(event.event.type, "chat.choice.expired")
    assert.equal(event.event.properties.payload.id, "choice-1")
  })
})
