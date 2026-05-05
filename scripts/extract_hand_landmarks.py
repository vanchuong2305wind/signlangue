"""
Script trích xuất 42 tọa độ landmarks bàn tay (21 điểm × 2 tay) từ video WLASL
Sử dụng MediaPipe Hands để phát hiện và trích xuất landmarks
"""

import cv2
import mediapipe as mp
import json
import os
from pathlib import Path
from tqdm import tqdm

# Khởi tạo MediaPipe Hands
mp_hands = mp.solutions.hands
hands = mp_hands.Hands(
    static_image_mode=False,
    max_num_hands=2,
    min_detection_confidence=0.5,
    min_tracking_confidence=0.5
)

def normalize_hand_landmarks(landmarks):
    """
    Chuẩn hóa landmarks về gốc tọa độ tại cổ tay (landmark[0])
    Đưa tất cả tọa độ về tương đối so với điểm cổ tay
    """
    if not landmarks or len(landmarks) == 0:
        return None

    # Lấy tọa độ cổ tay (landmark 0) làm gốc
    wrist = landmarks[0]
    wrist_x, wrist_y, wrist_z = wrist['x'], wrist['y'], wrist['z']

    # Dịch chuyển tất cả điểm về gốc tọa độ
    normalized = []
    for lm in landmarks:
        normalized.append({
            "x": lm['x'] - wrist_x,
            "y": lm['y'] - wrist_y,
            "z": lm['z'] - wrist_z
        })

    return normalized

def calculate_video_quality_score(frames_data):
    """
    Tính điểm chất lượng video dựa trên:
    - Số frame có detect được tay
    - Tính ổn định của detection
    """
    if not frames_data:
        return 0

    detected_frames = 0
    for frame in frames_data:
        if frame['left_hand'] or frame['right_hand']:
            detected_frames += 1

    # Tỷ lệ frame có detect được tay
    detection_rate = detected_frames / len(frames_data)
    return detection_rate

def extract_landmarks_from_video(video_path):
    """
    Trích xuất landmarks từ một video với chuẩn hóa tọa độ
    Returns: list of frames, mỗi frame chứa landmarks đã chuẩn hóa của 2 tay
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return None

    frames_data = []

    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            break

        # Chuyển BGR sang RGB
        frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

        # Xử lý với MediaPipe
        results = hands.process(frame_rgb)

        frame_landmarks = {
            "left_hand": None,
            "right_hand": None
        }

        if results.multi_hand_landmarks and results.multi_handedness:
            for hand_landmarks, handedness in zip(results.multi_hand_landmarks, results.multi_handedness):
                # Xác định tay trái hay phải
                hand_label = handedness.classification[0].label  # "Left" hoặc "Right"

                # Trích xuất 21 landmarks (x, y, z)
                landmarks = []
                for landmark in hand_landmarks.landmark:
                    landmarks.append({
                        "x": landmark.x,
                        "y": landmark.y,
                        "z": landmark.z
                    })

                # Chuẩn hóa về gốc tọa độ tại cổ tay
                normalized_landmarks = normalize_hand_landmarks(landmarks)

                if hand_label == "Left":
                    frame_landmarks["left_hand"] = normalized_landmarks
                else:
                    frame_landmarks["right_hand"] = normalized_landmarks

        frames_data.append(frame_landmarks)

    cap.release()
    return frames_data

def process_wlasl_dataset(json_path, videos_dir, output_dir):
    """
    Xử lý toàn bộ dataset WLASL
    """
    # Đọc file JSON metadata
    with open(json_path, 'r', encoding='utf-8') as f:
        wlasl_data = json.load(f)

    # Tạo thư mục output
    os.makedirs(output_dir, exist_ok=True)

    # Dictionary lưu kết quả
    sign_dictionary = {}

    print(f"Bắt đầu xử lý {len(wlasl_data)} từ ký hiệu...")

    for sign_entry in tqdm(wlasl_data):
        gloss = sign_entry['gloss']  # Từ ký hiệu (vd: "book", "hello")

        best_video_data = None
        best_score = -1
        best_video_id = None
        best_fps = 25

        # Tìm video tốt nhất cho từ này (có tỷ lệ detect tay cao nhất)
        for instance in sign_entry['instances']:
            video_id = instance['video_id']
            video_filename = f"{video_id}.mp4"
            video_path = os.path.join(videos_dir, video_filename)

            # Kiểm tra video có tồn tại không
            if not os.path.exists(video_path):
                continue

            # Trích xuất landmarks
            landmarks_data = extract_landmarks_from_video(video_path)

            if landmarks_data:
                score = calculate_video_quality_score(landmarks_data)

                # Cập nhật nếu video này tốt hơn
                if score > best_score:
                    best_score = score
                    best_video_data = landmarks_data
                    best_video_id = video_id
                    best_fps = instance.get('fps', 25)

                    # Nếu tỷ lệ detect > 90% thì đủ tốt rồi, không cần test các video khác của từ này để tiết kiệm thời gian
                    if score > 0.9:
                        break

        # Chỉ lưu lại video tốt nhất cho mỗi từ
        if best_video_data and best_score > 0.1: # Bỏ qua nếu từ đó không detect được tay (< 10%)
            sign_dictionary[gloss] = {
                "video_id": best_video_id,
                "score": round(best_score, 3),
                "fps": best_fps,
                "frames": best_video_data
            }

    # Lưu kết quả ra file JSON
    output_path = os.path.join(output_dir, 'sign_dictionary_landmarks.json')
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(sign_dictionary, f, ensure_ascii=False, indent=2)

    print(f"\nHoàn thành! Đã lưu vào: {output_path}")
    total_words = len(sign_dictionary)
    skipped_words = len(wlasl_data) - total_words
    print(f"Tổng số từ ký hiệu có landmarks: {total_words}")
    print(f"Số từ bị bỏ qua (không detect được tay): {skipped_words}")

if __name__ == "__main__":
    # Đường dẫn
    BASE_DIR = Path(__file__).parent.parent
    JSON_PATH = BASE_DIR / "data" / "archive" / "WLASL_v0.3.json"
    VIDEOS_DIR = BASE_DIR / "data" / "archive" / "videos"
    OUTPUT_DIR = BASE_DIR / "data" / "processed"

    process_wlasl_dataset(
        json_path=str(JSON_PATH),
        videos_dir=str(VIDEOS_DIR),
        output_dir=str(OUTPUT_DIR)
    )
