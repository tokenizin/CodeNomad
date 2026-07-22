#!/usr/bin/env python3
"""
Piper TTS local streaming server.

Reads JSON lines from stdin, synthesizes speech via Piper, and writes
base64-encoded raw PCM audio (24 kHz mono, 16-bit signed LE) to stdout.

IPC protocol (JSON lines over stdin/stdout):

  stdin:  {
            "text": "Hello world",
            "voice": "en_US-lessac-high",
            "speed": 1.0,                 # optional legacy; prefer length_scale
            "length_scale": 1.05,
            "noise_scale": 0.55,
            "noise_w_scale": 0.75,
            "volume": 1.0,
            "speaker_id": null,
            "normalize_audio": true
          }
  stdout: {"audio": "<base64-pcm-chunk>"}   — per-sentence audio
          {"type": "flushed"}                — all sentences for utterance sent
          {"type": "error", "message": "..."} — fatal error
          {"type": "ready"}                  — voice loaded, ready for input

Use Piper SynthesisConfig for rate/prosody (NOT crude PCM sample-skipping).
Voice models: $PIPER_VOICE_DIR (default ~/.local/share/piper-voices).
"""

from __future__ import annotations

import base64
import json
import os
import re
import signal
import struct
import sys
import threading
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Graceful shutdown
# ---------------------------------------------------------------------------

_shutdown = False


def _handle_signal(signum, _frame):
    global _shutdown
    _shutdown = True
    sys.stdout.write(json.dumps({"type": "flushed"}) + "\n")
    sys.stdout.flush()


signal.signal(signal.SIGTERM, _handle_signal)
signal.signal(signal.SIGINT, _handle_signal)

# ---------------------------------------------------------------------------
# Voice cache directory
# ---------------------------------------------------------------------------

VOICE_CACHE_DIR = Path(
    os.environ.get(
        "PIPER_VOICE_DIR",
        os.path.join(
            os.environ.get("XDG_DATA_HOME", os.path.expanduser("~/.local/share")),
            "piper-voices",
        ),
    )
)
VOICE_CACHE_DIR.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# Sentence splitting (mirrors the TypeScript logic)
# ---------------------------------------------------------------------------

_SENTENCE_RE = re.compile(r"(?<=[.!?;])\s+")


def split_sentences(text: str) -> list[str]:
    """Split *text* into sentences at '.', '!', '?', ';' boundaries."""
    parts = _SENTENCE_RE.split(text.strip())
    return [p for p in parts if p.strip()]


# ---------------------------------------------------------------------------
# Piper voice loading (lazy singleton)
# ---------------------------------------------------------------------------

_current_voice_name: Optional[str] = None
_current_voice = None
_voice_lock = threading.Lock()


def _load_voice(voice_name: str):
    global _current_voice_name, _current_voice

    with _voice_lock:
        if _current_voice_name == voice_name and _current_voice is not None:
            return _current_voice

    try:
        import piper
        from piper.download_voices import download_voice
    except ImportError:
        raise RuntimeError(
            "piper-tts is not installed.  Install with: pip install piper-tts"
        )

    with _voice_lock:
        if _current_voice_name == voice_name and _current_voice is not None:
            return _current_voice

        model_path = VOICE_CACHE_DIR / f"{voice_name}.onnx"
        config_path = VOICE_CACHE_DIR / f"{voice_name}.onnx.json"

        if not model_path.exists() or not config_path.exists():
            print(
                f"[local-tts] downloading voice '{voice_name}' to {VOICE_CACHE_DIR}...",
                file=sys.stderr,
            )
            download_voice(voice_name, VOICE_CACHE_DIR, force_redownload=False)
            print(
                f"[local-tts] voice '{voice_name}' downloaded",
                file=sys.stderr,
            )

        voice = piper.PiperVoice.load(
            str(model_path),
            config_path=str(config_path),
            download_dir=str(VOICE_CACHE_DIR),
        )
        _current_voice_name = voice_name
        _current_voice = voice
        return voice


# ---------------------------------------------------------------------------
# PCM synthesis
# ---------------------------------------------------------------------------

SAMPLE_RATE = 24000


