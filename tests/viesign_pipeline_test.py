"""Integration checks for selection, recovery, Vietnamese lookup and serving."""

import argparse
import contextlib
import csv
import io
import json
import socket
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app.api.viesign_dataset import atomic_json, normalize_word, word_id
from app.api.sign_lookup import SignDictionary
from scripts import extract_viesign_landmarks as pipeline


def clip(score, usable=True):
    def points(n):
        return [{"x": .1 + i*.001, "y": .2, "z": .3} for i in range(n)]
    frame = {"pose": points(33), "pose_world": points(33), "right_hand": points(21),
             "face_blendshapes": {"eyeBlinkLeft": .1, "jawOpen": .2}}
    return {"frames": [frame, frame], "fps": 25, "score": score,
            "coverage": {"body_and_hand": 1. if usable else 0., "both_hands": 0.}}


class VieSignPipelineTest(unittest.TestCase):
    def setUp(self):
        runs = ROOT / "data_v2" / "runs"
        runs.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="verification-", dir=runs)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        (self.source / "video_raw").mkdir(parents=True)
        self.rows = [
            {"ID_video": "A", "Meaning": "Cảm_ơn", "Signer": "1"},
            {"ID_video": "B", "Meaning": "ca\u0309m  o\u031bn", "Signer": "2"},
            {"ID_video": "C", "Meaning": "xin_chào", "Signer": "3"},
        ]
        with (self.source / "ISLR_447_all_rows.csv").open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=["ID_video", "Meaning", "Signer"])
            writer.writeheader(); writer.writerows(self.rows)
        for row in self.rows:
            (self.source / "video_raw" / f"{row['ID_video']}.mp4").write_bytes(b"fixture")
        self.model = self.root / "fixture.task"
        self.model.write_bytes(b"fixture")
        self.output = self.root / "output"
        self.args = argparse.Namespace(source=self.source, output=self.output, model=self.model,
                                       word=None, limit=None, plan=False, max_fps=25,
                                       max_width=960, min_coverage=.35, force=False)

    def run_build(self, fake):
        with patch.object(pipeline, "ensure_model"), patch.object(pipeline, "extract_clip", side_effect=fake) as extract:
            with contextlib.redirect_stdout(io.StringIO()):
                pipeline.build(self.args)
        return extract

    def test_normalization_keeps_accents_and_groups_representations(self):
        self.assertEqual(normalize_word(" CẢM_ƠN "), normalize_word("ca\u0309m  o\u031bn"))
        self.assertNotEqual(word_id("ma"), word_id("má"))
        groups, _, _ = pipeline.read_groups(self.source)
        self.assertEqual(len(groups), 2)
        self.assertEqual(len(groups["cảm ơn"]), 2)

    def test_best_clip_one_per_meaning_resume_and_missing_winner(self):
        scores = {"A": .5, "B": .95, "C": .8}
        fake = lambda path, *_: clip(scores[path.stem])
        self.assertEqual(self.run_build(fake).call_count, 3)
        catalog = json.loads((self.output / "catalog.json").read_text(encoding="utf-8"))
        self.assertEqual(len(catalog["entries"]), 2)
        self.assertEqual(catalog["entries"][word_id("cảm ơn")]["video_id"], "B")
        self.assertEqual(len(list((self.output / "landmarks").glob("*.json"))), 2)
        self.assertEqual(self.run_build(fake).call_count, 0)
        (self.output / "landmarks" / f"{word_id('cảm ơn')}.json").unlink()
        self.assertEqual(self.run_build(fake).call_count, 2)
        dictionary = SignDictionary(self.output); dictionary.load()
        self.assertTrue(dictionary.lookup_vietnamese("CẢM_ƠN")["found"])
        self.assertIsNone(dictionary.lookup_vietnamese("book"))
        self.assertEqual(len(dictionary.video_catalog()["list"]), 2)
        self.assertTrue(dictionary.video_path("B").is_relative_to(ROOT))
        self.assertIsNone(dictionary.video_path("../../.env"))

    def test_rejected_clip_never_published_and_no_asl_fallback(self):
        self.run_build(lambda path, *_: clip(.99, usable=path.stem != "C"))
        dictionary = SignDictionary(self.output); dictionary.load()
        self.assertIsNone(dictionary.lookup_vietnamese("xin chào"))
        self.assertEqual(len(dictionary.entries), 1)
        empty = SignDictionary(self.root / "absent"); empty.load()
        self.assertFalse(empty.available_glosses)
        self.assertIsNone(empty.lookup_vietnamese("hello"))

    def test_incomplete_source_and_duplicate_live_extractor_are_rejected(self):
        (self.source / "video_raw" / "C.mp4").unlink()
        with self.assertRaisesRegex(ValueError, "incomplete"):
            pipeline.read_groups(self.source)
        with pipeline.exclusive_lock(self.output):
            with self.assertRaisesRegex(RuntimeError, "already running"):
                with pipeline.exclusive_lock(self.output):
                    pass

    def test_api_serves_only_vietnamese_catalog_and_selected_video(self):
        self.run_build(lambda path, *_: clip(.8 if path.stem == "B" else .5))
        dictionary = SignDictionary(self.output); dictionary.load()
        from app.api import server, text_parser, local_nlp
        from fastapi.testclient import TestClient
        with patch.object(server, "sign_dict", dictionary), patch.object(text_parser, "sign_dict", dictionary), patch.object(local_nlp, "status", return_value={"loaded": False}):
            # No lifespan context: do not preload Whisper/PhoBERT or call Gemini.
            client = TestClient(server.app)
            words = client.get("/api/dictionary/videos")
            self.assertEqual(words.status_code, 200)
            self.assertEqual(words.json()["stats"]["total"], 2)
            self.assertEqual(client.get("/api/dictionary/stats").json()["dataset"], "viesign")
            response = client.post("/api/text-to-signs", json={"text": "cảm ơn", "use_llm": False})
            self.assertEqual(response.status_code, 200)
            identifier = word_id("cảm ơn")
            self.assertEqual(response.json()["found_count"], 1)
            self.assertEqual(response.json()["signs"][0]["gloss"], identifier)
            response = client.get(f"/api/landmarks/{identifier}")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["data"]["video_id"], "B")
            etag = response.headers["etag"]
            self.assertEqual(client.get(f"/api/landmarks/{identifier}", headers={"If-None-Match": etag}).status_code, 304)
            self.assertEqual(client.get("/api/landmarks/book").status_code, 404)
            self.assertEqual(client.get("/api/dataset/video/B").content, b"fixture")
            self.assertEqual(client.get("/api/dataset/video/not-selected").status_code, 404)

    def test_port_reservation_skips_existing_listener(self):
        from scripts.serve_viesign import reserve_socket
        with socket.socket() as occupied:
            occupied.bind(("127.0.0.1", 0)); occupied.listen(1)
            used = occupied.getsockname()[1]
            listener, selected = reserve_socket("127.0.0.1", used)
            try:
                self.assertNotEqual(used, selected)
                self.assertEqual(occupied.getsockname()[1], used)
                with socket.socket() as probe:
                    self.assertEqual(probe.connect_ex(("127.0.0.1", used)), 0)
            finally:
                listener.close()


if __name__ == "__main__":
    unittest.main()
