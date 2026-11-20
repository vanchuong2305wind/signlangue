"""Wait for both isolated extraction jobs, validate, then atomically activate a merge.

No source catalog is modified. A completed release and active_dataset.json are
published only after every selected landmark file passes validation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
import sys
import time
import uuid
from contextlib import ExitStack
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from app.api.viesign_dataset import ACTIVE_DATASET_PATH, DATA_DIR, DATASET_ID, atomic_json, normalize_word, word_id
from scripts.data_v2_viesign.extract_original import exclusive_lock, make_catalog_entry, now

ADDITIONAL = ROOT / "data_v2" / "processed_additional"
MERGED = ROOT / "data_v2" / "processed_merged"
FINISHED = {"complete", "complete_with_failures"}


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def waiting_reasons(inputs):
    reasons = []
    for source in inputs:
        progress = source / "progress.json"
        if not progress.is_file():
            reasons.append(f"{source.name}: no progress file yet")
            continue
        status = read_json(progress).get("status")
        if status not in FINISHED:
            reasons.append(f"{source.name}: {status}")
    return reasons


def validate_clip(path, identifier, entry):
    clip = read_json(path)
    meaning = normalize_word(entry["vi"])
    if (identifier != word_id(meaning) or clip.get("gloss") != identifier
            or normalize_word(clip.get("meaning", "")) != meaning
            or clip.get("dataset") != DATASET_ID or clip.get("schema_version") != 3
            or clip.get("video_id") != entry["video_id"]
            or clip.get("source_video") != entry["source_video"]):
        raise ValueError(f"Landmark/catalog identity mismatch: {path}")
    frames = clip.get("frames")
    if not isinstance(frames, list) or not frames:
        raise ValueError(f"Empty landmark frames: {path}")
    fps = float(clip.get("fps", 0))
    if not math.isfinite(fps) or fps <= 0 or not math.isfinite(float(clip.get("score", 0))):
        raise ValueError(f"Invalid FPS/score: {path}")
    for frame in frames:
        if not isinstance(frame, dict):
            raise ValueError(f"Invalid frame: {path}")
        for track, count in (("pose", 33), ("pose_world", 33), ("left_hand", 21), ("right_hand", 21)):
            if frame.get(track):
                if len(frame[track]) != count:
                    raise ValueError(f"Invalid {track} size: {path}")
                if any(not math.isfinite(float(point[axis])) for point in frame[track] for axis in ("x", "y", "z")):
                    raise ValueError(f"Non-finite landmark coordinates: {path}")
    if not any(frame.get("pose_world") and (frame.get("left_hand") or frame.get("right_hand")) for frame in frames):
        raise ValueError(f"No body/hand frames: {path}")
    video = (ROOT / clip["source_video"]).resolve()
    if (not video.is_relative_to((ROOT / "data_v2").resolve()) or not video.is_file()
            or Path(clip["source_video"]).stem != clip["video_id"]):
        raise ValueError(f"Source video missing or outside data_v2: {path}")
    return clip


def merge_once(inputs, output, pointer=ACTIVE_DATASET_PATH):
    """Return None until ready; hold all source locks while constructing a release."""
    if waiting_reasons(inputs):
        return None
    output.mkdir(parents=True, exist_ok=True)
    with ExitStack() as locks:
        for source in sorted(inputs):
            locks.enter_context(exclusive_lock(source))
        if waiting_reasons(inputs):
            return None
        catalogs = []
        input_digest = hashlib.sha256()
        for source in inputs:
            raw = (source / "catalog.json").read_bytes()
            input_digest.update(str(source.relative_to(ROOT)).encode())
            input_digest.update(raw)
            catalog = json.loads(raw)
            if catalog.get("dataset") != DATASET_ID:
                raise ValueError("Refusing to merge non-VieSign data")
            catalogs.append(catalog)
        digest = input_digest.hexdigest()
        release = output / f"release-{digest[:20]}"
        if release.is_dir():
            report = read_json(release / "merge_report.json")
            if report.get("input_digest") != digest:
                raise ValueError("Existing release digest mismatch")
            for identifier, entry in read_json(release / "catalog.json")["entries"].items():
                validate_clip(release / "landmarks" / f"{identifier}.json", identifier, entry)
        else:
            winners, video_meanings, duplicates = {}, {}, []
            input_stats = []
            for source, catalog in zip(inputs, catalogs):
                progress = read_json(source / "progress.json")
                input_stats.append({"directory": source.relative_to(ROOT).as_posix(),
                                    "status": progress["status"], "expected_words": catalog["expected_words"],
                                    "published_words": len(catalog["entries"]),
                                    "failed_words": progress.get("failed_words", 0)})
                for identifier, entry in catalog["entries"].items():
                    # ID validation happens before constructing/reading its file path.
                    meaning = normalize_word(entry["vi"])
                    if identifier != word_id(meaning):
                        raise ValueError("Invalid ID in source catalog")
                    path = source / "landmarks" / f"{identifier}.json"
                    clip = validate_clip(path, identifier, entry)
                    video_id = clip["video_id"]
                    if video_id in video_meanings and video_meanings[video_id] != meaning:
                        raise ValueError(f"One video assigned conflicting meanings: {video_id}")
                    video_meanings[video_id] = meaning
                    chosen = winners.get(meaning)
                    candidate = {"path": path, "entry": make_catalog_entry(clip)}
                    if chosen:
                        duplicates.append(meaning)
                    if chosen is None or candidate["entry"]["score"] > chosen["entry"]["score"]:
                        winners[meaning] = candidate
            if not winners:
                raise ValueError("No usable landmark files to merge")
            required_bytes = sum(item["path"].stat().st_size for item in winners.values())
            if shutil.disk_usage(output).free < required_bytes + 10_000_000:
                raise ValueError("Insufficient space for an independent merged copy")
            staging = output / f".building-{uuid.uuid4().hex}"
            staging.mkdir()
            (staging / "landmarks").mkdir()
            entries = {}
            for meaning, winner in sorted(winners.items()):
                identifier = word_id(meaning)
                destination = staging / "landmarks" / f"{identifier}.json"
                shutil.copyfile(winner["path"], destination)
                # The output is a separate copy: later retries cannot alter it.
                validate_clip(destination, identifier, winner["entry"])
                entries[identifier] = winner["entry"]
            catalog = {"dataset": DATASET_ID, "entries": entries, "updated_at": now(),
                       "expected_words": sum(c["expected_words"] for c in catalogs) - len(duplicates),
                       "merged_from": input_stats, "input_digest": digest}
            pending = sum(entry.get("annotation", {}).get("Review_status") == "pending_video_verification"
                          for entry in entries.values())
            report = {"status": "complete", "input_digest": digest, "inputs": input_stats,
                      "merged_words": len(entries), "duplicate_meanings_resolved": sorted(set(duplicates)),
                      "labels_pending_video_verification": pending, "finished_at": now(),
                      "release_directory": release.relative_to(ROOT).as_posix()}
            atomic_json(staging / "catalog.json", catalog)
            atomic_json(staging / "merge_report.json", report)
            staging.rename(release)
        # Only this last atomic write switches consumers to the fully checked release.
        atomic_json(pointer, {"dataset": DATASET_ID, "directory": release.relative_to(ROOT).as_posix(),
                              "input_digest": digest, "activated_at": now()})
        return report


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--original", type=Path, default=DATA_DIR)
    parser.add_argument("--additional", type=Path, default=ADDITIONAL)
    parser.add_argument("--output", type=Path, default=MERGED)
    parser.add_argument("--wait", action="store_true")
    parser.add_argument("--interval", type=float, default=30)
    args = parser.parse_args()
    inputs = [args.original.resolve(), args.additional.resolve()]
    output = args.output.resolve()
    data_root = (ROOT / "data_v2").resolve()
    paths = [*inputs, output]
    if any(not p.is_relative_to(data_root) for p in paths):
        parser.error("All merge directories must stay under data_v2")
    if len(set(paths)) != 3 or any(a in b.parents or b in a.parents for i, a in enumerate(paths) for b in paths[i+1:]):
        parser.error("Input and output directories must be separate, non-nested directories")
    if args.interval < 1:
        parser.error("--interval must be at least 1 second")
    with exclusive_lock(output):
        try:
            while True:
                reasons = waiting_reasons(inputs)
                if not reasons:
                    try:
                        report = merge_once(inputs, output)
                    except RuntimeError as error:
                        if "already running" not in str(error):
                            raise
                        reasons = ["A source extraction still holds its output lock"]
                    else:
                        if report is not None:
                            atomic_json(output / "progress.json", report)
                            print(json.dumps(report, ensure_ascii=False), flush=True)
                            return
                state = {"status": "waiting", "reasons": reasons, "updated_at": now()}
                atomic_json(output / "progress.json", state)
                print(json.dumps(state, ensure_ascii=False), flush=True)
                if not args.wait:
                    return
                time.sleep(args.interval)
        except BaseException as error:
            atomic_json(output / "progress.json", {"status": "error", "error": str(error), "updated_at": now()})
            raise


if __name__ == "__main__":
    main()
