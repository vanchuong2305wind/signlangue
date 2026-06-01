"""Quick check: what does HolisticLandmarkerResult actually look like?"""
import cv2
import numpy as np
import mediapipe as mp
from mediapipe.tasks.python import BaseOptions
from mediapipe.tasks.python.vision import (
    HolisticLandmarker, HolisticLandmarkerOptions, HolisticLandmarkerResult,
)
from mediapipe.tasks.python.vision.core.vision_task_running_mode import VisionTaskRunningMode

options = HolisticLandmarkerOptions(
    base_options=BaseOptions(model_asset_path="models/holistic_landmarker.task"),
    running_mode=VisionTaskRunningMode.VIDEO,
)
holistic = HolisticLandmarker.create_from_options(options)

cap = cv2.VideoCapture(0)
timestamp_ms = 0
found = False

for _ in range(60):  # try up to 60 frames
    ret, frame = cap.read()
    if not ret:
        break
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    timestamp_ms += 33
    result = holistic.detect_for_video(mp_image, timestamp_ms)

    if result.pose_landmarks and len(result.pose_landmarks) > 0:
        print(f"=== pose_landmarks ===")
        print(f"  type: {type(result.pose_landmarks)}")
        print(f"  len:  {len(result.pose_landmarks)}")
        print(f"  [0] type: {type(result.pose_landmarks[0])}")
        
        # Check if [0] is a list or a landmark
        first = result.pose_landmarks[0]
        if hasattr(first, 'x'):
            print(f"  [0] is a NormalizedLandmark: x={first.x:.4f}, y={first.y:.4f}")
            print(f"  → FLAT list of landmarks")
            if len(result.pose_landmarks) > 11:
                lm11 = result.pose_landmarks[11]
                print(f"  [11] (left_shoulder): x={lm11.x:.4f}, y={lm11.y:.4f}")
        else:
            print(f"  [0] is a LIST/container, len={len(first)}")
            print(f"  → NESTED list (per-person)")
            if hasattr(first[0], 'x'):
                print(f"  [0][0] NormalizedLandmark: x={first[0].x:.4f}, y={first[0].y:.4f}")
                if len(first) > 11:
                    print(f"  [0][11] (left_shoulder): x={first[11].x:.4f}, y={first[11].y:.4f}")

        # Check hands
        if result.left_hand_landmarks and len(result.left_hand_landmarks) > 0:
            print(f"\n=== left_hand_landmarks ===")
            print(f"  type: {type(result.left_hand_landmarks)}")
            print(f"  len:  {len(result.left_hand_landmarks)}")
            print(f"  [0] type: {type(result.left_hand_landmarks[0])}")
            lh0 = result.left_hand_landmarks[0]
            if hasattr(lh0, 'x'):
                print(f"  [0] is NormalizedLandmark: x={lh0.x:.4f}, y={lh0.y:.4f}")
                print(f"  → FLAT list")
            else:
                print(f"  [0] is LIST, len={len(lh0)}")
                print(f"  → NESTED list")
                if hasattr(lh0[0], 'x'):
                    print(f"  [0][0]: x={lh0[0].x:.4f}, y={lh0[0].y:.4f}")

        found = True
        break

if not found:
    print("No pose detected in 60 frames. Make sure you're visible to camera.")

cap.release()
holistic.close()
print("\nDONE")
