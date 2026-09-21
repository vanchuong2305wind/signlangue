"""
video_subtitles.py
Pull a video's spoken text off the platform that hosts it, as timed cues.

This is what lets the 3D avatar sign along with a video: the avatar needs to
know *what* is said and *when*, and a caption track carries both. Speech
recognition on the page cannot do this job — the Web Speech API only accepts
the microphone, never a video element's audio — so the transcript has to come
from the source.

Preference order for a track is deliberate:
  1. Vietnamese, human-written   — the dictionary is Vietnamese, and a written
                                   track has real punctuation to split on.
  2. Vietnamese, auto-generated  — for a Vietnamese video. YouTube also offers
                                   auto-*translated* Vietnamese on foreign
                                   videos, which is why an English clip still
                                   works without a translation step of our own.
  3. anything else               — better a track we cannot read well than none.
"""

import html
import json
import re
import time
from collections import OrderedDict
from typing import Any

import requests

from .cue_translate import translate_lines

# Auto-captions arrive as 2-5 word fragments — roughly one per breath. Signing
# one fragment at a time would make the avatar stutter and would spend an LLM
# parse on "và sau đó là", so fragments are glued into phrase-sized segments.
MAX_SEGMENT_CHARS = 90
MAX_SEGMENT_SECONDS = 7.0
# A pause this long reads as a sentence break even without punctuation.
SEGMENT_GAP_SECONDS = 0.8

SENTENCE_END = re.compile(r"[.!?…]['\"”’)]*\s*$")

PREFERRED_LANGS = ("vi", "vi-VN", "en", "en-US", "en-GB")
# json3 keeps each caption event separate with exact start/duration. vtt is the
# universal fallback but YouTube's auto-vtt repeats each line as it "rolls up",
# so it needs the dedupe pass below.
PREFERRED_FORMATS = ("json3", "srv3", "srv1", "vtt", "ttml")

_HTTP_TIMEOUT = 20
# YouTube throttles caption downloads hard from a server IP, so a 429 is an
# expected answer rather than a failure — it is retried, then stepped past.
_RETRY_DELAYS = (0.6, 1.6)
_MAX_TRACK_ATTEMPTS = 6
_DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0 Safari/537.36"
)

# Every throttled request makes the next one likelier to be throttled too, so a
# transcript is fetched once and reused — reloading the same video, switching
# layout or reopening the page all hit this instead of YouTube.
_CACHE_TTL_SECONDS = 1800
_CACHE_LIMIT = 24
_cache: "OrderedDict[tuple[str, str], tuple[float, dict]]" = OrderedDict()


def _cache_get(key: tuple[str, str]) -> dict | None:
    entry = _cache.get(key)
    if not entry:
        return None
    stored_at, payload = entry
    if time.monotonic() - stored_at > _CACHE_TTL_SECONDS:
        _cache.pop(key, None)
        return None
    _cache.move_to_end(key)
    return payload


def _cache_put(key: tuple[str, str], payload: dict) -> None:
    _cache[key] = (time.monotonic(), payload)
    _cache.move_to_end(key)
    while len(_cache) > _CACHE_LIMIT:
        _cache.popitem(last=False)


class SubtitleError(Exception):
    """Raised when no usable caption track can be produced for a URL."""


# ── Track selection ──────────────────────────────────────────────────────────

# TikTok labels its creator captions "eng-US" — ISO 639-2 where the rest of
# the world (and this module's preference list) uses ISO 639-1.
_THREE_LETTER = {
    "eng": "en", "vie": "vi", "jpn": "ja", "kor": "ko", "cmn": "zh", "zho": "zh",
    "fra": "fr", "fre": "fr", "deu": "de", "ger": "de", "spa": "es", "tha": "th",
    "ind": "id", "rus": "ru", "por": "pt", "ita": "it", "ara": "ar", "hin": "hi",
}


def normalize_lang(lang: str) -> str:
    """Language code reduced to its ISO 639-1 base."""
    base = (lang or "").lower().split("-")[0]
    return _THREE_LETTER.get(base, base)


