"""Export the active VieSign dictionary to chrome-extension-siglang.

The extension runs without the Python backend, so it gets a static copy of
exactly what the backend's SignDictionary publishes:

  public/data/viesign/dictionary.json      meanings, identifiers, aliases
  public/data/viesign/landmarks/<id>.json  VieSign (VSL) clips, copied verbatim

ASL supplement entries point at the extension's existing
data/landmarks_v2/<asl_gloss>.json, which is the same WLASL set the backend
reads from data/processed/landmarks_v2. Old data is never deleted.

Usage (from the signlangue folder):
    python -X utf8 scripts/export_viesign_to_extension.py [extension_dir]
"""

import filecmp
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.api.sign_lookup import SignDictionary  # noqa: E402
from app.api.viesign_dataset import DATASET_ID  # noqa: E402


def main():
    ext_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT.parent / "chrome-extension-siglang"
    public = ext_dir / "public"
    if not (public / "manifest.json").is_file():
        raise SystemExit(f"Not an extension folder: {ext_dir}")

    sign_dict = SignDictionary()
    sign_dict.load()

    out_dir = public / "data" / "viesign"
    landmark_dir = out_dir / "landmarks"
    landmark_dir.mkdir(parents=True, exist_ok=True)

    entries = {}
    copied = skipped = 0
    for identifier, entry in sorted(sign_dict.entries.items()):
        source = sign_dict.landmark_path(identifier)
        language = entry.get("language", "vsl")
        if language == "asl":
            # Reuse the extension's bundled ASL file; it must match the backend's.
            relative = f"data/landmarks_v2/{entry['asl_gloss']}.json"
            bundled = public / relative
            if not bundled.is_file() or not filecmp.cmp(source, bundled, shallow=False):
                raise SystemExit(f"Extension ASL file missing or different: {relative}")
        else:
            relative = f"data/viesign/landmarks/{identifier}.json"
            target = public / relative
            if target.is_file() and filecmp.cmp(source, target, shallow=False):
                skipped += 1
            else:
                shutil.copyfile(source, target)
                copied += 1
        entries[identifier] = {"vi": entry["vi"], "language": language, "landmark": relative}

    dictionary = {
        "dataset": DATASET_ID,
        "source_directory": sign_dict.data_dir.relative_to(ROOT).as_posix(),
        "entries": entries,
        "aliases": dict(sorted(sign_dict._aliases.items())),
    }
    (out_dir / "dictionary.json").write_text(
        json.dumps(dictionary, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    vsl = sum(e["language"] == "vsl" for e in entries.values())
    print(f"Exported {len(entries)} entries ({vsl} VSL, {len(entries) - vsl} ASL supplement), "
          f"{len(dictionary['aliases'])} aliases; copied {copied}, unchanged {skipped} landmark files")


if __name__ == "__main__":
    main()
