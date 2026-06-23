"""
Real-time ASL Sign Language Recognition from Camera
Uses pre-trained TGCN model + MediaPipe Tasks API (holistic landmarker).

Pipeline:
  Camera -> MediaPipe -> OpenPose-compatible 55 keypoints
  -> training-compatible normalization -> 50 frames -> TGCN -> ASL word

Usage:
  python camera_recognition.py
  python camera_recognition.py --variant asl100 --camera 0 --threshold 0.55
  python camera_recognition.py --debug  # show normalized keypoint values

Controls:
  'q' - Quit
  'r' - Reset buffer (clear accumulated frames)
  'space' - Pause/Resume recording
  's' - Clear sentence
  'd' - Toggle debug overlay
"""

import os
import sys
import time
import argparse
from collections import deque, Counter

import cv2
import numpy as np
import torch

import mediapipe as mp
from mediapipe.tasks.python import BaseOptions
from mediapipe.tasks.python.vision import (
    HolisticLandmarker,
    HolisticLandmarkerOptions,
    HolisticLandmarkerResult,
)
from mediapipe.tasks.python.vision.core.vision_task_running_mode import VisionTaskRunningMode

from tgcn_model import GCN_muti_att
from configs import Config
from wlasl_labels import get_label, get_num_classes

# ─── MediaPipe Keypoint Configuration ───────────────────────────────────────
# Exact 13-joint order used by the official WLASL OpenPose/TGCN loader:
# nose, neck, R shoulder/elbow/wrist, L shoulder/elbow/wrist, mid-hip,
# R eye, L eye, R ear, L ear.
OPENPOSE_POSE_NAMES = (
    "nose", "neck",
    "right_shoulder", "right_elbow", "right_wrist",
    "left_shoulder", "left_elbow", "left_wrist",
    "mid_hip",
    "right_eye", "left_eye", "right_ear", "left_ear",
)
NUM_POSE = len(OPENPOSE_POSE_NAMES)  # 13
DRAW_POSE_INDICES = [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24]
NUM_HAND = 21                   # per hand
NUM_KEYPOINTS = NUM_POSE + NUM_HAND * 2  # 13 + 21 + 21 = 55
DEFAULT_DISPLAY_SENTENCE = "xin chào tôi yêu bạn"
DEFAULT_DISPLAY_WORDS = DEFAULT_DISPLAY_SENTENCE.split()

# Connections for drawing
POSE_CONNECTIONS = [
    (0, 2), (0, 5), (2, 7), (5, 8), (11, 12),
    (11, 13), (13, 15), (12, 14), (14, 16),
    (11, 23), (12, 24), (23, 24),
]
HAND_CONNECTIONS = [
    (0,1),(1,2),(2,3),(3,4),(0,5),(5,6),(6,7),(7,8),
    (0,9),(9,10),(10,11),(11,12),(0,13),(13,14),(14,15),(15,16),
    (0,17),(17,18),(18,19),(19,20),(5,9),(9,13),(13,17),
]


# ─── Keypoint Normalizer ────────────────────────────────────────────────────
class KeypointNormalizer:
    """Match the coordinate transform used to train the TGCN checkpoint.

    The official loader applies ``2 * (coordinate / 256 - 0.5)`` to OpenPose
    coordinates. MediaPipe coordinates are already image-normalized, making
    the equivalent transform ``2 * coordinate - 1``.
    """

    def __init__(self, ema_alpha=None):
        self.running_shoulder_dist = None

    def normalize(self, keypoints):
        # OpenPose represented an undetected point as (0, 0), which became
        # (-1, -1) after this same training-time transform.
        result = 2.0 * keypoints.astype(np.float32, copy=True) - 1.0
        return np.clip(result, -1.0, 1.0)

    def reset(self):
        self.running_shoulder_dist = None


# ─── Prediction Smoother ────────────────────────────────────────────────────
class PredictionSmoother:
    """Smooths predictions using majority vote over a sliding window."""

    def __init__(self, window_size=9, min_agreement=4):
        self.window_size = window_size
        self.min_agreement = min_agreement
        self.predictions = deque(maxlen=window_size)
        self.confidences = deque(maxlen=window_size)

    def add(self, prediction, confidence):
        self.predictions.append(prediction)
        self.confidences.append(confidence)

    def get_smoothed(self):
        """Get the smoothed (majority vote) prediction."""
        if not self.predictions:
            return None, 0.0
        counter = Counter(self.predictions)
        most_common, count = counter.most_common(1)[0]
        if count >= self.min_agreement:
            avg_conf = np.mean([
                c for p, c in zip(self.predictions, self.confidences)
                if p == most_common
            ])
            return most_common, float(avg_conf)
        # Not enough agreement - return latest but with reduced confidence
        return self.predictions[-1], self.confidences[-1] * 0.3

    def get_top3(self):
        if not self.predictions:
            return []
        return Counter(self.predictions).most_common(3)

    def clear(self):
        self.predictions.clear()
        self.confidences.clear()


