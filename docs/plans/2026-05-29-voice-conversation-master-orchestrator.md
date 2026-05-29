# Unified Voice Conversation & Master Orchestrator Agent Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use godmode:task-runner to implement this plan task-by-task.

**Goal:** Build a unified voice conversation system with bilingual (EN ↔ ID) support, VAD-toggled single-button UX, Vercel Blob recording persistence, auto-posting STT to chat, and a Master Orchestrator Agent with DAG parallel processing wired to voice input.

**Architecture:** Three-layer SolidJS module (types → signals store → components/hooks) in `packages/ui/src/components/voice-conversation/`, extending existing `realtime-voice.ts` and `conversation-speech.ts` stores. Server-side extends `tokidapp.ts` with recording endpoints and wires voice → DAG orchestrator lifecycle.

**Tech Stack:** SolidJS (signals/stores), Fastify (routes/WS), OpenAI Realtime API (STT/TTS), Vercel Blob (recordings), `ws` (WebSocket), Zod (validation), existing DAG engine (`packages/server/src/plugins/tokidapp/orchestrator/`), existing i18n layer.

---

### Task Map

```
Phase 1 ── Foundation (Layer 1-2)
  Task 1: Types + Store
  Task 2: i18n Messages (EN + ID)

Phase 2 ── Hooks (Layer 3)
  Task 3: useBilingualTranslation hook
  Task 4: useVoiceConversation hook (core)

Phase 3 ── UI Components (Layer 4)
  Task 5: VoiceConversationButton component
  Task 6: VoiceConversationOverlay component
  Task 7: Styles (voice-conversation.css)

Phase 4 ── Integration
  Task 8: Modify prompt-input.tsx
  Task 9: i18n barrel updates

Phase 5 ── Server
  Task 10: Server recordings route
  Task 11: Server DAG orchestrator + voice integration

Phase 6 ── Polish & Verify
  Task 12: Completion gate
```

---

### Task 1: Types + Store

**Files:**
- Create: `packages/ui/src/components/voice-conversation/types.ts`
- Create: `packages/ui/src/components/voice-conversation/store.ts` (SolidJS signals store)
- Create: `packages/ui/src/components/voice-conversation/index.ts`

**Step 1: Create types.ts**

```typescript
import type { Accessor, Setter } from "solid-js"

/**
 * Voice conversation session state machine
 * idle → connecting → listening (VAD) → processing → speaking → listening → ...
 * Any state → paused (user click)
 * paused → listening (user click resume)
 * Any state → idle (long press / session end)
 */
export type VoiceConversationState =
  | "idle"
  | "connecting"
  | "listening"
  | "speaking"
  | "paused"
  | "error"

/** A single transcript entry in the bilingual overlay */
export interface TranscriptEntry {
  id: string
  role: "user" | "assistant"
  text: string       // English (original)
  translation: string // Indonesian translation
  timestamp: number
}

/** Session recording metadata */
export interface SessionRecording {
  id: string
  sessionId: string
  blobUrl: string
  duration: number
  transcript: string
  translations: { en: string; id: string }[]
  createdAt: string
}

/** Voice conversation preferences (stored in preferences store) */
export interface VoiceConversationPreferences {
  /** English ↔ Indonesian bilingual pair */
  bilingualEnabled: boolean
  /** Auto-post STT transcript to chat body */
  autoPostTranscript: boolean
  /** Automatically restore previous session on page load */
  autoRestoreSession: boolean
}

/**
 * Voice conversation store shape
 * Following the SolidJS signals pattern from session-state.ts and realtime-voice.ts
 */
export interface VoiceConversationStore {
  // Reactive state
  state: Accessor<VoiceConversationState>
  setState: Setter<VoiceConversationState>
  
  // Transcript
  transcripts: Accessor<TranscriptEntry[]>
  addTranscript: (entry: TranscriptEntry) => void
  clearTranscripts: () => void
  
  // Recording
  isRecording: Accessor<boolean>
  recordingDuration: Accessor<number>
  recordings: Accessor<SessionRecording[]>
  addRecording: (recording: SessionRecording) => void
  
  // Error
  lastError: Accessor<string | null>
  setLastError: Setter<string | null>
  
  // Audio levels (for VAD visualization)
  audioLevel: Accessor<number>
  setAudioLevel: Setter<number>
}
```

