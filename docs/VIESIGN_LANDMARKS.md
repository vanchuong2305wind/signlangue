# Landmark ký hiệu Việt Nam cho avatar 3D

Ứng dụng đọc `data_v2/processed/catalog.json` và các file trong
`data_v2/processed/landmarks/`. Không đọc hoặc dự phòng bằng từ điển ASL cũ.
Các file ASL vẫn giữ trên ổ đĩa để tránh xóa dữ liệu ngoài phạm vi yêu cầu.

## Quy tắc xử lý

- Dùng `ISLR_447_all_rows.csv`: 7.664 video có nhãn, 1.182 nghĩa gốc.
- Chuẩn hóa Unicode NFC, chữ thường, khoảng trắng và dấu `_`; giữ dấu tiếng Việt.
- Mỗi nghĩa có một ID ASCII ổn định dựa trên SHA-256, một file landmark và một video đại diện.
- Trích xuất mọi video cùng nhãn; chọn video có điểm phủ cơ thể/bàn tay cao nhất.
  Điểm này đánh giá khả năng trích xuất, chưa xác nhận nội dung ký hiệu đúng về ngôn ngữ.
- Chỉ xuất bản mẫu có pose_world và tay đồng thời ở ít nhất 35% frame.
  Từ không có mẫu đạt yêu cầu được ghi trong state, không lấy ASL để thay thế.
- Giữ `pose` (33), `pose_world` (33), hai tay (21 điểm mỗi tay), `face_blendshapes`.
  Dùng cùng hàm làm mượt/nội suy/giảm dung lượng mà avatar đang đọc.
- Giữ FPS thực sau lấy mẫu; tối đa 25 FPS, không đổi nhãn thời gian video.
- Không suy đoán nghĩa cho 2.889 video ngoài manifest, không tự gán vùng miền.
- Catalog và state ghi qua file tạm rồi thay thế nguyên tử; mỗi output có khóa hệ điều hành.
  Lần chạy sau bỏ qua các video đã xử lý nếu model, tham số và nguồn không đổi.

## Local

```powershell
python -m venv .venv-landmarks
.\.venv-landmarks\Scripts\python.exe -m pip install -r scripts/requirements-landmarks.txt
.\.venv-landmarks\Scripts\python.exe scripts/extract_viesign_landmarks.py --plan
.\.venv-landmarks\Scripts\python.exe scripts/extract_viesign_landmarks.py --word 12 --output data_v2/runs/local-smoke
```

Model Holistic được tải từ kho model chính thức của Google vào `data_v2/models/`.
Môi trường MediaPipe tách khỏi `.venv` để không thay thư viện ứng dụng.
Holistic mặc định chạy CPU; tên GPU server không có nghĩa pipeline này tự dùng CUDA.

## Server: chạy tiếp sau khi ngắt SSH hoặc tắt máy local

Chỉ thực hiện trong `~/Documents/sign-lang/signlangue`:

```bash
python3 -m venv .venv-landmarks
.venv-landmarks/bin/python -m pip install -r scripts/requirements-landmarks.txt
.venv-landmarks/bin/python scripts/extract_viesign_landmarks.py --plan
.venv-landmarks/bin/python scripts/run_viesign_background.py
```

Nếu server báo thiếu `ensurepip`, dùng `virtualenv` có trong môi trường hiện tại
thay cho lệnh tạo `venv` (không cần cài gói hệ thống hay thay `.venv`):

```bash
mkdir -p data_v2/runs
.venv/bin/python -m virtualenv --no-download --app-data data_v2/runs/virtualenv-cache .venv-landmarks
.venv-landmarks/bin/python -m pip install -r scripts/requirements-landmarks.txt
```

Launcher dùng session riêng, stdin đóng, stdout/stderr ghi log. Không mở port.
`data_v2/runs/latest_job.json` ghi PID/log; `data_v2/processed/progress.json` ghi
từ hiện tại, số từ đã xuất bản, lỗi, trạng thái hoàn thành. `state/*.json` ghi các
video đã thử và lý do mẫu thất bại. Video và landmark sinh ra không đưa lên Git.

```bash
cat data_v2/runs/latest_job.json
cat data_v2/processed/progress.json
```

Nếu server tắt/reboot, cần chạy lại launcher để tiếp tục. Một phiên SSH đóng không
làm dừng session đã tách; không cam kết tiếp tục khi máy server bị tắt.

## Ứng dụng và port

