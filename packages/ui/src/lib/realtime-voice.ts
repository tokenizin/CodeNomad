import { getStarGuardBearerToken } from "./starguard-auth"

const SAMPLE_RATE = 24000

export type RealtimeVoiceState = "idle" | "connecting" | "connected" | "recording" | "speaking"

export interface AudioCapture {
  stream: MediaStream
  source: AudioNode
  processor: ScriptProcessorNode
  context: AudioContext
  stop: () => void
}

// ── PCM16 Capture ────────────────────────────────────────────

function resampleTo24k(float32: Float32Array, sourceRate: number): Float32Array {
  if (sourceRate === SAMPLE_RATE) return float32
  const ratio = sourceRate / SAMPLE_RATE
  const outLength = Math.max(1, Math.floor(float32.length / ratio))
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const srcIndex = i * ratio
    const idx = Math.floor(srcIndex)
    const frac = srcIndex - idx
    const a = float32[idx] ?? 0
    const b = float32[idx + 1] ?? a
    out[i] = a + (b - a) * frac
  }
  return out
}

export async function startPCM16Capture(
  onChunk: (base64: string) => void,
): Promise<AudioCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const context = new AudioContext()
  await context.resume()
  const source = context.createMediaStreamSource(stream)

  const bufferSize = 4096
  const processor = context.createScriptProcessor(bufferSize, 1, 1)

  const silent = context.createGain()
  silent.gain.value = 0
  source.connect(processor)
  processor.connect(silent)
  silent.connect(context.destination)

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0)
    const resampled = resampleTo24k(input, context.sampleRate)
    const pcm16 = float32ToPCM16(resampled)
    const base64 = arrayBufferToBase64(pcm16.buffer as ArrayBuffer)
    onChunk(base64)
  }

  return {
    stream,
    source,
    processor,
    context,
    stop: () => {
      processor.disconnect()
      source.disconnect()
      stream.getTracks().forEach((t) => t.stop())
      context.close()
    },
  }
}

// ── PCM16 Playback ──────────────────────────────────────────

let audioQueue: Float32Array[] = []
let isPlaying = false
let audioCtx: AudioContext | null = null
let onPlaybackQueueEmpty: (() => void) | null = null

async function ensureAudioContext(): Promise<AudioContext> {
  if (!audioCtx || audioCtx.state === "closed") {
    audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE })
  }
  if (audioCtx.state === "suspended") {
    await audioCtx.resume()
  }
  return audioCtx
}

export function enqueueAudioChunk(base64: string) {
  const pcm16 = base64ToArrayBuffer(base64)
  const float32 = pcm16ToFloat32(new Int16Array(pcm16))
  audioQueue.push(float32)
  if (!isPlaying) scheduleNextChunk()
}

async function scheduleNextChunk() {
  if (audioQueue.length === 0) {
    isPlaying = false
    onPlaybackQueueEmpty?.()
    return
  }

  isPlaying = true
  const ctx = await ensureAudioContext()
  const data = audioQueue.shift()!

  const buffer = ctx.createBuffer(1, data.length, SAMPLE_RATE)
  buffer.getChannelData(0).set(data)

  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.connect(ctx.destination)
  source.onended = () => scheduleNextChunk()
  source.start()
}

/** Register a callback that fires when the playback queue drains completely (agent TTS finished). */
export function setOnPlaybackQueueEmpty(callback: (() => void) | null) {
  onPlaybackQueueEmpty = callback
}

export function clearAudioQueue() {
  audioQueue = []
  isPlaying = false
}

// ── Format Conversion ────────────────────────────────────────

function float32ToPCM16(float32: Float32Array): Int16Array {
  const pcm16 = new Int16Array(float32.length)
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]))
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return pcm16
}