**Step 2: Create store.ts (SolidJS signals module)**

Following the pattern from `stores/realtime-voice.ts` and `stores/conversation-speech.ts` — module-level signals + exported accessors/actions.

```typescript
import { createSignal } from "solid-js"
import type {
  VoiceConversationState,
  TranscriptEntry,
  SessionRecording,
  VoiceConversationStore,
} from "./types"

// --- Module-level signals (per the codebase convention) ---

const [state, setState] = createSignal<VoiceConversationState>("idle")
const [transcripts, setTranscripts] = createSignal<TranscriptEntry[]>([])
const [isRecording, setIsRecording] = createSignal(false)
const [recordingDuration, setRecordingDuration] = createSignal(0)
const [recordings, setRecordings] = createSignal<SessionRecording[]>([])
const [lastError, setLastError] = createSignal<string | null>(null)
const [audioLevel, setAudioLevel] = createSignal(0)

// --- Actions ---

function addTranscript(entry: TranscriptEntry) {
  setTranscripts(prev => [...prev, entry])
}

function clearTranscripts() {
  setTranscripts([])
}

function addRecording(recording: SessionRecording) {
  setRecordings(prev => [...prev, recording])
}

function resetState() {
  setState("idle")
  setIsRecording(false)
  setRecordingDuration(0)
  setLastError(null)
  setAudioLevel(0)
}

// --- Exported store object (matching pattern) ---

export const voiceConversationStore: VoiceConversationStore = {
  state,
  setState,
  transcripts,
  addTranscript,
  clearTranscripts,
  isRecording,
  recordingDuration,
  recordings,
  addRecording,
  lastError,
  setLastError,
  audioLevel,
  setAudioLevel,
}

export { resetState }
```

**Step 3: Create index.ts (barrel export)**

```typescript
export * from "./types"
export { voiceConversationStore, resetState } from "./store"
```

---

### Task 2: i18n Messages (EN + ID)

**Files:**
- Create: `packages/ui/src/lib/i18n/messages/en/voice-conversation.ts`
- Create: `packages/ui/src/lib/i18n/messages/id/voice-conversation.ts`
- Verify: `packages/ui/src/lib/i18n/messages/id/index.ts` exists for the ID locale

**Step 1: Create English messages**

```typescript
import type { Messages } from "../types"

const messages: Messages = {
  "voiceConversation.button.idle": "Start voice conversation",
  "voiceConversation.button.listening": "Listening...",
  "voiceConversation.button.speaking": "Speaking...",
  "voiceConversation.button.paused": "Paused — tap to resume",
  "voiceConversation.button.connecting": "Connecting...",
  "voiceConversation.button.error": "Error — tap to retry",
  "voiceConversation.overlay.transcript": "Transcript",
  "voiceConversation.overlay.translation": "Translation (Indonesian)",
  "voiceConversation.overlay.duration": "Duration: {duration}s",
  "voiceConversation.overlay.you": "You",
  "voiceConversation.overlay.assistant": "Assistant",
  "voiceConversation.overlay.noTranscripts": "No transcripts yet. Start speaking!",
  "voiceConversation.error.microphone": "Microphone access is required for voice conversation.",
  "voiceConversation.error.connection": "Failed to connect to voice service.",
  "voiceConversation.error.apiKey": "Speech API key is not configured.",
  "voiceConversation.error.restore": "Could not restore previous session recording.",
  "voiceConversation.error.upload": "Failed to save session recording.",
  "voiceConversation.settings.bilingualEnabled": "Show Indonesian translation",
  "voiceConversation.settings.autoPostTranscript": "Auto-post transcript to chat",
  "voiceConversation.settings.autoRestoreSession": "Auto-restore previous session",
  "voiceConversation.session.restored": "Previous session restored — {count} message(s)",
}
```

**Step 2: Create Indonesian messages**

Same keys, Indonesian values:

