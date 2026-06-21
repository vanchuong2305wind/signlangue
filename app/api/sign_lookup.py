"""
sign_lookup.py
Load vi_to_gloss.json and sign_dictionary_landmarks.json.
Provide lookup: Vietnamese word → gloss → landmark frames.
"""

import json
import os
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "processed"


class SignDictionary:
    def __init__(self):
        self.vi_to_gloss: dict[str, str] = {}
        self.gloss_to_vi: dict[str, str] = {}
        self.available_glosses: set[str] = set()
        self._landmarks_path = DATA_DIR / "sign_dictionary_landmarks.json"
        self._landmarks_v2_dir = DATA_DIR / "landmarks_v2"
        self._loaded = False

    def load(self):
        if self._loaded:
            return

        vi_path = DATA_DIR / "vi_to_gloss.json"
        gloss_path = DATA_DIR / "gloss_to_vi.json"

        with open(vi_path, "r", encoding="utf-8") as f:
            self.vi_to_gloss = json.load(f)

        with open(gloss_path, "r", encoding="utf-8") as f:
            self.gloss_to_vi = json.load(f)

        self.available_glosses = set(self.gloss_to_vi.keys())

        # Build multi-word Vietnamese phrases sorted by length (longest first)
        self._vi_phrases = sorted(
            self.vi_to_gloss.keys(),
            key=lambda x: len(x),
            reverse=True,
        )

        self._loaded = True
        print(f"[SignDictionary] Loaded {len(self.vi_to_gloss)} VI->Gloss entries, "
              f"{len(self.available_glosses)} glosses available")

    def lookup_vietnamese(self, word: str) -> dict | None:
        """Look up a Vietnamese word/phrase and return its gloss info.
        Also tries matching as an English gloss if Vietnamese lookup fails.
        """
        word_lower = word.lower().strip()
        gloss = self.vi_to_gloss.get(word_lower)
        if gloss:
            return {
                "vi": word_lower,
                "gloss": gloss,
                "found": True,
            }

        # Fallback: try matching as English gloss directly
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
        for char in word.lower():
            if char.isalpha() and char in self.available_glosses:
                letters.append({
                    "vi": char,
                    "gloss": char,
                    "found": True,
                    "fingerspell": True,
                })
            elif char == " ":
                continue
            else:
                letters.append({
                    "vi": char,
                    "gloss": char,
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
        text = text.lower().strip()
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
