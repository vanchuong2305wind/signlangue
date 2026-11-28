# SignLang App (`app/frontend` + `app/api`)

> **Lưu ý đồng bộ:** Kiến trúc hiện tại sử dụng **Vite + React** (`app/frontend/src/`) kết hợp **FastAPI** (`app/api/server.py`), thay thế hoàn toàn bản tĩnh `app/js/*` trước đây.

## Nhận diện giọng nói (Hybrid Online + Offline)

- **Khi có mạng:** Trình duyệt ưu tiên dùng Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition` trong `app/frontend/src/hooks/useSpeechRecognition.js`).
- **Khi mất mạng hoặc trình duyệt không hỗ trợ:** Frontend tự động chuyển sang ghi âm và gửi tới `POST /api/speech/transcribe` để chạy **Whisper offline** (`faster-whisper`, cấu hình `large-v3-turbo` trên GPU hoặc `small` trên CPU trong `app/api/asr.py`).
- **Kiểm soát dữ liệu ngoài:** Đặt `OFFLINE_ONLY=1` trong `.env` để vô hiệu hóa toàn bộ lời gọi ra Gemini API và tải phụ đề từ URL ngoài. Xem chi tiết tại [../PRIVACY_AND_SYNC_AUDIT.md](../PRIVACY_AND_SYNC_AUDIT.md).

---
*(Phần tài liệu tham khảo API sự kiện Web Speech bên dưới được giữ lại cho mục đích đối chiếu lịch sử)*

**Bước 2 / 5** trong pipeline chuyển giọng nói thành ngôn ngữ ký hiệu.

```
Giọng nói → [Text] → Chuỗi ký hiệu → Animation → Avatar 3D
            ↑ Bước này
```

## Tính năng

- ✅ Nhận diện giọng nói tiếng Việt real-time
- ✅ Web Speech API (Chrome/Edge) - miễn phí, không cần API key
- ✅ Lọc nhiễu tự động (confidence threshold, silence detection)
- ✅ Hiển thị interim text (mờ) và final text (rõ)
- ✅ Lịch sử văn bản với nút copy
- ✅ Output JSON cho Bước 3
- ✅ Keyboard shortcut: `Space` = toggle recording
- ✅ Accessibility: ARIA labels, screen reader support

## Yêu cầu

- **Trình duyệt:** Chrome hoặc Edge (Web Speech API)
- **Kết nối:** Internet (API cần kết nối Google servers)
- **Giao thức:** HTTPS hoặc `localhost` (microphone permission)

## Cách sử dụng

### 1. Mở file HTML

```bash
# Cách 1: Mở trực tiếp (chỉ hoạt động trên localhost)
open app/index.html

# Cách 2: Dùng local server (khuyến nghị)
cd app
python -m http.server 8000
# Mở: http://localhost:8000
```

### 2. Cấp quyền microphone

- Click nút "BẮT ĐẦU" hoặc nhấn `Space`
- Trình duyệt sẽ hỏi quyền truy cập microphone → chọn "Allow"

### 3. Nói tiếng Việt

- Nói rõ ràng, tốc độ bình thường
- Interim text (mờ) hiện khi đang nói
- Final text (rõ) hiện khi dừng
- Văn bản được lưu vào lịch sử

### 4. Copy kết quả

- Click nút "Copy" bên cạnh mỗi câu trong lịch sử
- Hoặc xem JSON output ở phần mở rộng bên dưới

## Tích hợp với Bước 3

Bước 3 (Text → Sign) có thể lắng nghe event:

```javascript
// Trong file của Bước 3:
window.addEventListener('speech:final', (e) => {
    const { text, confidence, timestamp, lang } = e.detail;
    
    // Feed vào tokenizer → LLM → Sign Dictionary
    processTextToSign(text);
});
```

### Các event có sẵn:

| Event | Payload | Mô tả |
|-------|---------|-------|
| `speech:interim` | `{ text }` | Text tạm thời khi đang nói |
| `speech:final` | `{ text, confidence, timestamp, lang }` | Text cuối cùng đã xác nhận |
| `speech:error` | `{ error, message }` | Lỗi xảy ra |
| `speech:silence` | `{ duration }` | Phát hiện im lặng >2s |
| `speech:state` | `{ state }` | Trạng thái: 'idle' \| 'listening' \| 'error' |

## Cấu trúc file

```
app/
├── index.html              # Entry point
├── styles/
│   └── main.css            # CSS variables + animations
├── js/
│   ├── event-bus.js        # Custom Event Bus
│   ├── noise-filter.js     # Lọc nhiễu + silence detection
│   ├── speech-engine.js    # Web Speech API wrapper
│   ├── text-display.js     # Render text + history
│   └── app.js              # Bootstrap + wiring
└── README.md               # File này
```

## Xử lý lỗi

### "Không hỗ trợ Web Speech API"
→ Dùng Chrome hoặc Edge (Firefox/Safari không hỗ trợ đầy đủ)

### "Không thể truy cập microphone"
→ Kiểm tra:
1. Cài đặt trình duyệt → Quyền → Microphone
2. Đang dùng HTTPS hoặc localhost
3. Microphone đã được cắm và hoạt động

### "Lỗi kết nối mạng"
→ Web Speech API cần internet để hoạt động

### Nhận diện sai từ
→ Nói rõ hơn, tránh tiếng ồn background

## Tùy chỉnh

### Thay đổi ngưỡng lọc nhiễu

Sửa trong `js/noise-filter.js`:

```javascript
const CONFIDENCE_THRESHOLD = 0.6;   // Tăng = nghiêm ngặt hơn
const MIN_TEXT_LENGTH = 2;          // Tăng = bỏ qua từ ngắn
const SILENCE_TIMEOUT_MS = 2000;    // Thời gian im lặng (ms)
```

### Thay đổi ngôn ngữ

Sửa trong `js/speech-engine.js`:

```javascript
this.recognition.lang = 'vi-VN';  // Đổi thành 'en-US', 'ja-JP', etc.
```

## Troubleshooting

**Q: Tại sao Chrome tự dừng sau vài giây?**  
A: Đây là behavior mặc định. App tự động restart recognition khi bị dừng.

**Q: Làm sao test trên mobile?**  
A: Deploy lên HTTPS server (GitHub Pages, Vercel, Netlify) rồi mở trên Chrome mobile.

**Q: Có thể dùng offline không?**  
A: Có. Khi mất mạng hoặc không dùng Chrome/Edge, frontend tự chuyển sang gửi âm thanh tới backend `/api/speech/transcribe` (dùng `faster-whisper` cục bộ). Đặt `OFFLINE_ONLY=1` trong `.env` để tắt toàn bộ dịch vụ ngoài.

## Bước tiếp theo

Sau khi hoàn thành bước này, tiếp tục với:

**Bước 3:** Text → Chuỗi ký hiệu (LLM tokenizer + Sign Dictionary lookup)

---

Tạo bởi Claude Code • 2026-04-16