```typescript
import type { Messages } from "../types"

const messages: Messages = {
  "voiceConversation.button.idle": "Mulai percakapan suara",
  "voiceConversation.button.listening": "Mendengarkan...",
  "voiceConversation.button.speaking": "Berbicara...",
  "voiceConversation.button.paused": "Dijeda — ketuk untuk melanjutkan",
  "voiceConversation.button.connecting": "Menghubungkan...",
  "voiceConversation.button.error": "Error — ketuk untuk coba lagi",
  "voiceConversation.overlay.transcript": "Transkrip",
  "voiceConversation.overlay.translation": "Terjemahan (Indonesia)",
  "voiceConversation.overlay.duration": "Durasi: {duration}d",
  "voiceConversation.overlay.you": "Anda",
  "voiceConversation.overlay.assistant": "Asisten",
  "voiceConversation.overlay.noTranscripts": "Belum ada transkrip. Mulai berbicara!",
  "voiceConversation.error.microphone": "Akses mikrofon diperlukan untuk percakapan suara.",
  "voiceConversation.error.connection": "Gagal terhubung ke layanan suara.",
  "voiceConversation.error.apiKey": "Kunci API Suara belum dikonfigurasi.",
  "voiceConversation.error.restore": "Tidak dapat memulihkan rekaman sesi sebelumnya.",
  "voiceConversation.error.upload": "Gagal menyimpan rekaman sesi.",
  "voiceConversation.settings.bilingualEnabled": "Tampilkan terjemahan Indonesia",
  "voiceConversation.settings.autoPostTranscript": "Otomatis posting transkrip ke chat",
  "voiceConversation.settings.autoRestoreSession": "Otomatis pulihkan sesi sebelumnya",
  "voiceConversation.session.restored": "Sesi sebelumnya dipulihkan — {count} pesan",
}
```

---

### Task 3: useBilingualTranslation Hook

**File:**
- Create: `packages/ui/src/components/voice-conversation/useBilingualTranslation.ts`

**Pattern:** SolidJS hook following the shape of `useRealtimeVoiceInput.ts` — returns accessor signals + actions.

```typescript
import { createSignal, createResource, createEffect } from "solid-js"
import { voiceConversationStore } from "./store"
import type { TranscriptEntry } from "./types"

interface BilingualTranslationResult {
  /** The Indonesian translation of the current/last transcript */
  translation: () => string | null
  /** Whether translation is in progress */
  isTranslating: () => boolean
  /** Translate a transcript entry — returns translated text */
  translateEntry: (entry: TranscriptEntry) => Promise<string>
  /** Available language pair */
  sourceLanguage: "en"
  targetLanguage: "id"
}

/**
 * Hook for English ↔ Indonesian bilingual translation.
 * Uses the existing server translation endpoint or direct OpenAI API.
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
      if (!response.ok) throw new Error("Translation failed")
      const data = await response.json()
      setTranslation(data.translation)
      return data.translation
    } catch (err) {
      console.error("Translation error:", err)
      return entry.text // Fallback: return original
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
```

---

### Task 4: useVoiceConversation Hook (Core)

**File:**
- Create: `packages/ui/src/components/voice-conversation/useVoiceConversation.ts`

**This is the most complex hook.** It orchestrates:
1. Existing `realtime-voice.ts` (RealtimeVoiceClient for WebSocket to OpenAI)
2. Existing `conversation-speech.ts` (TTS playback queue)
3. New bilingual translation
4. New MediaRecorder for session recording
5. New Vercel Blob upload/download
6. VAD listening state management
7. Interruption (cancelResponse)

**Pattern:** Follows existing hooks — module-level signals, exported functions.

