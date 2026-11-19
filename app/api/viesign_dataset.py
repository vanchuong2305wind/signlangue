"""Shared VieSign identifiers and on-disk layout, independent of MediaPipe."""

from __future__ import annotations

import hashlib
import json
import os
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "data_v2" / "processed"
DATASET_ID = "viesign"
PIPELINE_VERSION = 1


def normalize_word(word: str) -> str:
    """Preserve Vietnamese accents; normalize only spelling representation/spacing."""
    return " ".join(unicodedata.normalize("NFC", word).casefold().replace("_", " ").split())


def word_id(word: str) -> str:
    # ASCII route/file ID; Vietnamese meanings remain in the dictionary.
    return "vsl-" + hashlib.sha256(normalize_word(word).encode("utf-8")).hexdigest()[:20]


def atomic_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
