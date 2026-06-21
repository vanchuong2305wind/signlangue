# Avatar landmark cache

These files are generated from local WLASL videos with MediaPipe Pose and
Hands. Each frame contains:

- `pose`: 33 image-space body landmarks
- `pose_world`: 33 world-space body landmarks
- `left_hand` / `right_hand`: 21 anatomical hand landmarks

Hand sides are matched to the nearest MediaPipe pose wrist instead of trusting
the handedness label, so mirrored and non-mirrored dictionary videos work
consistently. Sparse hand tracks below 20% coverage are removed as false
positives.

Regenerate the bundled signs:

```powershell
.\.venv\Scripts\python.exe scripts\extract_holistic_landmarks.py `
  --gloss hello --gloss book --gloss love --gloss me --gloss you --force
```

The source video ID, FPS, quality score, and detection coverage are stored in
each JSON file.
