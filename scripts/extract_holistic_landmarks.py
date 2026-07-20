"""Extract smooth full-body signing landmarks with MediaPipe Holistic.

The output schema stores image-space pose/hands, world-space pose and facial
blendshapes. Files are written per gloss so extraction can safely resume.
"""

import argparse
import json
import math
import shutil
import sys
import tempfile
from pathlib import Path

import cv2
import mediapipe as mp
from tqdm import tqdm

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.api.landmark_processing import process_landmark_entry


def download_video(url, destination, timeout=45):
    """Download one source clip on demand without retaining the dataset."""
    if not url or not url.startswith(("http://", "https://")):
        return False

    try:
        import requests

        with requests.get(
            url,
            stream=True,
            timeout=(10, timeout),
            allow_redirects=True,
            headers={"User-Agent": "Mozilla/5.0"},
        ) as response:
            response.raise_for_status()
            content_type = response.headers.get("content-type", "").lower()
            if "text/html" in content_type:
                raise ValueError("source returned HTML instead of video")
            with destination.open("wb") as output:
                shutil.copyfileobj(response.raw, output)
        if destination.stat().st_size >= 5_000:
            return True
    except Exception:
        destination.unlink(missing_ok=True)

    # yt-dlp also handles YouTube and several sites that block plain requests.
    try:
        import yt_dlp

        options = {
            "format": "best[height<=720]/best",
            "outtmpl": str(destination),
            "quiet": True,
            "no_warnings": True,
            "noprogress": True,
            "socket_timeout": timeout,
            "retries": 1,
        }
        with yt_dlp.YoutubeDL(options) as downloader:
            downloader.download([url])
        return destination.exists() and destination.stat().st_size >= 5_000
    except Exception:
        destination.unlink(missing_ok=True)
        return False


def points_to_json(points):
    if not points:
        return None
    if hasattr(points, "landmark"):
        points = points.landmark
    return [
        {"x": float(point.x), "y": float(point.y), "z": float(point.z)}
        for point in points
    ]


def landmark_distance(a, b):
    return math.hypot(float(a.x) - float(b.x), float(a.y) - float(b.y))


def assign_hands_to_pose(hand_result, pose_landmarks):
    """Assign detected hands to anatomical sides, independent of mirroring."""
    assigned = {"left_hand": None, "right_hand": None}
    if not hand_result.multi_hand_landmarks:
        return assigned

    pose_points = pose_landmarks.landmark if pose_landmarks else None
    wrist_targets = {
        "left_hand": pose_points[15] if pose_points else None,
        "right_hand": pose_points[16] if pose_points else None,
    }
    detections = list(hand_result.multi_hand_landmarks)

    if pose_points:
        candidates = []
        for detection_index, hand in enumerate(detections):
            for side, target in wrist_targets.items():
                candidates.append((
                    landmark_distance(hand.landmark[0], target),
                    detection_index,
                    side,
                ))

        used_detections = set()
        used_sides = set()
        for _, detection_index, side in sorted(candidates):
            if detection_index in used_detections or side in used_sides:
                continue
            assigned[side] = points_to_json(detections[detection_index])
            used_detections.add(detection_index)
            used_sides.add(side)

        if len(used_detections) == len(detections):
            return assigned

    # Fall back to MediaPipe's classification only when pose wrists are absent.
    handedness_list = hand_result.multi_handedness or []
    for detection_index, hand in enumerate(detections):
        label = (
            handedness_list[detection_index].classification[0].label.lower()
            if detection_index < len(handedness_list)
            else "right"
        )
        side = f"{label}_hand"
        if assigned[side] is None:
            assigned[side] = points_to_json(hand)
    return assigned


def blendshapes_to_json(categories):
    if not categories:
        return None
    return {
        category.category_name: float(category.score)
        for category in categories
        if category.category_name
    }


