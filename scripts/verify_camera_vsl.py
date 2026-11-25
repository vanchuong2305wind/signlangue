"""Offline real-video/API verification; optional comparison with original training code.

Run from the project root with .venv/bin/python scripts/verify_camera_vsl.py
--dataset data_v2/VieSign10K --reference-root ..
The reference folders are only read by this verification command, never by runtime.
"""

import argparse
import ast
import base64
import csv
import json
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def reference_architecture(reference_root, labels, torch):
    # Execute only the RGB class definition, with pretrained initialization removed.
    # Never import train.py: its top-level code would start training and write files.
    sys.path.insert(0, str(reference_root / 'train_vls_1/SignRep'))
    from models.hiera.hiera_nodec_mae import mae_hiera_base_16x224
    source = reference_root / 'trian_vls3/train.py'
    node = next(n for n in ast.parse(source.read_text()).body
                if isinstance(n, ast.ClassDef) and n.name == 'RGB')
    init = next(n for n in node.body if isinstance(n, ast.FunctionDef) and n.name == '__init__')
    init.body = [n for n in init.body
                 if not (isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'ckpt' for t in n.targets))
                 and not (isinstance(n, ast.Expr) and isinstance(n.value, ast.Call)
                          and isinstance(n.value.func, ast.Attribute) and n.value.func.attr == 'load_state_dict')]
    namespace = {'torch': torch, 'nn': torch.nn, 'labels': labels,
                 'mae_hiera_base_16x224': mae_hiera_base_16x224}
    module = ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[]))
    exec(compile(module, str(source), 'exec'), namespace)
    return namespace['RGB']()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', type=Path, default=ROOT / 'data_v2/VieSign10K')
    parser.add_argument('--reference-root', type=Path)
    parser.add_argument('--count', type=int, default=3)
    args = parser.parse_args()
    import cv2
    import numpy as np
    import torch
    from fastapi.testclient import TestClient
    from app.api import camera_recognition as camera
    from app.api.server import app

    torch.set_num_threads(4)
    labels = camera._read_labels()
    with (args.dataset / 'ISLR_447_all_rows.csv').open(encoding='utf-8-sig') as handle:
        rows = list(csv.DictReader(handle))
    paths = {p.stem: p for p in (args.dataset / 'video_raw').iterdir()
             if p.suffix.lower() in ('.mp4', '.webm')}
    selected, seen = [], set()
    for row in rows:
        if row['split'] == 'test' and row['Meaning'] in labels and row['Meaning'] not in seen:
            selected.append(row)
            seen.add(row['Meaning'])
            if len(selected) >= args.count:
                break
    assert len(selected) == args.count, 'Not enough test videos'

    with patch('torch.hub.load_state_dict_from_url', side_effect=AssertionError('No downloads allowed')):
        camera._ensure_model()
        reference = None
        read_reference = None
        if args.reference_root:
            refroot = args.reference_root.resolve()
            reference = reference_architecture(refroot, labels, torch)
            reference.load_state_dict(torch.load(camera.CHECKPOINT, map_location='cpu', weights_only=True), strict=True)
            reference = reference.to(camera._device).eval()
            source = refroot / 'trian_vls3/dataset.py'
            node = next(n for n in ast.parse(source.read_text()).body
                        if isinstance(n, ast.FunctionDef) and n.name == 'read_clip')
            namespace = {'np': np, 'cv2': cv2, 'paths': paths}
            exec(compile(ast.Module(body=[node], type_ignores=[]), str(source), 'exec'), namespace)
            read_reference = namespace['read_clip']

        client = TestClient(app)  # No startup, model preloads, ports or external services.
        words, results = [], []
        try:
            status = client.get('/api/camera/model-status')
            assert status.status_code == 200 and status.json()['classes'] == 224
            for row in selected:
                cap = cv2.VideoCapture(str(paths[row['ID_video']]))
                frames = []
                while True:
                    ok, frame = cap.read()
                    if not ok:
                        break
                    frames.append(frame)
                cap.release()
                assert frames, row['ID_video']
                tensor = camera._preprocess(frames)
                if reference is not None:
                    original = torch.from_numpy(read_reference(row['ID_video'])).permute(3, 0, 1, 2).unsqueeze(0)
                    assert torch.equal(tensor, original), 'Training preprocessing differs'
                    with torch.inference_mode():
                        actual = camera._model(tensor.to(camera._device))
                        expected = reference(original.to(camera._device))
                    torch.testing.assert_close(actual, expected, rtol=1e-5, atol=1e-6)

                # Send exactly the sampled 16 frames via real JPEG/base64 request.
                indices = ((np.arange(16) + .5) * len(frames) / 16).astype(int)
                encoded = []
                for i in indices:
                    ok, jpg = cv2.imencode('.jpg', frames[i], [cv2.IMWRITE_JPEG_QUALITY, 90])
                    assert ok
                    encoded.append('data:image/jpeg;base64,' + base64.b64encode(jpg).decode())
                response = client.post('/api/camera/recognize', json={'frames': encoded, 'top_k': 3})
                assert response.status_code == 200, response.text
                result = response.json()
                assert result['model'] == camera.MODEL_NAME
                assert result['model_frame_count'] == 16 and result['frame_count'] == 16
                assert len(result['alternatives']) == 2
                prediction = result['prediction']
                assert prediction['label'] in labels
                assert prediction['vietnamese'] == prediction['label'].replace('_', ' ')
                decoded = [camera._decode_frame(frame) for frame in encoded]
                with torch.inference_mode():
                    p = camera._model(camera._preprocess(decoded).to(camera._device)).float().softmax(1)[0]
                assert prediction['label'] == labels[p.argmax().item()]
                assert prediction['confidence'] == round(p.max().item(), 4)
                # Match the existing browser's confidence and runner-up filters.
                accepted = (prediction['confidence'] >= .45
                            and prediction['confidence'] - result['alternatives'][0]['confidence'] >= .12)
                if accepted:
                    words.append(prediction['vietnamese'])
                results.append({'video': row['ID_video'], 'expected': row['Meaning'],
                                **prediction, 'accepted_for_sentence': accepted})
            assert len(words) >= 2, 'Need multiple accepted tokens to verify sentence composition'
            with patch('app.api.server.build_sentence', new_callable=AsyncMock, side_effect=RuntimeError('offline verification')):
                sentence = client.post('/api/camera/build-sentence', json={'words': words})
            assert sentence.status_code == 200 and sentence.json()['source_words'] == words
            print(json.dumps({'device': str(camera._device), 'reference_parity': reference is not None,
                              'videos': results, 'sentence': sentence.json()}, ensure_ascii=False, indent=2))
        finally:
            client.close()


if __name__ == '__main__':
    main()
