"""Precompute smooth per-sign landmark files for fast animation playback."""

import argparse
import json
import sys
from pathlib import Path

from tqdm import tqdm

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.api.landmark_processing import process_landmark_entry


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--input",
        type=Path,
        default=ROOT / "data" / "processed" / "sign_dictionary_landmarks.json",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "data" / "processed" / "landmarks_v2",
    )
    parser.add_argument("--cutoff", type=float, default=7.0)
    parser.add_argument("--max-gap", type=int, default=4)
    parser.add_argument("--gloss", action="append")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    args.output.mkdir(parents=True, exist_ok=True)
    with args.input.open("r", encoding="utf-8") as source:
        dictionary = json.load(source)

    entries = dictionary.items()
    if args.gloss:
        requested = {gloss.lower() for gloss in args.gloss}
        entries = ((gloss, entry) for gloss, entry in entries if gloss.lower() in requested)

    for gloss, entry in tqdm(entries, desc="Smoothing landmarks"):
        destination = args.output / f"{gloss.lower()}.json"
        if destination.exists() and not args.force:
            continue
        processed = process_landmark_entry(
            entry,
            cutoff_hz=args.cutoff,
            max_gap=args.max_gap,
        )
        temporary = destination.with_suffix(".tmp")
        temporary.write_text(
            json.dumps(processed, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        temporary.replace(destination)


if __name__ == "__main__":
    main()