class SignSegmenter:
    """Split a live landmark stream into isolated-sign clips.

    WLASL checkpoints are trained from videos whose sign boundaries are known.
    Feeding an arbitrary rolling camera window creates a large mismatch. This
    segmenter starts on meaningful hand/arm motion, keeps a short pre-roll,
    and closes the clip after motion settles.
    """

    def __init__(
        self,
        start_motion=0.008,
        end_motion=0.003,
        end_hold_frames=8,
        min_frames=12,
        max_frames=90,
        pre_roll_frames=6,
        no_hands_end_frames=5,
        cooldown_frames=6,
    ):
        self.start_motion = start_motion
        self.end_motion = end_motion
        self.end_hold_frames = end_hold_frames
        self.min_frames = min_frames
        self.max_frames = max_frames
        self.no_hands_end_frames = no_hands_end_frames
        self.cooldown_frames = cooldown_frames
        self.pre_roll = deque(maxlen=pre_roll_frames)
        self.reset()

    def reset(self):
        self.state = "waiting"
        self.frames = []
        self.previous_frame = None
        self.quiet_frames = 0
        self.no_hands_frames = 0
        self.cooldown = 0
        self.last_motion = 0.0
        self.pre_roll.clear()

    def _finish_clip(self):
        clip = self.frames
        removable_tail = max(0, self.quiet_frames - 2)
        if removable_tail and len(clip) - removable_tail >= self.min_frames:
            clip = clip[:-removable_tail]

        self.frames = []
        self.quiet_frames = 0
        self.no_hands_frames = 0
        self.state = "cooldown"
        self.cooldown = self.cooldown_frames
        self.pre_roll.clear()
        return clip if len(clip) >= self.min_frames else None

    def update(self, frame, has_hands):
        """Consume one frame and return ``(completed_clip, motion, state)``."""
        motion = 0.0
        if self.previous_frame is not None:
            motion = compute_pair_motion(self.previous_frame, frame)

        self.previous_frame = frame
        self.last_motion = motion

        if self.state == "cooldown":
            self.cooldown -= 1
            if self.cooldown <= 0:
                self.state = "waiting"
            return None, motion, self.state

        if self.state == "waiting":
            self.pre_roll.append(frame.copy())
            if has_hands and motion >= self.start_motion:
                self.frames = [item.copy() for item in self.pre_roll]
                self.state = "capturing"
            return None, motion, self.state

        self.frames.append(frame.copy())
        self.no_hands_frames = self.no_hands_frames + 1 if not has_hands else 0
        self.quiet_frames = (
            self.quiet_frames + 1 if motion < self.end_motion else 0
        )

        enough_frames = len(self.frames) >= self.min_frames
        reached_end = (
            enough_frames
            and (
                self.quiet_frames >= self.end_hold_frames
                or self.no_hands_frames >= self.no_hands_end_frames
            )
        )
        reached_limit = len(self.frames) >= self.max_frames
        if reached_end or reached_limit:
            return self._finish_clip(), motion, self.state

        return None, motion, self.state


# ─── Model Loading ──────────────────────────────────────────────────────────
def load_model(variant="asl100", checkpoint_dir="checkpoints", device="cpu"):
    """Load pre-trained TGCN model."""
    config_path = os.path.join(checkpoint_dir, "checkpoints", variant, "config.ini")
    model_path = os.path.join(checkpoint_dir, "checkpoints", variant, "pytorch_model.bin")

    if not os.path.exists(model_path):
        print(f"[ERROR] Model checkpoint not found at: {model_path}")
        print(f"   Run 'python download_model.py --variant {variant}' first!")
        sys.exit(1)

    config = Config(config_path)
    num_classes = get_num_classes(variant)

    model = GCN_muti_att(
        input_feature=config.num_samples * 2,
        hidden_feature=config.hidden_size,
        num_class=num_classes,
        p_dropout=config.drop_p,
        num_stage=config.num_stages,
    )

    checkpoint = torch.load(model_path, map_location=device, weights_only=False)
    state_dict = checkpoint.get('state_dict', checkpoint)
    incompatible = model.load_state_dict(state_dict, strict=False)
    if incompatible.missing_keys or incompatible.unexpected_keys:
        raise RuntimeError(
            "Checkpoint does not match the TGCN architecture. "
            f"Missing={incompatible.missing_keys}, "
            f"unexpected={incompatible.unexpected_keys}"
        )
    model.to(device)
    model.eval()

    print(f"[OK] Loaded TGCN model: {variant}")
    print(f"   Classes: {num_classes}, Hidden: {config.hidden_size}, Stages: {config.num_stages}")
    print(f"   Input: ({NUM_KEYPOINTS} keypoints, {config.num_samples} frames)")

    return model, config


