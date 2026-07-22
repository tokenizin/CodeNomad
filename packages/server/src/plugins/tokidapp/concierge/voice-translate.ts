/**
 * EN ↔ ID translation for local / Ornith voice pipelines.
 * Uses Ollama (Ornith) — no cloud. Keeps ASR + TTS multilingual while
 * the LLM can reason in English when interpret mode is on.
 */

const OLLAMA_BASE =
  process.env.OLLAMA_BASE_URL?.trim() ||
  process.env.ORNITH_MODEL_ENDPOINT?.replace(/\/v1\/?$/, "") ||
  "http://127.0.0.1:11434"

const TRANSLATE_MODEL =
  process.env.VOICE_TRANSLATE_MODEL?.trim() ||
  process.env.ORNITH_MODEL_ID?.trim() ||
  process.env.OLLAMA_PRIMARY_MODEL?.trim() ||
  "ornith:latest"

export type SpeechLang = "en" | "id"

const ID_MARKERS =
  /\b(yang|dan|atau|untuk|dengan|dari|ada|tidak|bisa|sudah|akan|ini|itu|saya|kami|anda|apa|bagaimana|terima\s*kasih|selamat)\b/i

export function detectSpeechLanguage(text: string): SpeechLang {
  const t = text.trim()
  if (!t) return "en"
  // Latin Indonesian often lacks accents; keyword heuristic is enough for voice.
  const idHits = (t.match(ID_MARKERS) || []).length
  if (idHits >= 2) return "id"
  if (idHits === 1 && t.split(/\s+/).length <= 8) return "id"
  return "en"
}

function langLabel(lang: SpeechLang): string {
  return lang === "id" ? "Indonesian (Bahasa Indonesia)" : "English"
}

/**
 * Translate text via Ollama /api/chat (think:false for Ornith).
 * Returns original text on failure.
 */
export async function translateSpeechText(
  text: string,
  from: SpeechLang,
  to: SpeechLang,
): Promise<string> {
  const trimmed = text.trim()
  if (!trimmed || from === to) return trimmed

  const system =
    "You are a precise bilingual interpreter for English and Indonesian. " +
    "Translate the user message only. Output the translation alone — no quotes, notes, or romanization."

  const user = `Translate from ${langLabel(from)} to ${langLabel(to)}:\n\n${trimmed}`

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 25_000)
    const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: TRANSLATE_MODEL,
        stream: false,
        think: false,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        options: { temperature: 0.1, num_predict: 512 },
      }),
    })
    clearTimeout(timer)

    if (!res.ok) {
      console.warn(`[voice-translate] HTTP ${res.status} — using original text`)
      return trimmed
    }

    const data = (await res.json()) as {
      message?: { content?: string; thinking?: string }
    }
    const out = (data.message?.content || "").trim()
    if (!out) {
      console.warn("[voice-translate] empty content — using original")
      return trimmed
    }
    return out
  } catch (err) {
    console.warn(
      "[voice-translate] failed:",
      err instanceof Error ? err.message : err,
    )
    return trimmed
  }
}

export interface VoiceLocalePlan {
  /** Language for STT (whisper language code). null = auto-detect. */
  sttLanguage: string | null
  /** Multilingual STT model when not English-only. */
  sttModel?: string
  /** Language the user spoke (best-effort). */
  userLang: SpeechLang
  /** Language to feed the LLM. */
  llmLang: SpeechLang
  /** Language for TTS reply. */
  ttsLang: SpeechLang
}

/**
 * Resolve STT/LLM/TTS language plan from session settings.
 *
 * - locale en|id|auto: speech language preference
 * - interpret: always reason in English; reply in user language (or locale)
 */
export function planVoiceLocales(opts: {
  locale: "en" | "id" | "auto"
  interpret: boolean
  detectedFromText?: SpeechLang
}): VoiceLocalePlan {
  const { locale, interpret, detectedFromText } = opts

  let userLang: SpeechLang =
    locale === "auto" ? detectedFromText || "en" : locale

  // English-only tiny models can't do Indonesian
  const needsMultilingual = locale === "id" || locale === "auto"
  const sttLanguage =
    locale === "auto" ? null : locale === "id" ? "id" : "en"
  const sttModel = needsMultilingual
    ? process.env.LOCAL_STT_MODEL_MULTILINGUAL?.trim() ||
      (process.env.LOCAL_STT_MODEL?.endsWith(".en")
        ? "small"
        : process.env.LOCAL_STT_MODEL?.trim()) ||
      "small"
    : undefined

  if (interpret) {
    return {
      sttLanguage,
      sttModel,
      userLang,
      llmLang: "en",
      ttsLang: userLang,
    }
  }

  return {
    sttLanguage,
    sttModel,
    userLang,
    llmLang: userLang,
    ttsLang: userLang,
  }
}
