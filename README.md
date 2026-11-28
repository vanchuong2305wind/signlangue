# 🤟 SignLang - Ứng dụng Học Ngôn ngữ Ký hiệu

Web app hỗ trợ học ngôn ngữ ký hiệu với giao diện **Liquid Glass (Glassmorphism)**.

## Tính năng

- 📚 **Học ký hiệu qua Video** - Dữ liệu ký hiệu Việt Nam VieSign
- 🎤 **Giọng nói → Ký hiệu** - Dịch giọng nói thành ký hiệu (Phase 2)
- 📷 **Camera → Nhận diện** - Nhận diện ký hiệu bằng camera (Phase 4)
- 🎮 **Gamification** - Theo dõi tiến độ học (Phase 3)

## Tech Stack

- **Frontend**: Vite + React
- **Backend**: Python FastAPI
- **AI**: `VSL224-Hiera-RGB` (camera 224 lớp, Git LFS), `faster-whisper` (ASR offline fallback), `underthesea` + PhoBERT (`local_nlp.py`), Gemini API (tùy chọn)
- **Data**: VieSign, bộ landmark Việt Nam đã gộp 3.393 mục từ; WLASL/ASL cũ lưu riêng

## Quyền riêng tư & Chế độ Offline

- Chi tiết đối chiếu mã–tài liệu, luồng dữ liệu gửi dịch vụ ngoài và chính sách lưu/xóa dữ liệu xem tại [PRIVACY_AND_SYNC_AUDIT.md](PRIVACY_AND_SYNC_AUDIT.md).
- Đặt `OFFLINE_ONLY=1` trong `.env` để chặn toàn bộ lời gọi ra dịch vụ ngoài (Gemini API, tải phụ đề YouTube/video).
- Kiểm tra cấu hình quyền riêng tư runtime qua `GET /api/privacy/status`; xóa lịch sử theo loại qua `DELETE /api/profile/activities?activity_type=recognition|translation` hoặc xóa toàn bộ hồ sơ trên đĩa qua `DELETE /api/profile`.

## Cài đặt

```bash
# Frontend
cd app/frontend
npm install
npm run dev

# Backend
pip install -r requirements.txt
python -m app.api.server
```

## Cấu trúc

```
app/
├── api/          # FastAPI backend
├── frontend/     # Vite + React (Liquid Glass UI)
data/
├── archive/      # WLASL dataset + videos
├── processed/    # Processed dictionaries
scripts/
├── data_v2_viesign/ # Pipeline ký hiệu Việt Nam đang dùng
├── data_v1_asl/     # Công cụ WLASL/ASL cũ, chia theo phiên bản landmark
├── runtime/        # Chạy API
└── run.py          # Liệt kê/chạy tác vụ
```

Xem [hướng dẫn các script](scripts/README.md) hoặc chạy `python scripts/run.py --help`.

## License

MIT
 python -c "import uvicorn; uvicorn.run('app.api.server:app', host='0.0.0.0', port=8000, reload=False)"
