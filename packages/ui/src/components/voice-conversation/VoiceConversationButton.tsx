import { createMemo, Show } from "solid-js"
import { Loader2, Mic, Volume2, Pause, Square, AlertCircle } from "lucide-solid"
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
 * Single unified voice conversation button with visible end button.
 *
 * Mic button click behavior depends on the current state:
 *  - idle/error: start conversation
 *  - listening: pause (stop listening, keep session alive)
 *  - speaking: interrupt agent mid-speech
 *  - paused: resume listening
 *  - connecting: no-op
 *
 * Long-press (800ms) mic button in any active state → stop and save recording.
 *
 * When conversation is active, a separate visible "End" button appears
 * next to the mic button for immediate stop without long-press.
 */
export function VoiceConversationButton(props: VoiceConversationButtonProps) {
  const state = voiceConversationStore.state
  const audioLevel = voiceConversationStore.audioLevel

  const label = createMemo(() => {
    switch (state()) {
      case "idle": return tGlobal("voiceConversation.button.idle")
      case "listening": return tGlobal("voiceConversation.button.listening")
      case "speaking": return tGlobal("voiceConversation.button.speaking")
      case "paused": return tGlobal("voiceConversation.button.paused")
      case "connecting":
      case "processing": return tGlobal("voiceConversation.button.connecting")
      case "error": {
        // Surface the real failure reason (e.g. "Sign in via StarGuard first")
        // instead of only the generic "tap to retry" message.
        const reason = voiceConversationStore.lastError()?.trim()
        const base = tGlobal("voiceConversation.button.error")
        return reason ? `${base}: ${reason}` : base
      }
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
        props.onPause()
        break
      case "paused":
        props.onResume()
        break
      case "connecting":
        break
    }
  }

  function handlePointerDown(_e: PointerEvent) {
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

  const isBusy = () => state() === "connecting" || state() === "processing"
  const isActive = createMemo(() => state() !== "idle" && state() !== "error" && state() !== "connecting")

  function handleEndClick() {
    if (props.disabled) return
    props.onStop()
  }

  return (
    <div class={`voice-conversation-container ${isActive() ? "is-active" : ""}`} role="group" aria-label="Voice conversation controls">
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

        {/* Icon — Lucide SVGs matching the rest of the UI */}
        <Show
          when={isBusy()}
          fallback={
            <span aria-hidden="true" class="voice-conv-icon">
              {state() === "speaking" ? <Volume2 class="h-4 w-4" /> :
               state() === "paused" ? <Pause class="h-4 w-4" /> :
               state() === "error" ? <AlertCircle class="h-4 w-4" /> :
               <Mic class="h-4 w-4" />}
            </span>
          }
        >
          <Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />
        </Show>
      </button>

      {/* Visible end button — shown when conversation is active */}
      <Show when={isActive()}>
        <button
          type="button"
          class="voice-conv-end-btn"
          onClick={handleEndClick}
          disabled={props.disabled}
          aria-label={tGlobal("voiceConversation.button.endTitle")}
          title={tGlobal("voiceConversation.button.endTitle")}
        >
          <Square class="h-3.5 w-3.5 fill-current" />
        </button>
      </Show>
    </div>
  )
}