def _build_syn_config(request: dict, speed: float):
    """Build Piper SynthesisConfig from request knobs + legacy speed."""
    from piper.config import SynthesisConfig

    length_scale = request.get("length_scale")
    if length_scale is None:
        # speed > 1 → speak faster → shorter length_scale
        if speed and speed > 0:
            length_scale = 1.0 / float(speed)
        else:
            length_scale = 1.0

    noise_scale = request.get("noise_scale")
    if noise_scale is None:
        noise_scale = 0.667

    noise_w_scale = request.get("noise_w_scale")
    if noise_w_scale is None:
        noise_w_scale = 0.8

    volume = request.get("volume")
    if volume is None:
        volume = 1.0

    speaker_id = request.get("speaker_id")
    normalize = request.get("normalize_audio")
    if normalize is None:
        normalize = True

    return SynthesisConfig(
        speaker_id=int(speaker_id) if speaker_id is not None else None,
        length_scale=float(length_scale),
        noise_scale=float(noise_scale),
        noise_w_scale=float(noise_w_scale),
        normalize_audio=bool(normalize),
        volume=float(volume),
    )


def synthesize_pcm(voice, text: str, syn_config) -> bytes:
    """Synthesize *text* to raw PCM bytes (16-bit signed LE, 24 kHz mono).

    Prosody/rate come from SynthesisConfig (length_scale), not sample-skipping.
    """
    chunks = list(voice.synthesize(text, syn_config=syn_config))

    raw_pcm = b"".join(c.audio_int16_bytes for c in chunks)

    if not raw_pcm:
        return b""

    native_rate = chunks[0].sample_rate if chunks else 22050

    if native_rate != SAMPLE_RATE:
        raw_pcm = _resample(raw_pcm, native_rate, SAMPLE_RATE)

    return raw_pcm


def _resample(pcm: bytes, from_rate: int, to_rate: int) -> bytes:
    """Linear interpolation resample for 16-bit signed LE PCM."""
    if from_rate == to_rate:
        return pcm

    n_samples = len(pcm) // 2
    samples = struct.unpack(f"<{n_samples}h", pcm)
    ratio = from_rate / to_rate
    out_count = int(n_samples / ratio)
    out = []
    for i in range(out_count):
        src_pos = i * ratio
        idx = int(src_pos)
        frac = src_pos - idx
        if idx + 1 < n_samples:
            val = int(samples[idx] * (1 - frac) + samples[idx + 1] * frac)
        else:
            val = samples[idx] if idx < n_samples else 0
        out.append(max(-32768, min(32767, val)))
    return struct.pack(f"<{len(out)}h", *out)


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def main():
    sys.stdout.write(json.dumps({"type": "ready"}) + "\n")
    sys.stdout.flush()

    default_voice = os.environ.get("LOCAL_TTS_VOICE", "en_US-lessac-high")
    default_speed = float(os.environ.get("LOCAL_TTS_SPEED", "1.0"))

    for line in sys.stdin:
        if _shutdown:
            break

        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            _write_error(f"Invalid JSON: {exc}")
            continue

        text = request.get("text", "")
        voice_name = request.get("voice", default_voice)
        speed = float(request.get("speed", default_speed))

        if not text:
            continue

        try:
            voice = _load_voice(voice_name)
        except Exception as exc:
            _write_error(f"Failed to load voice '{voice_name}': {exc}")
            continue

        try:
            syn_config = _build_syn_config(request, speed)
        except Exception as exc:
            _write_error(f"Invalid synthesis config: {exc}")
            continue

        sentences = split_sentences(text)

        for sentence in sentences:
            if _shutdown:
                break
            try:
                pcm_bytes = synthesize_pcm(voice, sentence, syn_config)
                b64 = base64.b64encode(pcm_bytes).decode("ascii")
                sys.stdout.write(json.dumps({"audio": b64}) + "\n")
                sys.stdout.flush()
            except Exception as exc:
                _write_error(f"Synthesis error: {exc}")

        if not _shutdown:
            sys.stdout.write(json.dumps({"type": "flushed"}) + "\n")
            sys.stdout.flush()


def _write_error(message: str):
    sys.stdout.write(json.dumps({"type": "error", "message": message}) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
