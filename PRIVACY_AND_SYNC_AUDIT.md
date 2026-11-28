# Bảng Đối Chiếu Mã – Tài Liệu & Chính Sách Quyền Riêng Tư

Tài liệu này tổng hợp kết quả rà soát đối chiếu giữa tài liệu dự án và mã nguồn thực tế trên nhánh `viesign-training-20261121`, đồng thời công khai luồng dữ liệu gửi dịch vụ ngoài và chính sách lưu/xóa lịch sử camera & giọng nói.

---

## 1. Bảng đối chiếu Mã nguồn – Tài liệu

| Hạng mục | Mô tả trong tài liệu cũ | Thực tế trong mã nguồn (`viesign-training-20261121`) | Trạng thái & Hành động đã xử lý |
| --- | --- | --- | --- |
| **ASR & Chế độ Offline** | `app/README.md` ghi chỉ dùng Web Speech API trên trình duyệt và *"không thể dùng offline"*, tham chiếu `app/js/*`, `app/styles/*`. | `app/api/asr.py` triển khai fallback offline `faster-whisper` (`large-v3-turbo` trên CUDA / `small` trên CPU) qua `POST /api/speech/transcribe`; `app/frontend/src/hooks/useSpeechRecognition.js` tự động chuyển sang Whisper khi gặp lỗi `network`; `app/api/local_nlp.py` có PhoBERT + `underthesea`. | **Đã đồng bộ** trong `app/README.md` và `README.md`. |
| **Mô hình & Checkpoint Camera** | `CAMERA_ACCURACY_PLAN.md` và nhánh `main` mô tả `WLASL100-I3D-Transformer` + `_trim_static_edges`; `main.tex` mô tả VSL 224 lớp (`trian_vls3`). | `app/api/camera_recognition.py` và `app/api/vsl_model.py` dùng `VSL224-Hiera-RGB` (`models/camera/vsl224/rgb-best.pt`, `labels.json`, 224 lớp, 16 khung, không dùng `_trim_static_edges`). `GET /api/camera/model-status` trả `VSL224-Hiera-RGB`. | **Khớp với `main.tex`** trên nhánh `viesign-training-20261121`. Lưu ý: file `.pt` phân phối qua **Git LFS** (`git lfs pull`). |
| **Gemini SDK & Model** | `docs.txt` ghi dùng Claude/GPT; `requirements.txt` chỉ liệt kê `google-genai`. | Cả `sentence_builder.py` (`gemini-3.6-flash`), `text_parser.py` (`gemini-flash-lite-latest`) và `cue_translate.py` (`gemini-flash-lite-latest`) đều đã thống nhất dùng `google-genai` qua `create_gemini_client()` và tuân thủ `OFFLINE_ONLY=1`. | **Đã đồng bộ** SDK `google-genai` và `OFFLINE_ONLY=1`. |
| **Bảo mật CORS & Origin** | `server.py` từng mở `CORSMiddleware(allow_origins=["*"])`. | `server.py` giới hạn `allow_origins` qua biến `ALLOWED_ORIGINS` (mặc định chỉ cho phép `localhost`/`127.0.0.1` cổng `5173` và `8000`). | **Đã siết** CORS whitelist mặc định local. |
| **Avatar 3D & Từ điển** | `docs.txt` ghi Ready Player Me + 12.000 video WLASL. | `app/frontend/src/components/avatar/AvatarScene3D.jsx` dùng VRM/Three.js; từ điển chính dùng VieSign (`data/`). | **Đã ghi nhận**; `docs.txt` mang tính bản nháp ý tưởng ban đầu. |
| **Lưu & Xóa lịch sử** | Chưa có tài liệu minh bạch chính sách lưu/xóa lịch sử camera & giọng nói. | `app/api/profile_store.py` lưu hoạt động vào `data/profile.json` (tối đa 1.000 mục); khung hình camera & audio mic chỉ xử lý trong RAM. | **Đã bổ sung** `DELETE /api/profile/activities?activity_type=...`, `DELETE /api/profile` và `GET /api/privacy/status`. |

---

## 2. Minh bạch dữ liệu gửi dịch vụ ngoài

| Dịch vụ ngoài | File nguồn gọi | Dữ liệu được gửi | Điều kiện kích hoạt | Cách tắt / Chặn hoàn toàn |
| --- | --- | --- | --- | --- |
| **Google Gemini API** (`text_parser.py`, `sentence_builder.py`, `cue_translate.py`) | `app/api/text_parser.py`, `app/api/sentence_builder.py`, `app/api/cue_translate.py` | Câu tiếng Việt cần tách từ, danh sách token ký hiệu từ camera, dòng phụ đề tiếng nước ngoài | Có `GEMINI_API_KEY` hợp lệ và `OFFLINE_ONLY=0` | Đặt `OFFLINE_ONLY=1` trong `.env` (hoặc bỏ `GEMINI_API_KEY`) → dùng fallback cục bộ (`local_nlp` / `build_sentence_local`). |
| **Web Speech API** (Trình duyệt) | `app/frontend/src/hooks/useSpeechRecognition.js` | Luồng audio microphone gửi tới máy chủ nhận diện của trình duyệt (Chrome/Edge) | Trình duyệt hỗ trợ và có kết nối mạng | Chặn mạng / dùng chế độ offline → tự chuyển sang `POST /api/speech/transcribe` (Whisper cục bộ). |
| **YouTube / `yt-dlp`** | `app/api/video_subtitles.py` | URL video do người dùng nhập để lấy phụ đề hoặc audio fallback | Người dùng dán URL vào trang Video Translate và `OFFLINE_ONLY=0` | Đặt `OFFLINE_ONLY=1` → từ chối gửi URL ra ngoài. |
| **HuggingFace Hub** | `app/api/asr.py`, `app/api/local_nlp.py` | Không gửi dữ liệu người dùng; chỉ tải trọng số model lần đầu nếu chưa có cache | Lần đầu khởi tạo Whisper / PhoBERT khi máy chưa cache | Đặt `LOCAL_AI_PRELOAD=0` hoặc tải sẵn model vào cache local trước khi chạy offline. |

---

## 3. Chính sách lưu trữ & xóa dữ liệu Camera / Giọng nói

- **Khung hình Camera (`/api/camera/recognize`):** Giải mã base64 và suy luận hoàn toàn **trong RAM** (`numpy` / `torch`). **Không** ghi ảnh hay video camera xuống đĩa.
- **Âm thanh Microphone (`/api/speech/transcribe`):** Đọc qua `io.BytesIO` **trong RAM** (giới hạn 20 MB/request). **Không** ghi file ghi âm microphone xuống đĩa.
- **Audio Video Fallback (`video_subtitles.py`):** Khi video không có sẵn phụ đề, audio tải tạm vào `tempfile.TemporaryDirectory(prefix="signlang-audio-")` và tự động xóa ngay khi kết thúc phiên đọc.
- **Lịch sử hoạt động (`data/profile.json`):** Chỉ lưu metadata học tập (`learned_word`, `video_view`, `translation`, `recognition`, `study_time`), giới hạn tối đa 1.000 mục gần nhất.
  - **Xóa chọn lọc theo loại:** `DELETE /api/profile/activities?activity_type=recognition` (lịch sử camera) hoặc `?activity_type=translation` (lịch sử dịch văn bản/giọng nói).
  - **Xóa toàn bộ lịch sử:** `DELETE /api/profile/activities`.
  - **Xóa sạch hồ sơ trên đĩa:** `DELETE /api/profile` (xóa hẳn file `data/profile.json`).
  - **Kiểm tra trạng thái minh bạch:** `GET /api/privacy/status`.
