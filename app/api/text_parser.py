"""
text_parser.py
Parse Vietnamese text into meaningful chunks using:
  1. Google Gemini API (primary)
  2. Rule-based longest-match (fallback)
"""

import json
import os
import re
from .sign_lookup import sign_dict


def _build_llm_prompt(text: str, available_words: list[str]) -> str:
    """Build the prompt for LLM to parse Vietnamese text."""
    sample_words = available_words[:200]  # Send a sample for context
    return f"""Bạn là một hệ thống xử lý ngôn ngữ ký hiệu. Nhiệm vụ: tách câu tiếng Việt thành danh sách các từ/cụm từ CÓ NGHĨA để tra cứu trong từ điển ngôn ngữ ký hiệu.

QUY TẮC:
1. Tách câu thành từng từ hoặc cụm từ có nghĩa
2. Giữ nguyên các cụm từ ghép nếu chúng là 1 khái niệm (ví dụ: "xin chào", "cảm ơn", "tạm biệt", "bóng đá")
3. Bỏ các từ đệm không cần thiết cho ngôn ngữ ký hiệu (ví dụ: "ạ", "nhé", "nha", "ơi", "là")
4. Giữ lại các từ quan trọng: danh từ, động từ, tính từ, trạng từ
5. Sắp xếp theo thứ tự phù hợp cho ngôn ngữ ký hiệu (chủ ngữ - tân ngữ - động từ nếu cần)

Một số từ có trong từ điển: {json.dumps(sample_words[:100], ensure_ascii=False)}

CÂU CẦN TÁCH: "{text}"

Trả về KẾT QUẢ dưới dạng JSON array, chỉ chứa các từ/cụm từ. Không giải thích.
Ví dụ: ["xin chào", "bạn", "tốt"]"""


async def parse_with_gemini(text: str) -> list[str] | None:
    """Use Google Gemini to parse Vietnamese text into meaningful chunks."""
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key or api_key == "your_gemini_api_key_here":
        return None

    try:
        import google.generativeai as genai
        genai.configure(api_key=api_key)

        model = genai.GenerativeModel("gemini-2.0-flash")
        sample_words = list(sign_dict.vi_to_gloss.keys())[:200]
        prompt = _build_llm_prompt(text, sample_words)

        response = await model.generate_content_async(
            prompt,
            generation_config=genai.GenerationConfig(
                temperature=0.1,
                max_output_tokens=500,
            ),
        )

        result_text = response.text.strip()

        # Extract JSON array from response
        json_match = re.search(r'\[.*\]', result_text, re.DOTALL)
        if json_match:
            words = json.loads(json_match.group())
            if isinstance(words, list) and all(isinstance(w, str) for w in words):
                return words

        return None
    except Exception as e:
        print(f"[TextParser] Gemini error: {e}")
        return None


def parse_rule_based(text: str) -> list[str]:
    """
    Rule-based Vietnamese text parser.
    Uses longest-match against the sign dictionary.
    """
    # Vietnamese stop words to remove (particles, fillers)
    stop_words = {
        "ạ", "nhé", "nha", "ơi", "à", "ừ", "hả", "nhỉ",
        "thì", "mà", "là", "của", "cái", "đó", "này", "kia",
        "được", "bị", "rồi", "đi", "có", "không",
        "rất", "quá", "lắm",
    }

    # Keep important function words
    keep_words = {
        "tôi", "bạn", "anh", "chị", "em", "chúng tôi",
        "không", "có", "muốn", "cần", "phải",
        "và", "hoặc", "nhưng",
        "tốt", "xấu", "đẹp", "xin", "cảm ơn",
    }

    text_lower = text.lower().strip()

    # First try longest-match tokenization from dictionary
    tokens = sign_dict.longest_match_tokenize(text_lower)

    result = []
    for token in tokens:
        word = token["vi"]
        # Skip stop words (unless they're in keep_words or found in dictionary)
        if word in stop_words and word not in keep_words and not token["found"]:
            continue
        result.append(word)

    return result


async def parse_text(text: str) -> list[dict]:
    """
    Main entry: parse Vietnamese text into sign-ready chunks.
    Returns list of {vi, gloss, found, fingerspell?}
    """
    if not text or not text.strip():
        return []

    # Try LLM first
    llm_words = await parse_with_gemini(text)

    if llm_words:
        # LLM gave us parsed words, now look up each in dictionary
        results = []
        for word in llm_words:
            lookup = sign_dict.lookup_vietnamese(word.lower().strip())
            if lookup:
                results.append(lookup)
            else:
                # Try sub-tokenizing with longest match
                sub_tokens = sign_dict.longest_match_tokenize(word)
                if sub_tokens and any(t["found"] for t in sub_tokens):
                    results.extend(sub_tokens)
                else:
                    results.append({
                        "vi": word,
                        "gloss": None,
                        "found": False,
                    })
        return results

    # Fallback: rule-based parsing
    words = parse_rule_based(text)
    results = []
    for word in words:
        lookup = sign_dict.lookup_vietnamese(word)
        if lookup:
            results.append(lookup)
        else:
            results.append({
                "vi": word,
                "gloss": None,
                "found": False,
            })

    return results
