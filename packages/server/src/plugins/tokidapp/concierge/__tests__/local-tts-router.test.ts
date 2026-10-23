import { describe, test, expect } from "bun:test"
import { createLocalTtsRouter } from "../local-tts-router"
import type { LocalTTSCallbacks, LocalTTSConnection } from "../local-tts"
import type { VoxCpmCallbacks, VoxCpmConnection, VoxCpmSpeakOverrides } from "../voxcpm-tts"

const PIPER = { voice: "en_US-lessac-high", synthesis: { lengthScale: 1.05 } }

function fakes() {
  const log: string[] = []
  const state = { piperCreated: 0, vox: null as null | { cbs: VoxCpmCallbacks<any>; speak: Array<[string, VoxCpmSpeakOverrides, unknown]> } }
  const createPiper = (_o: unknown, cbs: LocalTTSCallbacks): LocalTTSConnection => {
    state.piperCreated++
    return {
      ready: true,
      voiceModel: "piper",
      speak: (t, o) => log.push(`piper.speak:${t}:${(o as any)?.voice ?? ""}`),
      flush: () => { log.push("piper.flush"); cbs.onFlushed?.() },
      close: () => log.push("piper.close"),
    }
  }
  const createVox = (_o: unknown, cbs: VoxCpmCallbacks<any>): VoxCpmConnection<any> => {
    state.vox = { cbs, speak: [] }
    return {
      ready: true,
      voiceModel: "vox",
      speak: () => { throw new Error("router must use speakWithContext") },
      speakWithContext: (t, o, c) => { log.push(`vox.speak:${t}:${o.voice ?? ""}`); state.vox!.speak.push([t, o, c]) },
      flush: () => log.push("vox.flush"),
      close: () => log.push("vox.close"),
    }
  }
  return { log, state, createPiper, createVox }
}

describe("createLocalTtsRouter", () => {
  test("Piper-only: spawns Piper eagerly and never builds a VoxCPM connection", () => {
    const f = fakes()
    const r = createLocalTtsRouter({ piper: PIPER, createPiper: f.createPiper, createVox: f.createVox }, {})
    expect(f.state.piperCreated).toBe(1)
    expect(f.state.vox).toBeNull()
    expect(r.backend).toBe("piper")
    r.speak("hi", { piper: { voice: "en_GB-alba-medium" }, vox: { voice: "marin" } })
    r.flush()
    r.close()
    expect(f.log).toEqual(["piper.speak:hi:en_GB-alba-medium", "piper.flush", "piper.close"])
  })

  test("VoxCPM2 primary: uses the vox voice, does not spawn Piper", () => {
    const f = fakes()
    const r = createLocalTtsRouter({ voxVoice: "concierge", piper: PIPER, createPiper: f.createPiper, createVox: f.createVox }, {})
    expect(f.state.piperCreated).toBe(0)
    expect(r.backend).toBe("voxcpm")
    expect(r.ready).toBe(true)
    r.speak("hello", { piper: { voice: "p" }, vox: { voice: "marin" } })
    r.flush()
    expect(f.log).toEqual(["vox.speak:hello:marin", "vox.flush"])
    expect(f.state.piperCreated).toBe(0)
  })

  test("a failed utterance is spoken by Piper with the Piper overrides; Piper spawns lazily", () => {
    const f = fakes()
    const warnings: string[] = []
    const r = createLocalTtsRouter({ voxVoice: "concierge", piper: PIPER, createPiper: f.createPiper, createVox: f.createVox, log: (m) => warnings.push(m) }, {})
    r.speak("lost sentence", { piper: { voice: "id_ID-news_tts-medium" }, vox: {} })
    const [text, , context] = f.state.vox!.speak[0]
    f.state.vox!.cbs.onUtteranceFailed!({ text, overrides: {}, context, error: new Error("503 loading"), audioEmitted: false })
    expect(f.state.piperCreated).toBe(1)
    expect(f.log).toContain("piper.speak:lost sentence:id_ID-news_tts-medium")
    expect(f.log.at(-1)).toBe("piper.flush")
    expect(r.lastBackend).toBe("piper")
    expect(warnings[0]).toContain("503 loading")
  })

  test("circuit breaker: after a failure new sentences go straight to Piper until it expires", () => {
    const f = fakes()
    let t = 1_000
    const r = createLocalTtsRouter({ voxVoice: "c", piper: PIPER, createPiper: f.createPiper, createVox: f.createVox, now: () => t, breakerMs: 30_000, log: () => {} }, {})
    r.speak("a", { piper: {}, vox: {} })
    f.state.vox!.cbs.onUtteranceFailed!({ text: "a", overrides: {}, context: {}, error: new Error("down"), audioEmitted: false })
    f.log.length = 0

    r.speak("b", { piper: { voice: "p" }, vox: {} })
    expect(f.log).toEqual(["piper.speak:b:p"])

    t += 29_999
    r.speak("c", { piper: { voice: "p" }, vox: {} })
    expect(f.log.at(-1)).toBe("piper.speak:c:p")

    t += 2
    r.speak("d", { piper: {}, vox: {} })
    expect(f.log.at(-1)).toBe("vox.speak:d:")
    expect(r.lastBackend).toBe("voxcpm")
  })

  test("a stream that already played audio is NOT replayed on Piper; the error surfaces instead", () => {
    const f = fakes()
    const errors: string[] = []
    const r = createLocalTtsRouter({ voxVoice: "c", piper: PIPER, createPiper: f.createPiper, createVox: f.createVox }, { onError: (e) => errors.push(e.message) })
    r.speak("half spoken", { piper: {}, vox: {} })
    f.state.vox!.cbs.onUtteranceFailed!({ text: "half spoken", overrides: {}, context: {}, error: new Error("socket hang up"), audioEmitted: true })
    expect(f.state.piperCreated).toBe(0)
    expect(errors).toEqual(["socket hang up"])
  })

  test("close() closes both backends, later speaks error, late failures are ignored", () => {
    const f = fakes()
    const errors: string[] = []
    const r = createLocalTtsRouter({ voxVoice: "c", piper: PIPER, createPiper: f.createPiper, createVox: f.createVox, log: () => {} }, { onError: (e) => errors.push(e.message) })
    r.speak("x", { piper: {}, vox: {} })
    f.state.vox!.cbs.onUtteranceFailed!({ text: "x", overrides: {}, context: {}, error: new Error("down"), audioEmitted: false }) // spawns piper
    r.close()
    r.close()
    expect(f.log.filter((l) => l === "vox.close")).toHaveLength(1)
    expect(f.log.filter((l) => l === "piper.close")).toHaveLength(1)
    r.speak("after", { piper: {}, vox: {} })
    expect(errors).toEqual(["Cannot speak — connection is closed"])
    const piperCalls = f.log.length
    f.state.vox!.cbs.onUtteranceFailed!({ text: "late", overrides: {}, context: {}, error: new Error("late"), audioEmitted: false })
    expect(f.log.length).toBe(piperCalls)
  })
})
