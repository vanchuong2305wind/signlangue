"""Extract smooth full-body signing landmarks with MediaPipe Holistic.

The output schema stores image-space pose/hands, world-space pose and facial
blendshapes. Files are written per gloss so extraction can safely resume.
"""

import argparse
import json
import math
import sys
from pathlib import Path

import cv2
import mediapipe as mp
from tqdm import tqdm

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.api.landmark_processing import process_landmark_entry


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


def extract_video(video_path, detectors):
    pose_detector, hand_detector = detectors
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        return None

    fps = capture.get(cv2.CAP_PROP_FPS) or 25
    frames = []
    frame_index = 0

    while True:
        ok, frame = capture.read()
        if not ok:
            break

        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        pose_result = pose_detector.process(rgb)
        hand_result = hand_detector.process(rgb)
        hands = assign_hands_to_pose(
            hand_result,
            pose_result.pose_landmarks,
        )

        frames.append({
            "pose": points_to_json(pose_result.pose_landmarks),
            "pose_world": points_to_json(pose_result.pose_world_landmarks),
            "left_hand": hands["left_hand"],
            "right_hand": hands["right_hand"],
            "face_blendshapes": None,
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
        default=ROOT / "data" / "archive" / "WLASL_v0.3.json",
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
    args = parser.parse_args()

    args.output.mkdir(parents=True, exist_ok=True)
    metadata = json.loads(args.metadata.read_text(encoding="utf-8"))
    if args.gloss:
        requested = {gloss.lower() for gloss in args.gloss}
        metadata = [sign for sign in metadata if sign["gloss"].lower() in requested]
    if args.limit:
        metadata = metadata[:args.limit]

    with mp.solutions.pose.Pose(
        static_image_mode=False,
        model_complexity=2,
        smooth_landmarks=True,
        min_detection_confidence=0.5,
        min_tracking_confidence=0.5,
    ) as pose_detector, mp.solutions.hands.Hands(
        static_image_mode=False,
        max_num_hands=2,
        model_complexity=1,
        min_detection_confidence=0.5,
        min_tracking_confidence=0.5,
    ) as hand_detector:
        detectors = (pose_detector, hand_detector)
        for sign in tqdm(metadata, desc="Extracting Holistic landmarks"):
            gloss = sign["gloss"].lower()
            destination = args.output / f"{gloss}.json"
            if destination.exists() and not args.force:
                continue

            best = None
            best_video_id = None
            for instance in sign["instances"]:
                video_id = instance["video_id"]
                video_path = args.videos / f"{video_id}.mp4"
                if not video_path.exists():
                    continue
                candidate = extract_video(video_path, detectors)
                if candidate and (best is None or candidate["score"] > best["score"]):
                    best = candidate
                    best_video_id = video_id
                if best and best["score"] >= 0.95:
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