```typescript
import { createSignal, createEffect, onCleanup } from "solid-js"
import { voiceConversationStore } from "./store"
import { useBilingualTranslation } from "./useBilingualTranslation"
import { getRealtimeVoiceClient, disconnectRealtimeVoice } from "../../stores/realtime-voice"
import { toggleConversationMode, isConversationModeEnabled } from "../../stores/conversation-speech"
import { getStarGuardBearerToken } from "../../lib/starguard-auth"
import type { VoiceConversationState, TranscriptEntry } from "./types"

// Re-export the translation hook
export { useBilingualTranslation } from "./useBilingualTranslation"

/**
 * Core hook for unified voice conversation.
 * Manages the voice conversation lifecycle: connect → listen → speak → pause → resume → stop.
 */
export function useVoiceConversation(options: {
  instanceId: string
  sessionId?: string
  onTranscript?: (entry: TranscriptEntry) => void
  onStateChange?: (state: VoiceConversationState) => void
}) {
  const { translateEntry } = useBilingualTranslation()
  
  let recordingChunks: BlobPart[] = []
  let mediaRecorder: MediaRecorder | null = null
  let recordingTimer: ReturnType<typeof setInterval> | null = null

  // --- Start voice conversation ---
  async function startConversation() {
    const { state } = voiceConversationStore
    if (state() !== "idle" && state() !== "paused") return

    voiceConversationStore.setState("connecting")

    try {
      // 1. Check for speech API key
      const speechPrefs = await checkSpeechCapabilities()
      if (!speechPrefs) {
        voiceConversationStore.setLastError("Speech API key not configured")
        voiceConversationStore.setState("error")
        return
      }

      // 2. Get microphone
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      
      // 3. Start MediaRecorder for session recording
      startSessionRecording(stream)
      
      // 4. Connect to realtime voice
      const token = await getStarGuardBearerToken()
      const client = getRealtimeVoiceClient(options.instanceId, {
        starguardToken: token,
        onTranscript: (text: string, isFinal: boolean) => {
          if (isFinal) {
            const entry: TranscriptEntry = {
              id: crypto.randomUUID(),
              role: "user",
              text,
              translation: "",
              timestamp: Date.now(),
            }
            // Kick off translation (don't await — let it resolve async)
            translateEntry(entry).then(translation => {
              entry.translation = translation
            })
            voiceConversationStore.addTranscript(entry)
            options.onTranscript?.(entry)
          }
        },
        onSpeaking: () => {
          voiceConversationStore.setState("speaking")
        },
        onListening: () => {
          voiceConversationStore.setState("listening")
        },
      })

      // 5. Enable conversation mode for TTS playback
      if (!isConversationModeEnabled(options.instanceId)) {
        toggleConversationMode(options.instanceId)
      }

      voiceConversationStore.setState("listening")
    } catch (err) {
      console.error("Failed to start conversation:", err)
      voiceConversationStore.setLastError((err as Error).message)
      voiceConversationStore.setState("error")
    }
  }

  // --- Pause / Resume / Stop ---
  function pauseConversation() {
    if (voiceConversationStore.state() === "speaking") {
      // Interrupt agent mid-speech
      const client = getRealtimeVoiceClient(options.instanceId)
      client?.cancelResponse?.()
    }
    voiceConversationStore.setState("paused")
  }

  function resumeConversation() {
    if (voiceConversationStore.state() === "paused") {
      voiceConversationStore.setState("listening")
    }
  }

  async function stopConversation() {
    // Stop MediaRecorder
    stopSessionRecording()
    
    // Disconnect realtime voice
    disconnectRealtimeVoice(options.instanceId)
    
    // Disable conversation mode
    if (isConversationModeEnabled(options.instanceId)) {
      toggleConversationMode(options.instanceId)
    }

    // Upload recording to Vercel Blob
    await uploadRecording(options.sessionId)

    voiceConversationStore.setState("idle")
  }

  // --- Interruption (called from VoiceConversationButton click during speaking) ---
  function interruptAgent() {
    const client = getRealtimeVoiceClient(options.instanceId)
    client?.cancelResponse?.()
    voiceConversationStore.setState("listening")
  }

  // --- Session recording ---
  function startSessionRecording(stream: MediaStream) {
    recordingChunks = []
    try {
      mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm",
      })
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordingChunks.push(e.data)
      }
      mediaRecorder.start()
      voiceConversationStore.setIsRecording(true)

      // Track duration
      const startTime = Date.now()
      recordingTimer = setInterval(() => {
        voiceConversationStore.setRecordingDuration((Date.now() - startTime) / 1000)
      }, 1000)
    } catch (err) {
      console.error("Failed to start recording:", err)
    }
  }

  function stopSessionRecording() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop()
    }
    if (recordingTimer) {
      clearInterval(recordingTimer)
      recordingTimer = null
    }
    voiceConversationStore.setIsRecording(false)
  }

  async function uploadRecording(sessionId?: string) {
    if (recordingChunks.length === 0 || !sessionId) return

    const blob = new Blob(recordingChunks, { type: "audio/webm" })
    const duration = voiceConversationStore.recordingDuration()

    try {
      const formData = new FormData()
      formData.append("audio", blob, `recording-${sessionId}.webm`)
      formData.append("sessionId", sessionId)
      formData.append("duration", duration.toString())

      const response = await fetch("/api/tokidapp/recordings", {
        method: "POST",
        body: formData,
      })

      if (!response.ok) throw new Error("Upload failed")
      const data = await response.json()
      
      voiceConversationStore.addRecording({
        id: data.id,
        sessionId,
        blobUrl: data.blobUrl,
        duration,
        transcript: "",
        translations: [],
        createdAt: new Date().toISOString(),
      })
    } catch (err) {
      console.error("Failed to upload recording:", err)
    }
  }

  // --- Restore previous session ---
  async function restoreSession(sessionId: string) {
    try {
      const response = await fetch(`/api/tokidapp/recordings?sessionId=${sessionId}`)
      if (!response.ok) return
      const data = await response.json()
      if (data.recordings?.length > 0) {
        voiceConversationStore.setRecordings(data.recordings)
        return data.recordings
      }
    } catch (err) {
      console.error("Failed to restore session:", err)
    }
    return []
  }

  // Cleanup on unmount
  onCleanup(() => {
    stopSessionRecording()
  })

  return {
    startConversation,
    pauseConversation,
    resumeConversation,
    stopConversation,
    interruptAgent,
    restoreSession,
  }
}

async function checkSpeechCapabilities(): Promise<boolean> {
  try {
    const response = await fetch("/api/speech/capabilities")
    if (!response.ok) return false
    const data = await response.json()
    return data.configured === true
  } catch {
    return false
  }
}
```

