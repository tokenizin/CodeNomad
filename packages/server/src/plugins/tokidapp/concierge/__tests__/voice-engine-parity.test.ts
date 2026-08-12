/**
 * Voice engine parity.
 *
 * The hook that ends a voice session has existed for a while, but the engines
 * fed it unequally: Deepgram passed the session ids, OpenAI and Ornith passed
 * neither, and the writes downstream are all guarded on those ids — so half the
 * engines silently recorded nothing. Nothing in the type system catches that,
 * because every field on the context is optional by design (a one-shot session
 * legitimately has no chat session).
 *
 * So this asserts it at the source level. It is deliberately blunt: if you add
 * an engine or drop a field from one call site, this fails and names it.
 */

import { describe, test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const DIR = join(import.meta.dir, "..")

/** Engine → the file that owns its teardown call. */
const ENGINE_SOURCES: Record<string, string> = {
  openai: "openai-realtime.ts",
  deepgram: "deepgram-realtime.ts",
  ornith: "ornith-realtime.ts",
  local: "voice-speech-orchestrator.ts",
}

/** Fields without which the downstream writes are skipped or unattributed. */
const REQUIRED_FIELDS = [
  "chatSessionId",
  "userId",
  "agentSessionId",
  "durationMs",
]

/** Extract the argument object of the `onVoiceSessionEnd({ … })` call. */
function endCallBody(source: string): string | null {
  const start = source.indexOf("onVoiceSessionEnd({")
  if (start === -1) return null
  let depth = 0
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++
    else if (source[i] === "}") {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return null
}

describe("every voice engine feeds the session-end hook equally", () => {
  for (const [engine, file] of Object.entries(ENGINE_SOURCES)) {
    test(`${engine} (${file}) passes every attribution field`, () => {
      const body = endCallBody(readFileSync(join(DIR, file), "utf8"))
      expect(body).not.toBeNull()
      expect(body).toContain(`engine: "${engine}"`)

      const missing = REQUIRED_FIELDS.filter((f) => !body!.includes(f))
      expect(missing).toEqual([])
    })
  }

  // Match an invocation, not the identifier: an unused import satisfies
  // `includes("name")` and would make these assertions vacuous.
  const calls = (source: string, fn: string) =>
    (source.match(new RegExp(`\\b${fn}\\s*\\(`, "g")) ?? []).length

  test("every engine opens an agent-session row at connect", () => {
    for (const [engine, file] of Object.entries(ENGINE_SOURCES)) {
      const source = readFileSync(join(DIR, file), "utf8")
      expect(
        calls(source, "openVoiceAgentSession"),
        `${engine} (${file}) never opens an agent-session row, so its end hook has nothing to close`,
      ).toBeGreaterThan(0)
    }
  })

  test("every engine meters its generations", () => {
    for (const [engine, file] of Object.entries(ENGINE_SOURCES)) {
      const source = readFileSync(join(DIR, file), "utf8")
      expect(
        calls(source, "meterVoiceTurn"),
        `${engine} (${file}) never records usage — its sessions would bill as zero`,
      ).toBeGreaterThan(0)
    }
  })

  test("no engine reads the billed model off the session", () => {
    // Deepgram and local resolve their LLM per turn through a fallback chain,
    // so `session.lastModelUsed` is the *previous* turn's model at best. The
    // model must come from the response that was actually generated.
    for (const [engine, file] of Object.entries(ENGINE_SOURCES)) {
      const source = readFileSync(join(DIR, file), "utf8")
      const meterCalls = source.match(/meterVoiceTurn\(\{[\s\S]*?\n\s*\}\)/g) ?? []
      for (const call of meterCalls) {
        expect(
          call.includes("modelId: session.lastModelUsed"),
          `${engine} (${file}) bills the session's last model instead of this turn's`,
        ).toBe(false)
      }
    }
  })

  test("the engine list matches the union the end hook accepts", () => {
    const source = readFileSync(join(DIR, "voice-session-end.ts"), "utf8")
    const declared = source
      .match(/export type VoiceEngineId =([^\n]*)/)?.[1]
      ?.match(/"([a-z]+)"/g)
      ?.map((s) => s.replace(/"/g, ""))
    expect(declared?.sort()).toEqual(Object.keys(ENGINE_SOURCES).sort())
  })
})