def extract_video(video_path, landmarker, instance=None):
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        return None

    fps = capture.get(cv2.CAP_PROP_FPS) or 25
    instance = instance or {}
    frame_start = max(int(instance.get("frame_start", 1) or 1) - 1, 0)
    frame_end_raw = int(instance.get("frame_end", -1) or -1)
    frame_end = frame_end_raw - 1 if frame_end_raw > 0 else None
    if frame_start:
        capture.set(cv2.CAP_PROP_POS_FRAMES, frame_start)
    frames = []
    frame_index = 0

    while True:
        ok, frame = capture.read()
        if not ok:
            break
        source_frame_index = frame_start + frame_index
        if frame_end is not None and source_frame_index > frame_end:
            break

        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        timestamp_ms = frame_index * max(1, round(1000 / fps))
        result = landmarker.detect_for_video(mp_image, timestamp_ms)

        frames.append({
            "pose": points_to_json(result.pose_landmarks),
            "pose_world": points_to_json(result.pose_world_landmarks),
            "left_hand": points_to_json(result.left_hand_landmarks),
            "right_hand": points_to_json(result.right_hand_landmarks),
            "face_blendshapes": blendshapes_to_json(result.face_blendshapes),
        })
        frame_index += 1

    capture.release()
    if not frames:
        return None

    pose_coverage = sum(bool(frame["pose_world"]) for frame in frames) / len(frames)
    side_coverage = {
        side: sum(bool(frame[side]) for frame in frames) / len(frames)
        for side in ("left_hand", "right_hand")
    }
    # Sparse second-hand detections are usually face/background false positives.
    for side, coverage in side_coverage.items():
        if coverage < 0.20:
            for frame in frames:
                frame[side] = None
            side_coverage[side] = 0.0

    hand_coverage = sum(
        bool(frame["left_hand"]) or bool(frame["right_hand"])
        for frame in frames
    ) / len(frames)
    both_hands_coverage = sum(
        bool(frame["left_hand"]) and bool(frame["right_hand"])
        for frame in frames
    ) / len(frames)
    score = 0.55 * pose_coverage + 0.35 * hand_coverage + 0.10 * both_hands_coverage
    return {
        "schema_version": 2,
        "fps": fps,
        "score": score,
        "coverage": {
            "pose": pose_coverage,
            "any_hand": hand_coverage,
            "both_hands": both_hands_coverage,
            **side_coverage,
        },
        "frames": frames,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--metadata",
        type=Path,
        default=ROOT / "train_sing_language" / "wlasl_v0.3.json",
    )
    parser.add_argument(
        "--videos",
        type=Path,
        default=ROOT / "data" / "archive" / "videos",
    )
    parser.add_argument(
        "--model",
        type=Path,
        default=ROOT / "train_sing_language" / "models" / "holistic_landmarker.task",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "data" / "processed" / "landmarks_v2",
    )
    parser.add_argument("--limit", type=int)
    parser.add_argument("--gloss", action="append")
    parser.add_argument("--force", action="store_true")
    parser.add_argument(
        "--download-missing",
        action="store_true",
        help="Download missing source videos temporarily and delete them after extraction.",
    )
    parser.add_argument("--download-timeout", type=int, default=45)
    parser.add_argument(
        "--max-sources",
        type=int,
        default=3,
        help="Maximum source videos attempted per gloss (default: 3).",
    )
    parser.add_argument(
        "--target-score",
        type=float,
        default=0.75,
        help="Stop trying more sources after reaching this quality score.",
    )
    args = parser.parse_args()

    args.output.mkdir(parents=True, exist_ok=True)
    metadata = json.loads(args.metadata.read_text(encoding="utf-8"))
    if args.gloss:
        requested = {gloss.lower() for gloss in args.gloss}
        metadata = [sign for sign in metadata if sign["gloss"].lower() in requested]
    if args.limit:
        metadata = metadata[:args.limit]

    from mediapipe.tasks.python import BaseOptions
    from mediapipe.tasks.python.vision import (
        HolisticLandmarker,
        HolisticLandmarkerOptions,
    )
    from mediapipe.tasks.python.vision.core.vision_task_running_mode import (
        VisionTaskRunningMode,
    )

    options = HolisticLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(args.model)),
        running_mode=VisionTaskRunningMode.VIDEO,
        min_pose_detection_confidence=0.5,
        min_pose_landmarks_confidence=0.5,
        min_hand_landmarks_confidence=0.5,
        output_face_blendshapes=True,
    )

    with tempfile.TemporaryDirectory(prefix="landmark-videos-", ignore_cleanup_errors=True) as temporary_dir:
        for sign in tqdm(metadata, desc="Extracting Holistic landmarks"):
            gloss = sign["gloss"].lower()
            destination = args.output / f"{gloss}.json"
            if destination.exists() and not args.force:
                continue

            best = None
            best_video_id = None
            for instance in sign["instances"][:max(args.max_sources, 1)]:
                video_id = instance["video_id"]
                video_path = args.videos / f"{video_id}.mp4"
                temporary_video = False
                if not video_path.exists():
                    if not args.download_missing:
                        continue
                    video_path = Path(temporary_dir) / f"{video_id}.mp4"
                    if not download_video(
                        instance.get("url", ""),
                        video_path,
                        args.download_timeout,
                    ):
                        continue
                    temporary_video = True
                try:
                    with HolisticLandmarker.create_from_options(options) as landmarker:
                        candidate = extract_video(video_path, landmarker, instance)
                except (RuntimeError, ValueError) as error:
                    print(f"\n[WARN] {gloss}/{video_id}: {error}", file=sys.stderr)
                    candidate = None
                if temporary_video:
                    video_path.unlink(missing_ok=True)
                if candidate and (best is None or candidate["score"] > best["score"]):
                    best = candidate
                    best_video_id = video_id
                if best and best["score"] >= args.target_score:
                    break

            if not best:
                continue
            best["video_id"] = best_video_id
            best = process_landmark_entry(best)
            temporary = destination.with_suffix(".tmp")
            temporary.write_text(
                json.dumps(best, ensure_ascii=False, separators=(",", ":")),
                encoding="utf-8",
            )
            temporary.replace(destination)


if __name__ == "__main__":
    main()
