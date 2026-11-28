"""Verify the deployment serves built SPA/assets and API on one origin."""

import re
import sys
import unittest
from pathlib import Path
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.runtime.production import app


class ProductionServerTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def test_spa_routes_and_cache(self):
        for path in ('/', '/camera', '/learn', '/translate', '/video-translate'):
            response = self.client.get(path)
            self.assertEqual(response.status_code, 200, path)
            self.assertIn('text/html', response.headers['content-type'])
            self.assertIn('id="root"', response.text)
            self.assertEqual(response.headers['cache-control'], 'no-cache')

    def test_build_assets_and_public_avatar(self):
        index = self.client.get('/').text
        script = re.search(r'src="(/assets/[^\"]+\.js)"', index).group(1)
        response = self.client.get(script)
        self.assertEqual(response.status_code, 200)
        self.assertIn('immutable', response.headers['cache-control'])
        response = self.client.head('/models/avatar.vrm')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(int(response.headers['content-length']),
                         (ROOT / 'app/frontend/dist/models/avatar.vrm').stat().st_size)

    def test_api_is_not_spa_and_files_outside_dist_are_not_served(self):
        status = self.client.get('/api/camera/model-status')
        self.assertEqual(status.status_code, 200)
        self.assertEqual(status.json()['model'], 'VSL224-Hiera-RGB')
        self.assertEqual(status.json()['classes'], 224)
        for path in ('/api/nonexistent', '/assets/missing.js', '/.env', '/models/camera/vsl224/rgb-best.pt'):
            self.assertEqual(self.client.get(path).status_code, 404, path)


if __name__ == '__main__':
    unittest.main()
