"""Lazy, thread-safe WLASL100 inference for browser camera frames."""

from __future__ import annotations

import base64
import re
import sys
import threading
from pathlib import Path

import cv2
import numpy as np

ROOT_DIR = Path(__file__).resolve().parents[2]
MODEL_DIR = ROOT_DIR / "train" / "Sign-Language-Recognition" / "code"
CHECKPOINT = MODEL_DIR / "pretrained_wlasl100" / "best_model_40_73.pth"
LABELS_FILE = MODEL_DIR / "preprocess" / "wlasl_class_list.txt"
TRANSLATIONS_FILE = ROOT_DIR / "train" / "lang.txt"

_model = None
_labels = None
_translations = None
_device = None
_load_lock = threading.Lock()
_inference_lock = threading.Lock()


def is_available() -> bool:
    return CHECKPOINT.is_file() and LABELS_FILE.is_file()


def _load_translations() -> dict[int, str]:
    translations = {}
    if TRANSLATIONS_FILE.exists():
        pattern = re.compile(r"^(\d+)\s+\S+\s{2,}(.+)$")
        for line in TRANSLATIONS_FILE.read_text(encoding="utf-8").splitlines():
            match = pattern.match(line)
            if match:
                translations[int(match.group(1))] = match.group(2).strip()
    return translations


def _ensure_model() -> None:
    global _model, _labels, _translations, _device
    if _model is not None:
        return
    with _load_lock:
        if _model is not None:
            return
        if not is_available():
            raise RuntimeError("Không tìm thấy checkpoint WLASL100 trong thư mục train.")

        import torch

        if str(MODEL_DIR) not in sys.path:
            sys.path.insert(0, str(MODEL_DIR))
        from predict_video import load_labels, load_model

        _device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        if _device.type == "cpu":
            torch.set_num_threads(max(1, min(4, torch.get_num_threads())))
        _model = load_model(CHECKPOINT, _device)
        _labels = load_labels(LABELS_FILE, 100)
        _translations = _load_translations()


def _decode_frame(encoded: str) -> np.ndarray:
    try:
        raw = base64.b64decode(encoded.split(",", 1)[-1], validate=True)
    except (ValueError, base64.binascii.Error) as error:
        raise ValueError("Dữ liệu khung hình không hợp lệ.") from error
    frame = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise ValueError("Không đọc được khung hình camera.")
    return frame


def _trim_static_edges(frames: list[np.ndarray], min_length: int = 12) -> list[np.ndarray]:
    """Drop near-static frames at both ends of the clip.

    The browser's motion gate has slop (fixed pixel thresholds on a downsampled preview),
    so a captured segment can still start or end with a few near-idle frames. Those dilute
    the fixed 64-frame resample in _preprocess with non-gesture content. The motion here is
    scored per-clip (average consecutive-frame diff) rather than a fixed constant, since the
    absolute diff scale depends on lighting/compression and varies a lot more per request
    than the browser's own controlled downsample.
    """
    if len(frames) <= min_length:
        return frames

    small = [cv2.resize(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY), (64, 48)) for f in frames]
    diffs = [
        float(np.abs(small[i].astype(np.int16) - small[i + 1].astype(np.int16)).mean())
        for i in range(len(small) - 1)
    ]
    if not diffs:
        return frames
    threshold = max(2.0, (sum(diffs) / len(diffs)) * 0.35)

    start = 0
    while start < len(diffs) and diffs[start] < threshold:
        start += 1
    end = len(frames) - 1
    while end > 0 and diffs[end - 1] < threshold:
        end -= 1

    if end - start + 1 < min_length:
        return frames
    return frames[start : end + 1]


def _preprocess(frames: list[np.ndarray], frame_count: int = 64):
    import torch

    indices = np.linspace(0, len(frames) - 1, frame_count).round().astype(np.int64)
    processed = []
    for index in indices:
        frame = cv2.cvtColor(frames[index], cv2.COLOR_BGR2RGB)
        height, width = frame.shape[:2]
        scale = 256.0 / min(height, width)
        frame = cv2.resize(
            frame,
            (round(width * scale), round(height * scale)),
            interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR,
        )
        height, width = frame.shape[:2]
        top, left = (height - 224) // 2, (width - 224) // 2
        processed.append(frame[top : top + 224, left : left + 224])
    array = np.asarray(processed, dtype=np.float32) / 127.5 - 1.0
    return torch.from_numpy(array.transpose(3, 0, 1, 2)).unsqueeze(0)


def recognize(encoded_frames: list[str], top_k: int = 3) -> dict:
    if not 12 <= len(encoded_frames) <= 48:
        raise ValueError("Cần từ 12 đến 48 khung hình để nhận diện.")
    _ensure_model()

    import torch

    frames = [_decode_frame(frame) for frame in encoded_frames]
    frames = _trim_static_edges(frames)
    video = _preprocess(frames).to(_device)
    with _inference_lock, torch.inference_mode():
        probabilities = _model(video).softmax(dim=1)[0]
        values, indices = probabilities.topk(min(top_k, len(_labels)))

    predictions = [
        {
            "label": _labels[index],
            "vietnamese": _translations.get(index, ""),
            "confidence": round(float(probability), 4),
        }
        for probability, index in zip(values.tolist(), indices.tolist())
    ]
    return {
        "prediction": predictions[0],
        "alternatives": predictions[1:],
        "model": "WLASL100-I3D-Transformer",
        "device": str(_device),
        "frame_count": len(frames),
    }
