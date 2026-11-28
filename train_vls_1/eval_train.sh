#!/bin/bash
set -eu
cd "$(dirname "$0")"
mkdir -p tmp
export PYTHONDONTWRITEBYTECODE=1 OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=1 XDG_CACHE_HOME="$PWD/.cache" TORCH_HOME="$PWD/.cache/torch" TMPDIR="$PWD/tmp"
exec >eval_train.log 2>&1
"${TRAIN_PYTHON:-python}" -u eval_train.py rgb
"${TRAIN_PYTHON:-python}" -u eval_train.py pose
"${TRAIN_PYTHON:-python}" -c 'import torch; a,y=torch.load("results/rgb-train.pt",weights_only=True); b,z=torch.load("results/pose-train.pt",weights_only=True); assert torch.equal(y,z); p=.9*a+.1*b; ok=p.argmax(1)==y; n=y.bincount(minlength=p.shape[1]); print("TRAIN fusion top1",ok.float().mean().item(),"macro",(y[ok].bincount(minlength=p.shape[1])[n>0]/n[n>0]).mean().item(),flush=True)'
echo COMPLETE
