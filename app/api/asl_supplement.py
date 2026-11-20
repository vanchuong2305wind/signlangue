"""Explicit ASL additions selected for the active VieSign dictionary."""

from pathlib import Path

from .viesign_dataset import ROOT, normalize_word, word_id

SUPPLEMENT_PATH = ROOT / "data_v2" / "annotations" / "asl_supplement.json"
ASL_LANDMARKS = ROOT / "data" / "processed" / "landmarks_v2"
CLASSIFIERS = ("cái ", "con ", "chiếc ", "quyển ", "cuốn ", "sự ", "việc ")


def existing_meaning(meaning, available):
    if meaning in available:
        return meaning
    return next((meaning[len(prefix):] for prefix in CLASSIFIERS
                 if meaning.startswith(prefix) and meaning[len(prefix):] in available), None)


def landmark_path(entry):
    gloss = entry["asl_gloss"]
    if not isinstance(gloss, str) or not gloss or "/" in gloss or "\\" in gloss:
        raise ValueError("Invalid ASL source gloss")
    path = (ASL_LANDMARKS / (gloss + ".json")).resolve()
    if not path.is_relative_to(ASL_LANDMARKS.resolve()):
        raise ValueError("ASL landmark outside its source directory")
    if entry.get("gloss") != word_id(normalize_word(entry["vi"])):
        raise ValueError("Invalid ASL supplement identifier")
    return path
