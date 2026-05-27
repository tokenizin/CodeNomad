import { createSignal } from "solid-js"
import { getLogger } from "../lib/logger"
import { loadSpeechCapabilities, speechCapabilities } from "./speech"
import { getStarGuardBearerToken } from "../lib/starguard-auth"
import { RealtimeVoiceClient, type RealtimeVoiceState } from "../lib/realtime-voice"

const log = getLogger("api")

const [realtimeVoiceClients, setRealtimeVoiceClients] = createSignal<Map<string, RealtimeVoiceClient>>(new Map())

const [realtimeVoiceStateByInstance, setRealtimeVoiceStateByInstance] = createSignal<Map<string, RealtimeVoiceState>>(new Map())

const [realtimeVoiceTranscriptByInstance, setRealtimeVoiceTranscriptByInstance] = createSignal<Map<string, string>>(new Map())

const [realtimeVoiceErrorByInstance, setRealtimeVoiceErrorByInstance] = createSignal<Map<string, string | null>>(new Map())

export function getRealtimeVoiceError(instanceId: string): string | null {
  return realtimeVoiceErrorByInstance().get(instanceId) ?? null
}

function setRealtimeVoiceError(instanceId: string, message: string | null) {
  setRealtimeVoiceErrorByInstance((prev) => {
    const next = new Map(prev)
    if (message) next.set(instanceId, message)
    else next.delete(instanceId)
    return next
  })
}

export function getRealtimeVoiceState(instanceId: string): RealtimeVoiceState {
  return realtimeVoiceStateByInstance().get(instanceId) ?? "idle"
}

export function getRealtimeVoiceTranscript(instanceId: string): string {
  return realtimeVoiceTranscriptByInstance().get(instanceId) ?? ""
}

export function canUseRealtimeVoice(): boolean {
  const caps = speechCapabilities()
  if (!caps?.available || !caps?.configured) return false
  if (typeof window === "undefined") return false
  if (typeof AudioContext === "undefined") return false
  if (!navigator.mediaDevices?.getUserMedia) return false
  return true
}

export function realtimeVoiceBlockReason(): string | null {
  if (!canUseRealtimeVoice()) {
    return "Speech API not configured on CodeNomad (OPENAI_API_KEY / speech settings)."
  }
  if (!getStarGuardBearerToken()) {
    return "Sign in via StarGuard first (Connect from StarGuard → CodeNomad SSO)."
  }
  return null
}

export function ensureRealtimeVoiceClient(instanceId: string): RealtimeVoiceClient | null {
  const existing = realtimeVoiceClients().get(instanceId)
  if (existing) return existing

  if (!canUseRealtimeVoice()) return null

  const client = new RealtimeVoiceClient(
    instanceId,
    (state) => {
      setRealtimeVoiceStateByInstance((prev) => {
        const next = new Map(prev)
        next.set(instanceId, state)
        return next
      })
    },
    (text) => {
      setRealtimeVoiceTranscriptByInstance((prev) => {
        const next = new Map(prev)
        const existing = next.get(instanceId) ?? ""
        next.set(instanceId, existing + text)
        return next
      })
    },
    (message) => setRealtimeVoiceError(instanceId, message),
  )

  setRealtimeVoiceClients((prev) => {
    const next = new Map(prev)
    next.set(instanceId, client)
    return next
  })

  return client
}

export async function startRealtimeVoice(instanceId: string): Promise<void> {
  await loadSpeechCapabilities()
  const block = realtimeVoiceBlockReason()
  if (block) {
    setRealtimeVoiceError(instanceId, block)
    return
  }
  setRealtimeVoiceError(instanceId, null)
  const client = ensureRealtimeVoiceClient(instanceId)
  if (!client) {
    setRealtimeVoiceError(instanceId, "Could not start Realtime voice client.")
    return
  }

  setRealtimeVoiceTranscriptByInstance((prev) => {
    const next = new Map(prev)
    next.set(instanceId, "")
    return next
  })

  await client.startRecording()
}

export function stopRealtimeVoice(instanceId: string): void {
  const client = realtimeVoiceClients().get(instanceId)
  if (client) {
    client.stopRecording()
  }
}

export function disconnectRealtimeVoice(instanceId: string): void {
  const client = realtimeVoiceClients().get(instanceId)
  if (client) {
    client.disconnect()
  }
  setRealtimeVoiceClients((prev) => {
    const next = new Map(prev)
    next.delete(instanceId)
    return next
  })
  setRealtimeVoiceStateByInstance((prev) => {
    const next = new Map(prev)
    next.delete(instanceId)
    return next
  })
  setRealtimeVoiceTranscriptByInstance((prev) => {
    const next = new Map(prev)
    next.delete(instanceId)
    return next
  })
  setRealtimeVoiceError(instanceId, null)
}
