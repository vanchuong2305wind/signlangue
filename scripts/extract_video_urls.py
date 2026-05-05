"""
Create a comprehensive gloss → videos mapping from WLASL_v0.3.json.
Each gloss maps to ALL available video URLs + local video fallback.
Output format: dictionary keyed by gloss for fast lookup.
"""
import json
import os
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
WLASL_PATH = DATA_DIR / "archive" / "WLASL_v0.3.json"
GLOSS_TO_VI_PATH = DATA_DIR / "processed" / "gloss_to_vi.json"
VIDEOS_DIR = DATA_DIR / "archive" / "videos"
OUTPUT_PATH = DATA_DIR / "processed" / "sign_videos.json"

CATEGORIES = {
    "greetings": ["hello", "goodbye", "thank you", "please", "sorry", "welcome", "nice", "meet"],
    "family": ["mother", "father", "brother", "sister", "son", "daughter", "baby", "family",
               "husband", "wife", "cousin", "aunt", "uncle", "grandfather", "grandmother",
               "nephew", "niece", "children", "boy", "girl", "man", "woman", "friend"],
    "food_drink": ["eat", "drink", "water", "milk", "coffee", "tea", "bread", "cheese",
                   "chicken", "egg", "apple", "banana", "orange", "pizza", "sandwich",
                   "cookie", "cake", "candy", "chocolate", "sugar", "salt", "soup",
                   "salad", "food", "breakfast", "dinner", "hungry", "thirsty", "delicious"],
    "emotions": ["happy", "sad", "angry", "scared", "tired", "bored", "excited", "nervous",
                 "love", "hate", "like", "enjoy", "cry", "laugh", "smile", "worry",
                 "hope", "afraid", "upset", "proud", "lonely", "jealous", "shy", "confused"],
    "education": ["school", "teacher", "student", "learn", "study", "book", "read", "write",
                  "class", "test", "homework", "college", "university", "graduate", "library",
                  "science", "math", "history", "english", "art", "music", "dictionary"],
    "daily_life": ["home", "house", "room", "door", "window", "bed", "chair", "table",
                   "clothes", "shoes", "shower", "sleep", "wake up", "work", "drive", "walk",
                   "run", "sit", "stand", "open", "close", "clean", "cook"],
    "health": ["doctor", "nurse", "hospital", "medicine", "sick", "hurt", "headache",
               "cold", "hot", "temperature", "surgery", "dentist", "pain", "healthy"],
    "time_weather": ["time", "day", "week", "month", "year", "today", "tomorrow", "yesterday",
                     "morning", "afternoon", "evening", "night", "rain", "snow", "sun",
                     "cloud", "weather", "summer", "winter", "spring", "autumn"],
    "actions": ["go", "come here", "help", "want", "need", "give", "take", "bring",
                "show", "tell", "ask", "answer", "find", "buy", "pay", "stop",
                "wait", "play", "dance", "swim", "fly", "jump", "throw", "catch"],
    "animals": ["dog", "cat", "bird", "fish", "horse", "cow", "pig", "chicken",
                "monkey", "elephant", "bear", "rabbit", "mouse", "snake", "turtle",
                "deer", "duck", "frog", "lion", "tiger", "butterfly"],
    "colors_numbers": ["red", "blue", "green", "yellow", "black", "white", "brown",
                       "orange", "pink", "color", "one", "two", "three", "four", "five",
                       "six", "seven", "eight", "nine", "ten"],
}


def get_categories(gloss):
    cats = []
    g = gloss.lower()
    for cat, words in CATEGORIES.items():
        if g in words:
            cats.append(cat)
    return cats if cats else ["other"]


def classify_url(url):
    """Classify URL type for the frontend."""
    if not url:
        return "unknown"
    if url.endswith(".swf"):
        return "swf"
    if "youtube.com" in url or "youtu.be" in url:
        return "youtube"
    if url.endswith(".mp4"):
        return "mp4"
    return "other"


