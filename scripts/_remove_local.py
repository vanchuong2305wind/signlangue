"""Quick script to remove all 'local' type videos from sign_videos.json"""
import json
from pathlib import Path

JSON_PATH = Path(__file__).parent.parent / "app" / "frontend" / "public" / "data" / "sign_videos.json"

with open(JSON_PATH, 'r', encoding='utf-8') as f:
    data = json.load(f)

total_before = 0
total_after = 0
removed = 0

for gloss_key, gloss_data in data.get("glosses", {}).items():
    videos = gloss_data.get("videos", [])
    total_before += len(videos)
    new_videos = [v for v in videos if v.get("type") != "local"]
    removed += len(videos) - len(new_videos)
    total_after += len(new_videos)
    gloss_data["videos"] = new_videos
    gloss_data["video_count"] = len(new_videos)

with open(JSON_PATH, 'w', encoding='utf-8') as f:
    json.dump(data, f, indent=2, ensure_ascii=False)

print(f"Removed {removed} local videos")
print(f"Total: {total_before} -> {total_after}")
