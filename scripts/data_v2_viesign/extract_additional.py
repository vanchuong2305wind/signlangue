"""Extract only the additional Kaggle-labeled videos into an isolated output."""

from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from app.api.viesign_dataset import DATA_DIR, normalize_word
from scripts.data_v2_viesign import extract_original as pipeline

MANIFEST = ROOT / "data_v2" / "annotations" / "viesign_missing_labels.csv"
OUTPUT = ROOT / "data_v2" / "processed_additional"


def validate_annotations(source, manifest):
    with (source / "ISLR_447_all_rows.csv").open(encoding="utf-8-sig", newline="") as handle:
        original = list(csv.DictReader(handle))
    original_ids = {row["ID_video"] for row in original}
    original_words = {normalize_word(row["Meaning"]) for row in original}
    with manifest.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        required = {"ID_video", "Meaning", "Source_dataset", "Source_version", "Source_label",
                    "Source_url", "Match_method", "Review_status"}
        if not required.issubset(reader.fieldnames or []):
            raise ValueError("Additional manifest is missing label provenance columns")
        rows = list(reader)
    if not rows:
        raise ValueError("Additional manifest is empty")
    ids = [row["ID_video"] for row in rows]
    if len(ids) != len(set(ids)):
        raise ValueError("Additional manifest contains duplicate video IDs")
    if original_ids.intersection(ids):
        raise ValueError("Additional manifest overlaps the original video's IDs")
    if original_words.intersection(normalize_word(row["Meaning"]) for row in rows):
        raise ValueError("Additional manifest overlaps the original Vietnamese meanings")
    for row in rows:
        if row["Match_method"] != "exact_video_id" or not row["Review_status"]:
            raise ValueError("Additional label is missing its matching/review status")
        if normalize_word(row["Source_label"]) != normalize_word(row["Meaning"]):
            raise ValueError(f"Additional label differs from source: {row['ID_video']}")
    # Resolve actual videos under the selected server/local dataset root. The
    # local-only Video_path column is deliberately never used for extraction.
    return pipeline.read_groups(source, manifest)


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--manifest", type=Path, default=MANIFEST)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--model", type=Path, default=pipeline.MODEL_PATH)
    parser.add_argument("--max-fps", type=float, default=25)
    parser.add_argument("--max-width", type=int, default=960)
    parser.add_argument("--min-coverage", type=float, default=.35)
    parser.add_argument("--word", action="append")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--plan", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    args.manifest = args.manifest.resolve()
    args.output = args.output.resolve()
    args.source = pipeline.discover_source(args.source)
    if not args.manifest.is_relative_to(ROOT):
        parser.error("Annotation manifest must stay within the project")
    if args.output == DATA_DIR.resolve() or DATA_DIR.resolve() in args.output.parents:
        parser.error("Additional extraction must not write to the original output")
    if (args.word or args.limit) and args.output == OUTPUT.resolve():
        parser.error("Subset runs require a separate --output")
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be positive")
    groups, _, videos = validate_annotations(args.source, args.manifest)
    print(f"Additional input validated: {len(groups)} meanings / {videos} videos; original output untouched.", flush=True)
    pipeline.build(args)


if __name__ == "__main__":
    main()
