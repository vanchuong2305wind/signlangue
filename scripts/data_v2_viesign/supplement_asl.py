"""Select existing ASL landmark clips for missing VieSign labels and greeting."""

import json
import math
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from app.api.asl_supplement import ASL_LANDMARKS, SUPPLEMENT_PATH, existing_meaning
from app.api.viesign_dataset import active_data_dir, atomic_json, normalize_word, word_id


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def build():
    base = active_data_dir()
    meanings = {normalize_word(entry["vi"]) for identifier, entry in read(base / "catalog.json")["entries"].items()
                if (base / "landmarks" / (identifier + ".json")).is_file()}
    old = ROOT / "data" / "processed"
    videos = read(old / "sign_videos.json")["glosses"]
    groups = defaultdict(list)
    for gloss, meaning in read(old / "gloss_to_vi.json").items():
        groups[normalize_word(meaning)].append(gloss)
    aliases, entries, skipped = {}, {}, []
    preferred = {"tôi": "i", "nhiều": "many", "xin chào": "hello"}
    for meaning, glosses in sorted(groups.items()):
        target = existing_meaning(meaning, meanings)
        if target and meaning != "xin chào":
            if target != meaning:
                aliases[meaning] = target
            continue
        candidates = []
        for gloss in glosses:
            path = ASL_LANDMARKS / (gloss + ".json")
            if not path.is_file():
                continue
            clip = read(path)
            frames = clip.get("frames", [])
            if clip.get("schema_version") != 3 or not frames or not math.isfinite(clip.get("fps", 0)) or clip["fps"] <= 0:
                continue
            coverage = sum(bool(frame.get("pose")) and bool(frame.get("left_hand") or frame.get("right_hand"))
                           for frame in frames) / len(frames)
            if not coverage:
                continue
            for frame in frames:
                for track, count in (("pose", 33), ("pose_world", 33), ("left_hand", 21), ("right_hand", 21)):
                    points = frame.get(track)
                    if points and (len(points) != count or any(not math.isfinite(p[axis]) for p in points for axis in ("x", "y", "z"))):
                        raise ValueError(f"Invalid coordinates in {path}")
            rank = (gloss == preferred.get(meaning), float(clip.get("score", 0)), coverage, gloss)
            candidates.append((rank, gloss, clip))
        if not candidates:
            skipped.append(meaning)
            continue
        _, gloss, clip = max(candidates)
        identifier = word_id(meaning)
        source_videos = [video for video in videos.get(gloss, {}).get("videos", [])
                         if video.get("type") != "swf" and video.get("url", "").startswith(("https://", "http://"))]
        matching = [video for video in source_videos if str(video.get("video_id")) == str(clip.get("video_id"))]
        entries[identifier] = {
            "gloss": identifier, "vi": meaning, "language": "asl", "source": "WLASL",
            "asl_gloss": gloss, "video_id": "asl-" + str(clip.get("video_id", gloss)),
            "frame_count": len(clip["frames"]), "fps": clip["fps"],
            "score": clip.get("score", 0), "videos": matching or source_videos,
            "alternative_asl_glosses": sorted(glosses),
            "label_review": "translated_label_not_manually_verified",
        }
    greeting = entries.get(word_id("xin chào"))
    if not greeting or greeting["asl_gloss"] != "hello":
        raise ValueError("The requested ASL hello clip is unavailable")
    manifest = {"schema_version": 1, "base_directory": base.relative_to(ROOT).as_posix(),
                "overrides": ["xin chào"], "aliases": aliases, "entries": entries, "unavailable": skipped}
    atomic_json(SUPPLEMENT_PATH, manifest)
    print(json.dumps({"supplement": str(SUPPLEMENT_PATH), "asl_entries": len(entries),
                      "aliases_to_viesign": len(aliases), "unavailable": len(skipped)}, ensure_ascii=True))


if __name__ == "__main__":
    build()
