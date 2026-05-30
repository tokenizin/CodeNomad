import type { Accessor, Setter } from "solid-js"

/**
 * Voice conversation session state machine
 *
 * idle → connecting → listening (VAD mic active)
 * listening → processing → speaking (TTS playing)
 * speaking → listening (auto-loop after TTS ends)
 * Any state → paused (user click interrupt)
 * paused → listening (user click resume)
 * Any state → idle (long press / session end / error)
 */
export type VoiceConversationState =
  | "idle"
  | "connecting"
  | "listening"
  | "processing"
  | "speaking"
  | "paused"
  | "error"

/** A single transcript entry */
export interface TranscriptEntry {
  id: string
  role: "user" | "assistant"
  text: string
  timestamp: number
}

/** Session recording metadata */
export interface SessionRecording {
  id: string
  sessionId: string
  blobUrl: string
  duration: number
  transcript: string
  createdAt: string
}

/** Voice conversation preferences (stored in preferences store) */
export interface VoiceConversationPreferences {
  autoPostTranscript: boolean
  autoRestoreSession: boolean
}

/** Configuration passed into useVoiceConversation */
export interface VoiceConversationOptions {
  instanceId: string
  sessionId?: string
  onTranscript?: (entry: TranscriptEntry) => void
  onStateChange?: (state: VoiceConversationState) => void
}

/**
 * Public API returned by useVoiceConversation
 */
export interface VoiceConversationApi {
  startConversation: () => Promise<void>
  pauseConversation: () => void
  resumeConversation: () => void
  stopConversation: () => Promise<void>
  interruptAgent: () => void
  restoreSession: (sessionId: string) => Promise<SessionRecording[]>
}

/**
 * Voice conversation store shape
 * Following the SolidJS signals pattern from session-state.ts and realtime-voice.ts
 */
export interface VoiceConversationStore {
  state: Accessor<VoiceConversationState>
  setState: Setter<VoiceConversationState>
  isRecording: Accessor<boolean>
  setIsRecording: Setter<boolean>
  recordingDuration: Accessor<number>
  setRecordingDuration: Setter<number>
  recordings: Accessor<SessionRecording[]>
  setRecordings: Setter<SessionRecording[]>
  addRecording: (recording: SessionRecording) => void
  lastError: Accessor<string | null>
  setLastError: Setter<string | null>
  audioLevel: Accessor<number>
  setAudioLevel: Setter<number>
}
