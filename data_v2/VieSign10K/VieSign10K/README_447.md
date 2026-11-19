# VieSign-10K: Vietnamese Isolated Sign Language Corpus and Benchmarks

**Version:** 9 October 2026

VieSign-10K is a Vietnamese isolated sign language video corpus comprising 10,515 videos across 3,659 sign classes. Two evaluation benchmarks are derived from this corpus: VieSign-1182 and VieSign-SI447.

## 1. Corpus and Benchmark Overview

| Name | Description | Videos | Classes |
|---|---|---:|---:|
| **VieSign-10K** | Complete corpus | 10,515 | 3,659 |
| **VieSign-1182** | Original class-stratified benchmark with signer overlap | 7,664 | 1,182 |
| **VieSign-SI447** | Supplementary signer-independent benchmark | 4,252 | 447 |

These datasets are related subsets, not independent collections. Their video counts must not be added together.

### VieSign-10K

The complete corpus contains 10,515 videos covering 3,659 sign classes. It provides the source collection from which the evaluation benchmarks are derived.

### VieSign-1182

The original benchmark contains 7,664 unique videos covering 1,182 classes. It uses a class-stratified split that permits signer overlap between partitions.

| Partition | Videos |
|---|---:|
| Train | 4,154 |
| Validation | 1,755 |
| Test | 1,755 |
| **Total** | **7,664** |

This protocol evaluates recognition when signer identities may be shared across training, validation, and testing.

### VieSign-SI447

The signer-independent benchmark contains 4,252 videos covering 447 classes. Signer groups are mutually disjoint, and all 447 classes appear in every partition.

| Partition | Videos | Signers | Classes | Video proportion |
|---|---:|---:|---:|---:|
| Train | 2,344 | 25 | 447 | 55.13% |
| Validation | 1,021 | 13 | 447 | 24.01% |
| Test | 887 | 12 | 447 | 20.86% |
| **Total** | **4,252** | **50** | **447** | **100.00%** |

VieSign-SI447 is derived from VieSign-1182 by retaining classes represented in all three signer-disjoint partitions. This filtering excludes 735 classes comprising 3,412 videos.

Use only this 447-class configuration for the revised benchmark. Do not combine it with the alternative 572-class configuration.

## 2. Revision Package Contents

The following files document the construction and use of VieSign-SI447.

| File | Description |
|---|---|
| `ISLR_447classes_4252videos.csv` | Filtered VieSign-SI447 manifest containing 4,252 rows. Use this file for training and evaluation. |
| `ISLR_447_all_rows.csv` | Complete VieSign-1182 source manifest containing 7,664 rows, including entries excluded from VieSign-SI447. |
| `class_split_audit.csv` | Audit of the 1,182 source classes, including video and signer counts, partition counts, and reasons for retention or exclusion. |
| `signer_assignment.csv` | Partition assignments and retention status for the 57 signer IDs in the source benchmark. |
| `validation_checks.csv` | Checks for signer overlap, duplicate video IDs, and class coverage. |
| `split_summary.json` | Benchmark statistics and split-search parameters. |

The filenames are retained for compatibility with existing scripts.

> **Consistency check before release:** The partition statistics indicate 50 retained signers. An earlier file description reported 51 retained signers and six excluded signers among 57 source IDs. Verify `signer_assignment.csv` and reconcile these counts before publication.

## 3. Selecting the Evaluation Protocol

The manifests contain two partition columns:

| Column | Protocol |
|---|---|
| `split` | Original VieSign-1182 partition assignments |
| `split_signer_independent` | Revised VieSign-SI447 partition assignments |

For VieSign-SI447 experiments, use **`split_signer_independent`**.

Its retained entries are assigned to `train`, `val`, or `test`. The complete 7,664-row manifest additionally contains entries marked as `excluded`.

The `Signer` column identifies the person performing the sign. Clothing or background changes must not be used to assign different identities to the same person.

A `not_in_benchmark` status indicates that a source signer has no retained videos; it does not indicate an unknown identity.

## 4. Loading VieSign-SI447

