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

## Not covered

- `speech/providers/local-tts.ts` (the batch `/api/speech` provider) is still Piper-only.
- The `ornith` engine still uses Piper for TTS.
