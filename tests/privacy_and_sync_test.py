"""Verification tests for privacy controls, offline-only isolation, and data deletion."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from app.api import cue_translate, sentence_builder, server, text_parser, video_subtitles
from app.api.profile_store import ProfileStore


class PrivacyAndSyncTest(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.profile_path = Path(self.tmpdir.name) / "profile.json"
        self.store = ProfileStore(path=self.profile_path)
        self._orig_store = server.profile_store
        server.profile_store = self.store
        self.client = TestClient(server.app)

    def tearDown(self):
        server.profile_store = self._orig_store
        self.tmpdir.cleanup()

    def test_offline_only_blocks_gemini_and_video_network(self):
        env = {"OFFLINE_ONLY": "1", "GEMINI_API_KEY": "fake-live-key-for-test"}
        with patch.dict(os.environ, env, clear=False):
            self.assertFalse(text_parser.gemini_enabled())
            self.assertFalse(sentence_builder.gemini_configured())
            self.assertFalse(cue_translate._gemini_enabled())

            status_resp = self.client.get("/api/privacy/status")
            self.assertEqual(status_resp.status_code, 200)
            payload = status_resp.json()
            self.assertTrue(payload["offline_only"])
            self.assertFalse(payload["external_services"]["gemini"]["enabled"])
            self.assertFalse(payload["external_services"]["video_subtitles_network"]["enabled"])
            self.assertEqual(payload["storage_policy"]["camera_frames"], "ram_only")
            self.assertEqual(payload["storage_policy"]["speech_audio"], "ram_only")

            with patch.object(text_parser, "parse_with_gemini", new=AsyncMock()) as mock_parse:
                resp = self.client.post("/api/text-to-signs", json={"text": "xin chào", "use_llm": True})
                self.assertEqual(resp.status_code, 200)
                mock_parse.assert_not_called()

            with patch.object(sentence_builder, "build_sentence", new=AsyncMock()) as mock_build:
                resp = self.client.post("/api/camera/build-sentence", json={"words": ["xin chào", "bạn"]})
                self.assertEqual(resp.status_code, 200)
                self.assertEqual(resp.json()["method"], "local")
                mock_build.assert_not_called()

            with self.assertRaises(video_subtitles.SubtitleError):
                video_subtitles.fetch_subtitles("https://www.youtube.com/watch?v=dQw4w9WgXcQ")

    def test_selective_and_full_history_deletion(self):
        r1 = self.client.post(
            "/api/profile/activities",
            json={"type": "recognition", "label": "xin chào", "value": 1},
        )
        r2 = self.client.post(
            "/api/profile/activities",
            json={"type": "translation", "label": "cảm ơn", "value": 1},
        )
        self.assertEqual(r1.status_code, 200)
        self.assertEqual(r2.status_code, 200)
        self.assertTrue(self.profile_path.exists())

        # Invalid activity_type is rejected
        bad = self.client.delete("/api/profile/activities?activity_type=unknown")
        self.assertEqual(bad.status_code, 400)

        # Selective deletion removes only camera recognition history
        sel = self.client.delete("/api/profile/activities?activity_type=recognition")
        self.assertEqual(sel.status_code, 200)
        activities = sel.json()["history"]
        self.assertEqual(len(activities), 1)
        self.assertEqual(activities[0]["type"], "translation")

        # Full profile deletion removes profile.json from disk
        wipe = self.client.delete("/api/profile")
        self.assertEqual(wipe.status_code, 200)
        self.assertEqual(wipe.json()["history"], [])
        self.assertFalse(self.profile_path.exists())

    def test_camera_and_speech_endpoints_do_not_write_media_to_disk(self):
        before = set(Path(self.tmpdir.name).iterdir())

        with patch.object(server, "recognize", return_value={"prediction": {"label": "hello", "confidence": 0.9}}):
            cam_resp = self.client.post(
                "/api/camera/recognize",
                json={"frames": ["data:image/jpeg;base64,AAAA"] * 12, "top_k": 3},
            )
            self.assertEqual(cam_resp.status_code, 200)

        with patch.object(server.asr, "transcribe", return_value={"text": "xin chào", "language": "vi"}):
            asr_resp = self.client.post(
                "/api/speech/transcribe?lang=vi-VN",
                content=b"RIFF0000WAVEfmt ",
            )
            self.assertEqual(asr_resp.status_code, 200)

        after = set(Path(self.tmpdir.name).iterdir())
        self.assertEqual(before, after)

    def test_cors_blocks_unknown_origin_and_allows_localhost(self):
        blocked = self.client.get("/api/privacy/status", headers={"Origin": "https://evil.example"})
        self.assertEqual(blocked.status_code, 200)
        self.assertNotIn("access-control-allow-origin", blocked.headers)

        allowed = self.client.get("/api/privacy/status", headers={"Origin": "http://localhost:5173"})
        self.assertEqual(allowed.status_code, 200)
        self.assertEqual(allowed.headers.get("access-control-allow-origin"), "http://localhost:5173")

    def test_no_deprecated_google_generativeai_imports(self):
        api_dir = Path(__file__).resolve().parents[1] / "app" / "api"
        for py_file in api_dir.glob("*.py"):
            content = py_file.read_text(encoding="utf-8")
            self.assertNotIn("google.generativeai", content, msg=f"Deprecated SDK found in {py_file.name}")


if __name__ == "__main__":
    unittest.main()
