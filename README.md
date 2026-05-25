# 🤟 SignLang - Ứng dụng Học Ngôn ngữ Ký hiệu

Web app hỗ trợ học ngôn ngữ ký hiệu với giao diện **Liquid Glass (Glassmorphism)**.

## Tính năng

- 📚 **Học ký hiệu qua Video** - 2000+ từ vựng ASL với video
- 🎤 **Giọng nói → Ký hiệu** - Dịch giọng nói thành ký hiệu (Phase 2)
- 📷 **Camera → Nhận diện** - Nhận diện ký hiệu bằng camera (Phase 4)
- 🎮 **Gamification** - Theo dõi tiến độ học (Phase 3)

## Tech Stack

- **Frontend**: Vite + React
- **Backend**: Python FastAPI
- **AI**: MediaPipe, Gemini API
- **Data**: WLASL v0.3 (2000 glosses, 11,980 videos)

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
scripts/          # Data processing scripts
```

## License

MIT
 python -c "import uvicorn; uvicorn.run('app.api.server:app', host='0.0.0.0', port=8000, reload=False)"