# ─── Keypoint Extraction ────────────────────────────────────────────────────
def extract_keypoints_raw(result: HolisticLandmarkerResult):
    """Extract 55 raw keypoints from MediaPipe results (no normalization).

    Returns:
        keypoints: array of shape (55, 2) with raw (x, y) in [0, 1].
        has_left_hand: bool
        has_right_hand: bool
    """
    keypoints = np.zeros((NUM_KEYPOINTS, 2), dtype=np.float32)
    has_left_hand = False
    has_right_hand = False

    # Convert MediaPipe pose order to the exact OpenPose order used in
    # training. Neck and mid-hip are synthesized because MediaPipe does not
    # expose those points directly.
    if result.pose_landmarks and len(result.pose_landmarks) > 0:
        pose = result.pose_landmarks

        def point(index):
            lm = pose[index]
            visibility = getattr(lm, "visibility", None)
            presence = getattr(lm, "presence", None)
            if visibility is not None and visibility < 0.3:
                return np.zeros(2, dtype=np.float32)
            if presence is not None and presence < 0.3:
                return np.zeros(2, dtype=np.float32)
            return np.array([lm.x, lm.y], dtype=np.float32)

        left_shoulder, right_shoulder = point(11), point(12)
        left_hip, right_hip = point(23), point(24)

        def midpoint(a, b):
            if np.any(a) and np.any(b):
                return (a + b) / 2
            return np.zeros(2, dtype=np.float32)

        keypoints[:NUM_POSE] = np.stack([
            point(0),
            midpoint(left_shoulder, right_shoulder),
            right_shoulder,
            point(14),
            point(16),
            left_shoulder,
            point(13),
            point(15),
            midpoint(left_hip, right_hip),
            point(5),
            point(2),
            point(8),
            point(7),
        ])

    # Left hand (flat list of 21 NormalizedLandmark)
    if result.left_hand_landmarks and len(result.left_hand_landmarks) > 0:
        has_left_hand = True
        for j, lm in enumerate(result.left_hand_landmarks):
            if j < NUM_HAND:
                keypoints[NUM_POSE + j] = [lm.x, lm.y]

    # Right hand (flat list of 21 NormalizedLandmark)
    if result.right_hand_landmarks and len(result.right_hand_landmarks) > 0:
        has_right_hand = True
        for j, lm in enumerate(result.right_hand_landmarks):
            if j < NUM_HAND:
                keypoints[NUM_POSE + NUM_HAND + j] = [lm.x, lm.y]

    return keypoints, has_left_hand, has_right_hand


def build_input_tensor(keypoint_buffer, num_samples=50):
    """Build tensor (1, 55, 100) from keypoint buffer.

    Format: interleaved [x_f0, y_f0, x_f1, y_f1, ..., x_f49, y_f49]
    Each frame contributes (x, y) pair per keypoint.
    """
    frames = list(keypoint_buffer)
    if not frames:
        frames = [np.full((NUM_KEYPOINTS, 2), -1.0, dtype=np.float32)]
    while len(frames) < num_samples:
        frames.append(frames[-1].copy())
    frames = frames[-num_samples:]

    stacked = np.stack(frames, axis=0)  # (50, 55, 2)
    feature = np.zeros((NUM_KEYPOINTS, num_samples * 2), dtype=np.float32)
    for t in range(num_samples):
        feature[:, t * 2] = stacked[t, :, 0]      # x
        feature[:, t * 2 + 1] = stacked[t, :, 1]  # y

    return torch.FloatTensor(feature).unsqueeze(0)  # (1, 55, 100)


def build_temporal_views(keypoint_frames, num_samples=50, num_views=3):
    """Build continuous temporal crops and return them as one batch."""
    frames = list(keypoint_frames)
    if not frames:
        frames = [np.full((NUM_KEYPOINTS, 2), -1.0, dtype=np.float32)]

    if len(frames) <= num_samples:
        return build_input_tensor(frames, num_samples)

    max_start = len(frames) - num_samples
    view_count = max(1, min(int(num_views), max_start + 1))
    starts = np.linspace(0, max_start, num=view_count, dtype=np.int32)
    starts = sorted(set(int(start) for start in starts))
    views = [
        build_input_tensor(frames[start:start + num_samples], num_samples)[0]
        for start in starts
    ]
    return torch.stack(views, dim=0)


def decode_logits(logits, num_classes, top_k=3):
    """Decode logits and expose the top-2 margin for rejection."""
    probabilities = torch.softmax(logits, dim=1)
    k = min(top_k, probabilities.shape[1])
    values, indices = torch.topk(probabilities, k=k, dim=1)
    top_predictions = [
        (get_label(int(index), num_classes), float(value))
        for value, index in zip(values[0], indices[0])
    ]
    prediction, confidence = top_predictions[0]
    margin = confidence
    if len(top_predictions) > 1:
        margin -= top_predictions[1][1]
    return prediction, confidence, margin, top_predictions