---

### Task 5: VoiceConversationButton Component

**File:**
- Create: `packages/ui/src/components/voice-conversation/VoiceConversationButton.tsx`

A single button component with visual states matching the conversation state machine.

```tsx
import { createMemo } from "solid-js"
import { voiceConversationStore } from "./store"
import { tGlobal } from "../../lib/i18n"
import type { VoiceConversationState } from "./types"

interface VoiceConversationButtonProps {
  instanceId: string
  onStart: () => void
  onPause: () => void
  onResume: () => void
  onStop: () => void
}

const STATE_ICONS: Record<VoiceConversationState, string> = {
  idle: "mic",
  connecting: "loader",
  listening: "mic",
  speaking: "volume",
  paused: "pause",
  error: "alert-circle",
}

const STATE_CLASSES: Record<VoiceConversationState, string> = {
  idle: "voice-conv-idle",
  connecting: "voice-conv-connecting",
  listening: "voice-conv-listening",
  speaking: "voice-conv-speaking",
  paused: "voice-conv-paused",
  error: "voice-conv-error",
}

export function VoiceConversationButton(props: VoiceConversationButtonProps) {
  const state = voiceConversationStore.state
  const audioLevel = voiceConversationStore.audioLevel

  const label = createMemo(() => {
    switch (state()) {
      case "idle": return tGlobal("voiceConversation.button.idle")
      case "listening": return tGlobal("voiceConversation.button.listening")
      case "speaking": return tGlobal("voiceConversation.button.speaking")
      case "paused": return tGlobal("voiceConversation.button.paused")
      case "connecting": return tGlobal("voiceConversation.button.connecting")
      case "error": return tGlobal("voiceConversation.button.error")
    }
  })

  function handleClick() {
    switch (state()) {
      case "idle":
      case "error":
        props.onStart()
        break
      case "listening":
        props.onPause()
        break
      case "speaking":
        props.onPause()
        break
      case "paused":
        props.onResume()
        break
      case "connecting":
        break // ignore clicks while connecting
    }
  }

  function handleLongPress(e: PointerEvent) {
    e.preventDefault()
    if (state() !== "idle" && state() !== "error") {
      props.onStop()
    }
  }

  return (
    <button
      class={`voice-conversation-btn ${STATE_CLASSES[state()]}`}
      onClick={handleClick}
      onPointerDown={(e) => {
        // Detect long press for stop
        const timeout = setTimeout(() => handleLongPress(e), 800)
        const clear = () => { clearTimeout(timeout) }
        const events = ["pointerup", "pointerleave", "pointercancel"]
        events.forEach(evt => addEventListener(evt, clear, { once: true }))
      }}
      aria-label={label()}
      aria-pressed={state() !== "idle" && state() !== "error"}
      title={label()}
    >
      {/* Pulse ring animation when listening */}
      <div class="voice-conv-ring" data-active={state() === "listening" || state() === "speaking"} />
      {/* Audio level indicator when listening */}
      {(state() === "listening" || state() === "speaking") && (
        <div class="voice-conv-level" style={{ height: `${Math.max(4, audioLevel() * 40)}px` }} />
      )}
    </button>
  )
}
```

