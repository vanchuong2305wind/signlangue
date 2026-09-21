"""
build_landmark_cache.py
Keep `data/processed/landmarks_v2/` complete and compact.

Two jobs, both aimed at the same latency problem:

  fill      Create a cached file for every gloss that has none. Without this,
            the first request for an uncached gloss makes the server
            `json.load` the 446 MB `sign_dictionary_landmarks.json` — 5-15 s of
            blocked event loop and ~1.5 GB of RAM.

  reencode  Rewrite existing cached files with only the tracks the avatar reads
            and coordinates rounded to 4 decimals, which roughly halves them.
            Smoothing is NOT re-applied, so the files keep the richer pose and
            blendshape data they were originally built with.

Usage:
    python -m scripts.build_landmark_cache              # fill + reencode
    python -m scripts.build_landmark_cache --fill-only
    python -m scripts.build_landmark_cache --reencode-only
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.api.landmark_index import load_or_build, read_entry  # noqa: E402
from app.api.landmark_processing import (  # noqa: E402
    SCHEMA_VERSION,
    process_landmark_entry,
    slim_entry,
)

DATA_DIR = ROOT / "data" / "processed"
SOURCE = DATA_DIR / "sign_dictionary_landmarks.json"
INDEX_PATH = DATA_DIR / "landmarks_offsets.json"
OUTPUT_DIR = DATA_DIR / "landmarks_v2"


def write_json(destination: Path, data: dict) -> int:
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    temporary = destination.with_suffix(".tmp")
    temporary.write_text(payload, encoding="utf-8")
    temporary.replace(destination)
    return len(payload)


def is_current(path: Path) -> bool:
    """True when the cached file already uses the latest schema."""
    try:
        with path.open("r", encoding="utf-8") as handle:
            head = handle.read(512)
    except OSError:
        return False
    return f'"schema_version":{SCHEMA_VERSION}' in head.replace(" ", "")


def reencode_existing() -> None:
    """Shrink cached files in place. Never touches the 446 MB source."""
    paths = sorted(OUTPUT_DIR.glob("*.json"))
    print(f"[reencode] {len(paths)} cached files")

    changed = skipped = failed = 0
    before = after = 0
    started = time.perf_counter()

    for path in paths:
        if is_current(path):
            skipped += 1
            continue
        original_size = path.stat().st_size
        try:
            with path.open("r", encoding="utf-8") as handle:
                data = json.load(handle)
            written = write_json(path, slim_entry(data))
        except (OSError, ValueError) as error:
            print(f"[reencode] FAILED {path.name}: {error}")
            failed += 1
            continue
        before += original_size
        after += written
        changed += 1

    elapsed = time.perf_counter() - started
    print(f"[reencode] Done in {elapsed:.1f}s — changed={changed} "
          f"skipped={skipped} failed={failed}")
    if changed:
        print(f"[reencode] {before / 1e6:.0f} MB -> {after / 1e6:.0f} MB "
              f"({after / before * 100:.0f}%)")


def fill_missing() -> None:
    """Build cached files for glosses that have none, from the source file."""
    if not SOURCE.exists():
        print(f"[fill] Source not found, skipping: {SOURCE}")
        return

    print(f"[fill] Indexing {SOURCE.name} ({SOURCE.stat().st_size / 1e6:.0f} MB)...")
    started = time.perf_counter()
    offsets = load_or_build(SOURCE, INDEX_PATH)
    print(f"[fill] Indexed {len(offsets)} glosses in {time.perf_counter() - started:.1f}s")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    missing = [gloss for gloss in sorted(offsets)
               if not (OUTPUT_DIR / f"{gloss}.json").exists()]
    print(f"[fill] {len(missing)} glosses have no cached file")

    written = failed = 0
    started = time.perf_counter()
    for gloss in missing:
        try:
            entry = read_entry(SOURCE, offsets[gloss])[gloss]
            write_json(OUTPUT_DIR / f"{gloss}.json", process_landmark_entry(entry))
        except (OSError, ValueError, KeyError) as error:
            print(f"[fill] FAILED {gloss}: {error}")
            failed += 1
            continue
        written += 1

    print(f"[fill] Done in {time.perf_counter() - started:.1f}s — "
          f"written={written} failed={failed}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fill-only", action="store_true")
    parser.add_argument("--reencode-only", action="store_true")
    args = parser.parse_args()

    if not args.reencode_only:
        fill_missing()
    if not args.fill_only:
        reencode_existing()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
