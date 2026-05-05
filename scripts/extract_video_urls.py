"""
Extract best video URL per gloss from WLASL_v0.3.json
and merge with Vietnamese translations.
Output: sign_videos.json for frontend consumption.
"""
import json
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
WLASL_PATH = DATA_DIR / "archive" / "WLASL_v0.3.json"
GLOSS_TO_VI_PATH = DATA_DIR / "processed" / "gloss_to_vi.json"
OUTPUT_PATH = DATA_DIR / "processed" / "sign_videos.json"

# Source priority (higher = better for direct playback)
SOURCE_PRIORITY = {
    "aslbrick": 10,
    "handspeak": 9,
    "signingsavvy": 8,
    "startasl": 7,
    "signschool": 6,
    "aslsignbank": 5,
    "asldeafined": 4,
    "aslsearch": 3,
    "asllex": 2,
}

# Categories for organizing words
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


def pick_best_url(instances):
    """Pick the best direct .mp4 URL from instances."""
    candidates = []
    for inst in instances:
        url = inst.get("url", "")
        if not url:
            continue
        # Skip non-playable formats
        if ".swf" in url:
            continue
        # Check if it's a direct mp4 link (not YouTube)
        is_direct_mp4 = url.endswith(".mp4")
        is_youtube = "youtube.com" in url or "youtu.be" in url
        source = inst.get("source", "")
        priority = SOURCE_PRIORITY.get(source, 1)

        if is_direct_mp4:
            priority += 20  # Strongly prefer direct mp4
        elif is_youtube:
            priority -= 10  # Deprioritize YouTube

        candidates.append({
            "url": url,
            "priority": priority,
            "source": source,
            "video_id": inst.get("video_id", ""),
            "is_direct": is_direct_mp4,
        })

    if not candidates:
        return None

    candidates.sort(key=lambda x: x["priority"], reverse=True)
    best = candidates[0]
    return {
        "url": best["url"],
        "source": best["source"],
        "video_id": best["video_id"],
    }


def categorize_gloss(gloss):
    """Find categories for a gloss."""
    cats = []
    gloss_lower = gloss.lower()
    for cat_name, words in CATEGORIES.items():
        if gloss_lower in words:
            cats.append(cat_name)
    return cats if cats else ["other"]


def main():
    print("Loading WLASL data...")
    with open(WLASL_PATH, "r", encoding="utf-8") as f:
        wlasl = json.load(f)
    print(f"  Found {len(wlasl)} glosses")

    print("Loading Vietnamese translations...")
    with open(GLOSS_TO_VI_PATH, "r", encoding="utf-8") as f:
        gloss_to_vi = json.load(f)
    print(f"  Found {len(gloss_to_vi)} translations")

    results = []
    skipped = 0
    no_video = 0

    for entry in wlasl:
        gloss = entry["gloss"]
        instances = entry.get("instances", [])

        video_info = pick_best_url(instances)
        if not video_info:
            no_video += 1
            continue

        vi_word = gloss_to_vi.get(gloss.lower(), "")
        categories = categorize_gloss(gloss)

        results.append({
            "gloss": gloss.lower(),
            "vi": vi_word,
            "url": video_info["url"],
            "source": video_info["source"],
            "video_id": video_info["video_id"],
            "categories": categories,
            "instance_count": len(instances),
        })

    # Sort: words with Vietnamese translations first, then alphabetically
    results.sort(key=lambda x: (0 if x["vi"] else 1, x["gloss"]))

    print(f"\nResults:")
    print(f"  Total glosses with video: {len(results)}")
    print(f"  With Vietnamese: {sum(1 for r in results if r['vi'])}")
    print(f"  Skipped (no video): {no_video}")

    # Category stats
    cat_counts = {}
    for r in results:
        for c in r["categories"]:
            cat_counts[c] = cat_counts.get(c, 0) + 1
    print(f"\nCategories:")
    for cat, count in sorted(cat_counts.items(), key=lambda x: -x[1]):
        print(f"  {cat}: {count}")

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f"\nSaved to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
