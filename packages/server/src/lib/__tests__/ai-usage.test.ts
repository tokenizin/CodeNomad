/**
 * Voice-path usage extraction.
 *
 * Three providers report token counts three different ways, and one of them
 * (Ollama, streaming) reports them exactly once, on a chunk that is easy to
 * read past. These pin each shape.
 */

import { describe, test, expect } from "bun:test"
import { ollamaUsage, openAiUsage, estimateUsage } from "../ai-usage"

describe("ollamaUsage", () => {
  test("reads counts from a non-streamed body", () => {
    expect(
      ollamaUsage({
        model: "ornith:latest",
        message: { role: "assistant", content: "hi" },
        done: true,
        prompt_eval_count: 32,
        eval_count: 5,
      }),
    ).toEqual({
      promptTokens: 32,
      completionTokens: 5,
      totalTokens: 37,
      usageSource: "PROVIDER_REPORTED",
    })
  })

  test("reads counts from the terminal streaming chunk", () => {
    expect(
      ollamaUsage({ done: true, done_reason: "stop", prompt_eval_count: 210, eval_count: 18 }),
    ).toEqual({
      promptTokens: 210,
      completionTokens: 18,
      totalTokens: 228,
      usageSource: "PROVIDER_REPORTED",
    })
  })

  test("mid-stream chunks carry no counts", () => {
    expect(ollamaUsage({ message: { content: "partial" }, done: false })).toBeNull()
  })

  test("null, empty and non-object inputs yield null rather than throwing", () => {
    expect(ollamaUsage(null)).toBeNull()
    expect(ollamaUsage(undefined)).toBeNull()
    expect(ollamaUsage({})).toBeNull()
    expect(ollamaUsage("done")).toBeNull()
    expect(ollamaUsage(42)).toBeNull()
  })

  test("a prompt-only response still counts", () => {
    expect(ollamaUsage({ prompt_eval_count: 12, eval_count: 0 })?.totalTokens).toBe(12)
  })
})

describe("openAiUsage", () => {
  test("reads a Chat Completions usage block", () => {
    expect(
      openAiUsage({
        choices: [{ message: { content: "hi" } }],
        usage: { prompt_tokens: 40, completion_tokens: 9, total_tokens: 49 },
      }),
    ).toEqual({
      promptTokens: 40,
      completionTokens: 9,
      totalTokens: 49,
      usageSource: "PROVIDER_REPORTED",
    })
  })

  test("reads a Realtime response.done block, which names the counts differently", () => {
    // The Realtime API says input_tokens/output_tokens, not prompt/completion.
    expect(
      openAiUsage({
        usage: { total_tokens: 148, input_tokens: 120, output_tokens: 28 },
      }),
    ).toEqual({
      promptTokens: 120,
      completionTokens: 28,
      totalTokens: 148,
      usageSource: "PROVIDER_REPORTED",
    })
  })

  test("accepts a bare usage object as well as a wrapper", () => {
    expect(openAiUsage({ input_tokens: 5, output_tokens: 2 })?.totalTokens).toBe(7)
  })

  test("a response with no usage yields null", () => {
    expect(openAiUsage({ choices: [{ message: { content: "hi" } }] })).toBeNull()
    expect(openAiUsage({ usage: {} })).toBeNull()
    expect(openAiUsage(null)).toBeNull()
  })

  test("totals are recomputed, not trusted", () => {
    // A provider that reports an inconsistent total must not corrupt the sum.
    const usage = openAiUsage({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 999 } })
    expect(usage?.totalTokens).toBe(15)
  })
})

