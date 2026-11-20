"""Regression checks for the explicit hybrid dictionary and ASL greeting."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.api import asl_supplement
from app.api.sign_lookup import SignDictionary
from app.api.viesign_dataset import atomic_json, word_id


class AslSupplementTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.base = self.root / "viesign"
        self.asl = self.root / "asl"
        self.manifest = self.root / "supplement.json"
        entries = {}
        for word in ["chào", "học sinh", "trống"]:
            identifier = word_id(word)
            entries[identifier] = {"vi": word, "video_id": identifier, "source_video": f"data_v2/{identifier}.mp4"}
            atomic_json(self.base / "landmarks" / (identifier + ".json"), {"frames": []})
        atomic_json(self.base / "catalog.json", {"dataset": "viesign", "entries": entries})
        self.extra = {}
        for word, gloss in [("xin chào", "hello"), ("học sinh", "student"), ("tôi", "i")]:
            identifier = word_id(word)
            self.extra[identifier] = {"gloss": identifier, "vi": word, "language": "asl",
                                      "asl_gloss": gloss, "videos": [], "video_id": "asl-" + gloss}
            atomic_json(self.asl / (gloss + ".json"), {"frames": [{"pose": [], "right_hand": []}], "fps": 25})
        self.write_manifest()
        patcher = patch.object(asl_supplement, "ASL_LANDMARKS", self.asl)
        patcher.start()
        self.addCleanup(patcher.stop)

    def write_manifest(self):
        atomic_json(self.manifest, {"base_directory": str(self.base), "overrides": ["xin chào"],
                                   "entries": self.extra, "aliases": {"cái trống": "trống"}})

    def dictionary(self):
        result = SignDictionary(self.base, supplement_path=self.manifest)
        result.load()
        return result

    def test_asl_fills_missing_meanings_and_greeting_overrides_chao_alias(self):
        dictionary = self.dictionary()
        self.assertEqual(len(dictionary.entries), 5)
        token = dictionary.lookup_vietnamese("xin chào")
        self.assertEqual(token["gloss"], word_id("xin chào"))
        self.assertEqual(token["language"], "asl")
        self.assertEqual(dictionary.landmark_path(token["gloss"]), self.asl / "hello.json")
        self.assertEqual(dictionary.landmark_path(word_id("học sinh")),
                         self.base / "landmarks" / (word_id("học sinh") + ".json"))
        self.assertEqual(dictionary.lookup_vietnamese("cái trống")["gloss"], word_id("trống"))
        self.assertEqual(dictionary.lookup_vietnamese("tôi")["language"], "asl")
        self.assertEqual(next(entry for entry in dictionary.video_catalog()["list"]
                              if entry["vi"] == "xin chào")["language"], "asl")

    def test_greeting_and_landmarks_work_through_normal_api(self):
        from app.api import server, text_parser
        from fastapi.testclient import TestClient
        dictionary = self.dictionary()
        with patch.object(server, "sign_dict", dictionary), patch.object(text_parser, "sign_dict", dictionary):
            client = TestClient(server.app)
            response = client.post("/api/text-to-signs", json={"text": "xin chào", "use_llm": False})
            self.assertEqual(response.status_code, 200)
            signs = response.json()["signs"]
            self.assertEqual(len(signs), 1)
            self.assertEqual(signs[0]["language"], "asl")
            clip = client.get("/api/landmarks/" + signs[0]["gloss"])
            self.assertEqual(clip.status_code, 200)
            self.assertEqual(clip.json()["data"], json.loads((self.asl / "hello.json").read_text()))
            self.assertEqual(client.get("/api/landmarks/hello").status_code, 404)
            self.assertEqual(client.get("/api/landmarks/" + signs[0]["gloss"],
                                        headers={"If-None-Match": clip.headers["etag"]}).status_code, 304)

    def test_missing_file_is_not_advertised_and_path_escape_is_rejected(self):
        (self.asl / "i.json").unlink()
        self.assertIsNone(self.dictionary().lookup_vietnamese("tôi"))
        self.extra[word_id("xin chào")]["asl_gloss"] = "../escape"
        self.write_manifest()
        with self.assertRaises(ValueError):
            self.dictionary()

    def test_manifest_refresh_and_binding_to_active_base(self):
        dictionary = self.dictionary()
        del self.extra[word_id("tôi")]
        self.write_manifest()
        dictionary._last_checked = 0
        dictionary.load()
        self.assertIsNone(dictionary.lookup_vietnamese("tôi"))
        atomic_json(self.manifest, {"base_directory": "different-release", "entries": self.extra})
        self.assertEqual(len(self.dictionary().entries), 3)


if __name__ == "__main__":
    unittest.main()
