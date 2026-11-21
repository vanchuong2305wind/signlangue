#!/bin/bash
set -eu
cd "$(dirname "$0")"
mkdir -p tmp
export PYTHONDONTWRITEBYTECODE=1 XDG_CACHE_HOME="$PWD/.cache" TORCH_HOME="$PWD/.cache/torch" TMPDIR="$PWD/tmp" OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=1 OPENCV_FFMPEG_THREADS=1
exec >>run.log 2>&1
trap 'echo "exit=$? at $(date -Is)"' EXIT
echo "start $(date -Is)"
"${TRAIN_PYTHON:-python}" -u train.py rgb
"${TRAIN_PYTHON:-python}" -u train.py pose
"${TRAIN_PYTHON:-python}" -u fusion.py