describe("token details — the text/audio split", () => {
  /** A Realtime `response.done` usage block, as the GA API reports it. */
  const realtime = {
    usage: {
      total_tokens: 1234,
      input_tokens: 1000,
      output_tokens: 234,
      input_token_details: {
        text_tokens: 100,
        audio_tokens: 900,
        cached_tokens: 800,
        cached_tokens_details: { text_tokens: 100, audio_tokens: 700 },
      },
      output_token_details: { text_tokens: 34, audio_tokens: 200 },
    },
  }

  test("splits a Realtime turn into text and audio", () => {
    expect(openAiUsage(realtime)?.details).toEqual({
      promptTextTokens: 100,
      promptAudioTokens: 900,
      completionTextTokens: 34,
      completionAudioTokens: 200,
      promptCachedTokens: 800,
    })
  })

  test("the split reconciles with the totals it breaks down", () => {
    // A pricer that charges each bucket its own rate must not end up charging
    // for more or fewer tokens than the turn actually used.
    const usage = openAiUsage(realtime)!
    expect(usage.details!.promptTextTokens! + usage.details!.promptAudioTokens!).toBe(
      usage.promptTokens,
    )
    expect(
      usage.details!.completionTextTokens! + usage.details!.completionAudioTokens!,
    ).toBe(usage.completionTokens)
  })

  test("cached tokens are a subset of the prompt, not an addition to it", () => {
    // 800 cached against 1000 input: adding it would bill 1800 tokens for a
    // 1000-token turn. It has to be discounted from the buckets, never appended.
    const usage = openAiUsage(realtime)!
    expect(usage.details!.promptCachedTokens).toBeLessThanOrEqual(usage.promptTokens)
    expect(usage.totalTokens).toBe(1234)
  })

  test("reads the Chat Completions spelling of the same thing", () => {
    // That API says prompt_tokens_details/completion_tokens_details, and
    // reports audio without a matching text count.
    expect(
      openAiUsage({
        usage: {
          prompt_tokens: 500,
          completion_tokens: 60,
          prompt_tokens_details: { audio_tokens: 420, cached_tokens: 128 },
          completion_tokens_details: { audio_tokens: 50, text_tokens: 10 },
        },
      })?.details,
    ).toEqual({
      promptTextTokens: null, // not reported — deriving 80 would fold in image tokens
      promptAudioTokens: 420,
      completionTextTokens: 10,
      completionAudioTokens: 50,
      promptCachedTokens: 128,
    })
  })

  test("a measured zero is kept distinct from an unreported bucket", () => {
    // A text-only Realtime turn genuinely has 0 audio tokens. That must not
    // read the same as a provider that never broke the counts down.
    const textOnly = openAiUsage({
      usage: {
        input_tokens: 40,
        output_tokens: 12,
        input_token_details: { text_tokens: 40, audio_tokens: 0 },
        output_token_details: { text_tokens: 12, audio_tokens: 0 },
      },
    })
    expect(textOnly?.details?.promptAudioTokens).toBe(0)

    const noBreakdown = openAiUsage({ usage: { input_tokens: 40, output_tokens: 12 } })
    expect(noBreakdown?.details).toBeUndefined()
  })

  test("a details block that reports nothing is treated as no breakdown", () => {
    // Recording all-nulls would claim a breakdown exists; an empty object here
    // must not become a row that prices as "measured, no audio".
    expect(
      openAiUsage({ usage: { input_tokens: 9, output_tokens: 1, input_token_details: {} } })
        ?.details,
    ).toBeUndefined()
  })

  test("non-numeric or malformed detail values do not become NaN", () => {
    const details = openAiUsage({
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        input_token_details: { text_tokens: "oops", audio_tokens: 10 },
      },
    })?.details
    expect(details?.promptTextTokens).toBeNull()
    expect(details?.promptAudioTokens).toBe(10)
  })

  test("providers with no notion of audio carry no split at all", () => {
    // Ollama reports two counters and nothing else; an estimate can't tell the
    // kinds apart even in principle. Neither may fabricate a breakdown.
    expect(ollamaUsage({ prompt_eval_count: 32, eval_count: 5 })?.details).toBeUndefined()
    expect(estimateUsage("hello", "hi").details).toBeUndefined()
  })
})

describe("estimateUsage", () => {
  test("labels itself as an estimate", () => {
    expect(estimateUsage("hello there", "hi").usageSource).toBe("ESTIMATED")
  })

  test("estimates fall well short of real counts on short turns", () => {
    // The same prompt Ollama scores at 32 tokens once the chat template and
    // system preamble are applied — the reason the label is recorded.
    const estimated = estimateUsage("Say hi in exactly three words.", "")
    expect(estimated.promptTokens).toBeLessThan(32)
  })

  test("empty input yields zeroes, not NaN", () => {
    expect(estimateUsage("", "")).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      usageSource: "ESTIMATED",
    })
  })
})