---

### Task 6: VoiceConversationOverlay Component

**File:**
- Create: `packages/ui/src/components/voice-conversation/VoiceConversationOverlay.tsx`

```tsx
import { createMemo, For } from "solid-js"
import { voiceConversationStore } from "./store"
import { tGlobal } from "../../lib/i18n"

interface VoiceConversationOverlayProps {
  visible: boolean
  onClose: () => void
}

export function VoiceConversationOverlay(props: VoiceConversationOverlayProps) {
  const transcripts = voiceConversationStore.transcripts
  const state = voiceConversationStore.state
  const duration = voiceConversationStore.recordingDuration

  const durationLabel = createMemo(() => {
    const s = Math.floor(duration())
    const min = Math.floor(s / 60)
    const sec = s % 60
    return `${min}:${sec.toString().padStart(2, "0")}`
  })

  return (
    <div class="voice-conv-overlay" data-visible={props.visible}>
      <div class="voice-conv-overlay-header">
        <h3>{tGlobal("voiceConversation.overlay.transcript")}</h3>
        <span class="voice-conv-duration">{durationLabel()}</span>
        <button class="voice-conv-close" onClick={props.onClose}>×</button>
      </div>

      <div class="voice-conv-transcripts">
        <For each={transcripts()} fallback={
          <p class="voice-conv-empty">{tGlobal("voiceConversation.overlay.noTranscripts")}</p>
        }>
          {(entry) => (
            <div class="voice-conv-entry" data-role={entry.role}>
              <span class="voice-conv-role">
                {entry.role === "user"
                  ? tGlobal("voiceConversation.overlay.you")
                  : tGlobal("voiceConversation.overlay.assistant")}
              </span>
              <p class="voice-conv-text">{entry.text}</p>
              {entry.translation && (
                <p class="voice-conv-translation">{entry.translation}</p>
              )}
            </div>
          )}
        </For>
      </div>

      <div class="voice-conv-controls">
        <button
          class="voice-conv-btn"
          onClick={() => {
            if (state() === "speaking" || state() === "listening") {
              // pause
              voiceConversationStore.setState("paused")
            } else {
              voiceConversationStore.setState("listening")
            }
          }}
        >
          {state() === "paused" ? "▶" : "⏸"}
        </button>
      </div>
    </div>
  )
}
```

---

### Task 7: Styles (voice-conversation.css)

**File:**
- Create: `packages/ui/src/styles/components/voice-conversation.css`

Following the existing CSS convention (small focused files, Tailwind v4 `@apply`, CSS custom properties from tokens):

