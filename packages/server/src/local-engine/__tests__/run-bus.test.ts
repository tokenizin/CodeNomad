import { describe, expect, test } from "bun:test"
import { RunBus, type RunHeader } from "../run-bus"

const header = (sessionKey = "ses_lcl_a"): RunHeader => ({ type: "attach", sessionKey, startedAt: 1, user: { id: "u", text: "hi", createdAt: 1 }, assistantId: "a" })

describe("the run bus", () => {
  test("a listener gets what was said before it came, then each new event, then null when the run ends", () => {
    const bus = new RunBus()
    bus.start(header())
    bus.publish("ses_lcl_a", { type: "tool", id: "t1" })
    const got: unknown[] = []
    const stop = bus.follow("ses_lcl_a", (e) => got.push(e))
    expect(got).toEqual([{ type: "tool", id: "t1" }])
    bus.publish("ses_lcl_a", { type: "tool_result", id: "t1" })
    bus.end("ses_lcl_a")
    expect(got).toEqual([{ type: "tool", id: "t1" }, { type: "tool_result", id: "t1" }, null])
    expect(stop).toBeInstanceOf(Function)
    expect(bus.current("ses_lcl_a")).toBeUndefined()
    expect(bus.follow("ses_lcl_a", () => {})).toBeUndefined()
  })

  test("consecutive text deltas are joined for a late listener, but a live one sees each", () => {
    const bus = new RunBus()
    bus.start(header())
    const live: unknown[] = []
    bus.follow("ses_lcl_a", (e) => live.push(e))
    for (const text of ["Hel", "lo ", "there"]) bus.publish("ses_lcl_a", { type: "delta", text })
    bus.publish("ses_lcl_a", { type: "tool", id: "t" })
    bus.publish("ses_lcl_a", { type: "delta", text: "after" })
    expect(live.map((e) => (e as any).text ?? (e as any).type)).toEqual(["Hel", "lo ", "there", "tool", "after"])
    const late: unknown[] = []
    bus.follow("ses_lcl_a", (e) => late.push(e))
    expect(late).toEqual([{ type: "delta", text: "Hello there" }, { type: "tool", id: "t" }, { type: "delta", text: "after" }])
  })

  test("runs of different sessions do not mix, and a listener that stopped hears nothing more", () => {
    const bus = new RunBus()
    bus.start(header("ses_lcl_a"))
    bus.start(header("ses_lcl_b"))
    const a: unknown[] = []
    const stop = bus.follow("ses_lcl_a", (e) => a.push(e))!
    bus.publish("ses_lcl_b", { type: "delta", text: "b" })
    bus.publish("ses_lcl_a", { type: "delta", text: "a1" })
    stop()
    bus.publish("ses_lcl_a", { type: "delta", text: "a2" })
    expect(a).toEqual([{ type: "delta", text: "a1" }])
    bus.publish("ses_lcl_nope", { type: "delta", text: "x" }) // no run: ignored
    bus.end("ses_lcl_nope")
  })

  test("a new run of the same session starts with an empty replay", () => {
    const bus = new RunBus()
    bus.start(header())
    bus.publish("ses_lcl_a", { type: "delta", text: "first run" })
    bus.end("ses_lcl_a")
    bus.start(header())
    const got: unknown[] = []
    bus.follow("ses_lcl_a", (e) => got.push(e))
    expect(got).toEqual([])
  })
})
