"""
cue_translate.py
Translate subtitle lines into Vietnamese before they reach the sign dictionary.

The dictionary is Vietnamese, so a foreign caption track would look up almost
nothing. YouTube papers over this by offering auto-translated Vietnamese tracks,
but TikTok does not — its creator captions come back as "eng-US" and nothing
else — so a translation step of our own is the only way those videos sign.

Lines are translated together, not one by one: a subtitle line is a fragment,
and neighbouring lines are what say whether "right" is a direction or an
agreement.
"""

import json
import os
import re
import time

# Same lite model the sentence parser uses: this is translation of short,
# plain lines, and the reasoning models cost seconds per call for no gain.
GEMINI_MODEL = os.getenv("GEMINI_TRANSLATE_MODEL", "gemini-flash-lite-latest")
GEMINI_TIMEOUT_SECONDS = float(os.getenv("GEMINI_TRANSLATE_TIMEOUT", "25.0"))

# Big enough that a short video is one call, small enough to stay well inside
# the output token budget — a truncated reply loses the whole batch.
BATCH_SIZE = 40

# Mirrors the parser's breaker: when Gemini is down, every video would
# otherwise pay the full timeout per batch before falling back to the original.
_FAILURE_LIMIT = 3
_COOLDOWN_SECONDS = 120.0
_consecutive_failures = 0
_cooldown_until = 0.0

_model = None


def _gemini_enabled() -> bool:
    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    return bool(api_key and api_key != "your_gemini_api_key_here")


def _in_cooldown() -> bool:
    return time.monotonic() < _cooldown_until


def _note_failure() -> None:
    global _consecutive_failures, _cooldown_until
    _consecutive_failures += 1
    if _consecutive_failures >= _FAILURE_LIMIT:
        _cooldown_until = time.monotonic() + _COOLDOWN_SECONDS
        print(f"[CueTranslate] Gemini failed {_consecutive_failures}x — "
              f"keeping original subtitles for {_COOLDOWN_SECONDS:.0f}s")


def _note_success() -> None:
    global _consecutive_failures, _cooldown_until
    _consecutive_failures = 0
    _cooldown_until = 0.0


def _get_model():
    global _model
    if _model is not None:
        return _model
    import google.generativeai as genai
    genai.configure(api_key=os.environ["GEMINI_API_KEY"])
    _model = genai.GenerativeModel(GEMINI_MODEL)
    return _model


def _build_prompt(lines: list[str], source_lang: str) -> str:
    numbered = "\n".join(f"{i}. {line}" for i, line in enumerate(lines))
    return f"""Bạn là người dịch phụ đề video sang tiếng Việt.

Dưới đây là {len(lines)} dòng phụ đề liên tiếp của một video (ngôn ngữ gốc: {source_lang}).
Hãy dịch TỪNG DÒNG sang tiếng Việt tự nhiên, ngắn gọn, đúng văn nói.

QUY TẮC BẮT BUỘC:
1. Trả về ĐÚNG {len(lines)} dòng, theo đúng thứ tự.
2. Mỗi dòng dịch độc lập, KHÔNG gộp dòng, KHÔNG tách dòng.
3. Giữ nguyên tên riêng.
4. Nếu một dòng không có nội dung lời nói (nhạc, tiếng động), trả về chuỗi rỗng "".
5. Chỉ trả về JSON array gồm {len(lines)} chuỗi. Không giải thích, không đánh số.

PHỤ ĐỀ GỐC:
{numbered}

KẾT QUẢ (JSON array {len(lines)} phần tử):"""


def _parse_reply(text: str, expected: int) -> list[str] | None:
    match = re.search(r"\[.*\]", text, re.DOTALL)
    if not match:
        return None
    try:
        values = json.loads(match.group())
    except (ValueError, TypeError):
        return None
    if not isinstance(values, list) or len(values) != expected:
        # A mismatched length cannot be realigned to timestamps, and guessing
        # would sign the wrong words at the wrong moments.
        return None
    return [str(v).strip() for v in values]


def translate_lines(lines: list[str], source_lang: str) -> list[str] | None:
    """Translate subtitle lines to Vietnamese, or None if translation failed.

    A None return is not an error the caller must handle — it means the
    original lines stay in place, which still plays, just with poorer lookup.
    """
    if not lines or not _gemini_enabled() or _in_cooldown():
        return None

    try:
        import google.generativeai as genai
        model = _get_model()
    except Exception as error:  # noqa: BLE001 - SDK import/config can fail
        print(f"[CueTranslate] Gemini unavailable: {error}")
        _note_failure()
        return None

    translated: list[str] = []
    for start in range(0, len(lines), BATCH_SIZE):
        batch = lines[start:start + BATCH_SIZE]
        try:
            response = model.generate_content(
                _build_prompt(batch, source_lang),
                generation_config=genai.GenerationConfig(
                    temperature=0.2,
                    max_output_tokens=4096,
                ),
                request_options={"timeout": GEMINI_TIMEOUT_SECONDS},
            )
            values = _parse_reply(response.text or "", len(batch))
        except Exception as error:  # noqa: BLE001 - network, quota, safety
            print(f"[CueTranslate] batch failed: {error}")
            values = None

        if values is None:
            _note_failure()
            # Falling back per batch rather than per video: the batches that
            # did translate are still worth keeping.
            translated.extend(batch)
            continue

        _note_success()
        # An empty translation means "no speech here"; the original line is a
        # better thing to show than a blank subtitle.
        translated.extend(new or old for new, old in zip(values, batch))

    return translated
