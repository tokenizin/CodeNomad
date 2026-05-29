import { createMemo, For, Show } from "solid-js"
import { voiceConversationStore } from "./store"
import { tGlobal } from "../../lib/i18n"

export interface VoiceConversationOverlayProps {
  visible: boolean
  onClose: () => void
}

/**
 * Bilingual transcript overlay for the voice conversation.
 *
 * Shows:
 *  - Header with "Transcript" title + elapsed duration
 *  - Scrollable transcript list (user + assistant with EN/ID translation)
 *  - Bottom controls (play/pause button)
 */
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
      {/* Header */}
      <div class="voice-conv-overlay-header">
        <h3>{tGlobal("voiceConversation.overlay.transcript")}</h3>
        <span class="voice-conv-duration">{durationLabel()}</span>
        <button
          type="button"
          class="voice-conv-close"
          onClick={props.onClose}
          aria-label="Close"
        >
          &times;
        </button>
      </div>

      {/* Transcripts */}
      <div class="voice-conv-transcripts">
        <For
          each={transcripts()}
          fallback={
            <p class="voice-conv-empty">
              {tGlobal("voiceConversation.overlay.noTranscripts")}
            </p>
          }
        >
          {(entry) => (
            <div class="voice-conv-entry" data-role={entry.role}>
              <span class="voice-conv-role">
                {entry.role === "user"
                  ? tGlobal("voiceConversation.overlay.you")
                  : tGlobal("voiceConversation.overlay.assistant")}
              </span>
              <p class="voice-conv-text">{entry.text}</p>
              <Show when={entry.translation && entry.translation !== entry.text}>
                <p class="voice-conv-translation">
                  {tGlobal("voiceConversation.overlay.translation")}: {entry.translation}
                </p>
              </Show>
            </div>
          )}
        </For>
      </div>

      {/* Controls */}
      <div class="voice-conv-controls">
        <button
          type="button"
          class="voice-conv-btn"
          onClick={() => {
            if (state() === "speaking" || state() === "listening" || state() === "processing") {
              // Trigger pause
              voiceConversationStore.setState("paused")
            } else if (state() === "paused") {
              voiceConversationStore.setState("listening")
            }
          }}
          aria-label={state() === "paused" ? "Resume" : "Pause"}
        >
          {state() === "paused" ? "\u25B6" : "\u23F8"}
        </button>
      </div>
    </div>
  )
}
