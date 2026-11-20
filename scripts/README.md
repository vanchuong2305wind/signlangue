# Script theo phiên bản dữ liệu

Dùng `data_v2_viesign/` cho dữ liệu ký hiệu Việt Nam hiện tại. `data_v1_asl/`
giữ các công cụ WLASL/ASL cũ để tra cứu hoặc bảo trì dữ liệu lịch sử.
Trong nhóm ASL, `landmarks_v1` và `landmarks_v2` là hai đời trích xuất landmark
của cùng bộ dữ liệu cũ, không phải bộ VieSign mới.

## Cấu trúc

```text
scripts/
├── run.py                         # Một lệnh để liệt kê/chạy các tác vụ
├── _commands.py                   # Danh sách tác vụ và tên gọi cũ
├── data_v2_viesign/                # ĐANG DÙNG: ký hiệu Việt Nam
│   ├── requirements.txt           # Thư viện cho .venv-landmarks
│   ├── build_labels.py            # Nhãn bổ sung từ Kaggle
│   ├── extract_original.py        # Bộ gốc: 1.182 mục từ
│   ├── extract_additional.py      # Bổ sung: 2.334 mục từ
│   ├── merge.py                   # Kiểm tra, gộp và chọn bộ đang dùng
│   └── run_background.py          # Chạy các tác vụ trên nền Linux
├── runtime/
│   └── serve_api.py               # API; chọn port khác nếu port đã bận
└── data_v1_asl/                    # CŨ: WLASL/ASL
    ├── landmarks_v1/
    │   └── extract_hands.py        # Hai bàn tay, tọa độ tương đối cổ tay
    ├── landmarks_v2/
    │   ├── extract_holistic.py     # Holistic cơ thể/bàn tay/khuôn mặt
    │   ├── preprocess.py          # Làm mượt, nội suy
    │   └── build_cache.py         # Cache JSON theo từ
    ├── dictionary/
    │   ├── create_vi_en_mapping.py
    │   ├── translate_sign_dictionary.py
    │   └── translate_to_vietnamese.py
    └── videos/
        ├── extract_urls.py
        ├── migrate_cloudinary.py
        ├── migrate_youtube.py
        ├── validate_links.py
        ├── check_other_links.py
        └── remove_local_links.py
```

## Chọn đúng script

Chạy từ gốc dự án. Lệnh `--plan` chỉ đọc và kiểm tra đầu vào, không trích xuất.

| Mục đích | Tác vụ | Đầu ra |
|---|---|---|
| Tạo nhãn cho video chưa có trong bộ gốc | `viesign-labels` | `data_v2/annotations/` |
| Trích xuất bộ gốc 1.182 mục từ | `viesign-original` | `data_v2/processed/` |
| Trích xuất bổ sung 2.334 mục từ | `viesign-additional` | `data_v2/processed_additional/` |
| Gộp hai bộ đã xử lý | `viesign-merge` | `data_v2/processed_merged/` và `active_dataset.json` |
| Chạy tác vụ độc lập với SSH | `viesign-background` | PID/log trong `data_v2/runs/` |
| Chạy API trên port trống | `serve-api` | In ra địa chỉ/port được chọn |

Local PowerShell:

```powershell
.\.venv-landmarks\Scripts\python.exe -m pip install -r scripts/data_v2_viesign/requirements.txt
.\.venv-landmarks\Scripts\python.exe scripts/run.py --help
.\.venv-landmarks\Scripts\python.exe scripts/run.py viesign-original --plan
.\.venv-landmarks\Scripts\python.exe scripts/run.py viesign-additional --plan
```

Server Linux:

```bash
.venv-landmarks/bin/python scripts/run.py viesign-background
.venv-landmarks/bin/python scripts/run.py viesign-background --job-name additional --script additional
.venv-landmarks/bin/python scripts/run.py viesign-background --job-name merge --script merge --wait
```

Các lệnh nền tiếp tục dùng output/khóa/trạng thái cũ để resume; việc sắp xếp
script không di chuyển dữ liệu hay tạo lại landmark. Bộ đã gộp hiện có 3.393
mục từ, được chọn qua `data_v2/active_dataset.json`.

## Dùng lại tên script cũ

Tên file cũ được nhận qua dispatcher, ví dụ:

```powershell
python scripts/run.py extract_viesign_landmarks.py --plan
python scripts/run.py merge_viesign_landmarks.py --help
```

Lệnh trực tiếp `python scripts/extract_viesign_landmarks.py ...` cần đổi sang
`python scripts/run.py viesign-original ...`, hoặc đường dẫn mới
`python scripts/data_v2_viesign/extract_original.py ...`.
Giá trị `--script extract_viesign_landmarks.py`,
`--script extract_viesign_additional_landmarks.py`, `--script merge_viesign_landmarks.py`
vẫn được launcher nền nhận như trước. `requirements-landmarks.txt` cũ chuyển
thành `scripts/data_v2_viesign/requirements.txt`.

Nhóm `data_v1_asl` đọc/ghi bộ `data/` cũ và các file video ASL tĩnh. Một số công
cụ trong đó dịch nhãn, thay đổi danh sách video hoặc upload lên Cloudinary;
không dùng chúng để cập nhật bộ ký hiệu Việt Nam hiện tại. Xem danh sách bằng
`python scripts/run.py --help`; xem file và mô tả bằng `python scripts/run.py asl-video-cloudinary --help`.

Hướng dẫn pipeline chi tiết: [VIESIGN_LANDMARKS.md](../docs/VIESIGN_LANDMARKS.md).
