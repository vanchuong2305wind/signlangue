import json

d = json.load(open(r'app\frontend\public\data\sign_videos.json', 'r', encoding='utf-8'))

# Check 'other' type videos
others = []
for gk, g in d['glosses'].items():
    for v in g['videos']:
        if v['type'] == 'other':
            others.append({'gloss': gk, 'url': v['url'], 'source': v['source']})

print(f'Total other: {len(others)}')
for o in others[:15]:
    print(f"  {o['gloss']} - {o['source']}: {o['url'][:120]}")

# Also check local videos that don't have a corresponding file
import os
local_missing = 0
local_total = 0
public_dir = r'app\frontend\public'
for gk, g in d['glosses'].items():
    for v in g['videos']:
        if v['type'] == 'local':
            local_total += 1
            fpath = os.path.join(public_dir, v['url'].lstrip('/'))
            if not os.path.exists(fpath):
                local_missing += 1

print(f"\nLocal videos: {local_total} total, {local_missing} missing files")
