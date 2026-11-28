import csv
import os
from pathlib import Path
import numpy as np
import cv2

ROOT = Path(__file__).resolve().parent
def find_repo():
    for candidate in (ROOT.parent, ROOT.parent.parent, ROOT.parent / 'signlangue',
                      ROOT.parent.parent / 'signlangue'):
        if (candidate / 'data_v2/VieSign10K').is_dir():
            return candidate
    raise FileNotFoundError('Cannot locate the signlangue project data directory')


REPO = find_repo()
DATA_DIR = REPO / 'data_v2/VieSign10K'
DATA = Path(os.environ['VIESIGN_DATA_DIR']).expanduser().resolve() if 'VIESIGN_DATA_DIR' in os.environ else next(
    (candidate for candidate in (DATA_DIR, DATA_DIR / 'VieSign10K')
     if (candidate / 'ISLR_447_all_rows.csv').is_file() and (candidate / 'video_raw').is_dir()),
    DATA_DIR / 'VieSign10K',
)

rows = list(csv.DictReader((DATA / 'ISLR_447_all_rows.csv').open(encoding='utf-8-sig')))
from collections import Counter
counts = Counter(r['Meaning'] for r in rows if r['split'] == 'train')
labels = sorted(word for word, count in counts.items() if count >= 7)
selected = set(labels)
rows = [r for r in rows if r['Meaning'] in selected]
assert len(labels) == 224
assert Counter(r['split'] for r in rows) == {'train':1945, 'valid':632, 'test':632}
paths = {p.stem: p for p in (DATA / 'video_raw').iterdir() if p.suffix.lower() in ('.mp4', '.webm')}
cv2.setNumThreads(0)

def read_clip(key, jitter=False):
    cap = cv2.VideoCapture(str(paths[key]))
    try:
        count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        if count <= 0:
            raise ValueError(f'Invalid frame count: {key}')
        offset = np.random.uniform(0.1, 0.9, 16) if jitter else 0.5
        indices = ((np.arange(16) + offset) * count / 16).astype(int)
        frames = []
        for idx in range(indices[-1] + 1):
            if not cap.grab():
                break
            if idx != indices[len(frames)]:
                continue
            ok, frame = cap.retrieve()
            if not ok:
                break
            frame = cv2.cvtColor(cv2.resize(frame, (224, 224)), cv2.COLOR_BGR2RGB)
            frames.extend([frame] * int((indices == idx).sum()))
        if not frames:
            raise ValueError(f'Unreadable clip: {key}')
        return np.stack(frames + [frames[-1]] * (16 - len(frames)))
    finally:
        cap.release()
