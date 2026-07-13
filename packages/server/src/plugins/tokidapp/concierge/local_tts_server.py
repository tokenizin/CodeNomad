#!/usr/bin/env python3
"""
Piper TTS local streaming server.

Reads JSON lines from stdin, synthesizes speech via Piper, and writes
base64-encoded raw PCM audio (24 kHz mono, 16-bit signed LE) to stdout.

IPC protocol (JSON lines over stdin/stdout):

  stdin:  {"text": "Hello world", "voice": "en_US-amy-medium", "speed": 1.0}
  stdout: {"audio": "<base64-pcm-chunk>"}   — per-sentence audio
          {"type": "flushed"}                — all sentences for utterance sent
          {"type": "error", "message": "..."} — fatal error
          {"type": "ready"}                  — voice loaded, ready for input

Each stdin line triggers synthesis of one text block.  The server splits the
text into sentences internally and writes one stdout JSON object per sentence,
followed by a flushed sentinel.

Voice models are cached in $XDG_DATA_HOME/piper-voices (default
~/.local/share/piper-voices).  First run downloads the model from HuggingFace.
"""

from __future__ import annotations

import base64
import io
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
    # Write a final flushed so the Node side doesn't hang waiting
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

    # Import piper here so import errors surface as runtime errors
    # rather than at module load time.
    try:
        import piper
        from piper.download_voices import download_voice, VOICE_PATTERN
    except ImportError:
        raise RuntimeError(
            "piper-tts is not installed.  Install with: pip install piper-tts"
        )

    with _voice_lock:
        # Double-check after acquiring lock
        if _current_voice_name == voice_name and _current_voice is not None:
            return _current_voice

        # Resolve voice name to ONNX model path
        # The Piper Python API requires a file path, not a voice name.
        # Voice names like "en_US-amy-medium" map to:
        #   {download_dir}/{lang_code}-{voice_name}-{voice_quality}.onnx
        #   {download_dir}/{lang_code}-{voice_name}-{voice_quality}.onnx.json
        model_path = VOICE_CACHE_DIR / f"{voice_name}.onnx"
        config_path = VOICE_CACHE_DIR / f"{voice_name}.onnx.json"

        if not model_path.exists() or not config_path.exists():
            # Download voice model from HuggingFace
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


def synthesize_pcm(voice, text: str, speed: float = 1.0) -> bytes:
    """Synthesize *text* to raw PCM bytes (16-bit signed LE, 24 kHz mono).

    Piper outputs 16-bit PCM at the model's native sample rate.  If the
    model does not natively produce 24 kHz audio we re-sample here.
    """
    wav_buffer = io.BytesIO()
    voice.synthesize(text, wav_buffer)
    wav_bytes = wav_buffer.getvalue()

    # Strip WAV header to get raw PCM.  WAV header is at least 44 bytes.
    # We look for the 'data' chunk to find the exact offset.
    raw_pcm = _strip_wav_header(wav_bytes)

    # Resample to 24 kHz if the model's sample rate differs
    native_rate = voice.config.sample_rate if hasattr(voice.config, "sample_rate") else 22050
    if native_rate != SAMPLE_RATE:
        raw_pcm = _resample(raw_pcm, native_rate, SAMPLE_RATE)

    # Apply speed adjustment via simple sample skipping/interpolation
    if speed != 1.0:
        raw_pcm = _adjust_speed(raw_pcm, speed)

    return raw_pcm


def _strip_wav_header(data: bytes) -> bytes:
    """Return raw PCM audio from a WAV buffer, stripping the header."""
    # Standard WAV: find 'data' chunk
    idx = data.find(b"data")
    if idx > 0 and idx + 8 <= len(data):
        offset = idx + 8  # skip 'data' + 4-byte size
        size_bytes = struct.unpack_from("<I", data, idx + 4)[0]
        return data[offset : offset + size_bytes]
    # Fallback: skip 44-byte header
    return data[44:] if len(data) > 44 else data


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


def _adjust_speed(pcm: bytes, speed: float) -> bytes:
    """Adjust speech speed by resampling the PCM buffer."""
    if speed <= 0 or speed > 4.0:
        return pcm
    n_samples = len(pcm) // 2
    samples = struct.unpack(f"<{n_samples}h", pcm)
    out_count = int(n_samples / speed)
    out = []
    for i in range(out_count):
        src_pos = i * speed
        idx = int(src_pos)
        if idx < n_samples:
            out.append(samples[idx])
    return struct.pack(f"<{len(out)}h", *out)


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def main():
    # Signal readiness
    sys.stdout.write(json.dumps({"type": "ready"}) + "\n")
    sys.stdout.flush()

    default_voice = os.environ.get("LOCAL_TTS_VOICE", "en_US-amy-medium")
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

        # Split into sentences for streaming playback
        sentences = split_sentences(text)

        for sentence in sentences:
            if _shutdown:
                break
            try:
                pcm_bytes = synthesize_pcm(voice, sentence, speed)
                b64 = base64.b64encode(pcm_bytes).decode("ascii")
                sys.stdout.write(json.dumps({"audio": b64}) + "\n")
                sys.stdout.flush()
            except Exception as exc:
                _write_error(f"Synthesis error: {exc}")

        # Flush sentinel — all sentences for this utterance are done
        if not _shutdown:
            sys.stdout.write(json.dumps({"type": "flushed"}) + "\n")
            sys.stdout.flush()


def _write_error(message: str):
    sys.stdout.write(json.dumps({"type": "error", "message": message}) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
