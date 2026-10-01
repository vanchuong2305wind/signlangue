"""
local_nlp.py
Offline Vietnamese text-to-sign parsing: underthesea word segmentation plus
PhoBERT sentence embeddings for meaning-based dictionary lookup.

Standby path only. Gemini stays the primary parser; this answers when Gemini
cannot be reached (no internet, quota, timeout) and sits between Gemini and the
plain longest-match parser in the fallback chain.

What it adds over longest-match:
  - Real word segmentation, so "xe hơi" is one word rather than "xe" + "hơi".
  - A word missing from the dictionary is matched to the closest-meaning entry
    ("xe hơi" -> "ô tô") instead of being fingerspelled letter by letter.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from pathlib import Path

import numpy as np

from .sign_lookup import DATA_DIR, sign_dict

# PhoBERT-base-v2 fine-tuned as a Vietnamese sentence bi-encoder. Raw PhoBERT
# embeddings are poor at similarity; this checkpoint is trained for exactly it.
MODEL_NAME = os.getenv(
    "PHOBERT_MODEL", "bkai-foundation-models/vietnamese-bi-encoder"
)
# Below this the "closest" entry is usually a different concept, and signing a
# wrong word is worse than fingerspelling the right one.
SIMILARITY_THRESHOLD = float(os.getenv("PHOBERT_THRESHOLD", "0.75"))

INDEX_PATH = DATA_DIR / "semantic_index.npz"

STOP_WORDS = {
    "ạ", "nhé", "nha", "ơi", "à", "ừ", "hả", "nhỉ",
    "thì", "mà", "là", "của", "cái", "đó", "này", "kia",
    "được", "bị", "rồi", "đi", "có", "không",
    "rất", "quá", "lắm",
}

_model = None
_keys: list[str] = []
_matrix: np.ndarray | None = None
_load_lock = threading.Lock()
_encode_lock = threading.Lock()
_load_error: str | None = None
_info: dict = {}


def _segment(text: str) -> str:
    """PhoBERT expects syllables of one word joined by "_"."""
    from underthesea import word_tokenize
    return word_tokenize(text, format="text")


def _tokenize(text: str) -> list[str]:
    """Split into words, multi-syllable words kept whole ("xe hơi")."""
    from underthesea import word_tokenize
    return [word.strip() for word in word_tokenize(text) if word.strip()]


def is_installed() -> bool:
    try:
        import sentence_transformers  # noqa: F401
        import underthesea  # noqa: F401
    except ImportError:
        return False
    return True


def _keys_digest(keys: list[str]) -> str:
    raw = (MODEL_NAME + "\n" + "\n".join(keys)).encode("utf-8")
    return hashlib.sha1(raw).hexdigest()


def load() -> None:
    """Load the model and the dictionary embeddings. Raises RuntimeError."""
    global _model, _keys, _matrix, _load_error, _info
    if _matrix is not None:
        return
    with _load_lock:
        if _matrix is not None:
            return
        try:
            import torch
            from sentence_transformers import SentenceTransformer
        except ImportError as error:
            _load_error = "sentence-transformers / underthesea chưa được cài."
            raise RuntimeError(_load_error) from error

        started = time.monotonic()
        sign_dict.load()
        device = "cuda" if torch.cuda.is_available() else "cpu"
        try:
            model = SentenceTransformer(MODEL_NAME, device=device)
        except Exception as error:  # noqa: BLE001 - download, disk, CUDA
            _load_error = f"Không nạp được model PhoBERT: {error}"
            raise RuntimeError(_load_error) from error

        keys = sorted(sign_dict.vi_to_gloss.keys())
        digest = _keys_digest(keys)
        matrix = None

        # Encoding ~1.8k entries costs seconds on GPU and a minute on CPU, and
        # the dictionary rarely changes, so the result is kept on disk.
        if INDEX_PATH.exists():
            try:
                cached = np.load(INDEX_PATH, allow_pickle=False)
                if str(cached["digest"]) == digest:
                    matrix = cached["matrix"]
            except (OSError, ValueError, KeyError):
                matrix = None

        if matrix is None:
            matrix = model.encode(
                [_segment(key) for key in keys],
                batch_size=128,
                normalize_embeddings=True,
                convert_to_numpy=True,
                show_progress_bar=False,
            ).astype(np.float32)
            temporary = INDEX_PATH.with_name(INDEX_PATH.stem + ".tmp.npz")
            np.savez(temporary, matrix=matrix, digest=np.array(digest))
            temporary.replace(INDEX_PATH)

        _model = model
        _keys = keys
        _matrix = matrix
        _load_error = None
        _info = {
            "model": MODEL_NAME,
            "device": device,
            "entries": len(keys),
            "threshold": SIMILARITY_THRESHOLD,
            "load_seconds": round(time.monotonic() - started, 1),
        }
        print(f"[LocalNLP] PhoBERT ready: {_info}")


def status() -> dict:
    return {
        "installed": is_installed(),
        "loaded": _matrix is not None,
        "error": _load_error,
        **_info,
    }


def nearest(words: list[str]) -> list[tuple[str, float] | None]:
    """Closest dictionary entry for each word, or None under the threshold."""
    if not words:
        return []
    load()
    with _encode_lock:
        queries = _model.encode(
            [_segment(word) for word in words],
            normalize_embeddings=True,
            convert_to_numpy=True,
            show_progress_bar=False,
        )
    scores = queries @ _matrix.T
    results: list[tuple[str, float] | None] = []
    for row in scores:
        best = int(row.argmax())
        score = float(row[best])
        results.append((_keys[best], score) if score >= SIMILARITY_THRESHOLD else None)
    return results


def parse(text: str) -> list[dict]:
    """Parse text into sign tokens without any network call.

    Same token shape as the rest of the pipeline: {vi, gloss, found}, plus
    `match: "semantic"` and `matched_vi` when the gloss came from similarity.
    """
    words = [w for w in _tokenize(text.lower()) if w not in STOP_WORDS or sign_dict.lookup_vietnamese(w)]

    tokens: list[dict | None] = []
    misses: list[tuple[int, str]] = []
    for word in words:
        direct = sign_dict.lookup_vietnamese(word)
        if direct:
            tokens.append(direct)
            continue
        sub_tokens = sign_dict.longest_match_tokenize(word)
        if sub_tokens and all(token["found"] for token in sub_tokens):
            tokens.extend(sub_tokens)
            continue
        if any(ch.isalpha() for ch in word):
            misses.append((len(tokens), word))
        tokens.append({"vi": word, "gloss": None, "found": False})

    if misses:
        matches = nearest([word for _, word in misses])
        for (position, word), match in zip(misses, matches):
            if not match:
                continue
            matched_vi, score = match
            tokens[position] = {
                "vi": word,
                "gloss": sign_dict.vi_to_gloss[matched_vi],
                "found": True,
                "match": "semantic",
                "matched_vi": matched_vi,
                "score": round(score, 3),
            }

    return [token for token in tokens if token]
