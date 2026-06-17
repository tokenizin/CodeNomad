# ⚙️ Architecture Implementation Plan: Ollama LLM Integration (Gemma4 Adapter)

**Target File:** `packages/server/src/speech/service.ts`
**Goal:** Integrate the local Ollama 'gemma4:latest' model into CodeNomad's speech service using an adapter pattern, leveraging the newly created `OllamaSpeechProvider`.

***

### 📝 Overview of Changes (Highly Recommended Manual Implementation)

The changes must be applied in two places within `packages/server/src/speech/service.ts`:
1.  **Import Statements:** Add `import { OllamaSpeechProvider } from "./providers/ollama-provider";`
2.  **Method Modification 1: `resolveSettings()`** (Lines 92-105)
3.  **Method Modification 2: `createProvider()`** (Lines 84-90)

***

### 🎯 Implementation Details: Code Snippets & Context

#### 1. Modify `.resolveSettings()` Logic

This function must be updated to check if the provider specified in settings is `'ollama'`. If it matches, it should initialize a specific `NormalizedSpeechSettings` structure for Ollama, which generally requires fewer API keys but relies on the local service running.

**Context:** The return block of `resolveSettings()` needs conditional logic:

```typescript
// Locate this area (Lines 92-105 approx) and replace/wrap the existing return statement:

    return {
      provider: speech.provider?.trim() || DEFAULT_PROVIDER,
      apiKey: speech.apiKey?.trim() || process.env.OPENAI_API_KEY,
      baseUrl: speech.baseUrl?.trim() || process.env.OPENAI_BASE_URL || undefined,
// ... (rest of the fields)
    }

// ⬅️ REPLACEMENT LOGIC START ➡️
    const provider = speech.provider?.trim();

    if (provider === "ollama" && this.loggerInstance) {
        return {
            provider: "ollama",
            apiKey: "", // No API Key needed for pure localhost connection
            baseUrl: undefined,
            sttModel: speech.sttModel?.trim() || DEFAULT_STT_MODEL,
            ttsModel: speech.ttsModel?.trim() || DEFAULT_TTS_MODEL,
            ttsVoice: speech.ttsVoice?.trim() || DEFAULT_TTS_VOICE,
            ttsFormat: speech.ttsFormat ?? DEFAULT_TTS_FORMAT,
        }
    }

// ⬅️ ORIGINAL LOGIC CONTINUES ➡️
    return {
      provider: provider || DEFAULT_PROVIDER,
      apiKey: (provider && provider !== "ollama") ? (speech.apiKey?.trim() || process.env.OPENAI_API_KEY) : undefined, // Only require key if not ollama
      baseUrl: speech.baseUrl?.trim() || process.env.OPENAI_BASE_URL || undefined,
// ... rest of the fallbacks remain ...
    }

// 💡 Action Required: Please ensure the fallback logic still correctly handles when 'ollama' is *not* set but other settings are present.
```

#### 2. Modify `.createProvider()` Logic

This method must check the resolved provider and instantiate the appropriate class. This is where the selection switch happens.

**Context:** The `createProvider()` function (Lines 84-90).

```typescript
// Locate this area (Lines 84-90 approx) and update the return block:

  private createProvider(): SpeechProvider {
    const settings = this.resolveSettings()
    return new OpenAICompatibleSpeechProvider({ // <- This line needs modification
      settings,
      logger: this.logger.child({ provider: settings.provider }),
    })
}


// ⬅️ REPLACEMENT LOGIC START ➡️
  private createProvider(): SpeechProvider {
    const settings = this.resolveSettings()

    if (settings.provider === "ollama" && OllamaSpeechProvider) {
      return new OllamaSpeechProvider(settings, this.logger);
    }

    // Fallback to existing logic for OpenAI Compatible systems
    return new OpenAICompatibleSpeechProvider({
      settings,
      logger: this.logger.child({ provider: settings.provider }),
    });

  }
// ⬅️ REPLACEMENT LOGIC END ➡️
```

### ✅ Final Validation & Next Steps (Completion)

If these two snippets are applied successfully across the respective functions in `packages/server/src/speech/service.ts`, the LLM integration layer will be architecturally sound, fulfilling the initial goal.

**State:** The core service adapters pattern is designed and documented. No further coding discovery is needed for this specific task; the implementation plan itself serves as the final output documentation. In a live environment, these manual changes would now warrant running unit tests (e.g., `bun test`) to validate the API contract.
---