```python
import pandas as pd

df = pd.read_csv("ISLR_447classes_4252videos.csv")
split_column = "split_signer_independent"

assert len(df) == 4252
assert df["Meaning"].nunique() == 447
assert df[split_column].isin(["train", "val", "test"]).all()
assert df["Signer"].notna().all()

train = df[df[split_column] == "train"].copy()
val = df[df[split_column] == "val"].copy()
test = df[df[split_column] == "test"].copy()

assert (len(train), len(val), len(test)) == (2344, 1021, 887)

signer_sets = {
    "train": set(train["Signer"]),
    "val": set(val["Signer"]),
    "test": set(test["Signer"]),
}

assert signer_sets["train"].isdisjoint(signer_sets["val"])
assert signer_sets["train"].isdisjoint(signer_sets["test"])
assert signer_sets["val"].isdisjoint(signer_sets["test"])

classes = sorted(df["Meaning"].unique())
class_to_idx = {
    label: index
    for index, label in enumerate(classes)
}

for partition in (train, val, test):
    assert set(partition["Meaning"]) == set(classes)
    partition["label_idx"] = partition["Meaning"].map(class_to_idx)
```

Use the same label mapping and partition manifests for every model.

When adapting an existing video-copying function, replace:

```python
row["split"]
```

with:

```python
row["split_signer_independent"]
```

The filtered 4,252-row manifest contains no excluded entries.

The intended directory structure is:

```text
VieSign-SI447/
├── train/
│   └── <Meaning>/
├── val/
│   └── <Meaning>/
└── test/
    └── <Meaning>/
```

## 5. VieSign-SI447 Split Construction

The split search used:

- 100 initializations.
- Random seed: `20261009`.
- A maximum of 80 signer-reassignment steps per initialization.
- Target video proportions of 55–65% for training and 15–25% each for validation and testing.

The search prioritized the number of retained classes under the specified partition constraints. Each signer was assigned exclusively to one partition. A class was retained only when at least one video was available in each partition.

Test accuracy was not used to select the split. Global optimality has not been established.

The construction did not impose a minimum of three training videos or two training signers per class.

## 6. Training and Evaluation

For VieSign-SI447 experiments:

1. Retrain every model using the revised training partition.
2. Use only the validation partition for hyperparameter tuning, early stopping, and checkpoint selection.
3. Use the test partition only for final evaluation.
4. Apply the same label mapping and partition manifests to all models.
5. Document preprocessing, pretrained checkpoints, training settings, and random seeds.

Checkpoints previously trained on VieSign-1182 must not be reused to establish signer-independent performance, because their training data may include videos or signers assigned to the new validation or test partitions.

Report Top-1, Top-5, Top-10 accuracy, and Macro-F1 across all 447 classes. For long-tailed evaluation, define frequency groups using training-set counts only:

| Group | Training videos per class | Classes | Test videos |
|---|---|---:|---:|
| Head | At least 6 | 182 | 426 |
| Medium | 3–5 | 135 | 268 |
| Tail | 1–2 | 130 | 193 |

For repeated-run experiments, report mean ± sample standard deviation and specify the random seeds. Clearly distinguish single-run results from repeated-run summaries and identify the comparisons covered by statistical testing.

## 7. Interpretation and Limitations

VieSign-1182 and VieSign-SI447 differ in vocabulary, video composition, and signer separation. Their absolute accuracy differences cannot isolate the effect of signer overlap.

Signer independence depends on the consistency of the supplied signer IDs. Video content was unavailable during split construction for verifying identities, duplicate content, or label correctness.

The 57 source signer IDs refer to VieSign-1182. The signer count for the complete VieSign-10K corpus requires separate verification.

The label `Y0668` was retained as supplied in the metadata and was not verified against video content.

The data remain sparse and long-tailed, with limited training and test support for some classes. Constructing the signer-independent split alone does not resolve all reviewer concerns; outstanding experiments and verification tasks must be reported separately.

## 8. Source Attribution and Access

Source videos originate from YouTube and the QIPEDC Vietnamese Sign Language Dictionary. Source provenance and any available video identifiers or URLs should be retained in the metadata.

Access to and redistribution of source videos remain subject to the corresponding rights holders’ permissions and source conditions. Publication of metadata and evaluation splits does not imply permission to redistribute every source video.