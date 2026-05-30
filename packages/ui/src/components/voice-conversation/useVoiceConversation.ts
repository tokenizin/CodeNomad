import { onCleanup } from "solid-js"
import { voiceConversationStore } from "./store"
import { RealtimeVoiceClient, setOnPlaybackQueueEmpty, clearAudioQueue } from "../../lib/realtime-voice"
import { getStarGuardBearerToken } from "../../lib/starguard-auth"
import { loadSpeechCapabilities } from "../../stores/speech"
import {
  isConversationModeEnabled,
  toggleConversationMode,
} from "../../stores/conversation-speech"
import type {
  VoiceConversationState,
  TranscriptEntry,
  SessionRecording,
  VoiceConversationApi,
  VoiceConversationOptions,
} from "./types"

/**
 * Core hook for the unified voice conversation system.
 *
 * Manages the voice conversation lifecycle:
 *   idle → connecting → listening (VAD) → speaking (TTS) → listening → ...
 *   Any state → paused → listening (user interrupt/resume)
 *   Any state → idle (stop / session end / error)
 *
 * Integrates with:
 *  - RealtimeVoiceClient (WS → OpenAI Realtime API)
 *  - MediaRecorder (session recording → Vercel Blob)
 */
export function useVoiceConversation(options: VoiceConversationOptions): VoiceConversationApi {
  let client: RealtimeVoiceClient | null = null
  let recordingChunks: BlobPart[] = []
  let mediaRecorder: MediaRecorder | null = null
  let recordingTimer: ReturnType<typeof setInterval> | null = null
  let responseInProgress = false

  // ── Start conversation ──

  async function startConversation(): Promise<void> {
    const { state } = voiceConversationStore
    if (state() !== "idle" && state() !== "error") return

    voiceConversationStore.setState("connecting")
    voiceConversationStore.setLastError(null)

    try {
      // 1. Ensure speech capabilities are loaded
      await loadSpeechCapabilities()

      // 2. Check StarGuard auth
      const token = getStarGuardBearerToken()
      if (!token) {
        voiceConversationStore.setLastError(
          "Sign in via StarGuard first (SSO from StarGuard → CodeNomad)."
        )
        voiceConversationStore.setState("error")
        return
      }

      // 3. Get microphone permission early (so we fail fast)
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })

      // 4. Enable conversation mode for TTS playback
      if (!isConversationModeEnabled(options.instanceId)) {
        toggleConversationMode(options.instanceId)
      }

      // 5. Create RealtimeVoiceClient with custom callbacks
      client = new RealtimeVoiceClient(
        options.instanceId,
        // onStateChange
        (newState) => {
          // Map RealtimeVoiceState to our VoiceConversationState
          switch (newState) {
            case "idle":
              if (voiceConversationStore.state() !== "paused") {
                voiceConversationStore.setState("idle")
              }
              break
            case "connected":
              // Agent done speaking — listening will re-trigger via playback callback
              break
            case "recording":
              voiceConversationStore.setState("listening")
              break
            case "speaking":
              voiceConversationStore.setState("speaking")
              responseInProgress = true
              // Stop capture while agent is speaking
              stopCaptureForAgentResponse()
              break
            case "connecting":
              voiceConversationStore.setState("connecting")
              break
          }
        },
        // onTranscript — receives ASR text or agent text deltas
        (text: string) => {
          if (!responseInProgress && text.trim()) {
            // First transcript of a new user utterance
            responseInProgress = true
            stopCaptureForAgentResponse()

            const entry: TranscriptEntry = {
              id: crypto.randomUUID(),
              role: "user",
              text,
              timestamp: Date.now(),
            }

            // Auto-post transcript to chat
            options.onTranscript?.(entry)
          }
        },
        // onError
        (message: string) => {
          voiceConversationStore.setLastError(message)
          voiceConversationStore.setState("error")
        },
      )

      // 6. Register playback-empty callback for VAD loop
      setOnPlaybackQueueEmpty(() => {
        if (!client || voiceConversationStore.state() === "paused") return
        responseInProgress = false
        voiceConversationStore.setState("listening")
        startCaptureAfterAgentResponse()
      })

      // 7. Start MediaRecorder for session recording
      startSessionRecording(stream)

      // 8. Release the mic stream (client will re-acquire via getUserMedia)
      stream.getTracks().forEach((t) => t.stop())

      // 9. Start the voice session
      await client.startRecording()
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start voice conversation"
      voiceConversationStore.setLastError(message)
      voiceConversationStore.setState("error")
    }
  }

  // ── Helpers to stop/start capture around agent responses ──

  function stopCaptureForAgentResponse() {
    if (client) {
      client.stopRecording() // sends voice_stop, stops PCM16
    }
  }

  function startCaptureAfterAgentResponse() {
    if (client && voiceConversationStore.state() !== "paused" && voiceConversationStore.state() !== "idle") {
      void client.startRecording()
    }
  }

  // ── Pause / Resume / Stop ──

  function pauseConversation() {
    if (voiceConversationStore.state() === "speaking" && client) {
      // Interrupt agent mid-speech
      client.cancelResponse()
      clearAudioQueue()
    }
    voiceConversationStore.setState("paused")
  }

  function resumeConversation() {
    if (voiceConversationStore.state() === "paused") {
      voiceConversationStore.setState("listening")
      responseInProgress = false
      startCaptureAfterAgentResponse()
    }
  }

  async function stopConversation(): Promise<void> {
    // Stop MediaRecorder and upload recording
    await finalizeRecording()

    // Disconnect realtime voice
    if (client) {
      client.disconnect()
      client = null
    }

    // Disable conversation mode
    if (isConversationModeEnabled(options.instanceId)) {
      toggleConversationMode(options.instanceId)
    }

    // Cleanup
    setOnPlaybackQueueEmpty(null)
    clearAudioQueue()
    responseInProgress = false

    voiceConversationStore.setState("idle")
  }

  // ── Interruption (user clicks during speaking) ──

  function interruptAgent() {
    if (client) {
      client.cancelResponse()
    }
    clearAudioQueue()
    responseInProgress = false
    voiceConversationStore.setState("listening")
    startCaptureAfterAgentResponse()
  }

  // ── Session recording ──

  function startSessionRecording(stream: MediaStream) {
    recordingChunks = []
    try {
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm"
      mediaRecorder = new MediaRecorder(stream, { mimeType })
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordingChunks.push(e.data)
      }
      mediaRecorder.start()
      voiceConversationStore.setIsRecording(true)

      const startTime = Date.now()
      recordingTimer = setInterval(() => {
        voiceConversationStore.setRecordingDuration((Date.now() - startTime) / 1000)
      }, 1000)
    } catch (err) {
      console.error("[useVoiceConversation] Failed to start recording:", err)
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

  async function finalizeRecording() {
    stopSessionRecording()

    if (recordingChunks.length === 0 || !options.sessionId) return

    const blob = new Blob(recordingChunks, { type: "audio/webm" })
    const duration = voiceConversationStore.recordingDuration()

    try {
      // Step 1: Upload raw audio to CodeNomad server
      const audioRes = await fetch("/api/tokidapp/recordings/audio", {
        method: "POST",
        headers: {
          "Content-Type": "audio/webm",
          "X-Session-Id": options.sessionId ?? "",
          "X-Duration": duration.toString(),
        },
        body: blob,
      })
      if (!audioRes.ok) throw new Error(`Audio upload failed: ${audioRes.status}`)
      const { blobUrl } = await audioRes.json()

      // Step 2: Persist recording metadata
      const response = await fetch("/api/tokidapp/recordings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          blobUrl,
          sessionId: options.sessionId,
          duration: duration.toString(),
        }),
      })

      if (!response.ok) throw new Error(`Upload failed: ${response.status}`)
      const data = await response.json()

      voiceConversationStore.addRecording({
        id: data.id,
        sessionId: options.sessionId ?? "",
        blobUrl: data.blobUrl,
        duration,
        transcript: "",
        createdAt: new Date().toISOString(),
      })
    } catch (err) {
      console.error("[useVoiceConversation] Failed to upload recording:", err)
    }
  }

  // ── Session restoration ──

  async function restoreSession(sessionId: string): Promise<SessionRecording[]> {
    try {
      const response = await fetch(`/api/tokidapp/recordings?sessionId=${encodeURIComponent(sessionId)}`)
      if (!response.ok) return []
      const data = await response.json()
      const recs: SessionRecording[] = data.recordings ?? []
      if (recs.length > 0) {
        voiceConversationStore.setRecordings(recs)
      }
      return recs
    } catch (err) {
      console.error("[useVoiceConversation] Failed to restore session:", err)
      return []
    }
  }

  // ── Cleanup on component unmount ──

  onCleanup(() => {
    stopSessionRecording()
    setOnPlaybackQueueEmpty(null)
    if (client) {
      client.disconnect()
      client = null
    }
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
