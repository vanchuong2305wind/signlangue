"""
Debug: Check what the actual camera pipeline is feeding into the model.
Captures a few frames via camera, normalizes them, and shows:
1. The raw keypoint values 
2. The normalized keypoint values
3. What the model predicts
4. Whether keypoints have meaningful temporal variation
"""
import os
import sys
import time
import cv2
import numpy as np
import torch
from collections import deque

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

# ─── Same constants as camera_recognition.py ─────
POSE_INDICES = [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24]
NUM_POSE = len(POSE_INDICES)
NUM_HAND = 21
NUM_KEYPOINTS = NUM_POSE + NUM_HAND * 2  # 55


def extract_keypoints_debug(result: HolisticLandmarkerResult):
    """Extract and normalize keypoints, also return raw for debugging."""
    raw = np.zeros((NUM_KEYPOINTS, 2), dtype=np.float32)
    
    if result.pose_landmarks and len(result.pose_landmarks) > 0:
        for i, idx in enumerate(POSE_INDICES):
            if idx < len(result.pose_landmarks):
                lm = result.pose_landmarks[idx]
                raw[i] = [lm.x, lm.y]

    if result.left_hand_landmarks and len(result.left_hand_landmarks) > 0:
        for j, lm in enumerate(result.left_hand_landmarks):
            if j < NUM_HAND:
                raw[NUM_POSE + j] = [lm.x, lm.y]

    if result.right_hand_landmarks and len(result.right_hand_landmarks) > 0:
        for j, lm in enumerate(result.right_hand_landmarks):
            if j < NUM_HAND:
                raw[NUM_POSE + NUM_HAND + j] = [lm.x, lm.y]

    # Normalize
    normalized = raw.copy()
    left_shoulder = normalized[5]
    right_shoulder = normalized[6]

    if np.any(left_shoulder) and np.any(right_shoulder):
        center = (left_shoulder + right_shoulder) / 2.0
        shoulder_dist = np.linalg.norm(left_shoulder - right_shoulder)
        if shoulder_dist > 0.01:
            mask = np.any(normalized != 0, axis=1)
            normalized[mask] = (normalized[mask] - center) / shoulder_dist

    return raw, normalized


