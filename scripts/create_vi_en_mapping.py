"""
Script tạo file ánh xạ Tiếng Việt → Gloss (mã ký hiệu ASL)
Dùng Google Translate để tự động dịch 2000 từ trong WLASL sang tiếng Việt
Kết quả: vi_to_gloss.json
"""

import json
import os
import sys
import time
from pathlib import Path
from googletrans import Translator

# Fix encoding cho Windows terminal
sys.stdout.reconfigure(encoding='utf-8')

def create_mapping(landmarks_json_path, output_dir):
    """
    Đọc danh sách gloss từ sign_dictionary_landmarks.json
    Dịch từng từ tiếng Anh → tiếng Việt
    Lưu thành 2 chiều: vi→en và en→vi
    """
    # Đọc danh sách từ
    with open(landmarks_json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    glosses = sorted(data.keys())
    print(f"Tổng số từ cần dịch: {len(glosses)}")

    translator = Translator()

    # Ánh xạ Việt → Gloss (1 từ Việt có thể map tới 1 gloss)
    vi_to_gloss = {}
    # Ánh xạ ngược Gloss → Việt (để dễ tra cứu)
    gloss_to_vi = {}

    # Dịch theo batch nhỏ để tránh bị chặn
    batch_size = 50
    for i in range(0, len(glosses), batch_size):
        batch = glosses[i:i + batch_size]
        print(f"Đang dịch batch {i // batch_size + 1}/{(len(glosses) - 1) // batch_size + 1} ({len(batch)} từ)...")

        for word in batch:
            try:
                result = translator.translate(word, src='en', dest='vi')
                vi_word = result.text.lower().strip()

                # Lưu ánh xạ 2 chiều
                vi_to_gloss[vi_word] = word
                gloss_to_vi[word] = vi_word

            except Exception as e:
                print(f"  Lỗi dịch '{word}': {e}")
                # Nếu lỗi, giữ nguyên từ gốc
                gloss_to_vi[word] = word
                vi_to_gloss[word] = word

        # Nghỉ giữa các batch để tránh bị rate limit
        time.sleep(1)

    # Tạo thư mục output
    os.makedirs(output_dir, exist_ok=True)

    # === File 1: vi_to_gloss.json ===
    # Dùng trong pipeline: nhận text tiếng Việt → tra ra gloss ASL
    vi_to_gloss_path = os.path.join(output_dir, 'vi_to_gloss.json')
    with open(vi_to_gloss_path, 'w', encoding='utf-8') as f:
        json.dump(vi_to_gloss, f, ensure_ascii=False, indent=2)

    # === File 2: gloss_to_vi.json ===
    # Dùng để tra ngược / hiển thị nghĩa tiếng Việt trên UI
    gloss_to_vi_path = os.path.join(output_dir, 'gloss_to_vi.json')
    with open(gloss_to_vi_path, 'w', encoding='utf-8') as f:
        json.dump(gloss_to_vi, f, ensure_ascii=False, indent=2)

    print(f"\nHoàn thành!")
    print(f"  vi_to_gloss.json : {len(vi_to_gloss)} từ  ({vi_to_gloss_path})")
    print(f"  gloss_to_vi.json : {len(gloss_to_vi)} từ  ({gloss_to_vi_path})")
    print(f"\nVí dụ:")
    samples = list(gloss_to_vi.items())[:10]
    for en, vi in samples:
        print(f"  {vi} → {en}")


if __name__ == "__main__":
    BASE_DIR = Path(__file__).parent.parent
    LANDMARKS_JSON = BASE_DIR / "data" / "processed" / "sign_dictionary_landmarks.json"
    OUTPUT_DIR = BASE_DIR / "data" / "processed"

    create_mapping(
        landmarks_json_path=str(LANDMARKS_JSON),
        output_dir=str(OUTPUT_DIR)
    )