function pcm16ToFloat32(pcm16: Int16Array): Float32Array {
  const float32 = new Float32Array(pcm16.length)
  for (let i = 0; i < pcm16.length; i++) {
    float32[i] = pcm16[i] / (pcm16[i] < 0 ? 0x8000 : 0x7fff)
  }
  return float32
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ""
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

// ── WebSocket Client ────────────────────────────────────────

export class RealtimeVoiceClient {
  private ws: WebSocket | null = null
  private capture: AudioCapture | null = null
  private onStateChange: (state: RealtimeVoiceState) => void
  private onTranscript: (text: string) => void
  private onError: (message: string) => void
  private isRecording = false
  private voiceReady = false
  private voiceReadyTimeout: ReturnType<typeof setTimeout> | null = null

  constructor(
    private instanceId: string,
    onStateChange: (state: RealtimeVoiceState) => void,
    onTranscript: (text: string) => void,
    onError: (message: string) => void = () => {},
  ) {
    this.onStateChange = onStateChange
    this.onTranscript = onTranscript
    this.onError = onError
  }

  get state(): RealtimeVoiceState {
    if (this.isRecording) return "recording"
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return "connecting"
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return "connected"
    return "idle"
  }

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return

    // Close any lingering CONNECTING socket from a previous attempt
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close()
      this.ws = null
    }

    const token = getStarGuardBearerToken()
    if (!token) {
      this.onError("Sign in via StarGuard first (SSO from StarGuard → CodeNomad).")
      this.onStateChange("idle")
      return
    }

    this.onStateChange("connecting")

    const baseUrl = typeof window !== "undefined"
      ? (window as any).__CODENOMAD_API_BASE__ || window.location.origin
      : "http://localhost:9899"

    const wsUrl = baseUrl.replace(/^http/, "ws") + "/api/voice/session?token=" + encodeURIComponent(token)

    this.ws = new WebSocket(wsUrl)

    // Await the WebSocket opening so startRecording() can reliably send voice_start
    await new Promise<void>((resolve, reject) => {
      const ws = this.ws!
      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error("WebSocket connection timed out"))
      }, 10_000)

      ws.onopen = () => {
        clearTimeout(timeout)
        if (!this.isRecording) {
          this.onStateChange("connected")
        }
        resolve()
      }

      ws.onerror = () => {
        clearTimeout(timeout)
        this.cleanupCapture()
        this.voiceReady = false
        this.isRecording = false
        this.onError("Could not connect to Realtime voice (check tunnel and OPENAI_API_KEY).")
        this.onStateChange("idle")
        reject(new Error("WebSocket connection failed"))
      }
    })

    // Reattach onmessage/onclose after the connect promise resolves
    // (onopen was consumed by the promise, onerror handled above)
    this.ws!.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        switch (msg.type) {
          case "voice_ready":
            this.voiceReady = true
            if (this.voiceReadyTimeout) {
              clearTimeout(this.voiceReadyTimeout)
              this.voiceReadyTimeout = null
            }
            this.startCapture()
            break
          case "audio":
            enqueueAudioChunk(msg.data)
            this.onStateChange("speaking")
            break
          case "stream":
            if (msg.delta) {
              this.onTranscript(msg.delta)
            }
            break
          case "user_transcript":
            if (msg.content) {
              this.onTranscript(msg.content)
            }
            break
          case "voice_cancelled":
            this.isRecording = false
            this.voiceReady = false
            this.onStateChange("connected")
            break
          case "pong":
            break
          case "error":
            // Suppress "active response in progress" errors — these are recoverable
            // server-side races that get resolved internally. No need to alarm the user.
            if (msg.content && /active response in progress/i.test(msg.content)) {
              console.log("[realtime-voice] Active response error suppressed (recoverable)")
              this.onStateChange("recording")
              break
            }
            this.isRecording = false
            this.voiceReady = false
            this.onError(msg.content || "Realtime voice error")
            this.onStateChange("connected")
            break
        }
      } catch {
        // ignore
      }
    }

    this.ws!.onclose = () => {
      const wasActive = this.isRecording || this.voiceReady
      this.cleanupCapture()
      this.voiceReady = false
      this.isRecording = false
      if (wasActive) {
        this.onError("Realtime voice connection closed.")
      }
      this.onStateChange("idle")
    }
  }

  async startRecording(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      try {
        await this.connect()
      } catch {
        // connect() already called onError / onStateChange — just bail
        return
      }
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

    this.isRecording = true
    this.voiceReady = false
    clearAudioQueue()

    this.ws.send(JSON.stringify({ type: "voice_start" }))

    this.voiceReadyTimeout = setTimeout(() => {
      if (!this.voiceReady) {
        this.isRecording = false
        this.onError("Voice session timed out — is OPENAI_API_KEY set on CodeNomad?")
        this.onStateChange("connected")
        this.voiceReadyTimeout = null
      }
    }, 8000)
  }

  private async startCapture(): Promise<void> {
    if (this.capture) return
    try {
      this.capture = await startPCM16Capture((base64) => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: "audio", data: base64 }))
        }
      })
      this.onStateChange("recording")
    } catch {
      this.isRecording = false
      this.voiceReady = false
      this.onError("Microphone permission denied or unavailable.")
      this.onStateChange("connected")
    }
  }

  stopRecording(): void {
    this.cleanupCapture()
    this.isRecording = false
    if (this.voiceReady && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "voice_stop" }))
    }
    this.voiceReady = false
    this.onStateChange("connected")
  }

  private cleanupCapture(): void {
    if (this.capture) {
      this.capture.stop()
      this.capture = null
    }
  }

  /** Send a raw JSON message over the WebSocket (for cancel, voice_start, etc.) */
  sendJson(msg: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  /** Cancel the current agent response mid-speech and re-enter listening mode */
  cancelResponse(): void {
    clearAudioQueue()
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "cancel" }))
    }
    this.voiceReady = false
    this.onStateChange("connected")
  }

  disconnect(): void {
    this.stopRecording()
    clearAudioQueue()
    if (this.ws) {
      this.ws.onclose = null
      this.ws.onmessage = null
      this.ws.onerror = null
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close()
      }
      this.ws = null
    }
    this.onStateChange("idle")
  }
}
