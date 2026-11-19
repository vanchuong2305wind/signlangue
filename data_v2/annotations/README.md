# Nhãn bổ sung cho video VieSign chưa có trong manifest gốc

`viesign_missing_labels.csv` chỉ chứa video local **không có** trong
`ISLR_447_all_rows.csv`, được tìm thấy trong bảng nhãn Kaggle QIPEDC phiên bản 5.
Không ghi đè bảng nhãn cũ, không nhập tự động vào pipeline landmark đang chạy.

## Các file

- `viesign_missing_labels.csv`: một dòng trên mỗi video; không lặp `ID_video`.
- `viesign_label_groups.csv`: một dòng trên mỗi nghĩa đã chuẩn hóa; nhóm các video
  cùng nghĩa để bước trích xuất sau có thể chọn một bộ landmark cho mỗi từ.
- `viesign_unlabeled_remaining.csv`: các video chưa tìm được nhãn từ nguồn này.
- `sources/kaggle_qipedc_v5_label.csv`: bản CSV nguồn được dùng để đối chiếu.
- `summary.json`: số lượng, nguồn, phiên bản, checksum và thông tin xác minh.

## Đọc các cột

- `Meaning`: nghĩa tiếng Việt chuẩn hóa NFC, chữ thường, `_` thành khoảng trắng;
  giữ dấu tiếng Việt. `Source_label` giữ nguyên nhãn của nguồn.
- `Word_id`: ID ổn định cho nghĩa đã chuẩn hóa; có thể lặp giữa các video cùng từ.
- `Video_filename`: tên file local thật, giữ `.webm` hoặc `.mp4`.
- `Video_path`: đường dẫn tương đối với gốc dự án local. Nếu bố trí thư mục trên
  server khác, tra video theo `ID_video`/`Video_filename`, không đoán đường dẫn.
- `Source_video`, `Source_row_id`, `Source_dataset`, `Source_version`, `Source_url`:
  dấu vết để quay lại bảng Kaggle gốc.
- `Match_method=exact_video_id`: đối chiếu mã video, chưa so sánh nội dung clip.
- `Review_status=pending_video_verification`: cần xác minh video local đúng là
  video của nguồn trước khi nhập chính thức. Đây không phải nhãn do AI đoán.
- `Meaning_in_original_manifest=true`: cùng chuỗi nghĩa sau chuẩn hóa đã có trong
  bộ gốc; video này vẫn là mẫu bổ sung, không phải từ vựng mới. Giá trị `false`
  chưa bảo đảm là khái niệm mới vì có thể khác cách viết hoặc dùng từ đồng nghĩa.

Không suy đoán `Signer`, vùng miền, train/val/test hoặc thời lượng từ file Kaggle
vì nguồn nhãn này không cung cấp các trường đó. Không coi các từ khác dấu là một.

CSV dùng UTF-8 BOM để mở được tiếng Việt trong Excel. Tạo lại từ gốc dự án:

```powershell
.\.venv\Scripts\python.exe scripts/build_viesign_additional_labels.py
```

Nguồn: https://www.kaggle.com/datasets/aresusayhi/vsl-vietnamese-sign-languages/data
