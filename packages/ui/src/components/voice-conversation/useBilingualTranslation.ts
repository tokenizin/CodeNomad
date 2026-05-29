import { createSignal } from "solid-js"
import type { TranscriptEntry } from "./types"

export interface BilingualTranslationResult {
  /** The Indonesian translation of the most recent transcript */
  translation: () => string | null
  /** Whether a translation call is in progress */
  isTranslating: () => boolean
  /** Translate a single transcript entry and return the translated text */
  translateEntry: (entry: TranscriptEntry) => Promise<string>
  /** Source → target language pair */
  sourceLanguage: "en"
  targetLanguage: "id"
}

/**
 * Hook for English ↔ Indonesian bilingual translation.
 *
 * Calls the server translation endpoint. Falls back to the original text
 * if the endpoint is unavailable or the API key is missing.
 */
export function useBilingualTranslation(): BilingualTranslationResult {
  const [translation, setTranslation] = createSignal<string | null>(null)
  const [isTranslating, setIsTranslating] = createSignal(false)

  async function translateEntry(entry: TranscriptEntry): Promise<string> {
    setIsTranslating(true)
    try {
      const response = await fetch("/api/tokidapp/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: entry.text,
          source: "en",
          target: "id",
        }),
      })
      if (!response.ok) throw new Error(`Translation failed: ${response.status}`)
      const data = await response.json()
      const translatedText = data.translation ?? entry.text
      setTranslation(translatedText)
      return translatedText
    } catch (err) {
      // Fallback: return original text
      console.error("[useBilingualTranslation] Error:", err)
      return entry.text
    } finally {
      setIsTranslating(false)
    }
  }

  return {
    translation,
    isTranslating,
    translateEntry,
    sourceLanguage: "en",
    targetLanguage: "id",
  }
}
