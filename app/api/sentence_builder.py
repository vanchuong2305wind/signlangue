"""Turn noisy camera-recognition tokens into natural Vietnamese with Gemini."""

from __future__ import annotations

import os
import re
import asyncio


def gemini_configured() -> bool:
    key = os.getenv("GEMINI_API_KEY", "").strip()
    return bool(key and key != "your_gemini_api_key_here")


async def build_sentence(words: list[str]) -> str:
    if not gemini_configured():
        raise RuntimeError("Chưa cấu hình GEMINI_API_KEY trong file .env.")

    cleaned = [
        re.sub(r"\s+", " ", word).strip()
        for word in words
        if isinstance(word, str) and word.strip()
    ]
    if not cleaned:
        raise ValueError("Chưa có từ nào để tạo câu.")

    from google import genai
    from google.genai import types

    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    token_text = " | ".join(cleaned)
    prompt = f"""Bạn là trợ lý biên tập tiếng Việt cho ứng dụng nhận diện ngôn ngữ ký hiệu.

Các từ sau được model thị giác nhận diện theo đúng thứ tự thời gian:
{token_text}

Hãy viết lại thành MỘT câu tiếng Việt tự nhiên và có nghĩa nhất.
- Ưu tiên giữ nguyên ý và thứ tự của các từ nhận diện.
- Được phép thêm đại từ, từ nối và dấu câu cần thiết.
- Không thêm thông tin, tên riêng hay sự kiện không có căn cứ.
- Nếu một từ có vẻ bị lặp do camera, chỉ giữ một lần.
- Chỉ trả về câu hoàn chỉnh, không giải thích, không dùng Markdown."""

    response = await asyncio.wait_for(
        client.aio.models.generate_content(
            model="gemini-3.6-flash",
            contents=prompt,
            config=types.GenerateContentConfig(
                max_output_tokens=120,
            ),
        ),
        timeout=25,
    )
    sentence = response.text.strip().strip('"“”')
    if not sentence:
        raise RuntimeError("Gemini không trả về câu hợp lệ.")
    return sentence
