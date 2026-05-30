import { createSignal } from "solid-js"
import type {
  VoiceConversationState,
  SessionRecording,
  VoiceConversationStore,
} from "./types"

// ── Module-level signals (per the codebase convention from realtime-voice.ts) ──

const [state, setState] = createSignal<VoiceConversationState>("idle")
const [isRecording, setIsRecording] = createSignal(false)
const [recordingDuration, setRecordingDuration] = createSignal(0)
const [recordings, setRecordings] = createSignal<SessionRecording[]>([])
const [lastError, setLastError] = createSignal<string | null>(null)
const [audioLevel, setAudioLevel] = createSignal(0)

// ── Actions ──

function addRecording(recording: SessionRecording) {
  setRecordings((prev) => [...prev, recording])
}

function resetState() {
  setState("idle")
  setIsRecording(false)
  setRecordingDuration(0)
  setLastError(null)
  setAudioLevel(0)
}

// ── Exported store object ──

export const voiceConversationStore: VoiceConversationStore = {
  state,
  setState,
  isRecording,
  setIsRecording,
  recordingDuration,
  setRecordingDuration,
  recordings,
  setRecordings,
  addRecording,
  lastError,
  setLastError,
  audioLevel,
  setAudioLevel,
}

export { resetState }
