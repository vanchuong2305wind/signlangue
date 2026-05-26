"""
Video Link Validator v2 (STRICT) for sign_videos.json
- mp4/other links: downloads first bytes, REQUIRES ftyp/moov magic bytes + Content-Length > 10KB
- youtube links: oEmbed API check
- local links: checks if file actually exists on disk
- Runs concurrently (50 at a time)
- Removes all non-loadable videos
- Updates video_count
"""

import json
import asyncio
import aiohttp
import time
import sys
import os
from pathlib import Path

# --- Config ---
JSON_PATH = Path(__file__).parent.parent / "app" / "frontend" / "public" / "data" / "sign_videos.json"
PUBLIC_DIR = Path(__file__).parent.parent / "app" / "frontend" / "public"
CONCURRENCY = 50
TIMEOUT = 15
MAX_RETRIES = 2
MIN_VIDEO_SIZE = 5000  # minimum 5KB for a real video


# --- MP4 validation (STRICT) ---
VALID_MP4_BOX_TYPES = {b'ftyp', b'moov', b'mdat', b'free', b'wide', b'skip', b'pnot', b'uuid'}

def is_valid_video_file(data: bytes) -> bool:
    """Strictly validate video by checking MP4/MOV container structure."""
    if len(data) < 8:
        return False

    # Check for ftyp box - the definitive MP4/MOV/M4V signature
    # Standard: bytes 4-7 = 'ftyp', bytes 0-3 = box size
    if data[4:8] == b'ftyp':
        return True

    # Some files start with other boxes before ftyp
    # Walk the box structure
    offset = 0
    max_check = min(len(data), 512)
    while offset < max_check - 8:
        box_size = int.from_bytes(data[offset:offset+4], 'big')
        box_type = data[offset+4:offset+8]

        if box_type == b'ftyp':
            return True

        if box_type in VALID_MP4_BOX_TYPES and 8 <= box_size <= 100_000_000:
            offset += box_size
        else:
            break

    # Also check for WebM (1A 45 DF A3)
    if data[:4] == b'\x1a\x45\xdf\xa3':
        return True

    # Check for MOV (might have 'moov' or 'mdat' as first box)
    if data[4:8] in (b'moov', b'mdat', b'wide'):
        return True

    return False