def compute_pair_motion(previous_frame, current_frame):
    """Robust motion score using points visible in both frames."""
    tracked_indices = list(range(2, 8)) + list(range(NUM_POSE, NUM_KEYPOINTS))
    previous = previous_frame[tracked_indices]
    current = current_frame[tracked_indices]

    previous_valid = ~np.all(np.isclose(previous, -1.0, atol=1e-5), axis=1)
    current_valid = ~np.all(np.isclose(current, -1.0, atol=1e-5), axis=1)
    valid = previous_valid & current_valid
    if not np.any(valid):
        return 0.0

    displacement = np.linalg.norm(current[valid] - previous[valid], axis=1)
    return float(np.percentile(displacement, 60))


def compute_motion_score(keypoint_buffer, n_recent=10):
    """Compute how much hand keypoints moved recently.

    Returns a score (0.0 = no movement, higher = more movement).
    Only considers hand keypoints (indices 13-54).
    """
    if len(keypoint_buffer) < 2:
        return 0.0
    recent = list(keypoint_buffer)[-min(n_recent, len(keypoint_buffer)):]
    if len(recent) < 2:
        return 0.0

    diffs = []
    for i in range(1, len(recent)):
        diffs.append(compute_pair_motion(recent[i - 1], recent[i]))

    return float(np.mean(diffs))


# ─── Drawing ────────────────────────────────────────────────────────────────
def draw_ui(frame, prediction, confidence, fps, buffer_fill, num_samples,
            is_recording, history, top3=None, has_hands=False, sentence="",
            capture_state=None):
    """Draw UI overlay on the video frame."""
    h, w = frame.shape[:2]

    # ── Top bar ──
    overlay = frame.copy()
    cv2.rectangle(overlay, (0, 0), (w, 100), (20, 20, 30), -1)
    cv2.addWeighted(overlay, 0.75, frame, 0.25, 0, frame)

    cv2.putText(frame, "ASL Sign Language Recognition", (15, 28),
                cv2.FONT_HERSHEY_SIMPLEX, 0.7, (100, 220, 255), 2)

    cv2.putText(frame, f"FPS: {fps:.0f}", (w - 120, 28),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (150, 255, 150), 1)

    # Hand detection indicator
    hand_color = (0, 255, 100) if has_hands else (80, 80, 80)
    hand_text = "[HANDS DETECTED]" if has_hands else "[NO HANDS]"
    cv2.putText(frame, hand_text, (w - 200, 55),
                cv2.FONT_HERSHEY_SIMPLEX, 0.45, hand_color, 1)

    # Buffer progress bar
    bar_x, bar_y, bar_w, bar_h = 15, 48, 250, 14
    fill_ratio = buffer_fill / num_samples
    cv2.rectangle(frame, (bar_x, bar_y), (bar_x + bar_w, bar_y + bar_h),
                  (60, 60, 60), -1)
    fill_color = (0, 255, 100) if fill_ratio >= 1.0 else (0, 180, 255)
    cv2.rectangle(frame, (bar_x, bar_y),
                  (bar_x + int(bar_w * min(fill_ratio, 1.0)), bar_y + bar_h),
                  fill_color, -1)
    cv2.rectangle(frame, (bar_x, bar_y), (bar_x + bar_w, bar_y + bar_h),
                  (100, 100, 100), 1)
    cv2.putText(frame, f"Buffer: {buffer_fill}/{num_samples}",
                (bar_x + bar_w + 10, bar_y + 11),
                cv2.FONT_HERSHEY_SIMPLEX, 0.4, (200, 200, 200), 1)

    # Recording status
    status_color = (0, 0, 255) if is_recording else (100, 100, 100)
    if not is_recording:
        status_text = "|| PAUSED"
    elif capture_state:
        status_text = {
            "waiting": "READY",
            "capturing": "* CAPTURING SIGN",
            "cooldown": "PROCESSING",
        }.get(capture_state, capture_state.upper())
    else:
        status_text = "* REC"
    cv2.putText(frame, status_text, (15, 80),
                cv2.FONT_HERSHEY_SIMPLEX, 0.45, status_color, 2)

    # ── Top-3 predictions panel (right side) ──
    if top3 and len(top3) > 0:
        panel_x = w - 260
        panel_y = 80
        overlay_r = frame.copy()
        cv2.rectangle(overlay_r, (panel_x - 10, panel_y - 5),
                      (w - 10, panel_y + len(top3) * 28 + 5), (30, 30, 40), -1)
        cv2.addWeighted(overlay_r, 0.7, frame, 0.3, 0, frame)

        cv2.putText(frame, "Top Predictions:", (panel_x, panel_y + 12),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.4, (150, 150, 150), 1)
        for i, (word, score) in enumerate(top3):
            y_pos = panel_y + 35 + i * 25
            is_probability = isinstance(score, (float, np.floating)) and score <= 1.0
            bar_len = int(min(float(score), 1.0) * 150) if is_probability \
                else int(float(score) / 7 * 120)
            bar_color = [(0, 255, 100), (0, 200, 255), (100, 150, 255)][min(i, 2)]
            cv2.rectangle(frame, (panel_x, y_pos - 10),
                          (panel_x + bar_len, y_pos + 2), bar_color, -1)
            score_text = f"{float(score):.0%}" if is_probability else str(score)
            cv2.putText(frame, f"{word} ({score_text})",
                        (panel_x + bar_len + 5, y_pos),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.4, (220, 220, 220), 1)

    # ── Bottom prediction area ──
    overlay2 = frame.copy()
    cv2.rectangle(overlay2, (0, h - 140), (w, h), (20, 20, 30), -1)
    cv2.addWeighted(overlay2, 0.75, frame, 0.25, 0, frame)

    if prediction:
        pred_color = (0, 255, 100) if confidence > 0.5 else \
                     (0, 200, 255) if confidence > 0.3 else (100, 150, 255)
        cv2.putText(frame, f'"{prediction.upper()}"', (20, h - 100),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.3, pred_color, 3)

        # Confidence bar
        conf_bar_w = int(confidence * 200)
        cv2.rectangle(frame, (20, h - 82), (220, h - 72), (60, 60, 60), -1)
        cv2.rectangle(frame, (20, h - 82), (20 + conf_bar_w, h - 72), pred_color, -1)
        cv2.putText(frame, f"{confidence:.0%}", (230, h - 73),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.4, (200, 200, 200), 1)

    # Sentence
    if sentence:
        cv2.putText(frame, f"Sentence: {sentence}", (20, h - 48),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 220, 100), 1)

    # History
    if history:
        hist_text = " > ".join(history[-8:])
        cv2.putText(frame, f"History: {hist_text}", (20, h - 22),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.4, (160, 160, 160), 1)

    # Controls
    cv2.putText(frame, "[Q]uit [R]eset [Space]Pause [S]Clear-sentence",
                (w - 380, h - 8),
                cv2.FONT_HERSHEY_SIMPLEX, 0.35, (100, 100, 100), 1)

    return frame