def _score_lang(lang: str, wanted: str | None) -> int:
    """Lower is better."""
    code = lang.lower()
    base = normalize_lang(code)
    if wanted:
        wanted_code = wanted.lower()
        # Exact first: YouTube lists several Vietnamese tracks ("vi-en",
        # "vi-de" — translated from different source languages), and picking
        # one from the language menu has to land on that one.
        if code == wanted_code:
            return 0
        if base == normalize_lang(wanted_code):
            return 1
    for i, pref in enumerate(PREFERRED_LANGS):
        if base == normalize_lang(pref):
            return 2 + i
    return 50


def _ranked_formats(tracks: list[dict]) -> list[tuple[int, dict]]:
    """The formats of one language track, best-parsing first."""
    ranked: list[tuple[int, dict]] = []
    for track in tracks:
        if not track.get("url"):
            continue
        ext = track.get("ext", "")
        rank = PREFERRED_FORMATS.index(ext) if ext in PREFERRED_FORMATS else len(PREFERRED_FORMATS)
        ranked.append((rank, track))
    ranked.sort(key=lambda item: item[0])
    return ranked


def _rank_tracks(info: dict, wanted_lang: str | None) -> list[tuple[dict, str, str]]:
    """Every usable caption track as (track, lang, origin), best first.

    The whole list is returned rather than just the winner because YouTube
    rate-limits caption downloads: when the best track comes back 429, the next
    one down is a far better answer than an error.
    """
    manual = info.get("subtitles") or {}
    auto = info.get("automatic_captions") or {}

    candidates: list[tuple[tuple[int, int, int], dict, str, str]] = []
    # Manual tracks win ties against auto tracks of the same language: they are
    # punctuated, which is what the segmenter splits sentences on.
    for origin, table, origin_rank in (("manual", manual, 0), ("auto", auto, 1)):
        for lang, tracks in table.items():
            if not isinstance(tracks, list):
                continue
            lang_score = _score_lang(lang, wanted_lang)
            # Several formats of the same track are separate fallbacks: if
            # json3 is throttled, the vtt of the same captions may still load.
            for fmt_rank, track in _ranked_formats(tracks):
                candidates.append(
                    ((lang_score, origin_rank, fmt_rank), track, lang, origin)
                )

    candidates.sort(key=lambda item: item[0])
    return [(track, lang, origin) for _, track, lang, origin in candidates]


def _list_available(info: dict) -> list[dict]:
    seen: dict[str, dict] = {}
    for origin, table in (("manual", info.get("subtitles") or {}),
                          ("auto", info.get("automatic_captions") or {})):
        for lang in table:
            # A language offered both ways is reported once, as the better one.
            if lang not in seen:
                seen[lang] = {"lang": lang, "origin": origin}
    return sorted(seen.values(), key=lambda item: _score_lang(item["lang"], None))


# ── Caption format parsers ───────────────────────────────────────────────────

def _parse_json3(raw: str) -> list[dict]:
    data = json.loads(raw)
    cues: list[dict] = []
    for event in data.get("events") or []:
        segs = event.get("segs")
        if not segs:
            continue
        text = "".join(seg.get("utf8", "") for seg in segs)
        text = text.replace("\n", " ").strip()
        if not text:
            continue
        start = float(event.get("tStartMs", 0)) / 1000.0
        duration = float(event.get("dDurationMs", 0)) / 1000.0
        cues.append({"start": start, "end": start + duration, "text": text})
    return cues


_VTT_TIME = re.compile(
    r"(\d{2,}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2,}):(\d{2}):(\d{2})[.,](\d{3})"
)
# Inline karaoke timing YouTube puts inside auto-vtt lines.
_VTT_TAGS = re.compile(r"<[^>]+>")


def _vtt_seconds(h: str, m: str, s: str, ms: str) -> float:
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000.0


def _parse_vtt(raw: str) -> list[dict]:
    cues: list[dict] = []
    lines = raw.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    i = 0
    while i < len(lines):
        match = _VTT_TIME.search(lines[i])
        if not match:
            i += 1
            continue
        start = _vtt_seconds(*match.groups()[:4])
        end = _vtt_seconds(*match.groups()[4:])
        i += 1
        parts: list[str] = []
        while i < len(lines) and lines[i].strip():
            parts.append(_VTT_TAGS.sub("", lines[i]))
            i += 1
        text = html.unescape(" ".join(parts)).strip()
        text = re.sub(r"\s+", " ", text)
        if text:
            cues.append({"start": start, "end": end, "text": text})
        i += 1
    return _dedupe_rolling(cues)


