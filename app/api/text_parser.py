"""
text_parser.py
Parse Vietnamese text into meaningful chunks using:
  1. Google Gemini API (primary)
  2. PhoBERT local NLP (offline fallback, see local_nlp.py)
  3. Rule-based longest-match (last resort)
"""

import asyncio
import json
import os
import re
import time
import unicodedata
from collections import OrderedDict

from . import local_nlp
from .sign_lookup import sign_dict

# Splitting a sentence into dictionary words is a light task, so it runs on a
# lite model. The reasoning models are far too slow here: `gemini-3.6-flash`
# measured ~11.8 s on this prompt versus ~1.1 s for the lite one, and
# `gemini-2.0-flash` (the previous default) has been retired and now 404s on
# every call, which cost a wasted round trip per translation.
GEMINI_MODEL = os.getenv("GEMINI_PARSE_MODEL", "gemini-flash-lite-latest")

# A slow or unreachable Gemini used to hang the whole translation, because
# nothing bounded the call. Past this the rule-based parser answers instead.
GEMINI_TIMEOUT_SECONDS = float(os.getenv("GEMINI_PARSE_TIMEOUT", "3.0"))

# When Gemini is down, out of quota or renamed, every request would otherwise
# pay the full timeout before falling back. After this many consecutive
# failures the calls stop for a while and the rule-based parser answers
# immediately.
_FAILURE_LIMIT = 3
_COOLDOWN_SECONDS = 60.0
_consecutive_failures = 0
_cooldown_until = 0.0


def _note_failure() -> None:
    global _consecutive_failures, _cooldown_until
    _consecutive_failures += 1
    if _consecutive_failures >= _FAILURE_LIMIT:
        _cooldown_until = time.monotonic() + _COOLDOWN_SECONDS
        print(f"[TextParser] Gemini failed {_consecutive_failures}x — "
              f"using rule-based parsing for {_COOLDOWN_SECONDS:.0f}s")


def _note_success() -> None:
    global _consecutive_failures, _cooldown_until
    _consecutive_failures = 0
    _cooldown_until = 0.0


def _in_cooldown() -> bool:
    return time.monotonic() < _cooldown_until

# Repeat phrases are the norm here (replaying a transcript, re-running the same
# sentence), and the parse is deterministic enough to reuse.
_PARSE_CACHE_SIZE = 512
_parse_cache: "OrderedDict[str, list[str]]" = OrderedDict()

_gemini_model = None


def _cache_key(text: str) -> str:
    return unicodedata.normalize("NFC", " ".join(text.lower().split()))


def _cache_get(text: str) -> list[str] | None:
    key = _cache_key(text)
    words = _parse_cache.get(key)
    if words is not None:
        _parse_cache.move_to_end(key)
        return list(words)
    return None


def _cache_put(text: str, words: list[str]) -> None:
    key = _cache_key(text)
    _parse_cache[key] = list(words)
    _parse_cache.move_to_end(key)
    while len(_parse_cache) > _PARSE_CACHE_SIZE:
        _parse_cache.popitem(last=False)


def gemini_enabled() -> bool:
    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    return bool(api_key and api_key != "your_gemini_api_key_here")


def _get_model():
    """Build the Gemini model once.

    The first call also pays for importing the SDK and the TLS handshake, which
    measured ~4 s. `warmup()` moves that off the first user request.
    """
    global _gemini_model
    if _gemini_model is not None:
        return _gemini_model

    import google.generativeai as genai
    genai.configure(api_key=os.environ["GEMINI_API_KEY"])
    _gemini_model = genai.GenerativeModel(GEMINI_MODEL)
    return _gemini_model


async def warmup() -> None:
    """Pay the SDK import and connection cost at startup, not on first use."""
    if not gemini_enabled():
        return
    try:
        await asyncio.wait_for(
            asyncio.to_thread(_get_model),
            timeout=10,
        )
    except Exception as error:  # noqa: BLE001 - warmup must never break startup
        print(f"[TextParser] Gemini warmup skipped: {error}")


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
    if not gemini_enabled() or _in_cooldown():
        return None

    try:
        import google.generativeai as genai

        model = _get_model()
        sample_words = list(sign_dict.vi_to_gloss.keys())[:200]
        prompt = _build_llm_prompt(text, sample_words)

        response = await asyncio.wait_for(
            model.generate_content_async(
                prompt,
                generation_config=genai.GenerationConfig(
                    temperature=0.1,
                    max_output_tokens=500,
                ),
            ),
            timeout=GEMINI_TIMEOUT_SECONDS,
        )

        result_text = response.text.strip()

        # Extract JSON array from response
        json_match = re.search(r'\[.*\]', result_text, re.DOTALL)
        if json_match:
            words = json.loads(json_match.group())
            if isinstance(words, list) and all(isinstance(w, str) for w in words):
                _note_success()
                return words

        _note_failure()
        return None
    except asyncio.TimeoutError:
        _note_failure()
        print(f"[TextParser] Gemini timed out after {GEMINI_TIMEOUT_SECONDS}s, "
              "falling back to rule-based")
        return None
    except Exception as e:
        _note_failure()
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


def _lookup_words(words: list[str]) -> list[dict]:
    """Map parsed words onto dictionary entries."""
    results = []
    for word in words:
        lookup = sign_dict.lookup_vietnamese(word.lower().strip())
        if lookup:
            results.append(lookup)
            continue

        # Try sub-tokenizing with longest match
        sub_tokens = sign_dict.longest_match_tokenize(word)
        if sub_tokens and any(token["found"] for token in sub_tokens):
            results.extend(sub_tokens)
        else:
            results.append({
                "vi": word,
                "gloss": None,
                "found": False,
            })
    return results


async def parse_text(text: str, use_llm: bool = True) -> tuple[list[dict], str]:
    """
    Main entry: parse Vietnamese text into sign-ready chunks.

    Returns (tokens, method), where a token is {vi, gloss, found, fingerspell?}
    and method is the path actually taken — "gemini" or "rule_based". The caller
    used to infer this from whether an API key was set, which reported "gemini"
    even for requests the fallback had answered.
    """
    if not text or not text.strip():
        return [], "rule_based"

    # A repeat of a phrase already parsed skips the ~1 s round trip entirely.
    cached = _cache_get(text) if use_llm else None
    if cached is not None:
        return _lookup_words(cached), "gemini"

    llm_words = await parse_with_gemini(text) if use_llm else None

    if llm_words:
        _cache_put(text, llm_words)
        return _lookup_words(llm_words), "gemini"

    # Offline fallback: PhoBERT. Only once its model is already in memory — a
    # cold load takes seconds and must never land on a live request; the
    # startup preload is what makes it ready.
    if local_nlp.status()["loaded"]:
        try:
            return await asyncio.to_thread(local_nlp.parse, text), "local"
        except Exception as error:  # noqa: BLE001 - fall through to rules
            print(f"[TextParser] local NLP failed: {ascii(str(error))}")

    # Last resort: rule-based parsing
    return _lookup_words(parse_rule_based(text)), "rule_based"
