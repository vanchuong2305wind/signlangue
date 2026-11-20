"""Command names and old filename aliases; importing this never runs a job."""

COMMANDS = {
    "viesign-labels": ("scripts/data_v2_viesign/build_labels.py", "Tạo nhãn bổ sung từ CSV Kaggle"),
    "viesign-original": ("scripts/data_v2_viesign/extract_original.py", "Landmark bộ gốc 1.182 mục từ"),
    "viesign-additional": ("scripts/data_v2_viesign/extract_additional.py", "Landmark bộ bổ sung 2.334 mục từ"),
    "viesign-merge": ("scripts/data_v2_viesign/merge.py", "Chờ và gộp hai bộ landmark"),
    "viesign-background": ("scripts/data_v2_viesign/run_background.py", "Chạy tác vụ VieSign nền trên Linux"),
    "serve-api": ("scripts/runtime/serve_api.py", "Chạy API, tự chọn port trống"),
    "asl-v1-extract": ("scripts/data_v1_asl/landmarks_v1/extract_hands.py", "ASL cũ: trích xuất hai bàn tay"),
    "asl-v2-extract": ("scripts/data_v1_asl/landmarks_v2/extract_holistic.py", "ASL cũ: trích xuất Holistic"),
    "asl-v2-preprocess": ("scripts/data_v1_asl/landmarks_v2/preprocess.py", "ASL cũ: làm mượt landmark"),
    "asl-v2-cache": ("scripts/data_v1_asl/landmarks_v2/build_cache.py", "ASL cũ: tạo/nén cache từng từ"),
    "asl-map-vi": ("scripts/data_v1_asl/dictionary/create_vi_en_mapping.py", "ASL cũ: ánh xạ Việt/Anh"),
    "asl-translate-dictionary": ("scripts/data_v1_asl/dictionary/translate_sign_dictionary.py", "ASL cũ: dịch key từ điển"),
    "asl-translate-labels": ("scripts/data_v1_asl/dictionary/translate_to_vietnamese.py", "ASL cũ: dịch nhãn tiếng Anh"),
    "asl-video-urls": ("scripts/data_v1_asl/videos/extract_urls.py", "ASL cũ: lập danh sách URL video"),
    "asl-video-cloudinary": ("scripts/data_v1_asl/videos/migrate_cloudinary.py", "ASL cũ: đưa video lên Cloudinary"),
    "asl-video-youtube": ("scripts/data_v1_asl/videos/migrate_youtube.py", "ASL cũ: chuyển video YouTube"),
    "asl-video-validate": ("scripts/data_v1_asl/videos/validate_links.py", "ASL cũ: kiểm tra và lọc link video"),
    "asl-video-check": ("scripts/data_v1_asl/videos/check_other_links.py", "ASL cũ: thống kê link khác/local"),
    "asl-video-remove-local": ("scripts/data_v1_asl/videos/remove_local_links.py", "ASL cũ: bỏ link video local"),
}

# A single dispatcher accepts earlier filenames without retaining 19 wrappers
# in the scripts/ root. Background --script aliases are handled by its launcher.
ALIASES = {
    "build_viesign_additional_labels.py": "viesign-labels",
    "extract_viesign_landmarks.py": "viesign-original",
    "extract_viesign_additional_landmarks.py": "viesign-additional",
    "merge_viesign_landmarks.py": "viesign-merge",
    "run_viesign_background.py": "viesign-background",
    "serve_viesign.py": "serve-api",
    "extract_hand_landmarks.py": "asl-v1-extract",
    "extract_holistic_landmarks.py": "asl-v2-extract",
    "preprocess_landmarks.py": "asl-v2-preprocess",
    "build_landmark_cache.py": "asl-v2-cache",
    "create_vi_en_mapping.py": "asl-map-vi",
    "translate_sign_dictionary.py": "asl-translate-dictionary",
    "translate_to_vietnamese.py": "asl-translate-labels",
    "extract_video_urls.py": "asl-video-urls",
    "migrate_to_cloudinary.py": "asl-video-cloudinary",
    "migrate_youtube.py": "asl-video-youtube",
    "validate_video_links.py": "asl-video-validate",
    "_check_others.py": "asl-video-check",
    "_remove_local.py": "asl-video-remove-local",
}


def resolve_command(name):
    return COMMANDS[ALIASES.get(name, name)]
