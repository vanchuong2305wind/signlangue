"""Regression checks for compound Vietnamese signs across parser branches."""

import asyncio
import tempfile
import unittest
import unicodedata
from pathlib import Path
from unittest.mock import AsyncMock, patch
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.api import local_nlp, text_parser
from app.api.sign_lookup import SignDictionary
from app.api.viesign_dataset import atomic_json, word_id


class PhraseMatchingTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.meanings = ["chào", "bạn", "học", "sinh", "học sinh", "học sinh giỏi"]
        self.publish(self.meanings)
        self.dictionary = SignDictionary(self.root)
        self.dictionary.load()
        self.parser_patch = patch.object(text_parser, "sign_dict", self.dictionary)
        self.parser_patch.start()
        self.addCleanup(self.parser_patch.stop)
        text_parser._parse_cache.clear()

    def publish(self, meanings):
        entries = {}
        for index, meaning in enumerate(meanings):
            identifier = word_id(meaning)
            entries[identifier] = {"vi": meaning, "video_id": str(index),
                                   "source_video": f"data_v2/{index}.mp4"}
            atomic_json(self.root / "landmarks" / f"{identifier}.json", {"frames": []})
        atomic_json(self.root / "catalog.json", {"dataset": "viesign", "entries": entries})

    def parse(self, text, use_llm=True):
        return asyncio.run(text_parser.parse_text(text, use_llm=use_llm))

    def test_greeting_uses_existing_chao_clip_as_one_sign(self):
        with patch.object(text_parser, "parse_with_gemini", new_callable=AsyncMock) as gemini:
            tokens, method = self.parse("Xin chào!")
        gemini.assert_not_awaited()
        self.assertEqual(method, "dictionary")
        self.assertEqual(tokens, [{"vi": "xin chào", "gloss": word_id("chào"),
                                   "found": True, "match": "alias", "matched_vi": "chào"}])

    def test_actual_compound_clip_takes_priority_over_alias(self):
        self.publish(self.meanings + ["xin chào"])
        dictionary = SignDictionary(self.root)
        dictionary.load()
        self.assertEqual(dictionary.lookup_vietnamese("xin chào"),
                         {"vi": "xin chào", "gloss": word_id("xin chào"), "found": True})
        empty = SignDictionary(self.root / "empty")
        self.assertEqual(empty.longest_match_tokenize("xin chào"),
                         [{"vi": "xin", "gloss": None, "found": False},
                          {"vi": "chào", "gloss": None, "found": False}])

    def test_longest_phrase_unicode_spacing_and_punctuation(self):
        text = unicodedata.normalize("NFD", "  HỌC_sinh   GIỎI, học sinh! ")
        tokens = self.dictionary.longest_match_tokenize(text)
        self.assertEqual([token["vi"] for token in tokens], ["học sinh giỏi", "học sinh"])
        self.assertTrue(all(token["found"] for token in tokens))
        self.assertEqual([token["vi"] for token in self.dictionary.longest_match_tokenize("học, sinh")],
                         ["học", "sinh"])
        self.assertFalse(self.dictionary.longest_match_tokenize("chàobạn")[0]["found"])

    def test_gemini_only_receives_unmatched_span(self):
        with patch.object(text_parser, "parse_with_gemini", new=AsyncMock(return_value=["bạn"])) as gemini:
            tokens, method = self.parse("Xin chào bạn, học sinh giỏi!")
        gemini.assert_awaited_once_with(" bạn, ")
        self.assertEqual(method, "gemini")
        self.assertEqual([token["vi"] for token in tokens], ["xin chào", "bạn", "học sinh giỏi"])

    def test_local_parser_cannot_split_protected_compounds(self):
        def split_gap(text):
            return [{"vi": word, "gloss": None, "found": False} for word in text.split()]
        with patch.object(text_parser, "parse_with_gemini", new=AsyncMock(return_value=None)), \
                patch.object(local_nlp, "status", return_value={"loaded": True}), \
                patch.object(local_nlp, "parse", side_effect=split_gap) as local:
            tokens, method = self.parse("xin chào zzz học sinh")
        local.assert_called_once_with(" zzz ")
        self.assertEqual(method, "local")
        self.assertEqual([token["vi"] for token in tokens], ["xin chào", "zzz", "học sinh"])

    def test_rules_preserve_compounds_and_unknown_words_without_llm(self):
        with patch.object(local_nlp, "status", return_value={"loaded": False}), \
                patch.object(text_parser, "parse_with_gemini", new_callable=AsyncMock) as gemini:
            tokens, method = self.parse("xin chào zzz học sinh", use_llm=False)
        gemini.assert_not_awaited()
        self.assertEqual(method, "rule_based")
        self.assertEqual([token["vi"] for token in tokens], ["xin chào", "zzz", "học sinh"])
        self.assertFalse(tokens[1]["found"])

    def test_single_and_batch_api_keep_one_sign_per_compound(self):
        from fastapi.testclient import TestClient
        from app.api import server
        with patch.object(server, "sign_dict", self.dictionary), \
                patch.object(text_parser, "parse_with_gemini", new_callable=AsyncMock) as gemini:
            client = TestClient(server.app)
            response = client.post("/api/text-to-signs", json={"text": "Xin chào!"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["total_count"], 1)
            self.assertEqual(response.json()["signs"][0]["matched_vi"], "chào")
            response = client.post("/api/text-to-signs/batch",
                                   json={"texts": ["xin chào", "học sinh giỏi"]})
            self.assertEqual(response.status_code, 200)
            for result in response.json()["results"]:
                self.assertEqual(result["total_count"], 1)
                self.assertEqual(result["found_count"], 1)
            gemini.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