```css
/* Voice Conversation Button */
.voice-conversation-btn {
  @apply relative flex items-center justify-center w-10 h-10 rounded-full 
         transition-all duration-300 ease-out;
  background: var(--color-surface);
  border: 2px solid var(--color-border);
  color: var(--color-text-secondary);
  cursor: pointer;
}

.voice-conversation-btn:hover {
  border-color: var(--color-accent);
  color: var(--color-accent);
}

.voice-conversation-btn.voice-conv-listening {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: white;
  box-shadow: 0 0 0 4px var(--color-accent-alpha);
}

.voice-conversation-btn.voice-conv-speaking {
  background: var(--color-success);
  border-color: var(--color-success);
  color: white;
}

.voice-conversation-btn.voice-conv-paused {
  background: var(--color-warning);
  border-color: var(--color-warning);
  color: white;
}

.voice-conversation-btn.voice-conv-error {
  background: var(--color-error);
  border-color: var(--color-error);
  color: white;
}

.voice-conversation-btn.voice-conv-connecting {
  opacity: 0.7;
  pointer-events: none;
}

/* Pulse ring */
.voice-conv-ring {
  @apply absolute inset-0 rounded-full;
}
.voice-conv-ring[data-active="true"] {
  animation: voice-conv-pulse 1.5s ease-out infinite;
}

@keyframes voice-conv-pulse {
  0% { box-shadow: 0 0 0 0 var(--color-accent-alpha); }
  100% { box-shadow: 0 0 0 12px transparent; }
}

/* Audio level indicator */
.voice-conv-level {
  @apply absolute bottom-0 w-1 rounded-full;
  background: var(--color-accent);
  transition: height 150ms ease;
}

/* Overlay */
.voice-conv-overlay {
  @apply fixed bottom-20 right-4 w-80 max-h-96 rounded-xl shadow-xl 
         flex flex-col overflow-hidden z-50;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  display: none;
}
.voice-conv-overlay[data-visible="true"] {
  display: flex;
}

.voice-conv-overlay-header {
  @apply flex items-center justify-between px-4 py-2 border-b;
  border-color: var(--color-border);
}

.voice-conv-overlay-header h3 {
  @apply text-sm font-semibold;
  color: var(--color-text);
}

.voice-conv-duration {
  @apply text-xs;
  color: var(--color-text-secondary);
}

.voice-conv-close {
  @apply text-lg leading-none cursor-pointer;
  color: var(--color-text-secondary);
}

.voice-conv-transcripts {
  @apply flex-1 overflow-y-auto p-4 space-y-3;
}

.voice-conv-entry {
  @apply p-2 rounded-lg;
}
.voice-conv-entry[data-role="user"] {
  background: var(--color-accent-alpha);
}
.voice-conv-entry[data-role="assistant"] {
  background: var(--color-surface-alt);
}

.voice-conv-role {
  @apply text-xs font-medium;
  color: var(--color-text-secondary);
}

.voice-conv-text {
  @apply text-sm mt-1;
  color: var(--color-text);
}

.voice-conv-translation {
  @apply text-xs mt-1 italic;
  color: var(--color-text-secondary);
}

.voice-conv-empty {
  @apply text-sm text-center;
  color: var(--color-text-secondary);
}

.voice-conv-controls {
  @apply flex justify-center gap-2 px-4 py-2 border-t;
  border-color: var(--color-border);
}

.voice-conv-btn {
  @apply w-10 h-10 flex items-center justify-center rounded-full 
         transition-colors cursor-pointer;
  background: var(--color-surface-alt);
}
.voice-conv-btn:hover {
  background: var(--color-accent);
  color: white;
}
```

---

### Task 8: Modify prompt-input.tsx

**File:** `packages/ui/src/components/prompt-input.tsx` (1026 lines, over the 800 target)

**Changes:**
1. Replace the 3 voice buttons (lines ~852-922) with a single `VoiceConversationButton`
2. Remove the `realtimeVoice` hook instantiation
3. Keep `voiceInput` for the legacy push-to-talk (optional fallback)
4. Add `useVoiceConversation` hook
5. Import and render `VoiceConversationButton` + `VoiceConversationOverlay`
6. Wire auto-post transcript to chat when `autoPostTranscript` is enabled

The existing code (lines 650-674):
```typescript
const voiceInput = usePromptVoiceInput({ ... })
const realtimeVoice = useRealtimeVoiceInput({ ... })
```

Replace with:
```typescript
const voiceInput = usePromptVoiceInput({ ... })
const {
  startConversation,
  pauseConversation,
  resumeConversation,
  stopConversation,
  interruptAgent,
  restoreSession,
} = useVoiceConversation({
  instanceId: props.instanceId,
  sessionId: activeSession()?.id,
  onTranscript: (entry) => {
    if (preferences().autoPostTranscript) {
      // Append transcript text to prompt
      setPrompt(prev => prev + entry.text + " ")
    }
  },
})
```

And replace lines ~852-922 (3 buttons) with:
```tsx
<Show when={showVoiceInput()}>
  <VoiceConversationButton
    instanceId={props.instanceId}
    onStart={startConversation}
    onPause={pauseConversation}
    onResume={resumeConversation}
    onStop={stopConversation}
  />
</Show>

<VoiceConversationOverlay
  visible={voiceConversationStore.state() !== "idle"}
  onClose={stopConversation}
/>
```

---

### Task 9: i18n Barrel Updates

**Files:**
- Modify: `packages/ui/src/lib/i18n/messages/en/index.ts` — add import for `voice-conversation`
- Modify: `packages/ui/src/lib/i18n/messages/id/index.ts` — add import for `voice-conversation`

Need to verify the ID locale index file exists first.

---

### Task 10: Server Recordings Route

**File:**
- Create: `packages/server/src/server/routes/recordings.ts`

