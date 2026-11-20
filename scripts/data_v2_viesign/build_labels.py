"""Recover candidate labels for locally unlabeled videos using Kaggle metadata.

Matches video IDs, not video contents. Keeps annotations separate from the
original manifest and extraction catalog; no server job or model is modified.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import shutil
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from app.api.viesign_dataset import normalize_word, word_id
from scripts.data_v2_viesign.extract_original import discover_source

OUTPUT = ROOT / "data_v2" / "annotations"
SOURCE_URL = "https://www.kaggle.com/datasets/aresusayhi/vsl-vietnamese-sign-languages/data"
SOURCE_VERSION = 5


def read_csv(path):
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def write_csv(path, columns, rows):
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        writer.writerows(rows)


def build(dataset_root, label_path, output):
    original_manifest = dataset_root / "ISLR_447_all_rows.csv"
    original_rows = read_csv(original_manifest)
    original_ids = {row["ID_video"] for row in original_rows}
    original_meanings = {normalize_word(row["Meaning"]) for row in original_rows}
    source_labels = read_csv(label_path)
    if not source_labels or not {"ID", "VIDEO", "LABEL"}.issubset(source_labels[0]):
        raise ValueError("Kaggle CSV must contain ID, VIDEO, LABEL")
    source_by_id = {}
    for row in source_labels:
        identifier = Path(row["VIDEO"]).stem
        meaning = normalize_word(row["LABEL"])
        if not identifier or not meaning:
            raise ValueError("Blank video ID or label in Kaggle source")
        if identifier in source_by_id:
            previous = normalize_word(source_by_id[identifier]["LABEL"])
            if previous != meaning:
                raise ValueError(f"Conflicting Kaggle labels for {identifier}")
        source_by_id[identifier] = row

    videos = {}
    for path in sorted((dataset_root / "video_raw").iterdir()):
        if path.is_file() and path.suffix.lower() in {".mp4", ".webm"}:
            if path.stem in videos:
                raise ValueError(f"Duplicate local video ID: {path.stem}")
            videos[path.stem] = path
    missing_original = original_ids - set(videos)
    if missing_original:
        raise ValueError(f"Incomplete dataset copy: {len(missing_original)} original videos missing")

    annotations, remaining, groups = [], [], defaultdict(list)
    for identifier in sorted(set(videos) - original_ids):
        path = videos[identifier]
        local_path = path.relative_to(ROOT).as_posix()
        if identifier not in source_by_id:
            remaining.append({"ID_video": identifier, "Video_filename": path.name,
                              "Video_path": local_path, "Review_status": "no_source_label"})
            continue
        source = source_by_id[identifier]
        meaning = normalize_word(source["LABEL"])
        annotations.append({
            "ID_video": identifier,
            "Meaning": meaning,
            "Word_id": word_id(meaning),
            "Video_filename": path.name,
            "Video_path": local_path,
            "Source_video": source["VIDEO"],
            "Source_label": source["LABEL"],
            "Source_row_id": source["ID"],
            "Source_dataset": "aresusayhi/vsl-vietnamese-sign-languages",
            "Source_version": SOURCE_VERSION,
            "Source_url": SOURCE_URL,
            "Match_method": "exact_video_id",
            "Review_status": "pending_video_verification",
            "Meaning_in_original_manifest": str(meaning in original_meanings).lower(),
        })
        groups[meaning].append(identifier)

    word_groups = [
        {"Word_id": word_id(meaning), "Meaning": meaning, "Video_count": len(ids),
         "Video_ids": " | ".join(ids),
         "Meaning_in_original_manifest": str(meaning in original_meanings).lower(),
         "Review_status": "pending_video_verification"}
        for meaning, ids in sorted(groups.items())
    ]
    matched_ids = {row["ID_video"] for row in annotations}
    remaining_ids = {row["ID_video"] for row in remaining}
    assert len(matched_ids) == len(annotations)
    assert matched_ids.isdisjoint(original_ids)
    assert matched_ids.isdisjoint(remaining_ids)
    assert matched_ids | remaining_ids == set(videos) - original_ids
    assert len(word_groups) == len({row["Word_id"] for row in word_groups})

    output.mkdir(parents=True, exist_ok=True)
    source_copy = output / "sources" / "kaggle_qipedc_v5_label.csv"
    source_copy.parent.mkdir(parents=True, exist_ok=True)
    if source_copy.resolve() != label_path.resolve():
        shutil.copyfile(label_path, source_copy)
    write_csv(output / "viesign_missing_labels.csv", [
        "ID_video", "Meaning", "Word_id", "Video_filename", "Video_path", "Source_video",
        "Source_label", "Source_row_id", "Source_dataset", "Source_version", "Source_url",
        "Match_method", "Review_status", "Meaning_in_original_manifest",
    ], annotations)
    write_csv(output / "viesign_label_groups.csv", [
        "Word_id", "Meaning", "Video_count", "Video_ids", "Meaning_in_original_manifest", "Review_status",
    ], word_groups)
    write_csv(output / "viesign_unlabeled_remaining.csv", [
        "ID_video", "Video_filename", "Video_path", "Review_status",
    ], remaining)
    summary = {
        "created_at": datetime.now(timezone(timedelta(hours=7))).isoformat(),
        "dataset_root": dataset_root.relative_to(ROOT).as_posix(),
        "original_manifest": original_manifest.relative_to(ROOT).as_posix(),
        "original_manifest_sha256": hashlib.sha256(original_manifest.read_bytes()).hexdigest(),
        "source_url": SOURCE_URL,
        "source_version": SOURCE_VERSION,
        "source_label_csv_sha256": hashlib.sha256(label_path.read_bytes()).hexdigest(),
        "source_label_rows": len(source_labels),
        "original_labeled_videos": len(original_ids),
        "original_normalized_meanings": len(original_meanings),
        "local_videos": len(videos),
        "previously_unlabeled_videos": len(set(videos) - original_ids),
        "new_annotation_rows": len(annotations),
        "normalized_meanings_in_annotations": len(groups),
        "meanings_already_in_original_manifest": len(set(groups) & original_meanings),
        "meanings_not_in_original_manifest": len(set(groups) - original_meanings),
        "videos_still_without_label": len(remaining),
        "review_status": "pending_video_verification",
        "identity_check": "Matching filename stems only; clip contents not verified",
        "automatic_extraction_import": False,
    }
    (output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    # Check the saved files, not only the in-memory records.
    saved = read_csv(output / "viesign_missing_labels.csv")
    assert len(saved) == len(annotations)
    assert {row["ID_video"] for row in saved} == matched_ids
    assert all(row["Meaning"] == normalize_word(row["Source_label"]) for row in saved)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="Kaggle label.csv; default is the included source snapshot")
    parser.add_argument("--dataset-root", type=Path, help="Auto-detect fullest VieSign copy by default")
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()
    label_path = args.source or (OUTPUT / "sources" / "kaggle_qipedc_v5_label.csv")
    if not label_path.is_file():
        parser.error("Supply --source pointing to the Kaggle label.csv")
    build(discover_source(args.dataset_root), label_path, args.output)


if __name__ == "__main__":
    main()
