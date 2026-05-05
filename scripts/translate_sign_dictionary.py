"""
translate_sign_dictionary.py
-----------------------------
Chuyển đổi key trong sign_dictionary_landmarks.json từ tiếng Anh sang tiếng Việt.

Quy tắc:
  - Các từ kỹ thuật như "left", "right", "left_hand", "right_hand"
    → GIỮ NGUYÊN (không dịch)
  - Các key tiếng Anh khác  → dịch sang tiếng Việt, thay space bằng "_"
  - Nếu Google Translate lỗi → giữ nguyên tiếng Anh, ghi vào failed_words.txt

Cache:
  - Mỗi lần dịch xong lưu cache vào translation_cache.json
  - Lần sau chạy lại sẽ đọc cache, không gọi API lại

Output:
  data/processed/sign_dictionary_landmarks_vi.json  ← file chính
  data/processed/translation_cache.json             ← cache en→vi
  data/processed/failed_words.txt                   ← từ dịch thất bại
"""

import json
import time
from pathlib import Path

# ─────────────────────────────────────────────
# CÁC TỪ GIỮ NGUYÊN (không dịch)
# ─────────────────────────────────────────────
KEEP_AS_IS = {
    # hướng tay — dùng trong cấu trúc dữ liệu landmarks
    'left', 'right', 'left_hand', 'right_hand',
    # tên riêng, thương hiệu, chữ viết tắt
    'bowling', 'thanksgiving', 'iloveyou', 'halloween',
    'valentine', 'christmas', 'birthday',
    # chữ cái (fingerspelling)
    'a','b','c','d','e','f','g','h','i','j','k','l','m',
    'n','o','p','q','r','s','t','u','v','w','x','y','z',
}

# ─────────────────────────────────────────────
# OVERRIDE THỦ CÔNG (dịch tự động có thể sai)
# ─────────────────────────────────────────────
MANUAL_OVERRIDE = {
    'fine':      'tốt',
    'can':       'có_thể',
    'go':        'đi',
    'like':      'thích',
    'cool':      'mát',
    'hearing':   'nghe',
    'finish':    'xong',
    'later':     'sau',
    'before':    'trước',
    'all':       'tất_cả',
    'now':       'bây_giờ',
    'who':       'ai',
    'what':      'cái_gì',
    'no':        'không',
    'yes':       'có',
    'man':       'đàn_ông',
    'woman':     'phụ_nữ',
    'thin':      'gầy',
    'tall':      'cao',
    'hot':       'nóng',
    'black':     'đen',
    'blue':      'xanh',
    'white':     'trắng',
    'orange':    'màu_cam',
    'walk':      'đi_bộ',
    'study':     'học',
    'help':      'giúp',
    'kiss':      'hôn',
    'deaf':      'điếc',
    'graduate':  'tốt_nghiệp',
    'language':  'ngôn_ngữ',
    'family':    'gia_đình',
    'mother':    'mẹ',
    'many':      'nhiều',
    'year':      'năm',
    'book':      'sách',
    'drink':     'uống',
    'computer':  'máy_tính',
    'chair':     'ghế',
    'clothes':   'quần_áo',
    'candy':     'kẹo',
    'cousin':    'anh_em_họ',
    'table':     'bàn',
    'bed':       'giường',
    'dog':       'chó',
    'fish':      'cá',
    'hat':       'mũ',
    'shirt':     'áo',
    'man':       'đàn_ông',
}


def load_cache(cache_path: Path) -> dict:
    if cache_path.exists():
        with open(cache_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {}


def save_cache(cache_path: Path, cache: dict):
    with open(cache_path, 'w', encoding='utf-8') as f:
        json.dump(cache, f, ensure_ascii=False, indent=2)


def translate_word(word: str, translator, cache: dict, cache_path: Path) -> str:
    """
    Dịch một từ tiếng Anh sang tiếng Việt.
    Ưu tiên: cache → KEEP_AS_IS → MANUAL_OVERRIDE → Google Translate
    """
    # Đã có trong cache
    if word in cache:
        return cache[word]

    # Giữ nguyên
    if word.lower() in KEEP_AS_IS:
        cache[word] = word
        save_cache(cache_path, cache)
        return word

    # Override thủ công
    if word.lower() in MANUAL_OVERRIDE:
        vi = MANUAL_OVERRIDE[word.lower()]
        cache[word] = vi
        save_cache(cache_path, cache)
        return vi

    # Gọi Google Translate
    try:
        result = translator.translate(word, src='en', dest='vi')
        vi = result.text.lower().replace(' ', '_')
        cache[word] = vi
        save_cache(cache_path, cache)
        time.sleep(0.3)   # tránh bị rate-limit
        return vi
    except Exception as e:
        print(f"  ⚠ Không dịch được '{word}': {e}")
        cache[word] = word   # giữ nguyên nếu lỗi
        save_cache(cache_path, cache)
        return word


def translate_dictionary(
    input_path: str,
    output_path: str,
    cache_path: str,
    failed_path: str,
):
    from googletrans import Translator
    translator = Translator()

    input_p  = Path(input_path)
    output_p = Path(output_path)
    cache_p  = Path(cache_path)
    failed_p = Path(failed_path)

    print(f"[*] Doc file goc: {input_p}")
    with open(input_p, 'r', encoding='utf-8') as f:
        data = json.load(f)
    print(f"    Tong so ky hieu: {len(data)}")

    cache = load_cache(cache_p)
    print(f"    Cache hien co: {len(cache)} tu")

    translated_data = {}
    failed_words    = []

    total = len(data)
    for idx, (en_key, value) in enumerate(data.items(), 1):
        vi_key = translate_word(en_key, translator, cache, cache_p)

        # Phát hiện từ dịch thất bại (trả về y chang tiếng Anh và không trong KEEP_AS_IS)
        if vi_key == en_key and en_key.lower() not in KEEP_AS_IS and en_key.lower() not in MANUAL_OVERRIDE:
            failed_words.append(en_key)

        # Tránh trùng key sau khi dịch
        if vi_key in translated_data:
            vi_key = f"{vi_key}__{en_key}"

        translated_data[vi_key] = value

        # Log tiến độ mỗi 100 từ
        if idx % 100 == 0 or idx == total:
            print(f"    [{idx:4d}/{total}] {en_key:25s} -> {vi_key}")

    # Lưu file đầu ra
    output_p.parent.mkdir(parents=True, exist_ok=True)
    with open(output_p, 'w', encoding='utf-8') as f:
        json.dump(translated_data, f, ensure_ascii=False, indent=2)

    # Lưu danh sách từ dịch thất bại
    if failed_words:
        with open(failed_p, 'w', encoding='utf-8') as f:
            for w in sorted(failed_words):
                f.write(f"{w}\n")

    # Tổng kết
    print("\n" + "=" * 50)
    print(f"[*] HOAN THANH!")
    print(f"    Dau ra          : {output_p}")
    print(f"    Cache           : {cache_p}  ({len(cache)} muc)")
    print(f"    Giu nguyen      : {len(KEEP_AS_IS)} tu ky thuat (left, right, ...)")
    print(f"    Dich that bai   : {len(failed_words)} tu -> {failed_p}")
    print("=" * 50)


if __name__ == '__main__':
    BASE = Path('data/processed')

    translate_dictionary(
        input_path  = str(BASE / 'sign_dictionary_landmarks.json'),
        output_path = str(BASE / 'sign_dictionary_landmarks_vi.json'),
        cache_path  = str(BASE / 'translation_cache.json'),
        failed_path = str(BASE / 'failed_words.txt'),
    )
