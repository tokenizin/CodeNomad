# Local voice engine: VoxCPM2 TTS

The `local` voice engine (whisper STT → Ollama LLM → TTS) speaks with **Piper** by default. A voice id of the form
`voxcpm-<voice>` makes it speak with **VoxCPM2** running on the Mac Studio instead (the `voxcpm` sidecar from the
`contracts` repo: `scripts/voxcpm-server`, port 9972, see its `docs/VOXCPM_SETUP.md`).

```
voice id            backend
piper-en-male-ryan  Piper (unchanged)
voxcpm-concierge    VoxCPM2 preset "concierge"      (Indonesian replies → "concierge-id")
voxcpm-host-bali    VoxCPM2 library voice "host-bali"
```

## Environment (CodeNomad server)

| Var | Default | |
|---|---|---|
| `VOXCPM_SIDECAR_URL` | `http://127.0.0.1:9972` | Sidecar base URL |
| `VOXCPM_SIDECAR_API_KEY` | — | Sidecar bearer key (`scripts/voxcpm-server/engine-data/.api-key`) |
| `LOCAL_TTS_BACKEND` | — | `voxcpm` makes `voxcpm-concierge` the default local voice |
| `LOCAL_TTS_VOICE` | — | Explicit default voice id; wins over `LOCAL_TTS_BACKEND` |
| `VOXCPM_TTS_TIMEOUT_MS` | `120000` | Per-utterance timeout |

## How it works

- `voxcpm-tts.ts` implements the same `speak / flush / close` contract as `local-tts.ts`. It POSTs each utterance to
  `/v1/audio/speech` with `stream: true, response_format: "pcm"`, and forwards audio as it arrives.
- The browser plays local-engine audio as 24 kHz PCM16; VoxCPM2 emits 48 kHz, so `pcm-resample.ts` low-pass filters and
  decimates 2:1 (a plain sample-drop would alias everything above 12 kHz into the voice band).
- `local-tts-router.ts` picks the backend. **If VoxCPM2 fails before any audio of a sentence has played** (sidecar down,
  model still loading, queue full, timeout), that sentence is spoken by Piper instead, and VoxCPM2 is skipped for 30 s so
  a dead sidecar costs one failed request, not one per sentence. Piper is only spawned when first needed. A stream that
  dies *after* audio started is reported as an error and not replayed (it would repeat words).
- Sessions with a non-VoxCPM voice go through the router in Piper-only mode: Piper is spawned at creation, exactly as before.

## Ornith engine

The `ornith` engine speaks through the same router, so the same voice ids apply:

- `voxcpm-<voice>` → VoxCPM2, with Piper as the per-sentence fallback.
- `ornith-*` labels (the engine's own defaults) and an unset voice follow `LOCAL_TTS_VOICE=voxcpm-<id>`, then
  `LOCAL_TTS_BACKEND=voxcpm`, else Piper. An explicit Piper voice always stays Piper.
- Ornith streams the LLM reply token by token, and Piper speaks each fragment as it arrives. VoxCPM2 cannot — each request is a
  full generation pass — so on the VoxCPM2 path `speech-sentence-buffer.ts` batches the tokens into sentences (a sentence is
  released when the next token proves it ended, so "3.5" and "e.g." survive; a run-on is cut at a comma or space after
  300 characters) and flushes the remainder when the reply ends. The Piper path is untouched.

## `/api/speech` (speech provider `local`)

The `local` speech provider was STT-only (faster-whisper); synthesis threw. It now also synthesizes with VoxCPM2, so selecting
`local` gives a fully on-device speech stack. The `ttsVoice` setting accepts `voxcpm-<id>` or a bare sidecar voice (the
default setting, `marin`, is one of the sidecar's presets); a Piper id left over from an earlier setup falls back to `concierge`.

| Endpoint | Behaviour |
|---|---|
| `POST /api/speech/synthesize` | One sidecar request in the requested format. `wav` always; `mp3` / `opus` / `aac` need ffmpeg on the **sidecar** host. |
| `POST /api/speech/synthesize/stream` | `wav`: the sidecar's WAV stream, passed through. `mp3` / `aac`: the sidecar's PCM stream transcoded live by ffmpeg on the **CodeNomad** host (the UI's streaming playback uses MediaSource, which cannot play WAV). `opus`: not streamable — use the non-streaming endpoint. |

- Text is limited to 3500 characters per request (the sidecar rejects more); split longer text.
- A model that is still loading answers HTTP 503, an unreachable sidecar 502.
- Closing a streaming response cancels the sidecar request and stops ffmpeg, so a closed tab frees the synthesis slot.