def main():
    # Load model
    config = Config('checkpoints/checkpoints/asl2000/config.ini')
    num_classes = get_num_classes('asl2000')
    model = GCN_muti_att(
        input_feature=config.num_samples * 2,
        hidden_feature=config.hidden_size,
        num_class=num_classes,
        p_dropout=config.drop_p,
        num_stage=config.num_stages,
    )
    checkpoint = torch.load('checkpoints/checkpoints/asl2000/pytorch_model.bin', 
                          map_location='cpu', weights_only=False)
    state_dict = checkpoint.get('state_dict', checkpoint)
    model.load_state_dict(state_dict, strict=False)
    model.eval()
    print('[OK] Model loaded')

    # Init MediaPipe
    holistic_model = "models/holistic_landmarker.task"
    options = HolisticLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=holistic_model),
        running_mode=VisionTaskRunningMode.VIDEO,
        min_pose_detection_confidence=0.5,
        min_pose_landmarks_confidence=0.5,
        min_hand_landmarks_confidence=0.5,
    )
    holistic = HolisticLandmarker.create_from_options(options)
    print('[OK] MediaPipe initialized')

    # Camera
    cap = cv2.VideoCapture(0)
    if not cap.isOpened():
        print('[ERROR] Cannot open camera')
        sys.exit(1)
    
    num_samples = config.num_samples  # 50
    keypoint_buffer = deque(maxlen=num_samples)
    timestamp_ms = 0
    
    print('\nCollecting 80 frames... Show your hands and do a sign!')
    print('Press Q to quit early.\n')
    
    frame_count = 0
    raw_samples = []
    norm_samples = []
    
    while frame_count < 80:
        ret, frame = cap.read()
        if not ret:
            break
        
        frame = cv2.flip(frame, 1)
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        timestamp_ms += 33
        result = holistic.detect_for_video(mp_image, timestamp_ms)
        
        raw, normalized = extract_keypoints_debug(result)
        keypoint_buffer.append(normalized)
        raw_samples.append(raw)
        norm_samples.append(normalized)
        
        has_hands = (
            (result.left_hand_landmarks and len(result.left_hand_landmarks) > 0) or
            (result.right_hand_landmarks and len(result.right_hand_landmarks) > 0)
        )
        
        # Show frame with status
        cv2.putText(frame, f"Frame {frame_count}/80 {'[HANDS]' if has_hands else '[NO HANDS]'}", 
                    (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0) if has_hands else (0, 0, 255), 2)
        cv2.imshow("Debug Capture", frame)
        
        if cv2.waitKey(1) & 0xFF == ord('q'):
            break
        
        frame_count += 1
    
    cap.release()
    cv2.destroyAllWindows()
    holistic.close()
    
    # Analyze collected data
    raw_arr = np.array(raw_samples)   # (N, 55, 2)
    norm_arr = np.array(norm_samples) # (N, 55, 2)
    
    print(f"\n{'='*60}")
    print(f"Collected {len(raw_samples)} frames")
    print(f"{'='*60}")
    
    print(f"\n--- RAW Keypoint Statistics ---")
    print(f"  Range: [{raw_arr.min():.4f}, {raw_arr.max():.4f}]")
    print(f"  Mean: {raw_arr.mean():.4f}")
    print(f"  Std: {raw_arr.std():.4f}")
    
    # Check how many keypoints are non-zero
    nonzero_per_frame = np.count_nonzero(raw_arr.reshape(len(raw_samples), -1), axis=1)
    print(f"  Non-zero values per frame: mean={nonzero_per_frame.mean():.1f}, min={nonzero_per_frame.min()}, max={nonzero_per_frame.max()}")
    
    print(f"\n--- NORMALIZED Keypoint Statistics ---")
    print(f"  Range: [{norm_arr.min():.4f}, {norm_arr.max():.4f}]")
    print(f"  Mean: {norm_arr.mean():.4f}")
    print(f"  Std: {norm_arr.std():.4f}")
    
    # Check temporal variation (crucial!)
    print(f"\n--- Temporal Variation Analysis ---")
    if len(norm_samples) > 1:
        diffs = []
        for i in range(1, len(norm_samples)):
            diff = np.linalg.norm(norm_arr[i] - norm_arr[i-1])
            diffs.append(diff)
        diffs = np.array(diffs)
        print(f"  Frame-to-frame diff: mean={diffs.mean():.6f}, max={diffs.max():.6f}, min={diffs.min():.6f}")
        
        # Hand-specific motion
        hand_diffs = []
        for i in range(1, len(norm_samples)):
            hand_curr = norm_arr[i, NUM_POSE:, :]
            hand_prev = norm_arr[i-1, NUM_POSE:, :]
            diff = np.linalg.norm(hand_curr - hand_prev)
            hand_diffs.append(diff)
        hand_diffs = np.array(hand_diffs)
        print(f"  Hand motion: mean={hand_diffs.mean():.6f}, max={hand_diffs.max():.6f}")
    
    # Check specific keypoint values 
    print(f"\n--- Key Landmark Values (last frame, normalized) ---")
    names = ['nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear',
             'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
             'left_wrist', 'right_wrist', 'left_hip', 'right_hip']
    for i, name in enumerate(names):
        print(f"  {name:>15s}: ({norm_arr[-1, i, 0]:+.4f}, {norm_arr[-1, i, 1]:+.4f})")
    
    # Check hand landmarks (first few)
    print(f"  {'left_hand[0]':>15s}: ({norm_arr[-1, 13, 0]:+.4f}, {norm_arr[-1, 13, 1]:+.4f})")
    print(f"  {'right_hand[0]':>15s}: ({norm_arr[-1, 34, 0]:+.4f}, {norm_arr[-1, 34, 1]:+.4f})")
    
    # Run inference
    if len(keypoint_buffer) >= num_samples:
        print(f"\n--- Model Inference ---")
        frames = list(keypoint_buffer)[-num_samples:]
        stacked = np.stack(frames, axis=0)  # (50, 55, 2)
        feature = np.zeros((NUM_KEYPOINTS, num_samples * 2), dtype=np.float32)
        for t in range(num_samples):
            feature[:, t * 2] = stacked[t, :, 0]
            feature[:, t * 2 + 1] = stacked[t, :, 1]
        
        x = torch.FloatTensor(feature).unsqueeze(0)
        print(f"  Input tensor shape: {x.shape}")
        print(f"  Input range: [{x.min():.4f}, {x.max():.4f}]")
        print(f"  Input mean: {x.mean():.4f}, std: {x.std():.4f}")
        
        with torch.no_grad():
            output = model(x)
            probs = torch.softmax(output, dim=1)
            top5 = torch.topk(probs, 5, dim=1)
            print("  Top-5 predictions:")
            for i in range(5):
                idx = top5.indices[0][i].item()
                prob = top5.values[0][i].item()
                print(f"    {i+1}. '{get_label(idx)}' (class {idx}): {prob:.4f}")
    else:
        print(f"\nNot enough frames for inference (got {len(keypoint_buffer)}, need {num_samples})")


if __name__ == '__main__':
    main()