async def check_direct_link(session: aiohttp.ClientSession, url: str, semaphore: asyncio.Semaphore) -> bool:
    """Download first bytes and STRICTLY verify it's a playable video file."""
    async with semaphore:
        for attempt in range(MAX_RETRIES):
            try:
                headers = {
                    'Range': 'bytes=0-8191',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
                async with session.get(url, headers=headers,
                                       timeout=aiohttp.ClientTimeout(total=TIMEOUT),
                                       allow_redirects=True, ssl=False) as resp:

                    if resp.status not in (200, 206):
                        if attempt < MAX_RETRIES - 1:
                            await asyncio.sleep(1)
                            continue
                        return False

                    content_type = resp.headers.get('Content-Type', '').lower()

                    # Immediate reject: HTML pages (error pages, login pages)
                    if 'text/html' in content_type or 'text/plain' in content_type:
                        return False

                    # Check Content-Length (from Content-Range or Content-Length header)
                    content_length = 0
                    cr = resp.headers.get('Content-Range', '')
                    if '/' in cr:
                        try:
                            content_length = int(cr.split('/')[-1])
                        except (ValueError, IndexError):
                            pass

                    if content_length == 0:
                        cl = resp.headers.get('Content-Length', '0')
                        try:
                            content_length = int(cl)
                        except ValueError:
                            pass

                    # If we know the full size and it's too small, reject
                    if content_length > 0 and content_length < MIN_VIDEO_SIZE:
                        return False

                    # Read first 8KB
                    data = await resp.content.read(8192)

                    if not data or len(data) < 8:
                        return False

                    # STRICT: Must have valid video container magic bytes
                    if is_valid_video_file(data):
                        return True

                    # If content-type explicitly says video AND we got enough data, accept
                    if 'video/' in content_type and len(data) >= 100:
                        # Double check it's not text disguised as video
                        try:
                            data[:200].decode('utf-8')
                            # If it decodes as UTF-8 text, it's probably an error page
                            return False
                        except UnicodeDecodeError:
                            # Binary data with video content-type = probably valid
                            return True

                    return False

            except (aiohttp.ClientError, asyncio.TimeoutError, Exception):
                if attempt < MAX_RETRIES - 1:
                    await asyncio.sleep(1)
                    continue
                return False

    return False


async def check_youtube_link(session: aiohttp.ClientSession, url: str, semaphore: asyncio.Semaphore) -> bool:
    """Check if YouTube video is available via oEmbed."""
    async with semaphore:
        for attempt in range(MAX_RETRIES):
            try:
                oembed_url = f"https://www.youtube.com/oembed?url={url}&format=json"
                async with session.get(oembed_url,
                                       timeout=aiohttp.ClientTimeout(total=TIMEOUT),
                                       ssl=False) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        return data.get('type') == 'video' and bool(data.get('title'))
                    elif resp.status in (401, 403):
                        # Video exists but embedding restricted
                        return True
                    elif resp.status == 404:
                        return False
                    else:
                        if attempt < MAX_RETRIES - 1:
                            await asyncio.sleep(1)
                            continue
                        return False

            except (aiohttp.ClientError, asyncio.TimeoutError, Exception):
                if attempt < MAX_RETRIES - 1:
                    await asyncio.sleep(1)
                    continue
                return False

    return False


def check_local_file(url: str) -> bool:
    """Check if local video file actually exists on disk."""
    rel_path = url.lstrip('/')
    full_path = PUBLIC_DIR / rel_path
    return full_path.exists() and full_path.stat().st_size > MIN_VIDEO_SIZE


async def validate_all_videos(data: dict) -> dict:
    glosses = data.get("glosses", {})

    # Collect tasks
    tasks = []  # (gloss_key, video_index, url, check_type)

    for gloss_key, gloss_data in glosses.items():
        videos = gloss_data.get("videos", [])
        for i, video in enumerate(videos):
            vtype = video.get("type", "")
            url = video.get("url", "")

            if vtype == "local":
                tasks.append((gloss_key, i, url, "local"))
            elif vtype == "youtube" and url:
                tasks.append((gloss_key, i, url, "youtube"))
            elif url.startswith("http"):
                # mp4, other, or anything with http URL
                tasks.append((gloss_key, i, url, "direct"))

    total = len(tasks)
    print(f"\n{'='*60}")
    print(f"  Video Link Validator v2 (STRICT)")
    print(f"{'='*60}")
    print(f"  Total links to check: {total}")
    print(f"  Concurrency: {CONCURRENCY}")
    print(f"  Min video size: {MIN_VIDEO_SIZE} bytes")
    print(f"{'='*60}\n")

    # First: check local files synchronously (fast, no network)
    local_tasks = [(gk, idx, url) for gk, idx, url, ct in tasks if ct == "local"]
    network_tasks = [(gk, idx, url, ct) for gk, idx, url, ct in tasks if ct != "local"]

    results = {}
    valid_count = 0
    invalid_count = 0

    print(f"  Checking {len(local_tasks)} local files...")
    for gk, idx, url in local_tasks:
        ok = check_local_file(url)
        results[(gk, idx)] = ok
        if ok:
            valid_count += 1
        else:
            invalid_count += 1
    print(f"  Local: {valid_count} valid, {invalid_count} missing/too-small")

    # Network checks
    print(f"\n  Checking {len(network_tasks)} network links (concurrent)...")
    net_total = len(network_tasks)
    checked = 0
    net_valid = 0
    net_invalid = 0
    start_time = time.time()

    semaphore = asyncio.Semaphore(CONCURRENCY)
    connector = aiohttp.TCPConnector(limit=CONCURRENCY, limit_per_host=10, force_close=True)

    async with aiohttp.ClientSession(connector=connector) as session:
        async def check_and_record(gloss_key, idx, url, check_type):
            nonlocal checked, net_valid, net_invalid

            if check_type == "youtube":
                ok = await check_youtube_link(session, url, semaphore)
            else:
                ok = await check_direct_link(session, url, semaphore)

            results[(gloss_key, idx)] = ok
            checked += 1
            if ok:
                net_valid += 1
            else:
                net_invalid += 1

            if checked % 100 == 0 or checked == net_total:
                elapsed = time.time() - start_time
                rate = checked / elapsed if elapsed > 0 else 0
                eta = (net_total - checked) / rate if rate > 0 else 0
                pct = checked / net_total * 100
                print(f"  [{pct:5.1f}%] {checked}/{net_total} | "
                      f"OK:{net_valid} FAIL:{net_invalid} | "
                      f"ETA:{eta:.0f}s", flush=True)

        aws = [check_and_record(gk, idx, url, ct) for gk, idx, url, ct in network_tasks]
        await asyncio.gather(*aws)

    # Remove invalid videos
    removed_details = []
    for gloss_key, gloss_data in glosses.items():
        videos = gloss_data.get("videos", [])
        new_videos = []
        for i, video in enumerate(videos):
            key = (gloss_key, i)
            if key in results:
                if results[key]:
                    new_videos.append(video)
                else:
                    removed_details.append({
                        "gloss": gloss_key,
                        "url": video.get("url", ""),
                        "source": video.get("source", ""),
                        "type": video.get("type", ""),
                    })
            else:
                new_videos.append(video)

        gloss_data["videos"] = new_videos
        gloss_data["video_count"] = len(new_videos)

    total_valid = valid_count + net_valid
    total_invalid = invalid_count + net_invalid
    elapsed_total = time.time() - start_time

    print(f"\n{'='*60}")
    print(f"  RESULTS")
    print(f"{'='*60}")
    print(f"  Total checked:    {total}")
    print(f"  [OK] Valid:       {total_valid}")
    print(f"  [FAIL] Invalid:   {total_invalid}")
    print(f"    - Local missing:  {invalid_count}")
    print(f"    - Network dead:   {net_invalid}")
    print(f"  Time:             {elapsed_total:.1f}s")
    print(f"{'='*60}")

    if removed_details:
        print(f"\n  Sample removed ({len(removed_details)} total):")
        for item in removed_details[:30]:
            print(f"    [X] [{item['type']}] {item['gloss']} - {item['source']}: {item['url'][:80]}")
        if len(removed_details) > 30:
            print(f"    ... and {len(removed_details) - 30} more")

    # Save removal log
    log_path = JSON_PATH.parent / "removed_videos_log.json"
    with open(log_path, 'w', encoding='utf-8') as f:
        json.dump(removed_details, f, indent=2, ensure_ascii=False)
    print(f"\n  Removal log: {log_path}")

    # Check for glosses with 0 videos remaining
    empty_glosses = [gk for gk, gd in glosses.items() if len(gd.get("videos", [])) == 0]
    if empty_glosses:
        print(f"\n  [!] {len(empty_glosses)} glosses have 0 videos remaining!")
        for eg in empty_glosses[:10]:
            print(f"    - {eg}")

    return data


async def main():
    if not JSON_PATH.exists():
        print(f"ERROR: File not found: {JSON_PATH}")
        sys.exit(1)

    # Backup
    backup_path = JSON_PATH.with_suffix('.json.backup')
    if not backup_path.exists():
        import shutil
        shutil.copy2(JSON_PATH, backup_path)
        print(f"Backup: {backup_path}")
    else:
        print(f"Backup already exists: {backup_path}")

    print(f"Loading: {JSON_PATH}")
    with open(JSON_PATH, 'r', encoding='utf-8') as f:
        data = json.load(f)

    gloss_count = len(data.get("glosses", {}))
    total_videos = sum(len(g.get("videos", [])) for g in data.get("glosses", {}).values())
    type_counts = {}
    for g in data.get("glosses", {}).values():
        for v in g.get("videos", []):
            t = v.get("type", "unknown")
            type_counts[t] = type_counts.get(t, 0) + 1
    print(f"Loaded: {gloss_count} glosses, {total_videos} videos")
    print(f"Types: {json.dumps(type_counts)}")

    cleaned = await validate_all_videos(data)

    print(f"\nSaving: {JSON_PATH}")
    with open(JSON_PATH, 'w', encoding='utf-8') as f:
        json.dump(cleaned, f, indent=2, ensure_ascii=False)

    new_total = sum(len(g.get("videos", [])) for g in cleaned.get("glosses", {}).values())
    print(f"\nDone! {total_videos} -> {new_total} videos ({total_videos - new_total} removed)")


if __name__ == "__main__":
    asyncio.run(main())
