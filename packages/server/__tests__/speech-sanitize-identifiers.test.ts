import { describe, expect, it, beforeEach } from "bun:test"
import {
  clearSpeechReferences,
  registerSpeechReference,
  sanitizeAsrText,
  sanitizeSpeechText,
  sanitizeToolResultForSpeech,
  stringifyToolResultForSpeech,
} from "../src/plugins/tokidapp/concierge/speech-sanitize"

beforeEach(() => clearSpeechReferences())

const CUID = "clx3k2j9a0000qw3f8g7h2d1e"
const UUID_V4 = "5fd162f8-106d-4eee-a245-98e2f6333198"
const UUID_V7 = "018f4c2a-7b3d-7c1e-9f2a-1b2c3d4e5f60"
const EVM = "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1"

describe("identifier redaction", () => {
  it("never speaks a cuid — the primary key format for every TokiDAPP model", () => {
    const out = sanitizeSpeechText(`Task ${CUID} is ready`)
    expect(out).not.toContain(CUID)
    expect(out).toContain("that record")
  })

  it("redacts UUIDs of any version, not just v1-v5", () => {
    expect(sanitizeSpeechText(`session ${UUID_V4}`)).not.toContain(UUID_V4)
    // v7 has version nibble 7 and was missed by the previous pattern.
    expect(sanitizeSpeechText(`session ${UUID_V7}`)).not.toContain(UUID_V7)
  })

  it("redacts EVM addresses", () => {
    const out = sanitizeSpeechText(`Send to ${EVM} now`)
    expect(out).not.toContain(EVM)
    expect(out).toContain("the contract")
  })

  it("redacts URLs including bare www links", () => {
    expect(sanitizeSpeechText("see https://star-worlds.vercel.app/x?y=1")).not.toContain("vercel")
    expect(sanitizeSpeechText("see www.tokenizin.com/path")).not.toContain("tokenizin.com")
  })

  it("redacts WhatsApp JIDs", () => {
    for (const jid of ["6281353795211@c.us", "163574349590667@lid", "120363425487146562@g.us"]) {
      const out = sanitizeSpeechText(`message from ${jid}`)
      expect(out).not.toContain(jid)
      expect(out).toContain("that contact")
    }
  })

  it("redacts email addresses", () => {
    expect(sanitizeSpeechText("mail support@tokenizin.com")).not.toContain("support@tokenizin.com")
  })

  it("redacts credentials outright rather than aliasing them", () => {
    const secrets = [
      "owa_k1_e8550235e9dfabed4c9b067610813dfb",
      "npg_JoeTg7z2MFWG",
      "sk-abcdefghijklmnopqrstuvwxyz012345",
      "tvly-dev-abc123XYZ",
    ]
    for (const secret of secrets) {
      const out = sanitizeSpeechText(`key is ${secret}`)
      expect(out).not.toContain(secret)
      expect(out).toContain("[redacted credential]")
    }
  })

  it("applies the same rules to ASR transcripts", () => {
    const out = sanitizeAsrText(`open ${CUID} and ${EVM}`)
    expect(out).not.toContain(CUID)
    expect(out).not.toContain(EVM)
  })

  it("leaves ordinary prose and numbers untouched", () => {
    const text = "The invoice totals 150000 rupiah and is due in 3 days."
    expect(sanitizeSpeechText(text)).toBe(text)
  })

  it("does not swallow ordinary long words as cuids", () => {
    const text = "This recommendation requires internationalization considerations"
    expect(sanitizeSpeechText(text)).toBe(text)
  })
})

describe("friendly primary-key references", () => {
  it("speaks a registered id as its human label", () => {
    registerSpeechReference(CUID, "Aloko")
    const out = sanitizeSpeechText(`Task ${CUID} is ready`)
    expect(out).toContain("Aloko")
    expect(out).not.toContain(CUID)
  })

  it("harvests labels from tool results so later mentions are recognisable", () => {
    sanitizeToolResultForSpeech({ id: CUID, name: "Dewi Sri launch" })
    expect(sanitizeSpeechText(`open ${CUID}`)).toContain("Dewi Sri launch")
  })

  it("matches case-insensitively", () => {
    registerSpeechReference(EVM.toLowerCase(), "Star Bridge")
    expect(sanitizeSpeechText(`call ${EVM.toUpperCase()}`)).toContain("Star Bridge")
  })
})

describe("tool results entering the model", () => {
  it("omits @omit-class fields by name", () => {
    const out = sanitizeToolResultForSpeech({
      id: CUID,
      name: "Session",
      walletAddress: EVM,
      token: "super-secret-session-token",
      apiKey: "abc",
      api_key: "abc",
      "API-KEY": "abc",
    }) as Record<string, unknown>

    expect(out.walletAddress).toBe("[omitted]")
    expect(out.token).toBe("[omitted]")
    expect(out.apiKey).toBe("[omitted]")
    expect(out.api_key).toBe("[omitted]")
    expect(out["API-KEY"]).toBe("[omitted]")
    expect(out.name).toBe("Session")
  })

  it("redacts identifiers nested in arrays and objects", () => {
    const json = stringifyToolResultForSpeech({
      rows: [{ id: UUID_V4, meta: { link: "https://example.com/x", owner: EVM } }],
    })
    expect(json).not.toContain(UUID_V4)
    expect(json).not.toContain("example.com")
    expect(json).not.toContain(EVM)
  })

  it("keeps ids out of the model even when no label is known", () => {
    const json = stringifyToolResultForSpeech({ id: CUID })
    expect(json).not.toContain(CUID)
  })

  it("terminates on deeply nested structures", () => {
    let nested: Record<string, unknown> = { id: CUID }
    for (let i = 0; i < 40; i++) nested = { child: nested }
    expect(() => stringifyToolResultForSpeech(nested)).not.toThrow()
    expect(stringifyToolResultForSpeech(nested)).toContain("nested data omitted")
  })

  it("survives circular structures without throwing", () => {
    const circular: Record<string, unknown> = { name: "loop" }
    circular.self = circular
    expect(() => stringifyToolResultForSpeech(circular)).not.toThrow()
  })

  it("passes primitives through unchanged", () => {
    expect(sanitizeToolResultForSpeech(42)).toBe(42)
    expect(sanitizeToolResultForSpeech(true)).toBe(true)
    expect(sanitizeToolResultForSpeech(null)).toBe(null)
  })
})
