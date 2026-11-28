# VieSign training runs

The directories match the names used on the training server. Each results directory contains the label mapping, metrics, trained checkpoints and any saved predictions.

| Directory | Labels | Train / validation / test clips | Test Top-1 |
| --- | ---: | --- | --- |
| `train_vls_1` | 1,182 | 4,154 / 1,755 / 1,755 | SignRep RGB 63.87%, landmark TCN 51.40%, fusion 64.39% |
| `train_vls_2` | 1,182 | 4,154 / 1,755 / 1,755 | R(2+1)D-18 52.71% |
| `trian_vls3` | 224 | 1,945 / 632 / 632 | SignRep RGB 87.97%, landmark TCN 78.16%, fusion 87.82% |

The 224-label run uses classes represented by at least seven videos in the original train split. Its selected rows are in `trian_vls3/manifest.csv`. The original split allows the same signer in multiple splits. The two vocabulary sizes use different test sets.

## Clone and get the checkpoints

Install Git LFS before cloning. If already on this branch, run `git lfs pull` in the working tree.

```bash
git lfs install
git clone --branch viesign-training-20261121 https://github.com/vanchuong2305wind/signlangue.git
```

Use the `*-best.pt` or `best.pt` files for evaluation and the label order in the same directory's `labels.json`. The `*-last.pt` and `last.pt` files also include optimizer, scheduler and scaler state for resuming. Files named after a split in `results/` store prediction tensors. For either SignRep run, `python fusion.py` run from that directory reproduces the fusion scores using those tensors.

## Rerun training

The shell launchers are for Linux or WSL. They use the active Python environment by default. Set `TRAIN_PYTHON` and `LANDMARK_PYTHON` to absolute interpreter paths if training and MediaPipe use separate environments. The training server used PyTorch 2.6.0 and torchvision 0.21.0 with CUDA 12.4, NumPy, OpenCV and timm. Install the landmark dependencies from `scripts/data_v2_viesign/requirements.txt` for the pose extractor.

Place the VieSign videos in `data_v2/VieSign10K/VieSign10K/video_raw/` next to the original manifest, or set `VIESIGN_DATA_DIR` to a directory containing both `video_raw/` and `ISLR_447_all_rows.csv`. The published results include trained weights. To rerun or resume RGB training, also download the upstream [SignRep v0.0.1 checkpoint](https://github.com/ryanwongsa/SignRep/releases/tag/v0.0.1) to `train_vls_1/ckpt.pt`. Its SHA-256 is `f8be8ca44aec4d7066175dccc681338f376ec86de6ba72bc79223a6bbd3c766b`. The R(2+1)D-18 trainer obtains the Kinetics-400 initialization through torchvision.

For the original SignRep run, execute `bash run.sh` inside `train_vls_1`. To generate just the landmarks, run `python prepare_pose.py` in that directory with the MediaPipe environment. The 224-label run also reads those generated per-video landmarks. Once available, execute `bash run.sh` inside `trian_vls3`. For the R(2+1)D-18 run, execute `python train.py` from `train_vls_2`. Its `queue.sh` is the server launcher for running after the first job. Move the provided results out of the relevant directory if the intention is to train from the upstream initialization again.

The `train_vls_1/frequent_380` scripts correspond to the interrupted 380-label experiment.

## SignRep attribution

The vendored [SignRep](https://github.com/ryanwongsa/SignRep) code is from commit `06f40b5d287867b24e0dd2dc380b40b3f2ae8ac2`. SignRep is by Ryan Wong, Necati Cihan Camgoz and Richard Bowden. The VieSign RGB checkpoints in `train_vls_1` and `trian_vls3` are fine-tuned derivatives distributed under CC BY-NC-SA 4.0. See [the license](train_vls_1/SignRep/LICENSE) and the [upstream checkpoint release](https://github.com/ryanwongsa/SignRep/releases/tag/v0.0.1).
