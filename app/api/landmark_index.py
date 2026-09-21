"""
landmark_index.py
Byte-offset index over the ~446 MB `sign_dictionary_landmarks.json`.

The file is a flat `{"<gloss>": {...}, ...}` object pretty-printed with a
two-space indent, so every top-level key starts a line as `  "<gloss>": {`.
Scanning for those lines gives a (start, end) byte range per gloss, which
lets a single entry be read with one seek instead of parsing the whole file.

Reading the entry costs ~10 ms; `json.load` on the whole file costs 5-15 s
and ~1.5 GB of RAM.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

# `  "gloss": {` at the start of a line — the only place a top-level key appears.
_KEY_LINE = re.compile(rb'^  "([^"]*)": \{', re.MULTILINE)

_CHUNK = 8 << 20  # 8 MB


def build_index(source: Path) -> dict[str, list[int]]:
    """Scan the file once and return {gloss: [start, end]} byte offsets."""
    starts: list[tuple[int, str]] = []
    overlap = b""
    position = 0

    with source.open("rb") as handle:
        while True:
            chunk = handle.read(_CHUNK)
            if not chunk:
                break
            buffer = overlap + chunk
            base = position - len(overlap)
            for match in _KEY_LINE.finditer(buffer):
                # A match inside the overlap region was already recorded.
                offset = base + match.start()
                if starts and offset <= starts[-1][0]:
                    continue
                gloss = match.group(1).decode("utf-8")
                starts.append((offset, gloss))
            position += len(chunk)
            # Keep enough tail to catch a key line split across two chunks.
            overlap = buffer[-512:]

    file_size = source.stat().st_size

    # The last entry runs to EOF, which also holds the outer object's closing
    # brace. Stop just before it so the slice is one entry and nothing more.
    last_end = file_size
    with source.open("rb") as handle:
        handle.seek(max(0, file_size - 64))
        tail = handle.read()
    closing = tail.rfind(b"}")
    if closing != -1:
        last_end = max(0, file_size - 64) + closing

    index: dict[str, list[int]] = {}
    for position_in_list, (offset, gloss) in enumerate(starts):
        end = (
            starts[position_in_list + 1][0]
            if position_in_list + 1 < len(starts)
            else last_end
        )
        index[gloss] = [offset, end]
    return index


def load_or_build(source: Path, index_path: Path) -> dict[str, list[int]]:
    """Return the cached index, rebuilding it when missing or stale."""
    if index_path.exists():
        try:
            with index_path.open("r", encoding="utf-8") as handle:
                cached = json.load(handle)
            if cached.get("size") == source.stat().st_size:
                return cached["offsets"]
        except (OSError, ValueError, KeyError, AttributeError):
            pass

    offsets = build_index(source)
    index_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = index_path.with_suffix(".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(
            {"size": source.stat().st_size, "offsets": offsets},
            handle,
            separators=(",", ":"),
        )
    temporary.replace(index_path)
    return offsets


def read_entry(source: Path, span: list[int]) -> dict:
    """Read and parse one gloss entry from its byte range."""
    start, end = span
    with source.open("rb") as handle:
        handle.seek(start)
        raw = handle.read(end - start)

    # The slice looks like `  "gloss": { ... }` plus a trailing comma/newline.
    # Wrapping it in braces makes it a parsable one-key object.
    text = raw.decode("utf-8").rstrip().rstrip(",")
    return json.loads("{" + text + "}")