Following the pattern from `tokidapp.ts` and `speech.ts`:

```typescript
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { put as blobPut } from "@vercel/blob"

interface RecordingsDeps {
  blobStore: {
    upload: (path: string, blob: Blob) => Promise<{ url: string }>
  }
}

export function registerRecordingsRoutes(app: FastifyInstance, deps: RecordingsDeps) {
  // Upload recording
  app.post("/api/tokidapp/recordings", async (request, reply) => {
    try {
      const file = await request.file()
      if (!file) {
        reply.code(400)
        return { error: "No file provided" }
      }

      const buffer = await file.toBuffer()
      const blob = new Blob([buffer], { type: file.mimetype })
      
      const result = await deps.blobStore.upload(
        `recordings/${file.fields.sessionId?.value || "unknown"}/${Date.now()}.webm`,
        blob
      )

      return {
        id: crypto.randomUUID(),
        blobUrl: result.url,
        sessionId: file.fields.sessionId?.value,
        duration: Number(file.fields.duration?.value) || 0,
      }
    } catch (error) {
      request.log.error({ err: error }, "Failed to upload recording")
      reply.code(500)
      return { error: "Failed to upload recording" }
    }
  })

  // List recordings for session
  app.get("/api/tokidapp/recordings", async (request, reply) => {
    try {
      const query = z.object({
        sessionId: z.string().optional(),
      }).parse(request.query)

      // In production, query the DB or blob store
      return { recordings: [] }
    } catch (error) {
      reply.code(400)
      return { error: "Invalid query" }
    }
  })

  // Get single recording
  app.get("/api/tokidapp/recordings/:id", async (request, reply) => {
    try {
      const params = z.object({
        id: z.string(),
      }).parse(request.params)

      return { id: params.id, blobUrl: "" }
    } catch (error) {
      reply.code(400)
      return { error: "Invalid id" }
    }
  })

  // Delete recording
  app.delete("/api/tokidapp/recordings/:id", async (request, reply) => {
    try {
      const params = z.object({
        id: z.string(),
      }).parse(request.params)

      return { deleted: true }
    } catch (error) {
      reply.code(400)
      return { error: "Invalid id" }
    }
  })
}
```

---

### Task 11: Server DAG Orchestrator + Voice Integration

**Files:**
- Modify: `packages/server/src/plugins/tokidapp/orchestrator/dag-engine.ts`
- Modify: `packages/server/src/plugins/tokidapp/orchestrator/types.ts`

**Changes to types.ts:**
Add voice conversation lifecycle phase:

```typescript
/** Extended lifecycle phases to include voice conversation */
export type LifecyclePhase =
  // ... existing phases ...
  | "voice_conversation_start"
  | "voice_conversation_transcribe"
  | "voice_conversation_translate"
  | "voice_conversation_respond"
```

**Changes to dag-engine.ts:**
Add a voice conversation lifecycle template in `LIFECYCLE_TEMPLATES`:

```typescript
// In LIFECYCLE_TEMPLATES
voice_conversation: {
  phases: [
    "voice_conversation_start",
    "research_and_analyze",
    "voice_conversation_translate",
    "voice_conversation_respond",
  ],
  parallelGroups: {
    group1: ["research_and_analyze", "voice_conversation_translate"],
  },
  healingBranches: {
    research_and_analyze: [{
      fallbackTool: "diagnose",
      condition: "output === null",
    }],
  },
},
```

And in `routeToTool()`, add handlers for voice conversation tools:

```typescript
case "transcribe_audio":
case "translate_text":
case "voice_conversation":
  // Route to voice concierge handler
  return await handleVoiceConversationTool(node, callbacks)
```

---

### Task 12: Completion Gate & Verification

**Verification steps:**
1. `npm run build --workspace @neuralnomads/codenomad` — must pass
2. Load `codenomad-build-restart` skill and run: `bun run codenomad:build-restart`
3. Verify `curl -s http://127.0.0.1:9899/api/auth/status`
4. Manual test: Open CodeNomad, verify voice conversation button appears, click to start, speak, verify transcript appears in overlay, verify agent responds with TTS
5. Verify bilingual overlay shows Indonesian translations
6. Verify session recording restores on page reload
7. Check file lengths: warn if any source file >500 lines. The new files should be well under.
