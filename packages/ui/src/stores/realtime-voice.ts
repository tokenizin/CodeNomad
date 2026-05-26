import { createSignal } from "solid-js"
import { getLogger } from "../lib/logger"
import { loadSpeechCapabilities, speechCapabilities } from "./speech"
import { RealtimeVoiceClient, type RealtimeVoiceState } from "../lib/realtime-voice"

const log = getLogger("api")

const [realtimeVoiceClients, setRealtimeVoiceClients] = createSignal<Map<string, RealtimeVoiceClient>>(new Map())

const [realtimeVoiceStateByInstance, setRealtimeVoiceStateByInstance] = createSignal<Map<string, RealtimeVoiceState>>(new Map())

const [realtimeVoiceTranscriptByInstance, setRealtimeVoiceTranscriptByInstance] = createSignal<Map<string, string>>(new Map())

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
  const client = ensureRealtimeVoiceClient(instanceId)
  if (!client) return

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
}
