"""
sign_lookup.py
Vietnamese meanings and avatar clips from the generated VieSign catalog.
An explicit supplemental manifest supplies ASL clips for missing meanings.
"""

import json
import re
import threading
import time
from pathlib import Path

from .viesign_dataset import DATA_DIR, DATASET_ID, ROOT, active_data_dir, normalize_word, word_id
from .viesign_categories import categories_for
from .asl_supplement import SUPPLEMENT_PATH, existing_meaning, landmark_path as asl_landmark_path

# Spoken greetings can have a longer form than the dataset label. Only enable
# an alias when its target has a real clip; never synthesize a new landmark.
VI_ALIASES = {"xin chào": "chào"}


class SignDictionary:
    def __init__(self, data_dir: Path | None = None, supplement_path: Path | None = None):
        self.vi_to_gloss: dict[str, str] = {}
        self.gloss_to_vi: dict[str, str] = {}
        self.available_glosses: set[str] = set()
        self._follow_active = data_dir is None
        self._supplement_path = supplement_path if supplement_path is not None else (SUPPLEMENT_PATH if data_dir is None else None)
        self.data_dir = active_data_dir() if data_dir is None else data_dir
        self._landmarks_v2_dir = self.data_dir / "landmarks"
        self._catalog_path = self.data_dir / "catalog.json"
        self.entries: dict[str, dict] = {}
        self._vi_phrases: list[str] = []
        self._aliases: dict[str, str] = {}
        self._token_pattern = None
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
            if self._supplement_path and self._supplement_path.is_file():
                stat = self._supplement_path.stat()
                stamp = (stamp, stat.st_mtime_ns, stat.st_size)
            if self._loaded and stamp == self._catalog_stamp:
                return
            catalog = {"dataset": DATASET_ID, "entries": {}}
            if self._catalog_path.is_file():
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
            supplemental_aliases = {}
            if self._supplement_path and self._supplement_path.is_file():
                supplement = json.loads(self._supplement_path.read_text(encoding="utf-8"))
                selected_base = (ROOT / supplement.get("base_directory", "")).resolve()
                if selected_base != self.data_dir.resolve():
                    supplement = {"entries": {}}
                base_meanings = set(meanings)
                overrides = set(supplement.get("overrides", []))
                for identifier, entry in supplement["entries"].items():
                    meaning = normalize_word(entry["vi"])
                    if entry.get("language") != "asl" or identifier != word_id(meaning):
                        raise ValueError("Invalid ASL supplement entry")
                    target = existing_meaning(meaning, base_meanings)
                    if target and meaning not in overrides:
                        if target != meaning:
                            supplemental_aliases[meaning] = target
                        continue
                    if not asl_landmark_path(entry).is_file():
                        continue
                    meanings[meaning] = identifier
                    entries[identifier] = entry
                for alias, target in supplement.get("aliases", {}).items():
                    if target in meanings and alias not in meanings:
                        supplemental_aliases[alias] = target
            self.entries = entries
            self.vi_to_gloss = meanings
            self.gloss_to_vi = {identifier: entry["vi"] for identifier, entry in entries.items()}
            self.available_glosses = set(entries)
            self._vi_phrases = sorted(meanings, key=len, reverse=True)
            self._aliases = {alias: target for alias, target in {**VI_ALIASES, **supplemental_aliases}.items()
                             if alias not in meanings and target in meanings}
            phrases = sorted(set(meanings) | set(self._aliases), key=len, reverse=True)
            self._token_pattern = (re.compile(r"(?<!\w)(?:" + "|".join(map(re.escape, phrases)) + r")(?!\w)")
                                   if phrases else None)
            self._catalog_stamp = stamp
            self._loaded = True
            print(f"[SignDictionary] VieSign: {len(entries)} Vietnamese avatar clips")

    def video_catalog(self) -> dict:
        self.load()
        items = []
        category_counts = {}
        for identifier, entry in self.entries.items():
            language = entry.get("language", "vsl")
            if language == "asl":
                videos = entry.get("videos", [])
            else:
                source = entry["source_video"]
                videos = [{"video_id": entry["video_id"], "source": "VieSign",
                           "type": "local", "url": f"/api/dataset/video/{entry['video_id']}",
                           "mime_type": "video/webm" if source.lower().endswith('.webm') else "video/mp4"}]
            categories = categories_for(entry["vi"])
            for category in categories:
                category_counts[category] = category_counts.get(category, 0) + 1
            items.append({"gloss": identifier, "vi": entry["vi"], "language": language,
                          "categories": categories, "video_count": len(videos), "videos": videos})
        items.sort(key=lambda entry: entry["vi"])
        return {"dataset": DATASET_ID, "glosses": {entry["gloss"]: entry for entry in items},
                "list": items, "stats": {"total": len(items), "with_vi": len(items),
                                         "with_local": sum(item["language"] == "vsl" for item in items), "categories": category_counts}}

    def landmark_path(self, identifier):
        entry = self.entries.get(identifier)
        if entry and entry.get("language") == "asl":
            return asl_landmark_path(entry)
        return self._landmarks_v2_dir / (identifier + ".json")

    def video_path(self, video_id: str) -> Path | None:
        for entry in self.entries.values():
            if entry.get("language") == "asl":
                continue
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
            result = {
                "vi": word_lower,
                "gloss": gloss,
                "found": True,
            }
            if self.entries[gloss].get("language") == "asl":
                result.update(language="asl", source="ASL")
            return result

        target = self._aliases.get(word_lower)
        if target:
            return {"vi": word_lower, "gloss": self.vi_to_gloss[target],
                    "found": True, "match": "alias", "matched_vi": target}

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

    def phrase_matches(self, text: str) -> list[tuple[int, int, dict]]:
        """Longest dictionary matches with offsets in normalized text.

        Punctuation is a boundary, but phrases never cross it. These offsets
        let parsers keep exact phrases intact before asking an AI to segment.
        """
        self.load()
        text = normalize_word(text)
        if self._token_pattern is None:
            return []
        return [(match.start(), match.end(), self.lookup_vietnamese(match.group()))
                for match in self._token_pattern.finditer(text)]

    def longest_match_tokenize(self, text: str) -> list[dict]:
        """Keep the longest known phrase, returning unknown words separately."""
        text = normalize_word(text)
        tokens = []
        cursor = 0
        for start, end, token in self.phrase_matches(text):
            tokens.extend({"vi": word.group(), "gloss": None, "found": False}
                          for word in re.finditer(r"\w+", text[cursor:start]))
            tokens.append(token)
            cursor = end
        tokens.extend({"vi": word.group(), "gloss": None, "found": False}
                      for word in re.finditer(r"\w+", text[cursor:]))
        return tokens


# Singleton
sign_dict = SignDictionary()
