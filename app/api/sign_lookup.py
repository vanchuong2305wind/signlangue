"""
sign_lookup.py
Vietnamese meanings and avatar clips from the generated VieSign catalog.
The previous ASL dictionary is never loaded as a fallback.
"""

import json
import threading
import time
from pathlib import Path

from .viesign_dataset import DATA_DIR, DATASET_ID, ROOT, active_data_dir, normalize_word, word_id


class SignDictionary:
    def __init__(self, data_dir: Path | None = None):
        self.vi_to_gloss: dict[str, str] = {}
        self.gloss_to_vi: dict[str, str] = {}
        self.available_glosses: set[str] = set()
        self._follow_active = data_dir is None
        self.data_dir = active_data_dir() if data_dir is None else data_dir
        self._landmarks_v2_dir = self.data_dir / "landmarks"
        self._catalog_path = self.data_dir / "catalog.json"
        self.entries: dict[str, dict] = {}
        self._vi_phrases: list[str] = []
        self._catalog_stamp = None
        self._last_checked = 0.0
        self._lock = threading.RLock()
        self._video_roots = None
        self._loaded = False

    def load(self):
        # Extraction publishes catalog.json atomically. Refresh at most once a
        # second so an already-running API can see newly available Vietnamese clips.
        current = time.monotonic()
        if self._loaded and current - self._last_checked < 1.0:
            return
        with self._lock:
            self._last_checked = current
            if self._follow_active:
                self.data_dir = active_data_dir()
                self._landmarks_v2_dir = self.data_dir / "landmarks"
                self._catalog_path = self.data_dir / "catalog.json"
            try:
                stat = self._catalog_path.stat()
                stamp = (str(self.data_dir), stat.st_mtime_ns, stat.st_size)
            except FileNotFoundError:
                stamp = None
            if self._loaded and stamp == self._catalog_stamp:
                return
            catalog = {"dataset": DATASET_ID, "entries": {}}
            if stamp is not None:
                catalog = json.loads(self._catalog_path.read_text(encoding="utf-8"))
                if catalog.get("dataset") != DATASET_ID:
                    raise ValueError("Active catalog must contain Vietnamese VieSign data")
            entries = {}
            meanings = {}
            for identifier, entry in catalog.get("entries", {}).items():
                meaning = normalize_word(entry["vi"])
                if identifier != word_id(meaning) or meaning in meanings:
                    raise ValueError("Duplicate meaning or invalid VieSign identifier")
                # Publish only words which have an actual avatar file.
                if not (self._landmarks_v2_dir / f"{identifier}.json").is_file():
                    continue
                meanings[meaning] = identifier
                entries[identifier] = entry
            self.entries = entries
            self.vi_to_gloss = meanings
            self.gloss_to_vi = {identifier: entry["vi"] for identifier, entry in entries.items()}
            self.available_glosses = set(entries)
            self._vi_phrases = sorted(meanings, key=len, reverse=True)
            self._catalog_stamp = stamp
            self._loaded = True
            print(f"[SignDictionary] VieSign: {len(entries)} Vietnamese avatar clips")

    def video_catalog(self) -> dict:
        self.load()
        items = []
        for identifier, entry in self.entries.items():
            source = entry["source_video"]
            items.append({"gloss": identifier, "vi": entry["vi"], "language": "vsl",
                          "categories": ["other"], "video_count": 1,
                          "videos": [{"video_id": entry["video_id"], "source": "VieSign",
                                      "type": "local", "url": f"/api/dataset/video/{entry['video_id']}",
                                      "mime_type": "video/webm" if source.lower().endswith('.webm') else "video/mp4"}]})
        items.sort(key=lambda entry: entry["vi"])
        return {"dataset": DATASET_ID, "glosses": {entry["gloss"]: entry for entry in items},
                "list": items, "stats": {"total": len(items), "with_vi": len(items),
                                         "with_local": len(items), "categories": {"other": len(items)}}}

    def video_path(self, video_id: str) -> Path | None:
        for entry in self.entries.values():
            if entry["video_id"] == video_id:
                path = (ROOT / entry["source_video"]).resolve()
                if path.is_relative_to((ROOT / "data_v2").resolve()) and path.is_file():
                    return path
                # Server extraction uses VieSign10K/video_raw; the downloaded
                # archive may be nested as VieSign10K/VieSign10K/video_raw locally.
                filename = Path(entry["source_video"]).name
                if Path(filename).stem != video_id or Path(filename).suffix.lower() not in {".mp4", ".webm"}:
                    return None
                if self._video_roots is None:
                    source_root = ROOT / "data_v2" / "VieSign10K"
                    self._video_roots = tuple(source_root.rglob("video_raw")) if source_root.is_dir() else ()
                for video_root in self._video_roots:
                    candidate = (video_root / filename).resolve()
                    if candidate.is_relative_to((ROOT / "data_v2").resolve()) and candidate.is_file():
                        return candidate
        return None

    def lookup_vietnamese(self, word: str) -> dict | None:
        """Look up a Vietnamese meaning or an internal VieSign identifier."""
        word_lower = normalize_word(word)
        gloss = self.vi_to_gloss.get(word_lower)
        if gloss:
            return {
                "vi": word_lower,
                "gloss": gloss,
                "found": True,
            }

        # Internal ASCII VieSign IDs are supported; English ASL glosses are not.
        if word_lower in self.available_glosses:
            vi = self.gloss_to_vi.get(word_lower, word_lower)
            return {
                "vi": vi,
                "gloss": word_lower,
                "found": True,
            }

        return None

    def lookup_gloss(self, gloss: str) -> bool:
        """Check if a gloss exists in the sign dictionary."""
        return gloss.lower() in self.available_glosses

    def get_all_vi_phrases(self) -> list[str]:
        """Return all Vietnamese phrases, sorted longest first."""
        return self._vi_phrases

    def get_alphabet_glosses(self, word: str) -> list[dict]:
        """Fingerspell a word letter by letter."""
        letters = []
        for char in normalize_word(word):
            identifier = self.vi_to_gloss.get(char)
            if char.isalpha() and identifier:
                letters.append({
                    "vi": char,
                    "gloss": identifier,
                    "found": True,
                    "fingerspell": True,
                })
            elif char == " ":
                continue
            else:
                letters.append({
                    "vi": char,
                    "gloss": None,
                    "found": False,
                    "fingerspell": True,
                })
        return letters

    def longest_match_tokenize(self, text: str) -> list[dict]:
        """
        Greedy longest-match tokenizer.
        Tries to match the longest Vietnamese phrase in the dictionary first.
        Falls back to single words, then fingerspelling.
        """
        text = normalize_word(text)
        tokens = []
        i = 0

        while i < len(text):
            # Skip whitespace
            if text[i] == " ":
                i += 1
                continue

            matched = False
            # Try longest phrases first
            for phrase in self._vi_phrases:
                phrase_len = len(phrase)
                candidate = text[i:i + phrase_len]
                # Must match exactly and be at a word boundary
                if candidate == phrase:
                    next_pos = i + phrase_len
                    at_boundary = (
                        next_pos >= len(text) or text[next_pos] == " "
                    )
                    prev_boundary = (i == 0 or text[i - 1] == " ")
                    if at_boundary and prev_boundary:
                        result = self.lookup_vietnamese(phrase)
                        if result:
                            tokens.append(result)
                            i = next_pos
                            matched = True
                            break

            if not matched:
                # Extract current word
                end = text.find(" ", i)
                if end == -1:
                    end = len(text)
                word = text[i:end]

                result = self.lookup_vietnamese(word)
                if result:
                    tokens.append(result)
                else:
                    tokens.append({
                        "vi": word,
                        "gloss": None,
                        "found": False,
                    })
                i = end

        return tokens


# Singleton
sign_dict = SignDictionary()
