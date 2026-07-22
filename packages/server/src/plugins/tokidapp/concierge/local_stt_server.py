#!/usr/bin/env python3
"""
Local STT Server — faster-whisper streaming speech-to-text via JSON-line IPC.

Communicates with CodeNomad (Node.js/Bun) via stdin/stdout:
  - stdin:  base64-encoded PCM 16-bit 24kHz mono audio chunks (one per line)
  - stdout: JSON lines with transcripts, status, and heartbeat messages

Uses faster-whisper (CTranslate2 + Metal GPU on Apple Silicon) with Silero VAD
for speech activity detection. Model is cached to ~/.cache/huggingface/hub/.

Protocol:
  IN:  {"type":"audio","data":"<base64>"}           — audio chunk
  IN:  {"type":"config","key":"value",...}            — runtime config update
  OUT: {"type":"transcript","text":"...","is_final":true|false}
  OUT: {"type":"utterance_end"}
  OUT: {"type":"ready"}
  OUT: {"type":"error","message":"..."}
  OUT: {"type":"heartbeat","ts":<unix_ms>}
"""

import base64
import json
import os
import signal
import struct
import sys
import time
import threading
import numpy as np

# ── Environment Configuration ───────────────────────────────────────────

MODEL_NAME = os.environ.get("LOCAL_STT_MODEL", "base.en")
DEVICE = os.environ.get("LOCAL_STT_DEVICE", "cpu")
LANGUAGE = os.environ.get("LOCAL_STT_LANGUAGE", "en")
BEAM_SIZE = int(os.environ.get("LOCAL_STT_BEAM_SIZE", "5"))
VAD_THRESHOLD = float(os.environ.get("LOCAL_STT_VAD_THRESHOLD", "0.5"))
SAMPLE_RATE = 24000
HEARTBEAT_INTERVAL_MS = 10000
BUFFER_MAX_SECONDS = 30.0


def log(msg: str):
    """Log to stderr (stdout is reserved for JSON-line IPC)."""
    print(f"[local-stt] {msg}", file=sys.stderr, flush=True)


