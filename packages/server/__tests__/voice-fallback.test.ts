import { describe, expect, it, afterEach } from "bun:test"
import {
  DEFAULT_VOICE_FALLBACK_CHAIN,
  describeFallback,
  getNextFallbackEngine,
  getVoiceFallbackChain,
  isOpenAiVoiceFallbackError,
  isVoiceFallbackError,
  type VoiceEngine,
} from "../src/plugins/tokidapp/concierge/voice-fallback"

const ORIGINAL_CHAIN_ENV = process.env.VOICE_FALLBACK_CHAIN

afterEach(() => {
  if (ORIGINAL_CHAIN_ENV === undefined) delete process.env.VOICE_FALLBACK_CHAIN
  else process.env.VOICE_FALLBACK_CHAIN = ORIGINAL_CHAIN_ENV
})

const allAvailable = () => true

describe("getVoiceFallbackChain", () => {
  it("defaults to openai → deepgram → local → browser", () => {
    delete process.env.VOICE_FALLBACK_CHAIN
    expect(getVoiceFallbackChain()).toEqual(["openai", "deepgram", "local", "browser"])
    expect(DEFAULT_VOICE_FALLBACK_CHAIN).toEqual(["openai", "deepgram", "local", "browser"])
  })

  it("honours an env override", () => {
    process.env.VOICE_FALLBACK_CHAIN = "openai, local ,browser"
    expect(getVoiceFallbackChain()).toEqual(["openai", "local", "browser"])
  })

  it("drops unknown engines and de-dupes so the descent cannot loop", () => {
    process.env.VOICE_FALLBACK_CHAIN = "openai,bogus,local,openai,local"
    expect(getVoiceFallbackChain()).toEqual(["openai", "local"])
  })

  it("falls back to the default when the override is entirely invalid", () => {
    process.env.VOICE_FALLBACK_CHAIN = "bogus,nonsense"
    expect(getVoiceFallbackChain()).toEqual(DEFAULT_VOICE_FALLBACK_CHAIN)
  })
})

describe("getNextFallbackEngine", () => {
  it("descends one tier at a time", () => {
    delete process.env.VOICE_FALLBACK_CHAIN
    expect(getNextFallbackEngine("openai", { isAvailable: allAvailable })).toBe("deepgram")
    expect(getNextFallbackEngine("deepgram", { isAvailable: allAvailable })).toBe("local")
    expect(getNextFallbackEngine("local", { isAvailable: allAvailable })).toBe("browser")
  })

  it("returns null at the end of the chain", () => {
    expect(getNextFallbackEngine("browser", { isAvailable: allAvailable })).toBeNull()
  })

  it("skips engines that are not configured", () => {
    // Deepgram unconfigured — OpenAI must reach local, not dead-end.
    const isAvailable = (engine: VoiceEngine) => engine !== "deepgram"
    expect(getNextFallbackEngine("openai", { isAvailable })).toBe("local")
  })

  it("skips engines already attempted so the descent terminates", () => {
    expect(
      getNextFallbackEngine("openai", {
        isAvailable: allAvailable,
        attempted: ["deepgram", "local"],
      }),
    ).toBe("browser")
  })

  it("always offers the browser tier even though it has no server capability", () => {
    // Nothing is available server-side, yet browser must still be reachable.
    expect(getNextFallbackEngine("local", { isAvailable: () => false })).toBe("browser")
  })

  it("descends into the chain from an off-chain engine instead of dead-ending", () => {
    // ornith is a peer engine, not a tier — its failure starts at the top.
    expect(getNextFallbackEngine("ornith", { isAvailable: allAvailable })).toBe("openai")
  })

  it("never selects a non-tier engine as a fallback target", () => {
    process.env.VOICE_FALLBACK_CHAIN = "openai,ornith,local"
    expect(getNextFallbackEngine("openai", { isAvailable: allAvailable })).toBe("local")
  })

  it("terminates when every lower tier is exhausted", () => {
    expect(
      getNextFallbackEngine("openai", {
        isAvailable: allAvailable,
        attempted: ["deepgram", "local", "browser"],
      }),
    ).toBeNull()
  })
})

describe("isVoiceFallbackError", () => {
  it("catches OpenAI quota, billing and rate-limit failures", () => {
    expect(isVoiceFallbackError("You exceeded your current quota", "openai")).toBe(true)
    expect(isVoiceFallbackError("insufficient_quota", "openai")).toBe(true)
    expect(isVoiceFallbackError("HTTP 429 rate limit", "openai")).toBe(true)
    expect(isVoiceFallbackError("Voice mode requires OPENAI_API_KEY", "openai")).toBe(true)
  })

  it("catches Deepgram transport and auth failures", () => {
    expect(isVoiceFallbackError("Deepgram websocket close 1006", "deepgram")).toBe(true)
    expect(isVoiceFallbackError("401 Unauthorized", "deepgram")).toBe(true)
  })

  it("catches local engine startup failures", () => {
    expect(isVoiceFallbackError("spawn whisper ENOENT", "local")).toBe(true)
    expect(isVoiceFallbackError("connect ECONNREFUSED 127.0.0.1:11434", "local")).toBe(true)
    expect(isVoiceFallbackError("ollama model not found", "local")).toBe(true)
  })

  it("treats shared transport failures as fallback-worthy on any engine", () => {
    for (const engine of ["openai", "deepgram", "local"] as VoiceEngine[]) {
      expect(isVoiceFallbackError("request timed out", engine)).toBe(true)
    }
  })

  it("does not fall back on unrelated errors", () => {
    expect(isVoiceFallbackError("user cancelled the response", "openai")).toBe(false)
    expect(isVoiceFallbackError("", "openai")).toBe(false)
    expect(isVoiceFallbackError(null, "openai")).toBe(false)
    expect(isVoiceFallbackError(undefined, "openai")).toBe(false)
  })

  it("keeps the deprecated OpenAI-only classifier working", () => {
    expect(isOpenAiVoiceFallbackError("insufficient_quota")).toBe(true)
    expect(isOpenAiVoiceFallbackError("user cancelled")).toBe(false)
  })
})

describe("describeFallback", () => {
  it("names both tiers and the reason", () => {
    const notice = describeFallback("openai", "deepgram", "insufficient_quota")
    expect(notice).toContain("OpenAI Realtime")
    expect(notice).toContain("Deepgram")
    expect(notice).toContain("insufficient_quota")
  })

  it("reads cleanly without a reason", () => {
    expect(describeFallback("local", "browser")).toBe(
      "local Whisper + Piper + Ollama unavailable — switched to browser speech (Web Speech API).",
    )
  })
})