def main():
    print("Loading WLASL data...")
    with open(WLASL_PATH, "r", encoding="utf-8") as f:
        wlasl = json.load(f)
    print(f"  {len(wlasl)} glosses")

    print("Loading Vietnamese translations...")
    with open(GLOSS_TO_VI_PATH, "r", encoding="utf-8") as f:
        gloss_to_vi = json.load(f)
    print(f"  {len(gloss_to_vi)} translations")

    # Scan local video files
    print("Scanning local videos...")
    local_videos = set()
    if VIDEOS_DIR.exists():
        for f in VIDEOS_DIR.iterdir():
            if f.suffix == ".mp4":
                local_videos.add(f.stem)  # e.g., "00335"
    print(f"  {len(local_videos)} local video files")

    # Build the mapping
    result = {}
    stats = {"total": 0, "with_mp4": 0, "with_local": 0, "with_youtube": 0}

    for entry in wlasl:
        gloss = entry["gloss"].lower()
        instances = entry.get("instances", [])
        vi = gloss_to_vi.get(gloss, "")
        categories = get_categories(gloss)

        videos = []
        local_paths = []

        for inst in instances:
            url = inst.get("url", "")
            video_id = inst.get("video_id", "")
            source = inst.get("source", "")
            url_type = classify_url(url)

            # Skip .swf files entirely
            if url_type == "swf":
                continue

            video_entry = {
                "url": url,
                "source": source,
                "type": url_type,
                "video_id": video_id,
            }
            videos.append(video_entry)

            # Check if this video_id has a local file
            if video_id and video_id in local_videos:
                local_path = f"/videos/{video_id}.mp4"
                if local_path not in [lp["url"] for lp in local_paths]:
                    local_paths.append({
                        "url": local_path,
                        "source": "local",
                        "type": "local",
                        "video_id": video_id,
                    })

        # Sort videos: mp4 first, then youtube, then others
        type_order = {"mp4": 0, "local": 1, "youtube": 2, "other": 3}
        videos.sort(key=lambda v: type_order.get(v["type"], 99))

        # Add local videos at the end
        videos.extend(local_paths)

        if not videos:
            continue

        result[gloss] = {
            "gloss": gloss,
            "vi": vi,
            "categories": categories,
            "videos": videos,
            "video_count": len(videos),
        }

        stats["total"] += 1
        if any(v["type"] == "mp4" for v in videos):
            stats["with_mp4"] += 1
        if any(v["type"] == "local" for v in videos):
            stats["with_local"] += 1
        if any(v["type"] == "youtube" for v in videos):
            stats["with_youtube"] += 1

    print(f"\n=== Results ===")
    print(f"Total glosses: {stats['total']}")
    print(f"With direct .mp4: {stats['with_mp4']}")
    print(f"With local video: {stats['with_local']}")
    print(f"With YouTube: {stats['with_youtube']}")
    print(f"With Vietnamese: {sum(1 for v in result.values() if v['vi'])}")

    # Also create a flat array version for easy listing
    flat_list = sorted(result.values(), key=lambda x: (0 if x["vi"] else 1, x["gloss"]))

    output = {
        "glosses": result,       # dict keyed by gloss for fast lookup
        "list": flat_list,       # sorted array for listing/pagination
        "stats": {
            "total": stats["total"],
            "with_vi": sum(1 for v in result.values() if v["vi"]),
            "with_mp4": stats["with_mp4"],
            "with_local": stats["with_local"],
            "categories": {},
        }
    }

    # Category counts
    for item in flat_list:
        for c in item["categories"]:
            output["stats"]["categories"][c] = output["stats"]["categories"].get(c, 0) + 1

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    size_mb = os.path.getsize(OUTPUT_PATH) / (1024 * 1024)
    print(f"\nSaved to {OUTPUT_PATH} ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
