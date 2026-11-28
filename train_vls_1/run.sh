#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")"
mkdir -p tmp
export PYTHONDONTWRITEBYTECODE=1 XDG_CACHE_HOME="$PWD/.cache" TORCH_HOME="$PWD/.cache/torch" TMPDIR="$PWD/tmp" MPLCONFIGDIR="$PWD/.cache/mpl" OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=1
export OPENCV_FFMPEG_THREADS=1
exec >>run.log 2>&1
trap 'echo "exit=$? at $(date -Is)"' EXIT
py=${TRAIN_PYTHON:-python}
echo "start $(date -Is)"
"$py" -u train.py rgb
"${LANDMARK_PYTHON:-$py}" -u prepare_pose.py >pose.log 2>&1
"$py" -u train.py pose
"$py" fusion.py
