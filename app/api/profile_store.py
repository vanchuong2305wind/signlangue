"""Persistent single-user profile and learning activity storage."""

from __future__ import annotations

import json
import threading
from copy import deepcopy
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent.parent
PROFILE_PATH = ROOT / "data" / "profile.json"

DEFAULT_DATA = {
    "profile": {
        "name": "Người học",
        "role": "Học viên ngôn ngữ ký hiệu",
        "daily_goal": 10,
    },
    "settings": {
        "autoplay": True,
        "notifications": True,
    },
    "activities": [],
}

ACTIVITY_TYPES = {
    "learned_word",
    "video_view",
    "translation",
    "recognition",
    "study_time",
}


class ProfileStore:
    def __init__(self, path: Path = PROFILE_PATH):
        self.path = path
        self._lock = threading.RLock()

    def _load(self) -> dict[str, Any]:
        if not self.path.exists():
            return deepcopy(DEFAULT_DATA)
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return deepcopy(DEFAULT_DATA)

        result = deepcopy(DEFAULT_DATA)
        result["profile"].update(data.get("profile") or {})
        result["settings"].update(data.get("settings") or {})
        result["activities"] = data.get("activities") or []
        return result

    def _save(self, data: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(
            json.dumps(data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        temporary.replace(self.path)

    def get(self, total_words: int) -> dict[str, Any]:
        with self._lock:
            return self._summary(self._load(), total_words)

    def update(
        self,
        profile: dict[str, Any] | None,
        settings: dict[str, Any] | None,
        total_words: int,
    ) -> dict[str, Any]:
        with self._lock:
            data = self._load()
            if profile:
                data["profile"].update(profile)
            if settings:
                data["settings"].update(settings)
            self._save(data)
            return self._summary(data, total_words)

    def add_activity(
        self,
        activity_type: str,
        label: str,
        value: int,
        metadata: dict[str, Any] | None,
        total_words: int,
    ) -> dict[str, Any]:
        if activity_type not in ACTIVITY_TYPES:
            raise ValueError("Unsupported activity type")

        with self._lock:
            data = self._load()
            now = datetime.now().astimezone()
            entry = {
                "id": f"{int(now.timestamp() * 1000)}-{len(data['activities'])}",
                "type": activity_type,
                "label": label.strip()[:160],
                "value": max(1, int(value)),
                "metadata": metadata or {},
                "created_at": now.isoformat(),
            }
            data["activities"].append(entry)
            data["activities"] = data["activities"][-1000:]
            self._save(data)
            return self._summary(data, total_words)

    def reset(self, total_words: int) -> dict[str, Any]:
        with self._lock:
            data = self._load()
            data["activities"] = []
            self._save(data)
            return self._summary(data, total_words)

    @staticmethod
    def _summary(data: dict[str, Any], total_words: int) -> dict[str, Any]:
        activities = data["activities"]
        now = datetime.now().astimezone()
        today = now.date()

        def parse_time(item):
            try:
                return datetime.fromisoformat(item["created_at"])
            except (KeyError, TypeError, ValueError):
                return now

        learned_glosses = {
            item.get("metadata", {}).get("gloss") or item.get("label")
            for item in activities
            if item.get("type") == "learned_word"
        }
        learned_glosses.discard(None)

        active_dates = sorted({
            parse_time(item).astimezone().date()
            for item in activities
        }, reverse=True)
        streak = 0
        expected = today
        if active_dates and active_dates[0] < today:
            expected = today.fromordinal(today.toordinal() - 1)
        for active_date in active_dates:
            if active_date == expected:
                streak += 1
                expected = expected.fromordinal(expected.toordinal() - 1)
            elif active_date < expected:
                break

        today_items = [
            item for item in activities
            if parse_time(item).astimezone().date() == today
        ]
        today_stats = {
            "learned_words": len({
                item.get("metadata", {}).get("gloss") or item.get("label")
                for item in today_items
                if item.get("type") == "learned_word"
            }),
            "videos": sum(
                item.get("value", 1)
                for item in today_items
                if item.get("type") == "video_view"
            ),
            "translations": sum(
                item.get("value", 1)
                for item in today_items
                if item.get("type") == "translation"
            ),
            "recognitions": sum(
                item.get("value", 1)
                for item in today_items
                if item.get("type") == "recognition"
            ),
        }
        total_minutes = sum(
            item.get("value", 0)
            for item in activities
            if item.get("type") == "study_time"
        )
        daily_goal = max(1, int(data["profile"].get("daily_goal", 10)))

        return {
            "profile": data["profile"],
            "settings": data["settings"],
            "stats": {
                "learned_words": len(learned_glosses),
                "total_words": total_words,
                "streak": streak,
                "total_minutes": total_minutes,
                "daily_progress": min(
                    100,
                    round(today_stats["learned_words"] / daily_goal * 100),
                ),
            },
            "today": today_stats,
            "history": list(reversed(activities[-30:])),
        }


profile_store = ProfileStore()