def _parse_ttml(raw: str) -> list[dict]:
    cues: list[dict] = []
    for match in re.finditer(
        r'<p[^>]*begin="([^"]+)"[^>]*end="([^"]+)"[^>]*>(.*?)</p>', raw, re.DOTALL
    ):
        begin, end, body = match.groups()
        text = html.unescape(re.sub(r"<[^>]+>", " ", body)).strip()
        text = re.sub(r"\s+", " ", text)
        if not text:
            continue
        cues.append({"start": _ttml_seconds(begin), "end": _ttml_seconds(end), "text": text})
    return cues


def _ttml_seconds(value: str) -> float:
    value = value.strip()
    if value.endswith("s") and ":" not in value:
        return float(value[:-1])
    parts = value.split(":")
    total = 0.0
    for part in parts:
        total = total * 60 + float(part.replace(",", "."))
    return total


def _dedupe_rolling(cues: list[dict]) -> list[dict]:
    """Drop YouTube's roll-up repeats.

    Auto-vtt renders a scrolling caption box by re-emitting the previous line
    above the new one, so a naive parse yields every sentence two or three
    times. A cue whose text the previous cue already ends with is one of those
    repeats.
    """
    cleaned: list[dict] = []
    for cue in cues:
        text = cue["text"].strip()
        if not text:
            continue
        if cleaned:
            previous = cleaned[-1]["text"].strip()
            if text == previous or previous.endswith(text):
                continue
            if text.startswith(previous):
                # The new cue is the old line plus more — keep the longer one.
                cleaned[-1] = {**cue, "start": cleaned[-1]["start"]}
                continue
        cleaned.append({**cue, "text": text})
    return cleaned


def _parse_track(raw: str, ext: str) -> list[dict]:
    if ext == "json3" or raw.lstrip().startswith("{"):
        try:
            return _parse_json3(raw)
        except (ValueError, TypeError):
            pass
    stripped = raw.lstrip()
    if stripped.startswith("<"):
        return _parse_ttml(raw)
    return _parse_vtt(raw)


# ── Segmentation ─────────────────────────────────────────────────────────────

def segment_cues(cues: list[dict]) -> list[dict]:
    """Glue caption fragments into phrase-sized segments the avatar can sign.

    One segment becomes one call to the sign parser, so the boundaries matter:
    too short and the parser sees fragments with no grammar, too long and the
    avatar falls behind the video.
    """
    segments: list[dict] = []
    current: dict[str, Any] | None = None

    for cue in cues:
        text = re.sub(r"\s+", " ", cue["text"]).strip()
        if not text:
            continue

        if current is None:
            current = {"start": cue["start"], "end": cue["end"], "text": text}
            continue

        gap = cue["start"] - current["end"]
        merged_len = len(current["text"]) + 1 + len(text)
        span = cue["end"] - current["start"]

        if (
            SENTENCE_END.search(current["text"])
            or gap >= SEGMENT_GAP_SECONDS
            or merged_len > MAX_SEGMENT_CHARS
            or span > MAX_SEGMENT_SECONDS
        ):
            segments.append(current)
            current = {"start": cue["start"], "end": cue["end"], "text": text}
            continue

        current["text"] = f"{current['text']} {text}"
        current["end"] = cue["end"]

    if current is not None:
        segments.append(current)

    # A zero-length segment would never match the playhead, so give it the
    # room up to the next one (capped, in case the next is minutes away).
    for i, segment in enumerate(segments):
        if segment["end"] <= segment["start"]:
            following = segments[i + 1]["start"] if i + 1 < len(segments) else segment["start"] + 2
            segment["end"] = min(following, segment["start"] + MAX_SEGMENT_SECONDS)
        segment["start"] = round(segment["start"], 3)
        segment["end"] = round(segment["end"], 3)

    return segments


# ── Public entry point ───────────────────────────────────────────────────────

def _download_track(url: str, headers: dict) -> str | None:
    """Fetch one caption track, or None if it stays unavailable."""
    for attempt in range(len(_RETRY_DELAYS) + 1):
        try:
            response = requests.get(url, headers=headers, timeout=_HTTP_TIMEOUT)
            if response.status_code == 200 and response.text.strip():
                return response.text
            # Anything else is worth another try only while retries remain.
        except requests.RequestException:
            pass
        if attempt < len(_RETRY_DELAYS):
            time.sleep(_RETRY_DELAYS[attempt])
    return None


