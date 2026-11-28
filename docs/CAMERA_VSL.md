# Camera VSL224

Camera uses `VSL224-Hiera-RGB`, an isolated-sign classifier with 224 Vietnamese
labels. It replaces WLASL100 only for `/api/camera/*`; the old WLASL files remain.
Text/speech-to-sign, VieSign catalogs, and avatar playback are independent.

## Local model assets

The runtime reads these project-relative files, regardless of working directory:

```text
models/camera/vsl224/rgb-best.pt
models/camera/vsl224/labels.json
```

The checkpoint was copied from `../trian_vls3/results/rgb-best.pt`; labels are an
unchanged copy of that run's `labels.json`. The original training folders were
not changed. The checkpoint is about 195 MiB and is ignored by Git. On another
machine, supply this exact checkpoint separately; pulling source code alone does
not install it. Keep the paired label list in its original order.

SHA-256:

- `rgb-best.pt`: `14ad616249e560f293427002b3d14363ece0e32dc2633ecf1b0913fe61555fc1`
- `labels.json`: `b5cd803d59c2808e8dc7cc75aff1ac22480765ec81a30585947c7054fd72af9a`

The Hiera source needed by inference is in `app/api/vsl_hiera`; see its NOTICE.md
and preserved LICENSE. Runtime never imports a training script, reads training
manifests, depends on sibling directories, or downloads pretrained weights.
`timm==1.0.30` is added to requirements; this was checked with torch 2.6.0+cu124
and torchvision 0.21.0+cu124 in the current environment.

## Camera flow and limits

1. Browser capture stays at one JPEG per 125 ms, with the existing motion gate,
   pre-roll, FIFO queue and 12–44-frame clip segmentation.
2. API accepts 12–48 frames. It decodes BGR, selects 16 indices with
   `floor((arange(16) + 0.5) * N / 16)`, resizes each image directly to 224×224,
   converts to RGB and builds `[1, 3, 16, 224, 224]` uint8.
3. Hiera normalizes exactly once in its forward:
   `(x / 255 - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]`.
   It uses `mask_ratio=0`, LayerNorm(768), Dropout(0.2), Linear(768,224).
   The complete state_dict is loaded with `weights_only=True`, `strict=True`.
4. Each clip produces one label; underscores become spaces for Vietnamese
   display. API fields `prediction`, `alternatives`, `model`, `device` and
   `frame_count` remain. `frame_count` counts received frames;
   `model_frame_count` is always 16.
5. Existing confidence >=0.45 and margin >=0.12 control accepted tokens. Each
   motion event contributes at most one accepted token, even across forced clip
   cutoffs. A pause of three quiet capture ticks starts a new event, so distinct
   events may contribute the same word. The thresholds and the motion gate have
   NOT been calibrated for VSL224.
6. “Tạo câu đề xuất” takes those tokens in order and calls Gemini. The original
   tokens remain beside an editable draft. Repetitions and negation are retained
   by the prompt and local fallback. Reading/copying requires explicit confirmation;
   edits and source changes invalidate approval. Undo can revert approval or edits.

The former WLASL backend static-edge trimming is removed from this path:
it changes the sampled content relative to training and could discard meaningful
holds. This preserves the received clip, rather than claiming a camera accuracy
improvement. Browser motion segmentation is unchanged.

Pause slightly between signs. A label can be a multiword phrase, e.g.
`bệnh_viện` → `bệnh viện`, but the model does not decode a continuous signed
sentence. Signs outside the 224 labels can still produce a confident wrong
label: there is no trained unknown/background class. Event separation still
depends on a motion pause; two signs without a pause can merge into one event.
Gemini receives words, not camera video.
The saved video-test RGB Top-1 of 87.97% is not webcam accuracy.

## Availability and errors

`GET /api/camera/model-status` reports the model name, 224 classes, 16 model
frames, `available`, `loaded`, and `error`. Before first recognition this is
an asset/label/dependency preflight, not proof the checkpoint loads. Weights
load lazily on first valid clip, guarded by a lock; inference has its own lock.
After a load failure status exposes the failure; there is no WLASL fallback.
Missing assets/dependencies or an incompatible checkpoint give HTTP 503 on
recognition. Invalid images give 400; invalid request lengths/top_k give 422.
CUDA is selected if available, otherwise CPU. CPU inference can create a queue
backlog if capture is faster than processing; latency must be measured on the
deployment device. After replacing assets/dependencies, restart the intended
API yourself to ensure in-memory weights are replaced.

## Verify and run

From the signlangue project root, in the existing environment:

```bash
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python tests/camera_vsl_test.py
PYTHONDONTWRITEBYTECODE=1 HF_HUB_OFFLINE=1 .venv/bin/python scripts/verify_camera_vsl.py --reference-root ..
```

The second command uses three distinct test-video labels from
`data_v2/VieSign10K` by default. Optional `--reference-root ..` checks the original
Hiera/RGB class and video preprocessing without executing training entry points.
It reads sibling source only as a development reference; omit that flag for a
standalone API smoke check. It opens no port, runs no app startup/AI preloads,
and calls no Gemini service. It checks full-video preprocessing/logit parity,
then exercises JPEG recognition and sentence composition through in-process HTTP.
This verifies integration, not webcam performance or a new dataset accuracy score.

Integration check on 2026-11-22: all six camera contract/error tests passed;
the three real test videos A0003 (`tự_tin`), A0016 (`ôm`), and A0033 (`ghét`)
were recognized correctly through the JPEG API on both CUDA and CPU, with
preprocessing and logit parity against the original source. All three passed
the current confidence/margin filters and reached sentence composition in order.
The frontend build, camera-component lint, and existing
cue-timeline test passed (the build still warns about a large avatar bundle).
No physical webcam test or live Gemini request was performed.

To try in a NEW process without stopping an existing API, choose an unused port:

```bash
LOCAL_AI_PRELOAD=0 .venv/bin/python scripts/run.py serve-api --port 8001
```

The launcher prints the actual port (it advances if that port is occupied).
In a second terminal, point Vite to that printed port:

```bash
cd app/frontend
VITE_API_TARGET=http://localhost:8001 npm run dev
```

Open the URL printed by Vite on localhost, allow the camera, start recognition,
and use signs from `labels.json`. Stop recognition and wait for queued clips before
pressing “Tạo câu đề xuất”. Compare/edit the draft and click “Xác nhận câu” before
reading/copying. See [the review demo](CAMERA_SENTENCE_REVIEW.md) for repetitions,
negation and undo. On another device use HTTPS for browser camera permission.
Existing running services keep their old imported code until explicitly restarted.
