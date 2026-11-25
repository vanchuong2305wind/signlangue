"""Lazy, thread-safe VSL224 RGB inference for browser camera clips."""

from __future__ import annotations

import base64
import importlib.util
import json
import threading
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]
MODEL_DIR = ROOT_DIR / "models" / "camera" / "vsl224"
CHECKPOINT = MODEL_DIR / "rgb-best.pt"
LABELS_FILE = MODEL_DIR / "labels.json"
MODEL_NAME = "VSL224-Hiera-RGB"
NUM_CLASSES = 224
MODEL_FRAME_COUNT = 16

_model = None
_labels = None
_device = None
_load_error = None
_load_lock = threading.Lock()
_inference_lock = threading.Lock()


def _read_labels() -> list[str]:
    try:
        labels = json.loads(LABELS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise RuntimeError("Không đọc được labels.json của model VSL224.") from error
    if (not isinstance(labels, list) or len(labels) != NUM_CLASSES
            or not all(isinstance(label, str) and label.strip() for label in labels)
            or len(set(labels)) != NUM_CLASSES):
        raise RuntimeError("labels.json phải chứa đúng 224 nhãn VSL khác nhau, theo thứ tự lúc train.")
    return labels


def _check_assets() -> None:
    if not CHECKPOINT.is_file():
        raise RuntimeError("Không tìm thấy model VSL224: models/camera/vsl224/rgb-best.pt.")
    _read_labels()
    missing = [name for name in ("torch", "torchvision", "timm", "cv2", "numpy")
               if importlib.util.find_spec(name) is None]
    if missing:
        raise RuntimeError("Thiếu thư viện cho model VSL224: " + ", ".join(missing))


def model_status() -> dict:
    # Asset/dependency preflight only; weights stay lazy until first recognition.
    error = None
    try:
        _check_assets()
    except RuntimeError as problem:
        error = str(problem)
    error = error or _load_error
    return {
        "available": error is None,
        "loaded": _model is not None,
        "model": MODEL_NAME,
        "classes": NUM_CLASSES,
        "model_frame_count": MODEL_FRAME_COUNT,
        "error": error,
    }


def _ensure_model() -> None:
    global _model, _labels, _device, _load_error
    if _model is not None:
        return
    with _load_lock:
        if _model is not None:
            return
        try:
            _check_assets()
            import torch
            from .vsl_model import VSLRGB

            labels = _read_labels()
            device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
            if device.type == "cpu":
                torch.set_num_threads(max(1, min(4, torch.get_num_threads())))
            model = VSLRGB(NUM_CLASSES)
            state = torch.load(CHECKPOINT, map_location="cpu", weights_only=True)
            model.load_state_dict(state, strict=True)
            model = model.to(device).eval()
        except Exception as error:
            _load_error = f"Không nạp được model VSL224: {error}"
            raise RuntimeError(_load_error) from error
        # Publish only after a successful strict load; never use a partial model.
        _labels, _device = labels, device
        _load_error = None
        _model = model


def _decode_frame(encoded: str):
    import cv2
    import numpy as np

    if not isinstance(encoded, str):
        raise ValueError("Dữ liệu khung hình không hợp lệ.")
    try:
        raw = base64.b64decode(encoded.split(",", 1)[-1], validate=True)
    except (ValueError, base64.binascii.Error) as error:
        raise ValueError("Dữ liệu khung hình không hợp lệ.") from error
    if not raw:
        raise ValueError("Dữ liệu khung hình trống.")
    try:
        frame = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    except cv2.error as error:
        raise ValueError("Không đọc được khung hình camera.") from error
    if frame is None:
        raise ValueError("Không đọc được khung hình camera.")
    return frame


def _preprocess(frames: list):
    """Match dataset.read_clip(jitter=False); return unnormalized RGB uint8."""
    import cv2
    import numpy as np
    import torch

    if not frames:
        raise ValueError("Clip camera không có khung hình.")
    indices = np.floor((np.arange(MODEL_FRAME_COUNT) + .5) * len(frames)
                       / MODEL_FRAME_COUNT).astype(np.int64)
    indices = np.clip(indices, 0, len(frames) - 1)
    processed = [cv2.cvtColor(cv2.resize(frames[index], (224, 224)), cv2.COLOR_BGR2RGB)
                 for index in indices]
    array = np.stack(processed)
    return torch.from_numpy(array.transpose(3, 0, 1, 2)).unsqueeze(0)


def recognize(encoded_frames: list[str], top_k: int = 3) -> dict:
    if not 12 <= len(encoded_frames) <= 48:
        raise ValueError("Cần từ 12 đến 48 khung hình để nhận diện.")
    if not isinstance(top_k, int) or not 1 <= top_k <= 5:
        raise ValueError("top_k phải nằm trong khoảng 1 đến 5.")
    _check_assets()
    try:
        frames = [_decode_frame(frame) for frame in encoded_frames]
    except ImportError as error:
        raise RuntimeError(f"Thiếu thư viện xử lý ảnh VSL224: {error}") from error
    # No WLASL static-edge trimming: preserve the clip for training-parity sampling.
    _ensure_model()

    import torch

    video = _preprocess(frames).to(_device)
    with _inference_lock, torch.inference_mode():
        probabilities = _model(video).float().softmax(dim=1)[0]
        if not torch.isfinite(probabilities).all():
            raise RuntimeError("Model VSL224 trả về xác suất không hợp lệ.")
        values, indices = probabilities.topk(min(top_k, len(_labels)))

    predictions = [
        {"label": _labels[index],
         "vietnamese": _labels[index].replace("_", " "),
         "confidence": round(float(probability), 4)}
        for probability, index in zip(values.tolist(), indices.tolist())
    ]
    return {
        "prediction": predictions[0],
        "alternatives": predictions[1:],
        "model": MODEL_NAME,
        "device": str(_device),
        "frame_count": len(frames),
        "model_frame_count": MODEL_FRAME_COUNT,
    }
