"""
Script dịch tất cả từ tiếng Anh trong sign_dictionary_landmarks.json sang tiếng Việt
Tạo 2 file:
  - gloss_to_vi.json: Anh -> Việt (book -> sách)
  - vi_to_gloss.json: Việt -> Anh (sách -> book)
"""

import json
import sys
import time
from googletrans import Translator

# Fix encoding
sys.stdout.reconfigure(encoding='utf-8')

# Đọc danh sách từ
print("Đang đọc sign_dictionary_landmarks.json...")
with open('d:/CLB_AI/Duan/data/processed/sign_dictionary_landmarks.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

glosses = sorted(data.keys())
print(f"Tổng số từ cần dịch: {len(glosses)}")

# Khởi tạo translator
translator = Translator()
gloss_to_vi = {}
errors = []

print("\nBắt đầu dịch...")
for i, word in enumerate(glosses):
    try:
        result = translator.translate(word, src='en', dest='vi')
        vietnamese = result.text.lower().strip()
        gloss_to_vi[word] = vietnamese

        # In tiến trình mỗi 50 từ
        if (i + 1) % 50 == 0:
            print(f"  Đã dịch: {i + 1}/{len(glosses)} từ... (vừa dịch: {word} -> {vietnamese})")
            time.sleep(0.3)  # Nghỉ chút để tránh bị chặn

    except Exception as e:
        print(f"  ⚠ Lỗi dịch '{word}': {e}")
        gloss_to_vi[word] = word  # Giữ nguyên tiếng Anh nếu lỗi
        errors.append(word)

# Tạo map ngược: Việt -> Anh
print("\nĐang tạo bản đồ ngược (Việt -> Anh)...")
vi_to_gloss = {}
for eng, vie in gloss_to_vi.items():
    vi_to_gloss[vie] = eng

# Lưu file
print("\nĐang lưu file...")
with open('d:/CLB_AI/Duan/data/processed/gloss_to_vi.json', 'w', encoding='utf-8') as f:
    json.dump(gloss_to_vi, f, ensure_ascii=False, indent=2)

with open('d:/CLB_AI/Duan/data/processed/vi_to_gloss.json', 'w', encoding='utf-8') as f:
    json.dump(vi_to_gloss, f, ensure_ascii=False, indent=2)

print("\n✓ Hoàn thành!")
print(f"  gloss_to_vi.json: {len(gloss_to_vi)} từ")
print(f"  vi_to_gloss.json: {len(vi_to_gloss)} từ")
if errors:
    print(f"  Số từ lỗi (giữ nguyên tiếng Anh): {len(errors)}")

print("\nMột số ví dụ:")
for eng, vie in list(gloss_to_vi.items())[:20]:
    print(f"  {eng:20s} -> {vie}")
