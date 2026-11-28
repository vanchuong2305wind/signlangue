"""Centralized privacy controls and data-flow transparency helpers."""

from __future__ import annotations

import os
from typing import Any


_TRUTHY = {"1", "true", "yes", "on"}
_DEFAULT_ALLOWED_ORIGINS = (
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
)


def get_allowed_origins() -> list[str]:
    """Return whitelisted CORS origins; defaults to local dev/server origins."""
    raw = os.getenv("ALLOWED_ORIGINS", "").strip()
    if not raw:
        return list(_DEFAULT_ALLOWED_ORIGINS)
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


def create_gemini_client():
    """Create a Google GenAI client using the unified `google-genai` SDK."""
    from google import genai

    return genai.Client(api_key=os.environ["GEMINI_API_KEY"])


def is_offline_only() -> bool:
    """Return True when outbound calls to external AI/video services are disabled."""
    return os.getenv("OFFLINE_ONLY", "0").strip().lower() in _TRUTHY


def _has_gemini_key() -> bool:
    key = os.getenv("GEMINI_API_KEY", "").strip()
    return bool(key and key != "your_gemini_api_key_here")


def privacy_status(*, profile_path: str, profile_exists: bool) -> dict[str, Any]:
    """Describe active external integrations and local data retention policies."""
    offline_only = is_offline_only()
    gemini_active = (not offline_only) and _has_gemini_key()
    return {
        "offline_only": offline_only,
        "external_services": {
            "gemini": {
                "enabled": gemini_active,
                "data_sent": ["text_to_sign_queries", "camera_recognized_tokens", "foreign_video_subtitles"],
                "blocked_by_offline_only": offline_only,
            },
            "video_subtitles_network": {
                "enabled": not offline_only,
                "data_sent": ["video_url"],
                "blocked_by_offline_only": offline_only,
            },
            "browser_web_speech": {
                "client_side": True,
                "note": "Web Speech API runs in the browser when online; offline/network errors fall back to local Whisper (/api/speech/transcribe).",
            },
        },
        "storage_policy": {
            "camera_frames": "ram_only",
            "speech_audio": "ram_only",
            "video_audio_fallback": "ephemeral_temp_dir",
            "activity_history": {
                "path": profile_path,
                "exists": profile_exists,
                "max_entries": 1000,
                "supports_selective_delete": True,
                "supports_full_delete": True,
            },
        },
    }
