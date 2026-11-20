"""Build one avatar-ready landmark clip per Vietnamese meaning, without ASL.

Run --help. Intermediate progress is atomic and resumable; only clips with both
body and hand detections are published in catalog.json. No network service/port.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import sys
import time
import urllib.request
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from app.api.landmark_processing import process_landmark_entry
from app.api.viesign_dataset import DATA_DIR, DATASET_ID, PIPELINE_VERSION, atomic_json, normalize_word, word_id

MODEL_URL = ("https://storage.googleapis.com/mediapipe-models/holistic_landmarker/"
             "holistic_landmarker/float16/1/holistic_landmarker.task")
MODEL_PATH = ROOT / "data_v2" / "models" / "holistic_landmarker.task"
MODEL_SHA256 = "e2dab61191e2dcd0a15f943d8e3ed1dce13c82dfa597b9dd39f562975a50c3f8"
VIDEO_EXTENSIONS = {".mp4", ".webm"}


def now():
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def exclusive_lock(output):
    """OS lock releases even after a crash; never kills an existing extractor."""
    output.mkdir(parents=True, exist_ok=True)
    with (output / "extraction.lock").open("a+b") as handle:
        if os.name == "nt":
            import msvcrt
            try:
                handle.seek(0)
                if not handle.read(1):
                    handle.write(b"0"); handle.flush()
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as error:
                raise RuntimeError("Extraction already running for this output directory") from error
        else:
            import fcntl
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise RuntimeError("Extraction already running for this output directory") from error
        try:
            yield
        finally:
            if os.name == "nt":
                handle.seek(0); msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


def discover_source(explicit=None):
    if explicit:
        source = Path(explicit).resolve()
        if not (source / "ISLR_447_all_rows.csv").is_file() or not (source / "video_raw").is_dir():
            raise ValueError("--source must contain ISLR_447_all_rows.csv and video_raw/")
        return source
    candidates = []
    for manifest in (ROOT / "data_v2").rglob("ISLR_447_all_rows.csv"):
        videos = manifest.parent / "video_raw"
        if videos.is_dir():
            count = sum(p.suffix.lower() in VIDEO_EXTENSIONS for p in videos.iterdir() if p.is_file())
            candidates.append((count, manifest.parent))
    if not candidates:
        raise FileNotFoundError("No VieSign manifest + video_raw found under data_v2")
    candidates.sort(key=lambda item: (-item[0], str(item[1])))
    if len(candidates) > 1 and candidates[0][0] == candidates[1][0]:
        raise ValueError("Ambiguous dataset copies; specify --source explicitly")
    return candidates[0][1]


def read_groups(source, manifest=None):
    files = {}
    for path in sorted((source / "video_raw").iterdir()):
        if path.is_file() and path.suffix.lower() in VIDEO_EXTENSIONS:
            if path.stem in files:
                raise ValueError(f"Multiple files for video ID {path.stem}")
            if not path.resolve().is_relative_to(ROOT):
                raise ValueError("Video path leaves project")
            files[path.stem] = path
    groups, seen_ids, missing = {}, {}, []
    manifest_path = manifest or (source / "ISLR_447_all_rows.csv")
    with manifest_path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        required = {"ID_video", "Meaning"}
        if manifest is None:
            required.add("Signer")
        if not required.issubset(reader.fieldnames or []):
            raise ValueError(f"Missing required manifest columns: {required}")
        for row in reader:
            meaning = normalize_word(row["Meaning"])
            video_id = row["ID_video"].strip()
            if not meaning or not video_id:
                raise ValueError("Blank meaning or video ID in source manifest")
            if video_id in seen_ids:
                if seen_ids[video_id] != meaning:
                    raise ValueError(f"Conflicting meanings for {video_id}")
                continue
            seen_ids[video_id] = meaning
            if video_id not in files:
                missing.append(video_id)
                continue
            groups.setdefault(meaning, []).append({"Signer": None, **row, "path": files[video_id]})
    if missing:
        raise ValueError(f"Source copy is incomplete: {len(missing)} labeled videos missing, e.g. {missing[:5]}")
    identifiers = [word_id(word) for word in groups]
    if len(identifiers) != len(set(identifiers)):
        raise ValueError("Meaning identifier collision")
    # Compare every labeled candidate, including short/long videos, with a deterministic tie-break.
    for candidates in groups.values():
        candidates.sort(key=lambda row: row["ID_video"])
    return dict(sorted(groups.items())), len(files), len(seen_ids)


def ensure_model(path):
    if path.is_file() and path.stat().st_size > 1_000_000:
        if hashlib.sha256(path.read_bytes()).hexdigest() != MODEL_SHA256:
            raise ValueError(f"Model checksum mismatch: {path}")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".download")
    print(f"Downloading official Holistic model: {MODEL_URL}", flush=True)
    try:
        with urllib.request.urlopen(MODEL_URL, timeout=90) as response, temporary.open("wb") as handle:
            while block := response.read(1 << 20):
                handle.write(block)
        if hashlib.sha256(temporary.read_bytes()).hexdigest() != MODEL_SHA256:
            raise ValueError("Downloaded model checksum mismatch")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def json_points(points):
    if not points:
        return None
    if hasattr(points, "landmark"):
        points = points.landmark
    return [{"x": float(p.x), "y": float(p.y), "z": float(p.z)} for p in points]


def measure_coverage(frames):
    n = max(len(frames), 1)
    rates = {name: sum(bool(f.get(name)) for f in frames) / n
             for name in ("pose", "pose_world", "left_hand", "right_hand", "face_blendshapes")}
    rates["any_hand"] = sum(bool(f.get("left_hand")) or bool(f.get("right_hand")) for f in frames) / n
    rates["both_hands"] = sum(bool(f.get("left_hand")) and bool(f.get("right_hand")) for f in frames) / n
    rates["body_and_hand"] = sum(bool(f.get("pose_world")) and
                                    (bool(f.get("left_hand")) or bool(f.get("right_hand"))) for f in frames) / n
    return rates


def extract_clip(path, model_path, max_fps=25.0, max_width=960):
    import cv2
    import mediapipe as mp
    cv2.setNumThreads(1)
    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        capture.release()
        raise ValueError("OpenCV cannot open video")
    source_fps = float(capture.get(cv2.CAP_PROP_FPS))
    if not math.isfinite(source_fps) or source_fps <= 0:
        capture.release()
        raise ValueError("Invalid source FPS")
    # Uniform stride keeps real clip duration; do not relabel 30fps frames as 25fps.
    stride = max(1, math.ceil(source_fps / max_fps))
    fps = source_fps / stride
    options = mp.tasks.vision.HolisticLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(model_path)),
        running_mode=mp.tasks.vision.RunningMode.VIDEO,
        output_face_blendshapes=True,
    )
    frames, index, last_timestamp = [], 0, -1
    try:
        # New tracker for every video, so signer/hand state cannot leak across clips.
        with mp.tasks.vision.HolisticLandmarker.create_from_options(options) as detector:
            while True:
                ok, bgr = capture.read()
                if not ok:
                    break
                current = index
                index += 1
                if current % stride:
                    continue
                if bgr.shape[1] > max_width:
                    scale = max_width / bgr.shape[1]
                    bgr = cv2.resize(bgr, (max_width, max(1, round(bgr.shape[0] * scale))))
                rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
                timestamp = max(last_timestamp + 1, round(current * 1000 / source_fps))
                result = detector.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), timestamp)
                last_timestamp = timestamp
                shapes = result.face_blendshapes
                frames.append({
                    "pose": json_points(result.pose_landmarks),
                    "pose_world": json_points(result.pose_world_landmarks),
                    "left_hand": json_points(result.left_hand_landmarks),
                    "right_hand": json_points(result.right_hand_landmarks),
                    "face_blendshapes": {c.category_name: float(c.score) for c in shapes if c.category_name} if shapes else None,
                })
    finally:
        capture.release()
    if not frames:
        raise ValueError("No decoded frames")
    # Do not silently accept a prefix of a corrupted file with a substantial missing tail.
    probe = cv2.VideoCapture(str(path))
    declared_count = int(probe.get(cv2.CAP_PROP_FRAME_COUNT)) if probe.isOpened() else 0
    probe.release()
    if declared_count > 0 and index < declared_count * 0.95:
        raise ValueError(f"Incomplete video decode: {index}/{declared_count} frames")
    coverage = measure_coverage(frames)
    # Same tracks as the previous avatar dataset, but retain genuine sparse second-hand motion.
    # Detection coverage estimates extraction quality, not linguistic correctness.
    score = 0.45 * coverage["body_and_hand"] + 0.35 * coverage["any_hand"] + 0.15 * coverage["both_hands"] + 0.05 * coverage["face_blendshapes"]
    return {"schema_version": 3, "fps": fps, "source_fps": source_fps,
            "source_frame_count": index, "frame_stride": stride, "score": round(score, 6),
            "coverage": coverage, "frames": frames,
            "coordinate_space": "mediapipe_image_and_pose_world"}


def candidate_fingerprint(row):
    stat = row["path"].stat()
    result = {"id": row["ID_video"], "path": row["path"].relative_to(ROOT).as_posix(),
              "size": stat.st_size, "mtime_ns": stat.st_mtime_ns}
    if row.get("Source_dataset"):
        result["annotation"] = annotation_provenance(row)
    return result


def annotation_provenance(row):
    return {key: row[key] for key in (
        "Source_dataset", "Source_version", "Source_url", "Source_video", "Source_label",
        "Source_row_id", "Match_method", "Review_status",
    ) if key in row}


def build(args):
    source = discover_source(args.source)
    output = args.output.resolve()
    if not source.is_relative_to(ROOT) or not output.is_relative_to(ROOT):
        raise ValueError("Source and output must stay within this project")
    if not args.model.resolve().is_relative_to(ROOT):
        raise ValueError("Model file must stay within this project")
    manifest = getattr(args, "manifest", None)
    groups, disk_videos, labeled_videos = read_groups(source, manifest)
    if args.word:
        requested = {normalize_word(w) for w in args.word}
        absent = requested - set(groups)
        if absent:
            raise ValueError(f"Words absent from manifest: {absent}")
        groups = {word: rows for word, rows in groups.items() if word in requested}
    if args.limit:
        groups = dict(list(groups.items())[:args.limit])
    if args.plan:
        print(json.dumps({"source": str(source), "output": str(output), "words": len(groups),
                          "labeled_videos": labeled_videos, "disk_videos": disk_videos,
                          "policy": "one normalized Vietnamese meaning -> one best landmark clip; no ASL"}, ensure_ascii=False, indent=2))
        return
    if args.max_fps <= 0 or args.max_width < 64 or not 0 < args.min_coverage <= 1:
        raise ValueError("Invalid frame/coverage settings")
    with exclusive_lock(output):
        ensure_model(args.model)
        model_digest = hashlib.sha256(args.model.read_bytes()).hexdigest()
        settings = {"pipeline_version": PIPELINE_VERSION, "model_sha256": model_digest,
                    "max_fps": args.max_fps, "max_width": args.max_width, "min_coverage": args.min_coverage}
        catalog_path = output / "catalog.json"
        catalog = {"dataset": DATASET_ID, "entries": {}}
        if catalog_path.is_file():
            catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
            if catalog.get("dataset") != DATASET_ID:
                raise ValueError("Output catalog is not VieSign")
        catalog.update({"source_root": source.relative_to(ROOT).as_posix(),
                        "expected_words": len(groups), "labeled_videos": labeled_videos, "settings": settings})
        if manifest is not None:
            catalog["annotation_manifest"] = manifest.relative_to(ROOT).as_posix()
            catalog["annotation_manifest_sha256"] = hashlib.sha256(manifest.read_bytes()).hexdigest()
        atomic_json(catalog_path, catalog)
        started = time.monotonic()
        successful = failed = resumed = 0
        progress = {"status": "running", "pid": os.getpid(), "started_at": now(), "expected_words": len(groups)}
        try:
            for number, (word, candidates) in enumerate(groups.items(), 1):
                identifier = word_id(word)
                destination = output / "landmarks" / f"{identifier}.json"
                state_path = output / "state" / f"{identifier}.json"
                signature_data = {"settings": settings, "word": word,
                                  "candidates": [candidate_fingerprint(row) for row in candidates]}
                signature = hashlib.sha256(json.dumps(signature_data, sort_keys=True).encode()).hexdigest()
                state = {"signature": signature, "completed_ids": [], "attempts": [], "best": None}
                if state_path.is_file() and not args.force:
                    previous = json.loads(state_path.read_text(encoding="utf-8"))
                    if previous.get("signature") == signature:
                        state = previous
                if state.get("best") and not destination.is_file():
                    # An interrupted/manual cleanup may remove the winning file;
                    # re-evaluate candidates instead of publishing a dangling entry.
                    state = {"signature": signature, "completed_ids": [], "attempts": [], "best": None}
                if args.force or state["signature"] != signature:
                    state = {"signature": signature, "completed_ids": [], "attempts": [], "best": None}
                completed = set(state["completed_ids"])
                if state.get("complete") and destination.is_file():
                    saved = json.loads(destination.read_text(encoding="utf-8"))
                    if saved.get("meaning") == word and saved.get("pipeline_signature") == signature:
                        catalog["entries"][identifier] = make_catalog_entry(saved)
                        resumed += 1
                        continue
                # A changed signature must never reuse an older best clip.
                if state.get("best") and destination.is_file():
                    saved = json.loads(destination.read_text(encoding="utf-8"))
                    if saved.get("pipeline_signature") != signature:
                        state["best"] = None
                best_rank = tuple(state["best"]["rank"]) if state.get("best") else None
                for row in candidates:
                    video_id = row["ID_video"]
                    if video_id in completed:
                        continue
                    attempt = {"video_id": video_id}
                    try:
                        candidate = extract_clip(row["path"], args.model, args.max_fps, args.max_width)
                        coverage = candidate["coverage"]
                        usable = coverage["body_and_hand"] >= args.min_coverage
                        attempt.update({"score": candidate["score"], "coverage": coverage, "usable": usable})
                        rank = (candidate["score"], coverage["body_and_hand"], coverage["both_hands"])
                        if usable and (best_rank is None or rank > best_rank):
                            candidate.update({"dataset": DATASET_ID, "meaning": word, "gloss": identifier,
                                              "video_id": video_id, "signer": row["Signer"],
                                              "source_video": row["path"].relative_to(ROOT).as_posix(),
                                              "pipeline_signature": signature,
                                              "selection": "highest extraction coverage score among all labeled candidates"})
                            if row.get("Source_dataset"):
                                candidate["annotation"] = annotation_provenance(row)
                            processed = process_landmark_entry(candidate)
                            atomic_json(destination, processed)
                            best_rank = rank
                            state["best"] = {"video_id": video_id, "rank": rank}
                            catalog["entries"][identifier] = make_catalog_entry(processed)
                            catalog["updated_at"] = now()
                            atomic_json(catalog_path, catalog)
                    except Exception as error:
                        attempt["error"] = f"{type(error).__name__}: {error}"
                        print(f"[WARN] {word} / {video_id}: {error}", flush=True)
                    state["completed_ids"].append(video_id)
                    state["attempts"].append(attempt)
                    atomic_json(state_path, state)
                    progress.update({"word": word, "video_id": video_id, "word_number": number,
                                     "completed_words": number-1, "published_words": len(catalog["entries"]),
                                     "updated_at": now(), "elapsed_seconds": round(time.monotonic()-started)})
                    atomic_json(output / "progress.json", progress)
                state["complete"] = True
                atomic_json(state_path, state)
                if state.get("best"):
                    successful += 1
                else:
                    failed += 1
                    catalog["entries"].pop(identifier, None)
                catalog["updated_at"] = now()
                atomic_json(catalog_path, catalog)
                print(f"[{number}/{len(groups)}] {word}: {state['best']['video_id'] if state.get('best') else 'NO_USABLE_CLIP'} ({len(candidates)} candidates); published={len(catalog['entries'])}", flush=True)
            progress.update({"status": "complete" if failed == 0 else "complete_with_failures",
                             "completed_words": len(groups), "published_words": len(catalog["entries"]),
                             "successful_this_run": successful, "resumed_words": resumed, "failed_words": failed,
                             "finished_at": now()})
        except BaseException as error:
            progress.update({"status": "interrupted", "error": str(error), "updated_at": now()})
            raise
        finally:
            atomic_json(catalog_path, catalog)
            atomic_json(output / "progress.json", progress)
        print(json.dumps(progress, ensure_ascii=False), flush=True)


def make_catalog_entry(entry):
    result = {"gloss": entry["gloss"], "vi": entry["meaning"], "video_id": entry["video_id"],
              "source_video": entry["source_video"], "signer": entry["signer"],
              "score": entry["score"], "frame_count": len(entry["frames"]), "fps": entry["fps"]}
    if entry.get("annotation"):
        result["annotation"] = entry["annotation"]
    return result


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="Directory containing source CSV and video_raw; auto-selects fullest copy")
    parser.add_argument("--output", type=Path, default=DATA_DIR)
    parser.add_argument("--model", type=Path, default=MODEL_PATH)
    parser.add_argument("--max-fps", type=float, default=25)
    parser.add_argument("--max-width", type=int, default=960)
    parser.add_argument("--min-coverage", type=float, default=0.35)
    parser.add_argument("--word", action="append", help="Process only this meaning; may be repeated")
    parser.add_argument("--limit", type=int, help="Smoke test first N meanings; use a separate --output")
    parser.add_argument("--plan", action="store_true", help="Validate manifests without loading MediaPipe or writing outputs")
    parser.add_argument("--force", action="store_true", help="Re-evaluate even previously completed meanings")
    args = parser.parse_args()
    if (args.word or args.limit) and args.output.resolve() == DATA_DIR.resolve():
        parser.error("Subset runs require a separate --output so production catalog stays complete")
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be positive")
    build(args)


if __name__ == "__main__":
    main()
