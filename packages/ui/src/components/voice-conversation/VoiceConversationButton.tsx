import { createMemo, Show } from "solid-js"
import { voiceConversationStore } from "./store"
import { tGlobal } from "../../lib/i18n"
import type { VoiceConversationState } from "./types"

export interface VoiceConversationButtonProps {
  instanceId: string
  onStart: () => void
  onPause: () => void
  onResume: () => void
  onStop: () => void
  disabled?: boolean
}

const STATE_ICONS: Record<VoiceConversationState, string> = {
  idle: "mic",
  connecting: "loader",
  listening: "mic",
  processing: "loader",
  speaking: "volume",
  paused: "pause",
  error: "alert-circle",
}

const STATE_CLASSES: Record<VoiceConversationState, string> = {
  idle: "voice-conv-idle",
  connecting: "voice-conv-connecting",
  listening: "voice-conv-listening",
  processing: "voice-conv-connecting",
  speaking: "voice-conv-speaking",
  paused: "voice-conv-paused",
  error: "voice-conv-error",
}

/**
 * Single unified voice conversation button.
 *
 * Click behavior depends on the current state:
 *  - idle/error: start conversation
 *  - listening: pause (stop listening, keep session alive)
 *  - speaking: interrupt agent mid-speech
 *  - paused: resume listening
 *  - connecting: no-op
 *
 * Long-press (800ms) in any active state → stop and save recording.
 */
export function VoiceConversationButton(props: VoiceConversationButtonProps) {
  const state = voiceConversationStore.state
  const audioLevel = voiceConversationStore.audioLevel
  const lastError = voiceConversationStore.lastError

  const label = createMemo(() => {
    switch (state()) {
      case "idle": return tGlobal("voiceConversation.button.idle")
      case "listening": return tGlobal("voiceConversation.button.listening")
      case "speaking": return tGlobal("voiceConversation.button.speaking")
      case "paused": return tGlobal("voiceConversation.button.paused")
      case "connecting":
      case "processing": return tGlobal("voiceConversation.button.connecting")
      case "error": return tGlobal("voiceConversation.button.error")
    }
  })

  function handleClick() {
    if (props.disabled) return

    switch (state()) {
      case "idle":
      case "error":
        props.onStart()
        break
      case "listening":
      case "processing":
      case "speaking":
        // Click during any active state = pause/interrupt
        props.onPause()
        break
      case "paused":
        props.onResume()
        break
      case "connecting":
        break
    }
  }

  function handlePointerDown(e: PointerEvent) {
    // Detect long press for stop
    let longPressTriggered = false
    const timeout = setTimeout(() => {
      longPressTriggered = true
      if (state() !== "idle" && state() !== "error") {
        props.onStop()
      }
    }, 800)

    const cleanup = () => {
      clearTimeout(timeout)
      removeEventListener("pointerup", cleanup)
      removeEventListener("pointerleave", cleanup)
      removeEventListener("pointercancel", cleanup)
    }

    addEventListener("pointerup", cleanup, { once: true })
    addEventListener("pointerleave", cleanup, { once: true })
    addEventListener("pointercancel", cleanup, { once: true })
  }

  return (
    <button
      type="button"
      class={`prompt-voice-button prompt-nav-voice-button voice-conversation-btn ${STATE_CLASSES[state()]}`}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      disabled={props.disabled}
      aria-label={label()}
      aria-pressed={state() !== "idle" && state() !== "error"}
      title={label()}
    >
      {/* Pulse ring when listening or speaking */}
      <div
        class="voice-conv-ring"
        data-active={state() === "listening" || state() === "speaking"}
      />

      {/* Audio level bar when listening */}
      <Show when={state() === "listening"}>
        <div
          class="voice-conv-level"
          style={{ height: `${Math.max(3, audioLevel() * 36)}px` }}
        />
      </Show>

      {/* Icon */}
      <Show
        when={state() === "connecting" || state() === "processing"}
        fallback={
          <span aria-hidden="true" class="voice-conv-icon">
            {state() === "listening" || state() === "speaking" ? "\u{1F3A4}" : // mic
             state() === "paused" ? "\u23F8" : // pause
             state() === "error" ? "\u26A0" : // warning
             "\u{1F3A4}"} {/* mic (idle) */}
          </span>
        }
      >
        <span class="voice-conv-spinner" aria-hidden="true">...</span>
      </Show>
    </button>
  )
}
