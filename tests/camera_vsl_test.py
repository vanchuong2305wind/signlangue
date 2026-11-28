"""VSL camera contract/error checks; no webcam, training or network needed."""

import base64
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import cv2
import numpy as np
import torch
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app.api import camera_recognition as camera
from app.api.server import app


class CameraVSLTest(unittest.TestCase):
    def setUp(self):
        # No context manager: do not run app startup/preload unrelated AI models.
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def test_sampling_preserves_rgb_and_training_resize_for_short_and_long_clips(self):
        for count in (12, 17, 44, 48):
            frames = [np.full((30, 50, 3), (i, 100, 200), dtype=np.uint8)
                      for i in range(count)]
            result = camera._preprocess(frames)
            expected = [int((i + .5) * count / 16) for i in range(16)]
            self.assertEqual(tuple(result.shape), (1, 3, 16, 224, 224))
            self.assertEqual(result.dtype, torch.uint8)
            self.assertEqual(result[0, 2, :, 0, 0].tolist(), expected)
            self.assertTrue((result[0, 0] == 200).all())
            self.assertTrue((result[0, 1] == 100).all())

    def test_missing_checkpoint_status_and_recognition(self):
        with patch.object(camera, 'CHECKPOINT', ROOT / 'models/nonexistent.pt'):
            response = self.client.get('/api/camera/model-status')
            self.assertFalse(response.json()['available'])
            self.assertIn('VSL224', response.json()['error'])
            response = self.client.post('/api/camera/recognize', json={'frames': ['x'] * 12})
            self.assertEqual(response.status_code, 503)

    def test_invalid_labels_and_missing_dependency(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'labels.json'
            for labels in (['wrong'], ['duplicate'] * 224, {'labels': []}):
                path.write_text(json.dumps(labels))
                with patch.object(camera, 'LABELS_FILE', path):
                    self.assertFalse(camera.model_status()['available'])
        original = camera.importlib.util.find_spec
        with patch.object(camera.importlib.util, 'find_spec',
                          side_effect=lambda name: None if name == 'timm' else original(name)):
            self.assertIn('timm', camera.model_status()['error'])

    def test_invalid_frames_and_top_k(self):
        for count in (0, 11, 49):
            response = self.client.post('/api/camera/recognize', json={'frames': ['x'] * count})
            self.assertEqual(response.status_code, 422)
        for encoded in ('!!!', '', base64.b64encode(b'not an image').decode()):
            response = self.client.post('/api/camera/recognize', json={'frames': [encoded] * 12})
            self.assertEqual(response.status_code, 400)
        response = self.client.post('/api/camera/recognize', json={'frames': ['x'] * 12, 'top_k': 0})
        self.assertEqual(response.status_code, 422)

    def test_incompatible_checkpoint_never_publishes_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'bad.pt'
            torch.save({'head.2.weight': torch.zeros(1, 1)}, path)
            with patch.object(camera, '_model', None), patch.object(camera, '_load_error', None), \
                    patch.object(camera, 'CHECKPOINT', path):
                with self.assertRaisesRegex(RuntimeError, 'Không nạp được model VSL224'):
                    camera._ensure_model()
                self.assertIsNone(camera._model)
                status = camera.model_status()
                self.assertFalse(status['available'])
                self.assertIn('VSL224', status['error'])

    def test_multiple_vsl_tokens_reach_sentence_builder_in_order(self):
        # These are actual VSL labels, not English-to-Vietnamese dictionary entries.
        words = [label.replace('_', ' ') for label in camera._read_labels()[:3]]
        with patch('app.api.server.build_sentence', new_callable=AsyncMock,
                   side_effect=RuntimeError('offline')):
            response = self.client.post('/api/camera/build-sentence', json={'words': words})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['source_words'], words)
        self.assertEqual(response.json()['method'], 'local')
        self.assertEqual(response.json()['sentence'], ' '.join(words).capitalize() + '.')


if __name__ == '__main__':
    unittest.main()
