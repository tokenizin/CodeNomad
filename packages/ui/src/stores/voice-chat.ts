/**
 * Voice conversation through the chat, for speech providers with server STT/TTS (VoxCPM2, local, Deepgram…).
 *
 *   listening  → speech is transcribed into the prompt, phrase by phrase
 *   4 s quiet  → the prompt is sent to the chat like a typed message
 *   thinking   → wait until the agent's reply is complete in the chat
 *   speaking   → the reply is read aloud with the Speech settings' voice
 *   → listening again, until the user ends the conversation
 *
 * The OpenAI Realtime conversation (useVoiceConversation) is used only for the OpenAI provider.
 * Lives at module level so it survives the composer remounting when a new chat gets its session.
 */

import { startDictationCapture, type DictationCapture } from "../lib/dictation-capture"
import { insertSpokenText } from "../lib/dictation-prompt"
import { speechTextFromReply } from "../lib/speech-text"
import { getLogger } from "../lib/logger"
import { voiceConversationStore } from "../components/voice-conversation/store"
import { speakText, type PlaybackHandle } from "./conversation-speech"
import { messageStoreBus } from "./message-v2/bus"
import { getActiveSession } from "./session-state"
import { getSessionStatus } from "./session-status"

const log = getLogger("actions")

export interface VoiceChatComposer {
  prompt: () => string
  setPrompt: (value: string) => void
  getTextarea: () => HTMLTextAreaElement | null
  /** The composer's normal send. */
  send: () => Promise<void> | void
}

type Phase = "idle" | "listening" | "thinking" | "speaking" | "paused"

const REPLY_TIMEOUT_MS = 15 * 60_000
const POLL_MS = 300

interface Chat {
  instanceId: string
  phase: Phase
  capture: DictationCapture | null
  playback: PlaybackHandle | null
  typedSinceSend: boolean
  /** Bumped on pause/stop so a pending reply wait or playback doesn't resume listening. */
  generation: number
}

const composers = new Map<string, VoiceChatComposer>()
let chat: Chat | null = null

/** The mounted composer for an instance registers itself; the newest one wins. */
export function bindVoiceChatComposer(instanceId: string, composer: VoiceChatComposer): () => void {
  composers.set(instanceId, composer)
  return () => {
    if (composers.get(instanceId) === composer) composers.delete(instanceId)
  }
}

export function isVoiceChatActive(instanceId: string): boolean {
  return chat?.instanceId === instanceId && chat.phase !== "idle"
}

function setPhase(c: Chat, phase: Phase) {
  c.phase = phase
  const map = { idle: "idle", listening: "listening", thinking: "processing", speaking: "speaking", paused: "paused" } as const
  voiceConversationStore.setState(map[phase])
}

function fail(c: Chat, message: string) {
  voiceConversationStore.setLastError(message)
  voiceConversationStore.setState("error")
  log.error("Voice conversation failed", message)
}

async function listen(c: Chat): Promise<void> {
  if (chat !== c) return
  const composer = composers.get(c.instanceId)
  if (!composer) return fail(c, "The chat input is not available.")
  c.typedSinceSend = false
  try {
    c.capture = await startDictationCapture({
      onText: (text) => {
        const current = composers.get(c.instanceId)
        if (!current) return
        insertSpokenText(current, text)
        c.typedSinceSend = true
      },
      onAutoSend: () => void sendAndReply(c),
      onLevel: (level) => voiceConversationStore.setAudioLevel(Math.min(1, level * 6)),
      onError: (message) => voiceConversationStore.setLastError(message),
    })
    setPhase(c, "listening")
  } catch (err) {
    c.capture = null
    fail(c, err instanceof Error ? err.message : String(err))
  }
}

async function sendAndReply(c: Chat): Promise<void> {
  const composer = composers.get(c.instanceId)
  if (chat !== c || c.phase !== "listening" || !composer || !c.typedSinceSend || !composer.prompt().trim()) return
  const generation = c.generation
  // Don't transcribe our own voice: the mic is off until the reply has been spoken.
  const capture = c.capture
  c.capture = null
  await capture?.stop()
  setPhase(c, "thinking")
  const since = Date.now()
  try {
    await composer.send()
    const reply = await waitForReply(c.instanceId, since, () => chat !== c || c.generation !== generation)
    if (chat !== c || c.generation !== generation) return
    const text = reply ? speechTextFromReply(reply) : ""
    if (text) {
      setPhase(c, "speaking")
      c.playback = await speakText(text)
      await c.playback.done.catch(() => undefined)
      c.playback = null
    }
  } catch (err) {
    voiceConversationStore.setLastError(err instanceof Error ? err.message : String(err))
  }
  if (chat === c && c.generation === generation) await listen(c)
}

/** The text of the agent's reply to the prompt sent at `since`, once it is complete (null if it failed). */
export async function waitForReply(instanceId: string, since: number, cancelled: () => boolean): Promise<string | null> {
  const deadline = Date.now() + REPLY_TIMEOUT_MS
  // OpenCode stamps messages with the server clock; allow a little skew.
  const after = since - 2000
  let sawWork = false
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    if (cancelled()) return null
    const session = getActiveSession(instanceId)
    if (!session) continue
    const status = getSessionStatus(instanceId, session.id)
    if (status !== "idle") sawWork = true
    const store = messageStoreBus.getOrCreate(instanceId)
    const replies = store
      .getSessionMessageIds(session.id)
      .map((id) => store.getMessage(id))
      .filter((m) => m && m.role === "assistant" && m.createdAt >= after)
    const last = replies[replies.length - 1]
    if (!last || status !== "idle" || (last.status !== "complete" && last.status !== "error")) continue
    // A reply that was already complete before this prompt started working doesn't count.
    if (!sawWork && last.updatedAt < since) continue
    if (last.status === "error") return null
    for (let i = replies.length - 1; i >= 0; i -= 1) {
      const record = replies[i]!
      const text = record.partIds
        .map((id) => record.parts[id]?.data)
        .filter((p: any) => p?.type === "text" && !p.synthetic && typeof p.text === "string")
        .map((p: any) => p.text as string)
        .join("\n")
        .trim()
      if (text) return text
    }
    return null
  }
  return null
}

export async function startVoiceChat(instanceId: string): Promise<void> {
  if (chat && chat.phase !== "idle") return
  voiceConversationStore.setLastError(null)
  voiceConversationStore.setState("connecting")
  chat = { instanceId, phase: "idle", capture: null, playback: null, typedSinceSend: false, generation: 0 }
  await listen(chat)
}

/** Pause listening, or cut the spoken reply short. */
export function pauseVoiceChat(): void {
  const c = chat
  if (!c || c.phase === "idle" || c.phase === "paused") return
  c.generation += 1
  c.playback?.stop()
  c.playback = null
  void c.capture?.stop()
  c.capture = null
  setPhase(c, "paused")
}

export function resumeVoiceChat(): void {
  const c = chat
  if (!c || c.phase !== "paused") return
  void listen(c)
}

export function stopVoiceChat(): void {
  const c = chat
  if (!c) return
  c.generation += 1
  c.playback?.stop()
  void c.capture?.stop()
  chat = null
  voiceConversationStore.setAudioLevel(0)
  voiceConversationStore.setState("idle")
}