# A probe is the expensive half of both browsing and playing: the feed checks
# whether a video has captions, then the click fetches them. Sharing one cache
# means the click pays nothing, and it halves the requests YouTube sees — which
# is what keeps the throttling above at bay.
_INFO_TTL_SECONDS = 900
_INFO_LIMIT = 120
_info_cache: "OrderedDict[str, tuple[float, dict]]" = OrderedDict()


def extract_info_cached(url: str) -> dict:
    """yt-dlp metadata for a video, reused across the feed and playback."""
    key = url.strip()
    entry = _info_cache.get(key)
    if entry and time.monotonic() - entry[0] <= _INFO_TTL_SECONDS:
        _info_cache.move_to_end(key)
        return entry[1]

    info = _extract_info(url)
    _info_cache[key] = (time.monotonic(), info)
    _info_cache.move_to_end(key)
    while len(_info_cache) > _INFO_LIMIT:
        _info_cache.popitem(last=False)
    return info


def _extract_info(url: str) -> dict:
    try:
        import yt_dlp
    except ImportError as error:  # pragma: no cover - depends on the install
        raise SubtitleError(
            "Thiếu thư viện yt-dlp trên server. Chạy: pip install yt-dlp"
        ) from error

    options = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        "extract_flat": False,
        # Only the caption index is needed, so the format probe is dead weight.
        "youtube_include_dash_manifest": False,
    }
    with yt_dlp.YoutubeDL(options) as ydl:
        return ydl.extract_info(url, download=False)


def fetch_subtitles(url: str, lang: str | None = None) -> dict:
    """Fetch and segment a video's caption track.

    Raises SubtitleError with a message meant for the user on every failure
    path, so the route can hand it straight to the UI.
    """
    cache_key = (url.strip(), (lang or "").strip())
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    try:
        info = extract_info_cached(url)
    except SubtitleError:
        raise
    except Exception as error:  # noqa: BLE001 - yt-dlp raises a wide range
        raise SubtitleError(f"Không đọc được video: {error}") from error

    if not info:
        raise SubtitleError("Không lấy được thông tin video.")

    available = _list_available(info)
    candidates = _rank_tracks(info, lang)
    if not candidates:
        raise SubtitleError(
            "Video này không có phụ đề. Hãy bật chế độ micro hoặc tải lên file .srt/.vtt."
        )

    headers = dict(info.get("http_headers") or {})
    headers.setdefault("User-Agent", _DEFAULT_UA)
    headers.setdefault("Accept-Language", "vi,en;q=0.8")

    cues: list[dict] = []
    track_lang = ""
    origin = ""
    last_error: str = ""

    for track, candidate_lang, candidate_origin in candidates[:_MAX_TRACK_ATTEMPTS]:
        raw = _download_track(track["url"], headers)
        if raw is None:
            last_error = "máy chủ phụ đề từ chối yêu cầu (thử lại sau ít phút)"
            continue
        parsed = _parse_track(raw, track.get("ext", ""))
        if not parsed:
            last_error = "phụ đề tải về nhưng không đọc được nội dung"
            continue
        cues = parsed
        track_lang = candidate_lang
        origin = candidate_origin
        break

    if not cues:
        raise SubtitleError(f"Không tải được phụ đề: {last_error or 'không rõ nguyên nhân'}.")

    segments = segment_cues(cues)

    # The sign dictionary is Vietnamese. YouTube can hand us an auto-translated
    # Vietnamese track, but TikTok only ever returns the creator's own language,
    # so anything non-Vietnamese is translated here or it would look up nothing.
    source_base = normalize_lang(track_lang)
    translated_from = ""
    if source_base and source_base != "vi" and segments:
        rendered = translate_lines([s["text"] for s in segments], source_base)
        if rendered:
            translated_from = track_lang
            for segment, text in zip(segments, rendered):
                segment["original"] = segment["text"]
                segment["text"] = text

    payload = {
        "title": info.get("title") or "",
        "duration": info.get("duration") or 0,
        "thumbnail": info.get("thumbnail") or "",
        "video_id": info.get("id") or "",
        "extractor": info.get("extractor_key") or "",
        "lang": track_lang,
        "origin": origin,
        "available": available,
        "cues": segments,
        "raw_cue_count": len(cues),
        "translated_from": translated_from,
    }
    _cache_put(cache_key, payload)
    return payload
