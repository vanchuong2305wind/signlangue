"""Learning filters must use Vietnamese labels and count the returned entries."""

import tempfile
import unittest
from collections import Counter
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.api.sign_lookup import SignDictionary
from app.api.viesign_categories import categories_for
from app.api.viesign_dataset import atomic_json, word_id


class VieSignCategoriesTest(unittest.TestCase):
    def test_learning_topics_use_vietnamese_meanings(self):
        for meaning, topic in [("chào", "greetings"), ("ông ngoại", "family"),
                               ("bún cá", "food_drink"), ("tôi yêu bạn", "emotions"),
                               ("HỌC_SINH", "education"), ("áo phông", "daily_life"),
                               ("đau bụng", "health"), ("giông bão", "time_weather"),
                               ("chạy", "actions"), ("chó", "animals"),
                               ("0 (số không)", "colors_numbers"), ("1 000 000", "colors_numbers")]:
            with self.subTest(meaning=meaning):
                self.assertIn(topic, categories_for(meaning))

    def test_unknown_or_ambiguous_prefix_does_not_get_a_false_topic(self):
        for meaning in ["vsl-123456", "hello", "bánh xe", "bánh lái", "dấu chân", "truyền thống"]:
            with self.subTest(meaning=meaning):
                self.assertEqual(categories_for(meaning), ["other"])

    def test_catalog_category_counts_match_filter_results(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            entries = {}
            for meaning in ["chào", "học sinh", "cá", "bún cá", "bánh xe"]:
                identifier = word_id(meaning)
                entries[identifier] = {"vi": meaning, "video_id": identifier,
                                       "source_video": f"data_v2/{identifier}.mp4"}
                atomic_json(root / "landmarks" / f"{identifier}.json", {"frames": []})
            atomic_json(root / "catalog.json", {"dataset": "viesign", "entries": entries})
            # An unpublished clip must never appear in a filter or its counts.
            (root / "landmarks" / f"{word_id('chào')}.json").unlink()
            catalog = SignDictionary(root).video_catalog()
            counts = Counter(category for entry in catalog["list"] for category in entry["categories"])
            self.assertEqual(catalog["stats"]["categories"], dict(counts))
            self.assertEqual(catalog["stats"]["total"], 4)
            self.assertEqual([entry["vi"] for entry in catalog["list"] if "education" in entry["categories"]],
                             ["học sinh"])
            self.assertEqual([entry["vi"] for entry in catalog["list"] if "other" in entry["categories"]],
                             ["bánh xe"])
            self.assertNotIn("greetings", counts)


if __name__ == "__main__":
    unittest.main()