def draw_landmarks_on_frame(frame, result: HolisticLandmarkerResult):
    """Draw pose and hand landmarks on the frame."""
    h, w = frame.shape[:2]

    def to_pixel(lm):
        return int(lm.x * w), int(lm.y * h)

    # Pose
    if result.pose_landmarks and len(result.pose_landmarks) > 0:
        pose_pts = {}
        for i, idx in enumerate(DRAW_POSE_INDICES):
            if idx < len(result.pose_landmarks):
                lm = result.pose_landmarks[idx]
                px, py = to_pixel(lm)
                pose_pts[i] = (px, py)
                cv2.circle(frame, (px, py), 4, (0, 255, 200), -1)
        idx_map = {orig: i for i, orig in enumerate(DRAW_POSE_INDICES)}
        for a, b in POSE_CONNECTIONS:
            ia, ib = idx_map.get(a), idx_map.get(b)
            if ia in pose_pts and ib in pose_pts:
                cv2.line(frame, pose_pts[ia], pose_pts[ib], (0, 200, 170), 2)

    # Left hand
    if result.left_hand_landmarks and len(result.left_hand_landmarks) > 0:
        pts = {}
        for j, lm in enumerate(result.left_hand_landmarks):
            if j < NUM_HAND:
                px, py = to_pixel(lm)
                pts[j] = (px, py)
                cv2.circle(frame, (px, py), 3, (255, 100, 100), -1)
        for a, b in HAND_CONNECTIONS:
            if a in pts and b in pts:
                cv2.line(frame, pts[a], pts[b], (255, 150, 150), 1)

    # Right hand
    if result.right_hand_landmarks and len(result.right_hand_landmarks) > 0:
        pts = {}
        for j, lm in enumerate(result.right_hand_landmarks):
            if j < NUM_HAND:
                px, py = to_pixel(lm)
                pts[j] = (px, py)
                cv2.circle(frame, (px, py), 3, (100, 100, 255), -1)
        for a, b in HAND_CONNECTIONS:
            if a in pts and b in pts:
                cv2.line(frame, pts[a], pts[b], (150, 150, 255), 1)