def send_json(obj: dict):
    """Write a JSON line to stdout."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def parse_config(raw: str) -> dict:
    """Parse a config message, returning known keys."""
    try:
        msg = json.loads(raw)
        if msg.get("type") == "config":
            return msg
    except (json.JSONDecodeError, TypeError):
        pass
    return {}


class LocalSTTServer:
    """
    Streaming STT server using faster-whisper with Silero VAD.

    Architecture:
      1. Accumulate base64-encoded PCM audio chunks into a ring buffer.
      2. When VAD detects speech onset, begin collecting into a segment buffer.
      3. When VAD detects speech end, transcribe the segment and emit final transcript.
      4. For partial transcripts, run transcription on a rolling window during speech.
    """

    def __init__(self):
        self.model = None
        self.model_info = None
        self.audio_buffer = np.array([], dtype=np.float32)
        self.segment_buffer = np.array([], dtype=np.float32)
        self.is_speaking = False
        self.lock = threading.Lock()
        self.last_heartbeat_ms = int(time.time() * 1000)

    def load_model(self):
        """Load faster-whisper. Prefer CPU+int8 — device=auto+float16 crashes on Apple Silicon."""
        log(f"Loading model '{MODEL_NAME}' on device '{DEVICE}'...")
        send_json({"type": "status", "message": f"Loading model '{MODEL_NAME}'..."})

        try:
            from faster_whisper import WhisperModel

            device = DEVICE if DEVICE and DEVICE != "auto" else "cpu"
            if device.lower() == "cuda":
                candidates = [("cuda", "float16"), ("cuda", "int8"), ("cpu", "int8")]
            elif device.lower() in ("metal", "gpu"):
                candidates = [(device, "float16"), (device, "int8"), ("cpu", "int8")]
            else:
                candidates = [("cpu", "int8")]

            last_err = None
            for dev, compute_type in candidates:
                try:
                    self.model = WhisperModel(
                        MODEL_NAME,
                        device=dev,
                        compute_type=compute_type,
                    )
                    self.model_info = {
                        "model": MODEL_NAME,
                        "device": dev,
                        "compute_type": compute_type,
                    }
                    log(f"Model loaded: {MODEL_NAME} (device={dev}, compute_type={compute_type})")
                    send_json({"type": "ready", "model": MODEL_NAME, "device": dev})
                    return
                except Exception as e:
                    last_err = e
                    log(f"Load attempt failed device={dev} compute={compute_type}: {e}")

            raise last_err or RuntimeError("All WhisperModel load attempts failed")
        except ImportError as e:
            log(f"Failed to import faster_whisper: {e}")
            send_json({"type": "error", "message": f"ImportError: {e}. Install: /usr/bin/python3 -m pip install --user faster-whisper"})
            sys.exit(1)
        except Exception as e:
            log(f"Failed to load model: {e}")
            send_json({"type": "error", "message": f"Model load failed: {e}"})
            sys.exit(1)

    def decode_audio_chunk(self, b64_data: str):
        """Decode base64-encoded PCM 16-bit mono audio to float32 numpy array."""
        try:
            raw_bytes = base64.b64decode(b64_data)
            # PCM 16-bit signed little-endian → float32 normalized to [-1, 1]
            samples = np.frombuffer(raw_bytes, dtype=np.int16).astype(np.float32) / 32768.0
            return samples
        except Exception as e:
            log(f"Audio decode error: {e}")
            return None

    def process_audio(self, audio_chunk: np.ndarray):
        """
        Process incoming audio chunk through VAD + transcription pipeline.

        Uses faster-whisper's built-in Silero VAD (vad_filter=True).
        Processes audio in windows for streaming behavior.
        """
        if self.model is None:
            return

        with self.lock:
            # Append new audio to the running buffer
            self.audio_buffer = np.concatenate([self.audio_buffer, audio_chunk])

            # Cap buffer at max seconds to prevent unbounded growth
            max_samples = int(BUFFER_MAX_SECONDS * SAMPLE_RATE)
            if len(self.audio_buffer) > max_samples:
                self.audio_buffer = self.audio_buffer[-max_samples:]

            # Only process if we have enough audio (at least 500ms)
            min_samples = int(0.5 * SAMPLE_RATE)
            if len(self.audio_buffer) < min_samples:
                return

            # Run transcription with VAD filtering
            try:
                self._transcribe_window()
            except Exception as e:
                log(f"Transcription error: {e}")

    def _transcribe_window(self):
        """Run faster-whisper transcription on the current audio buffer with VAD."""
        if self.model is None or len(self.audio_buffer) == 0:
            return

        audio = self.audio_buffer.copy()

        segments, info = self.model.transcribe(
            audio,
            language=LANGUAGE if LANGUAGE else None,
            beam_size=BEAM_SIZE,
            vad_filter=True,
            vad_parameters=dict(
                threshold=VAD_THRESHOLD,
                min_speech_duration_ms=250,
                min_silence_duration_ms=500,
                speech_pad_ms=200,
                max_speech_duration_s=30.0,
            ),
        )

        any_speech = False
        for segment in segments:
            text = segment.text.strip()
            if not text:
                continue

            any_speech = True

            # Determine if this is likely a final transcript based on VAD timing.
            # If the segment end is close to the buffer end, it's likely partial.
            buffer_duration = len(audio) / SAMPLE_RATE
            is_near_end = (buffer_duration - segment.end) < 1.0

            send_json({
                "type": "transcript",
                "text": text,
                "is_final": is_near_end,
                "start": round(segment.start, 3),
                "end": round(segment.end, 3),
                "language": info.language if hasattr(info, "language") else LANGUAGE,
                "probability": round(info.language_probability, 4) if hasattr(info, "language_probability") and info.language_probability else None,
            })

        if not any_speech:
            # No speech detected — if we were speaking, emit utterance_end
            if self.is_speaking:
                send_json({"type": "utterance_end"})
                self.is_speaking = False
        else:
            self.is_speaking = True

    def send_heartbeat(self):
        """Send periodic heartbeat to keep IPC alive."""
        now_ms = int(time.time() * 1000)
        if now_ms - self.last_heartbeat_ms >= HEARTBEAT_INTERVAL_MS:
            send_json({"type": "heartbeat", "ts": now_ms})
            self.last_heartbeat_ms = now_ms

    def run(self):
        """Main loop: read JSON lines from stdin, process, emit transcripts."""
        self.load_model()

        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue

            # Handle config updates
            config = parse_config(line)
            if config:
                self._handle_config(config)
                continue

            # Handle audio chunks
            try:
                msg = json.loads(line)
                msg_type = msg.get("type", "")

                if msg_type == "audio":
                    b64_data = msg.get("data", "")
                    if b64_data:
                        audio_chunk = self.decode_audio_chunk(b64_data)
                        if audio_chunk is not None and len(audio_chunk) > 0:
                            self.process_audio(audio_chunk)

                elif msg_type == "flush":
                    # Force transcription of any remaining buffer
                    with self.lock:
                        if len(self.audio_buffer) > 0 and self.model is not None:
                            try:
                                self._transcribe_window()
                            except Exception as e:
                                log(f"Flush transcription error: {e}")
                    if self.is_speaking:
                        send_json({"type": "utterance_end"})
                        self.is_speaking = False

                elif msg_type == "reset":
                    with self.lock:
                        self.audio_buffer = np.array([], dtype=np.float32)
                        self.segment_buffer = np.array([], dtype=np.float32)
                        self.is_speaking = False
                    log("Buffer reset")

                elif msg_type == "ping":
                    send_json({"type": "pong", "ts": int(time.time() * 1000)})

            except json.JSONDecodeError as e:
                log(f"Invalid JSON line: {e}")
                send_json({"type": "error", "message": f"Invalid JSON: {e}"})

            self.send_heartbeat()

    def _handle_config(self, config: dict):
        """Handle runtime config updates (e.g., language, VAD threshold)."""
        global LANGUAGE, VAD_THRESHOLD, BEAM_SIZE

        if "language" in config:
            LANGUAGE = config["language"]
            log(f"Language updated to: {LANGUAGE}")
        if "vad_threshold" in config:
            try:
                VAD_THRESHOLD = float(config["vad_threshold"])
                log(f"VAD threshold updated to: {VAD_THRESHOLD}")
            except (ValueError, TypeError):
                pass
        if "beam_size" in config:
            try:
                BEAM_SIZE = int(config["beam_size"])
                log(f"Beam size updated to: {BEAM_SIZE}")
            except (ValueError, TypeError):
                pass


def main():
    """Entry point: register signal handlers, start server."""
    server = LocalSTTServer()

    def handle_signal(signum, frame):
        log(f"Received signal {signum}, shutting down...")
        send_json({"type": "status", "message": "shutting_down"})
        sys.exit(0)

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    log(f"Starting local STT server (model={MODEL_NAME}, device={DEVICE}, lang={LANGUAGE})")
    server.run()


if __name__ == "__main__":
    main()
