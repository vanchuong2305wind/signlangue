#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")"
mkdir -p tmp
exec >>run.log 2>&1
exec 9>queue.lock
flock -n 9 || exit 0
export PYTHONDONTWRITEBYTECODE=1 TORCH_HOME="$PWD/cache/torch" XDG_CACHE_HOME="$PWD/cache" TMPDIR="$PWD/tmp" MPLCONFIGDIR="$PWD/cache/mpl" OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=1 OPENCV_FFMPEG_THREADS=1
first=../train_vls_1
py=${TRAIN_PYTHON:-python}
echo "$(date -Is) WAITING for train_vls_1 to finish RGB, landmark training and fusion"
while :; do
    last=$(tail -n 1 "$first/run.log")
    if [[ "$last" == exit=0\ at\ * ]] && [[ -s "$first/results/metrics.json" ]]; then
        "$py" -c 'import json,sys; d=json.load(open(sys.argv[1])); assert "top1" in d["test"] and "rgb_weight" in d' "$first/results/metrics.json"
        break
    fi
    if [[ "$last" == exit=* ]] || ! tmux -S "$first/train.sock" has-session -t viesign1182 2>/dev/null; then
        echo "$(date -Is) BLOCKED: first pipeline ended without verified success"
        exit 1
    fi
    sleep 30
done
echo "$(date -Is) START R(2+1)D-18"
"$py" -u train.py
echo "$(date -Is) COMPLETE"
