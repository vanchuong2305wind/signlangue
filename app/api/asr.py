"""
asr.py
Offline speech recognition with Whisper (faster-whisper / CTranslate2).

This is a standby path, not the main one. The browser's speech engine still
handles the microphone and the platform caption tracks still drive the video
page; Whisper only answers when those cannot:
  - the browser's speech engine is unreachable (no internet) or missing,
  - a video has no caption track at all.

The model is loaded lazily (or in the background at startup) so the normal
path never waits on it.
"""

from __future__ import annotations

import os
import threading
import time
from typing import BinaryIO

# Turbo is large-v3 with a pruned decoder: close to large-v3 on Vietnamese at a
# fraction of the latency, which matters for a fallback that has to feel live.
# On CPU it would take seconds per utterance, so a CPU host drops to `small`.
GPU_MODEL = os.getenv("WHISPER_MODEL", "large-v3-turbo")
CPU_MODEL = os.getenv("WHISPER_CPU_MODEL", "small")
DEFAULT_LANGUAGE = os.getenv("WHISPER_LANGUAGE", "vi")

_model = None
_model_info: dict = {}
_load_lock = threading.Lock()
# CTranslate2 models are safe to share, but one GPU decoding two requests at
# once only makes both slower, so requests are served one at a time.
_inference_lock = threading.Lock()
_load_error: str | None = None


def _pick_device() -> tuple[str, str, str]:
    """(device, compute_type, model name) for this host."""
    device = os.getenv("WHISPER_DEVICE", "").strip().lower()
    if not device:
        try:
            import ctranslate2
            device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
        except Exception:  # noqa: BLE001 - a broken CUDA install must not crash
            device = "cpu"
    compute_type = os.getenv("WHISPER_COMPUTE_TYPE", "").strip() or (
        "float16" if device == "cuda" else "int8"
    )
    model_name = GPU_MODEL if device == "cuda" else CPU_MODEL
    return device, compute_type, model_name


def is_installed() -> bool:
    try:
        import faster_whisper  # noqa: F401
    except ImportError:
        return False
    return True


def load():
    """Build the model once. Raises RuntimeError when it cannot be loaded."""
    global _model, _model_info, _load_error
    if _model is not None:
        return _model
    with _load_lock:
        if _model is not None:
            return _model
        try:
            from faster_whisper import WhisperModel
        except ImportError as error:
            _load_error = "faster-whisper chưa được cài trên máy chủ."
            raise RuntimeError(_load_error) from error

        device, compute_type, model_name = _pick_device()
        started = time.monotonic()
        try:
            _model = WhisperModel(model_name, device=device, compute_type=compute_type)
        except Exception as error:  # noqa: BLE001 - download, CUDA, disk
            _load_error = f"Không nạp được model nhận dạng giọng nói: {error}"
            raise RuntimeError(_load_error) from error
        _model_info = {
            "model": model_name,
            "device": device,
            "compute_type": compute_type,
            "load_seconds": round(time.monotonic() - started, 1),
        }
        _load_error = None
        print(f"[ASR] Whisper ready: {_model_info}")
        return _model


def status() -> dict:
    return {
        "installed": is_installed(),
        "loaded": _model is not None,
        "error": _load_error,
        **_model_info,
    }


def transcribe(audio: str | BinaryIO, language: str | None = DEFAULT_LANGUAGE) -> dict:
    """Transcribe a file path or file-like object into timed segments.

    `language=None` lets Whisper detect it, which the video path needs because
    a video can be in any language; the microphone path pins Vietnamese so a
    short utterance is never misdetected.
    """
    model = load()
    started = time.monotonic()
    with _inference_lock:
        segments, info = model.transcribe(
            audio,
            language=language or None,
            beam_size=5,
            # Skips silence before decoding: faster, and it removes most of
            # Whisper's habit of inventing text over quiet stretches.
            vad_filter=True,
            # Prevents one hallucinated line from repeating through the rest.
            condition_on_previous_text=False,
        )
        cues = [
            {
                "start": round(float(segment.start), 3),
                "end": round(float(segment.end), 3),
                "text": segment.text.strip(),
            }
            for segment in segments
            if segment.text and segment.text.strip()
        ]
    return {
        "text": " ".join(cue["text"] for cue in cues).strip(),
        "cues": cues,
        "language": info.language,
        "language_probability": round(float(info.language_probability), 3),
        "duration": round(float(info.duration), 2),
        "elapsed": round(time.monotonic() - started, 2),
    }
