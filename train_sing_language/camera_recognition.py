"""
Real-time ASL Sign Language Recognition from Camera
Uses pre-trained TGCN model + MediaPipe Tasks API (holistic landmarker).

Pipeline:
  Camera -> MediaPipe (55 keypoints) -> Normalize -> Buffer 50 frames -> TGCN -> ASL word

Usage:
  python camera_recognition.py
  python camera_recognition.py --variant asl100 --camera 0 --threshold 0.3
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
# TGCN expects 55 keypoints:
#   13 upper-body pose landmarks + 21 left hand + 21 right hand = 55
POSE_INDICES = [
    0,   # nose
    2,   # left_eye
    5,   # right_eye
    7,   # left_ear
    8,   # right_ear
    11,  # left_shoulder
    12,  # right_shoulder
    13,  # left_elbow
    14,  # right_elbow
    15,  # left_wrist
    16,  # right_wrist
    23,  # left_hip
    24,  # right_hip
]
NUM_POSE = len(POSE_INDICES)   # 13
NUM_HAND = 21                   # per hand
NUM_KEYPOINTS = NUM_POSE + NUM_HAND * 2  # 13 + 21 + 21 = 55

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
    """Maintains running statistics for stable keypoint normalization.

    Uses EMA (exponential moving average) of shoulder distance to avoid
    jitter in normalization scale between frames.
    """

    def __init__(self, ema_alpha=0.3):
        self.ema_alpha = ema_alpha
        self.running_shoulder_dist = None
        self.running_center = None
        self.prev_keypoints = None  # for EMA smoothing of keypoints
        self.kp_smooth_alpha = 0.5  # keypoint EMA factor

    def normalize(self, keypoints):
        """Normalize keypoints using shoulder-centered, shoulder-scaled coords.

        Args:
            keypoints: (55, 2) raw keypoint array

        Returns:
            (55, 2) normalized keypoint array
        """
        result = keypoints.copy()

        # Get shoulder positions (indices 5, 6 in our 13-pose mapping)
        left_shoulder = keypoints[5]
        right_shoulder = keypoints[6]

        has_shoulders = np.any(left_shoulder != 0) and np.any(right_shoulder != 0)

        if has_shoulders:
            center = (left_shoulder + right_shoulder) / 2.0
            shoulder_dist = float(np.linalg.norm(left_shoulder - right_shoulder))

            if shoulder_dist > 0.01:
                # Update running statistics with EMA
                if self.running_shoulder_dist is None:
                    self.running_shoulder_dist = shoulder_dist
                    self.running_center = center.copy()
                else:
                    self.running_shoulder_dist = (
                        self.ema_alpha * shoulder_dist
                        + (1 - self.ema_alpha) * self.running_shoulder_dist
                    )
                    self.running_center = (
                        self.ema_alpha * center
                        + (1 - self.ema_alpha) * self.running_center
                    )

        # Apply normalization using running stats
        if self.running_shoulder_dist is not None and self.running_shoulder_dist > 0.01:
            mask = np.any(result != 0, axis=1)
            result[mask] = (
                (result[mask] - self.running_center) / self.running_shoulder_dist
            )
            # Clip extreme values to avoid outliers
            result = np.clip(result, -5.0, 5.0)

        # EMA smooth keypoints to reduce jitter
        if self.prev_keypoints is not None:
            # Only smooth non-zero keypoints that were also non-zero before
            curr_mask = np.any(result != 0, axis=1)
            prev_mask = np.any(self.prev_keypoints != 0, axis=1)
            smooth_mask = curr_mask & prev_mask
            result[smooth_mask] = (
                self.kp_smooth_alpha * result[smooth_mask]
                + (1 - self.kp_smooth_alpha) * self.prev_keypoints[smooth_mask]
            )

        self.prev_keypoints = result.copy()
        return result

    def reset(self):
        self.running_shoulder_dist = None
        self.running_center = None
        self.prev_keypoints = None


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
    model.load_state_dict(state_dict, strict=False)
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

    # Pose landmarks (flat list of 33 NormalizedLandmark)
    if result.pose_landmarks and len(result.pose_landmarks) > 0:
        for i, idx in enumerate(POSE_INDICES):
            if idx < len(result.pose_landmarks):
                lm = result.pose_landmarks[idx]
                keypoints[i] = [lm.x, lm.y]

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
    while len(frames) < num_samples:
        frames.append(np.zeros((NUM_KEYPOINTS, 2), dtype=np.float32))
    frames = frames[-num_samples:]

    stacked = np.stack(frames, axis=0)  # (50, 55, 2)
    feature = np.zeros((NUM_KEYPOINTS, num_samples * 2), dtype=np.float32)
    for t in range(num_samples):
        feature[:, t * 2] = stacked[t, :, 0]      # x
        feature[:, t * 2 + 1] = stacked[t, :, 1]  # y

    return torch.FloatTensor(feature).unsqueeze(0)  # (1, 55, 100)


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
        hand_curr = recent[i][NUM_POSE:, :]
        hand_prev = recent[i - 1][NUM_POSE:, :]
        diff = np.linalg.norm(hand_curr - hand_prev, axis=1)
        diffs.append(np.mean(diff))

    return float(np.mean(diffs))


# ─── Drawing ────────────────────────────────────────────────────────────────
def draw_ui(frame, prediction, confidence, fps, buffer_fill, num_samples,
            is_recording, history, top3=None, has_hands=False, sentence=""):
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
    status_text = "* REC" if is_recording else "|| PAUSED"
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
        for i, (word, count) in enumerate(top3):
            y_pos = panel_y + 35 + i * 25
            bar_len = int(count / 7 * 120)
            bar_color = [(0, 255, 100), (0, 200, 255), (100, 150, 255)][min(i, 2)]
            cv2.rectangle(frame, (panel_x, y_pos - 10),
                          (panel_x + bar_len, y_pos + 2), bar_color, -1)
            cv2.putText(frame, f"{word} ({count})", (panel_x + bar_len + 5, y_pos),
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
        for i, idx in enumerate(POSE_INDICES):
            if idx < len(result.pose_landmarks):
                lm = result.pose_landmarks[idx]
                px, py = to_pixel(lm)
                pose_pts[i] = (px, py)
                cv2.circle(frame, (px, py), 4, (0, 255, 200), -1)
        idx_map = {orig: i for i, orig in enumerate(POSE_INDICES)}
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
    parser.add_argument("--variant", type=str, default="asl2000")
    parser.add_argument("--camera", type=int, default=0)
    parser.add_argument("--threshold", type=float, default=0.25)
    parser.add_argument("--checkpoint-dir", type=str, default="checkpoints")
    parser.add_argument("--no-skeleton", action="store_true")
    parser.add_argument("--device", type=str, default="auto")
    parser.add_argument("--holistic-model", type=str,
                        default="models/holistic_landmarker.task")
    parser.add_argument("--debug", action="store_true",
                        help="Show debug overlay with keypoint values")
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
    normalizer = KeypointNormalizer(ema_alpha=0.3)
    smoother = PredictionSmoother(window_size=9, min_agreement=4)
    prediction = None
    confidence = 0.0
    motion_score = 0.0
    motion_threshold = 0.005  # minimum hand motion to consider a sign
    history = []
    sentence_words = []
    is_recording = True
    fps = 0
    frame_count = 0
    last_fps_time = time.time()
    inference_interval = 3
    last_history_word = ""
    last_history_time = 0.0
    history_cooldown = 2.0  # seconds between adding same word
    timestamp_ms = 0
    has_hands = False
    top3 = []
    show_debug = args.debug
    hands_frame_count = 0  # count consecutive frames with hands detected
    min_hands_frames = 10  # need this many frames with hands before inference
    debug_verified = False  # one-time startup verification
    debug_info = {}  # for debug overlay

    print("\n" + "=" * 55)
    print("  ASL Sign Language Recognition - READY")
    print("  Controls: [Q]uit [R]eset [Space]Pause [S]Clear [D]ebug")
    print("=" * 55 + "\n")

    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                print("[ERROR] Failed to read frame")
                break

            frame = cv2.flip(frame, 1)

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
            timestamp_ms += 33
            result = holistic.detect_for_video(mp_image, timestamp_ms)

            # Extract raw keypoints + hand detection
            raw_kp, has_left, has_right = extract_keypoints_raw(result)
            has_hands = has_left or has_right

            # Track consecutive frames with hands
            if has_hands:
                hands_frame_count += 1
            else:
                hands_frame_count = max(0, hands_frame_count - 2)  # decay fast

            motion_score = compute_motion_score(keypoint_buffer, n_recent=10)

            # One-time startup verification (first frame with pose)
            if not debug_verified and np.any(raw_kp[5] != 0):
                debug_verified = True
                print("[DEBUG] First valid frame - raw keypoints:")
                print(f"  Nose:           ({raw_kp[0, 0]:.4f}, {raw_kp[0, 1]:.4f})")
                print(f"  L.Shoulder[5]:  ({raw_kp[5, 0]:.4f}, {raw_kp[5, 1]:.4f})")
                print(f"  R.Shoulder[6]:  ({raw_kp[6, 0]:.4f}, {raw_kp[6, 1]:.4f})")
                sh_dist = np.linalg.norm(raw_kp[5] - raw_kp[6])
                print(f"  Shoulder dist:  {sh_dist:.4f}")
                print(f"  Has hands:      L={has_left}, R={has_right}")
                hand_nz = np.count_nonzero(raw_kp[NUM_POSE:])
                print(f"  Hand keypoints: {hand_nz}/{NUM_HAND * 2 * 2} non-zero")

            # Draw skeleton
            if not args.no_skeleton:
                draw_landmarks_on_frame(frame, result)

            # Normalize and buffer keypoints
            if is_recording:
                normalized_kp = normalizer.normalize(raw_kp)
                keypoint_buffer.append(normalized_kp)

                # Store debug info
                if show_debug:
                    debug_info = {
                        'raw_range': (float(raw_kp.min()), float(raw_kp.max())),
                        'norm_range': (float(normalized_kp.min()), float(normalized_kp.max())),
                        'norm_mean': float(normalized_kp[normalized_kp != 0].mean()) if np.any(normalized_kp != 0) else 0,
                        'norm_std': float(normalized_kp[normalized_kp != 0].std()) if np.any(normalized_kp != 0) else 0,
                        'shoulder_dist': normalizer.running_shoulder_dist or 0,
                        'hand_nz': int(np.count_nonzero(normalized_kp[NUM_POSE:])),
                        'motion': motion_score,
                        'hands_streak': hands_frame_count,
                    }

            # Inference - only when we have enough frames AND hands have been detected
            buffer_fill = len(keypoint_buffer)
            if (is_recording and buffer_fill >= num_samples
                    and frame_count % inference_interval == 0
                    and hands_frame_count >= min_hands_frames):
                input_tensor = build_input_tensor(keypoint_buffer, num_samples)
                input_tensor = input_tensor.to(device)

                with torch.no_grad():
                    output = model(input_tensor)
                    probs = torch.softmax(output, dim=1)
                    conf, pred_idx = torch.max(probs, dim=1)
                    raw_conf = conf.item()
                    pred_class = pred_idx.item()

                raw_pred = get_label(pred_class)

                # Only feed to smoother if confidence is above minimum
                if raw_conf >= 0.10:
                    smoother.add(raw_pred, raw_conf)

                prediction, confidence = smoother.get_smoothed()
                top3 = smoother.get_top3()

                # Add to history (stricter criteria)
                now = time.time()
                if (confidence >= args.threshold and prediction
                        and has_hands
                        and hands_frame_count >= min_hands_frames
                        and motion_score > motion_threshold):
                    if (prediction != last_history_word or
                            now - last_history_time > history_cooldown * 3):
                        history.append(prediction)
                        sentence_words.append(prediction)
                        last_history_word = prediction
                        last_history_time = now
                        print(f"  >> '{prediction}' (conf={confidence:.2f}, motion={motion_score:.4f})")
                        if len(history) > 30:
                            history = history[-30:]

            # Sentence string
            sentence = " ".join(sentence_words[-15:]) if sentence_words else ""

            # Draw UI
            frame = draw_ui(frame, prediction, confidence, fps,
                            buffer_fill, num_samples, is_recording,
                            history, top3, has_hands, sentence)

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
                normalizer.reset()
                prediction = None
                confidence = 0.0
                history.clear()
                last_history_word = ""
                top3 = []
                hands_frame_count = 0
                print("[RESET] Buffer + normalizer reset")
            elif key == ord('s'):
                sentence_words.clear()
                print("[CLEAR] Sentence cleared")
            elif key == ord(' '):
                is_recording = not is_recording
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