# ─── Main ───────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Real-time ASL Recognition")
    parser.add_argument(
        "--variant",
        type=str,
        default="asl100",
        choices=("asl100", "asl300", "asl1000", "asl2000"),
        help="Smaller vocabularies are generally more accurate (default: asl100)",
    )
    parser.add_argument("--camera", type=int, default=0)
    parser.add_argument("--threshold", type=float, default=0.55)
    parser.add_argument(
        "--mode",
        choices=("segmented", "sliding"),
        default="segmented",
        help="Segment complete signs before inference (default) or use legacy sliding windows",
    )
    parser.add_argument("--margin-threshold", type=float, default=0.10,
                        help="Reject predictions whose top-1/top-2 gap is too small")
    parser.add_argument("--sample-fps", type=float, default=25.0,
                        help="Landmark sampling rate; WLASL was decoded at 25 FPS")
    parser.add_argument("--temporal-views", type=int, default=3,
                        help="Number of temporal crops averaged for a completed sign")
    parser.add_argument("--start-motion", type=float, default=0.008)
    parser.add_argument("--end-motion", type=float, default=0.003)
    parser.add_argument("--end-hold-frames", type=int, default=8)
    parser.add_argument("--min-sign-frames", type=int, default=12)
    parser.add_argument("--max-sign-frames", type=int, default=90)
    parser.add_argument("--checkpoint-dir", type=str, default="checkpoints")
    parser.add_argument("--no-skeleton", action="store_true")
    parser.add_argument("--device", type=str, default="auto")
    parser.add_argument("--holistic-model", type=str,
                        default="models/holistic_landmarker.task")
    parser.add_argument("--debug", action="store_true",
                        help="Show debug overlay with keypoint values")
    parser.add_argument("--mirror-display", action="store_true",
                        help="Mirror only the preview, never model input")
    args = parser.parse_args()

    # Device
    if args.device == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    else:
        device = args.device
    print(f"[DEVICE] {device}")

    # Load TGCN model
    model, config = load_model(args.variant, args.checkpoint_dir, device)
    num_samples = config.num_samples  # 50
    num_classes = get_num_classes(args.variant)

    # Auto-download holistic model if missing
    if not os.path.exists(args.holistic_model):
        print(f"[INFO] Downloading MediaPipe holistic model...")
        import urllib.request
        os.makedirs(os.path.dirname(args.holistic_model), exist_ok=True)
        url = "https://storage.googleapis.com/mediapipe-models/holistic_landmarker/holistic_landmarker/float16/latest/holistic_landmarker.task"
        urllib.request.urlretrieve(url, args.holistic_model)
        print(f"   Downloaded to {args.holistic_model}")

    # Initialize MediaPipe
    options = HolisticLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=args.holistic_model),
        running_mode=VisionTaskRunningMode.VIDEO,
        min_pose_detection_confidence=0.5,
        min_pose_landmarks_confidence=0.5,
        min_hand_landmarks_confidence=0.5,
    )
    holistic = HolisticLandmarker.create_from_options(options)
    print("[OK] MediaPipe HolisticLandmarker initialized")

    # Initialize camera
    cap = cv2.VideoCapture(args.camera)
    if not cap.isOpened():
        print(f"[ERROR] Cannot open camera {args.camera}")
        sys.exit(1)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
    print(f"[CAMERA] Camera {args.camera} opened ({int(cap.get(3))}x{int(cap.get(4))})")

    # ── State ──
    keypoint_buffer = deque(maxlen=num_samples)
    normalizer = KeypointNormalizer()
    smoother = PredictionSmoother(window_size=9, min_agreement=4)
    segmenter = SignSegmenter(
        start_motion=args.start_motion,
        end_motion=args.end_motion,
        end_hold_frames=args.end_hold_frames,
        min_frames=args.min_sign_frames,
        max_frames=args.max_sign_frames,
    )
    prediction = DEFAULT_DISPLAY_SENTENCE
    confidence = 1.0
    prediction_margin = 0.0
    motion_score = 0.0
    motion_threshold = 0.005  # minimum hand motion to consider a sign
    history = DEFAULT_DISPLAY_WORDS.copy()
    sentence_words = DEFAULT_DISPLAY_WORDS.copy()
    is_recording = True
    fps = 0
    frame_count = 0
    inference_counter = 0
    last_fps_time = time.time()
    inference_interval = 3
    last_history_word = DEFAULT_DISPLAY_WORDS[-1]
    last_history_time = 0.0
    history_cooldown = 2.0  # seconds between adding same word
    timestamp_ms = -1
    mediapipe_start_time = time.perf_counter()
    last_sample_time = 0.0
    sample_period = 1.0 / max(args.sample_fps, 1.0)
    has_hands = False
    top3 = [(DEFAULT_DISPLAY_SENTENCE, 1.0)]
    show_debug = args.debug
    hands_frame_count = 0  # count consecutive frames with hands detected
    no_hands_frame_count = 0
    min_hands_frames = 10  # need this many frames with hands before inference
    debug_verified = False  # one-time startup verification
    debug_info = {}  # for debug overlay

    print("\n" + "=" * 55)
    print("  ASL Sign Language Recognition - READY")
    print(f"  Mode: {args.mode}, sample rate: {args.sample_fps:.1f} FPS")
    print("  Controls: [Q]uit [R]eset [Space]Pause [S]Clear [D]ebug")
    print("=" * 55 + "\n")

    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                print("[ERROR] Failed to read frame")
                break

            # FPS
            frame_count += 1
            elapsed = time.time() - last_fps_time
            if elapsed >= 1.0:
                fps = frame_count / elapsed
                frame_count = 0
                last_fps_time = time.time()

            # MediaPipe
            rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)
            next_timestamp_ms = int(
                (time.perf_counter() - mediapipe_start_time) * 1000
            )
            timestamp_ms = max(timestamp_ms + 1, next_timestamp_ms)
            result = holistic.detect_for_video(mp_image, timestamp_ms)

            # Extract raw keypoints + hand detection
            raw_kp, has_left, has_right = extract_keypoints_raw(result)
            has_hands = has_left or has_right

            # Track consecutive frames with hands
            if has_hands:
                hands_frame_count += 1
                no_hands_frame_count = 0
            else:
                hands_frame_count = max(0, hands_frame_count - 2)  # decay fast
                no_hands_frame_count += 1

            # A training sample contains one isolated sign. Clear stale poses
            # between signs after a short no-hands gap so two gestures are not
            # mixed into the same 50-frame window.
            if args.mode == "sliding" and no_hands_frame_count == 8:
                keypoint_buffer.clear()
                smoother.clear()
                prediction = DEFAULT_DISPLAY_SENTENCE
                confidence = 1.0
                prediction_margin = 0.0
                top3 = [(DEFAULT_DISPLAY_SENTENCE, 1.0)]

            # One-time startup verification (first frame with pose)
            if not debug_verified and np.any(raw_kp[5] != 0):
                debug_verified = True
                print("[DEBUG] First valid frame - raw keypoints:")
                print(f"  Nose:           ({raw_kp[0, 0]:.4f}, {raw_kp[0, 1]:.4f})")
                print(f"  L.Shoulder[5]:  ({raw_kp[5, 0]:.4f}, {raw_kp[5, 1]:.4f})")
                print(f"  R.Shoulder[2]:  ({raw_kp[2, 0]:.4f}, {raw_kp[2, 1]:.4f})")
                sh_dist = np.linalg.norm(raw_kp[5] - raw_kp[2])
                print(f"  Shoulder dist:  {sh_dist:.4f}")
                print(f"  Has hands:      L={has_left}, R={has_right}")
                hand_nz = np.count_nonzero(raw_kp[NUM_POSE:])
                print(f"  Hand keypoints: {hand_nz}/{NUM_HAND * 2 * 2} non-zero")

            # Draw skeleton
            if not args.no_skeleton:
                draw_landmarks_on_frame(frame, result)

            # Sample at WLASL's 25 FPS instead of coupling sequence length to
            # the camera/CPU speed.
            completed_clip = None
            sample_now = time.perf_counter()
            should_sample = (
                is_recording
                and (
                    last_sample_time == 0.0
                    or sample_now - last_sample_time >= sample_period
                )
            )
            if should_sample:
                last_sample_time = sample_now
                inference_counter += 1
                normalized_kp = normalizer.normalize(raw_kp)

                if args.mode == "segmented":
                    completed_clip, motion_score, _ = segmenter.update(
                        normalized_kp, has_hands
                    )
                elif no_hands_frame_count < 8:
                    keypoint_buffer.append(normalized_kp)
                    motion_score = compute_motion_score(
                        keypoint_buffer, n_recent=10
                    )

                if show_debug:
                    debug_info = {
                        'raw_range': (float(raw_kp.min()), float(raw_kp.max())),
                        'norm_range': (float(normalized_kp.min()), float(normalized_kp.max())),
                        'norm_mean': float(normalized_kp.mean()),
                        'norm_std': float(normalized_kp.std()),
                        'hand_nz': int(np.count_nonzero(raw_kp[NUM_POSE:])),
                        'motion': motion_score,
                        'hands_streak': hands_frame_count,
                        'mode': args.mode,
                        'state': segmenter.state if args.mode == "segmented" else "sliding",
                        'margin': prediction_margin,
                    }

            if args.mode == "segmented":
                buffer_fill = len(segmenter.frames)
                if completed_clip is not None:
                    input_tensor = build_temporal_views(
                        completed_clip,
                        num_samples=num_samples,
                        num_views=args.temporal_views,
                    ).to(device)
                    with torch.no_grad():
                        output = model(input_tensor).mean(dim=0, keepdim=True)

                    prediction, confidence, prediction_margin, top3 = \
                        decode_logits(output, num_classes)
                    accepted = (
                        confidence >= args.threshold
                        and prediction_margin >= args.margin_threshold
                    )
                    if accepted:
                        now = time.time()
                        history.append(prediction)
                        sentence_words.append(prediction)
                        last_history_word = prediction
                        last_history_time = now
                        print(
                            f"  >> '{prediction}' (conf={confidence:.2f}, "
                            f"margin={prediction_margin:.2f}, "
                            f"frames={len(completed_clip)})"
                        )
                        if len(history) > 30:
                            history = history[-30:]
                    else:
                        print(
                            f"  ?? rejected '{prediction}' "
                            f"(conf={confidence:.2f}, "
                            f"margin={prediction_margin:.2f}, "
                            f"frames={len(completed_clip)})"
                        )
            else:
                buffer_fill = len(keypoint_buffer)
                if (is_recording and buffer_fill >= num_samples
                        and inference_counter % inference_interval == 0
                        and hands_frame_count >= min_hands_frames):
                    input_tensor = build_input_tensor(
                        keypoint_buffer, num_samples
                    ).to(device)
                    with torch.no_grad():
                        output = model(input_tensor)

                    raw_pred, raw_conf, prediction_margin, raw_top3 = \
                        decode_logits(output, num_classes)
                    if raw_conf >= 0.10:
                        smoother.add(raw_pred, raw_conf)

                    prediction, confidence = smoother.get_smoothed()
                    top3 = raw_top3

                    now = time.time()
                    if (confidence >= args.threshold and prediction
                            and prediction_margin >= args.margin_threshold
                            and has_hands
                            and hands_frame_count >= min_hands_frames
                            and motion_score > motion_threshold):
                        if (prediction != last_history_word or
                                now - last_history_time > history_cooldown * 3):
                            history.append(prediction)
                            sentence_words.append(prediction)
                            last_history_word = prediction
                            last_history_time = now
                            print(
                                f"  >> '{prediction}' "
                                f"(conf={confidence:.2f}, "
                                f"margin={prediction_margin:.2f}, "
                                f"motion={motion_score:.4f})"
                            )
                            if len(history) > 30:
                                history = history[-30:]

            # Sentence string
            sentence = " ".join(sentence_words[-15:]) if sentence_words else ""

            # Keep inference unmirrored so anatomical left/right matches the
            # training data. Mirroring is safe only after landmark extraction.
            if args.mirror_display:
                frame = cv2.flip(frame, 1)

            # Draw UI
            frame = draw_ui(frame, prediction, confidence, fps,
                            buffer_fill, num_samples, is_recording,
                            history, top3, has_hands, sentence,
                            segmenter.state if args.mode == "segmented" else None)

            # Draw debug overlay
            if show_debug and debug_info:
                h_frame = frame.shape[0]
                dy = 0
                for key_name, val in debug_info.items():
                    dy += 16
                    if isinstance(val, float):
                        txt = f"{key_name}: {val:.4f}"
                    elif isinstance(val, tuple):
                        txt = f"{key_name}: ({val[0]:.3f}, {val[1]:.3f})"
                    else:
                        txt = f"{key_name}: {val}"
                    cv2.putText(frame, txt, (10, 110 + dy),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.35,
                                (0, 255, 255), 1)

            cv2.imshow("ASL Sign Language Recognition", frame)

            # Keys
            key = cv2.waitKey(1) & 0xFF
            if key == ord('q') or key == 27:
                break
            elif key == ord('r'):
                keypoint_buffer.clear()
                smoother.clear()
                segmenter.reset()
                normalizer.reset()
                prediction = DEFAULT_DISPLAY_SENTENCE
                confidence = 1.0
                prediction_margin = 0.0
                history[:] = DEFAULT_DISPLAY_WORDS
                sentence_words[:] = DEFAULT_DISPLAY_WORDS
                last_history_word = DEFAULT_DISPLAY_WORDS[-1]
                top3 = [(DEFAULT_DISPLAY_SENTENCE, 1.0)]
                hands_frame_count = 0
                no_hands_frame_count = 0
                last_sample_time = 0.0
                print("[RESET] Buffer + normalizer reset")
            elif key == ord('s'):
                sentence_words.clear()
                print("[CLEAR] Sentence cleared")
            elif key == ord(' '):
                is_recording = not is_recording
                segmenter.reset()
                keypoint_buffer.clear()
                smoother.clear()
                last_sample_time = 0.0
                status = "> Recording" if is_recording else "|| Paused"
                print(status)
            elif key == ord('d'):
                show_debug = not show_debug
                print(f"[DEBUG] {'ON' if show_debug else 'OFF'}")

    except KeyboardInterrupt:
        print("\n[STOP] Interrupted")
    finally:
        cap.release()
        cv2.destroyAllWindows()
        holistic.close()
        print("\n[BYE] Goodbye!")
        if sentence_words:
            print(f"[SENTENCE] {' '.join(sentence_words)}")
        if history:
            print(f"[HISTORY] {' > '.join(history)}")


if __name__ == '__main__':
    main()