API mới đọc catalog đang được bổ sung, tối đa mỗi giây làm mới một lần.
Trang học/dịch lấy video qua `/api/dictionary/videos`, không dùng JSON ASL tĩnh.
Mẫu video và landmark của cùng một từ luôn lấy từ cùng video được chọn.
Nếu chưa có landmark Việt Nam, từ điển rỗng thay vì dùng ASL.
Mô hình camera WLASL là phần riêng, chưa được huấn luyện lại trong thay đổi này.

Không dừng dịch vụ đang chiếm port. Để chạy **thêm** API mới, dùng:

```bash
LOCAL_AI_PRELOAD=0 .venv/bin/python scripts/serve_viesign.py --port 8000
```

Script giữ socket trống rồi chuyển trực tiếp cho Uvicorn; nếu 8000 bận sẽ chọn
8001, 8002… Dịch vụ cũ đã nạp code vào bộ nhớ không tự đổi sang code mới chỉ vì
`git pull`. Cần chủ động chuyển frontend/proxy sang API mới hoặc khởi động lại
dịch vụ theo lịch riêng; script trích xuất không làm việc đó.

Tham khảo model/API: https://developers.google.com/edge/mediapipe/solutions/vision/holistic_landmarker

## Chạy song song phần bổ sung, sau đó tự gộp

Giữ nguyên tác vụ 1.182 từ đang chạy và đầu vào của nó. Luồng thứ hai đọc
`data_v2/annotations/viesign_missing_labels.csv`: 2.392 video / 2.334 nghĩa sau
chuẩn hóa. Tra video theo ID trong bản dataset đầy đủ trên server, không dùng
đường dẫn local trong CSV. Giữ nhãn nguồn, trạng thái chờ xác minh; không tự gán
Signer hoặc vùng miền. Các nhãn này do người dùng chọn đưa vào xử lý, chưa phải
nhãn đã được kiểm duyệt nội dung clip.

```bash
.venv-landmarks/bin/python scripts/extract_viesign_additional_landmarks.py --plan
.venv-landmarks/bin/python scripts/run_viesign_background.py --job-name additional --script extract_viesign_additional_landmarks.py
.venv-landmarks/bin/python scripts/run_viesign_background.py --job-name merge --script merge_viesign_landmarks.py --wait
```

- Luồng gốc: `data_v2/processed/`, job cũ vẫn ở `data_v2/runs/latest_job.json`.
- Luồng mới: `data_v2/processed_additional/`, PID/log ở `data_v2/runs/jobs/additional.json`.
- Tác vụ chờ gộp: `data_v2/processed_merged/progress.json`, PID/log ở `data_v2/runs/jobs/merge.json`.
- Hai luồng trích xuất và tác vụ chờ đều chạy session riêng, không mở port.

Chương trình gộp chỉ đọc nguồn khi cả hai có trạng thái `complete` hoặc
`complete_with_failures`, và đã lấy được khóa thư mục của cả hai nguồn. Nếu một
luồng bị gián đoạn, chương trình tiếp tục chờ; cần chạy tiếp luồng đó bằng lệnh
cũ của nó. Không gộp bộ đang viết dở, không sửa hay xóa hai bộ nguồn.

Kết quả được sao chép độc lập sang `data_v2/processed_merged/release-<digest>/`.
Kiểm tra từng file: ID/nghĩa/video phải khớp catalog, landmark đúng kích thước,
tọa độ hữu hạn, có frame cơ thể và tay. Nếu nghĩa bị trùng, chọn mẫu điểm cao
hơn; một video bị gán hai nghĩa khác nhau sẽ làm bước gộp dừng để kiểm tra.
Sau khi toàn bộ kết quả đã đạt kiểm tra, `data_v2/active_dataset.json` được thay
nguyên tử để API mới chuyển sang bộ gộp. Giữ dấu vết nhãn chờ xác minh trong
landmark/catalog và báo cáo, không tự đổi sang trạng thái đã kiểm duyệt.

Tổng mục từ dự kiến là 3.516; số xuất bản có thể ít hơn nếu clip không đạt chất
lượng trích xuất. Xem số thực và lỗi trong `merge_report.json` của release.
Tác vụ gộp tự kết thúc sau khi xuất bản; chạy lại cùng đầu vào sẽ dùng lại release.
Thêm luồng chỉ nhanh hơn nếu server còn đủ tài nguyên CPU/RAM.

```bash
cat data_v2/processed/progress.json
cat data_v2/processed_additional/progress.json
cat data_v2/processed_merged/progress.json
```
