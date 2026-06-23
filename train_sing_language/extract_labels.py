"""Extract all gloss labels from WLASL JSON and generate wlasl_labels.py"""
import json
import urllib.request
import os

URL = "https://raw.githubusercontent.com/dxli94/WLASL/master/start_kit/WLASL_v0.3.json"
CACHE = "wlasl_v0.3.json"

# Download if not cached
if not os.path.exists(CACHE):
    print(f"Downloading WLASL JSON from {URL}...")
    urllib.request.urlretrieve(URL, CACHE)
    print(f"Saved to {CACHE}")

# Parse
with open(CACHE, 'r', encoding='utf-8') as f:
    data = json.load(f)

glosses = [entry['gloss'] for entry in data]
print(f"Total glosses: {len(glosses)}")
print(f"First 10: {glosses[:10]}")
print(f"Last 10: {glosses[-10:]}")

# Generate wlasl_labels.py
with open("wlasl_labels.py", "w", encoding="utf-8") as f:
    f.write('"""\n')
    f.write('WLASL Label Mapping\n')
    f.write('Auto-generated from WLASL_v0.3.json\n')
    f.write('Maps class indices to ASL word glosses.\n')
    f.write('Reference: https://github.com/dxli94/WLASL\n')
    f.write('"""\n\n')

    f.write(f'# Total: {len(glosses)} glosses\n')
    f.write('WLASL_LABELS = [\n')
    for i, g in enumerate(glosses):
        f.write(f'    "{g}",  # {i}\n')
    f.write(']\n\n')

    # The original TGCN loader fits sklearn.LabelEncoder on each top-K
    # subset, so output class indices follow alphabetical order.
    f.write('# LabelEncoder-compatible subsets used by TGCN\n')
    f.write('WLASL100_LABELS = sorted(WLASL_LABELS[:100])\n')
    f.write('WLASL300_LABELS = sorted(WLASL_LABELS[:300])\n')
    f.write('WLASL1000_LABELS = sorted(WLASL_LABELS[:1000])\n')
    f.write('WLASL2000_LABELS = sorted(WLASL_LABELS[:2000])\n\n')
    f.write('LABELS_BY_SIZE = {\n')
    f.write('    100: WLASL100_LABELS,\n')
    f.write('    300: WLASL300_LABELS,\n')
    f.write('    1000: WLASL1000_LABELS,\n')
    f.write('    2000: WLASL2000_LABELS,\n')
    f.write('}\n\n')

    f.write('\ndef get_label(class_index: int, num_classes: int = 2000) -> str:\n')
    f.write('    """Get the ASL word for a given class index."""\n')
    f.write('    try:\n')
    f.write('        labels = LABELS_BY_SIZE[num_classes]\n')
    f.write('    except KeyError as exc:\n')
    f.write('        raise ValueError(\n')
    f.write('            f"Unsupported WLASL class count: {num_classes}. "\n')
    f.write('            f"Expected one of {sorted(LABELS_BY_SIZE)}"\n')
    f.write('        ) from exc\n')
    f.write('    if 0 <= class_index < len(labels):\n')
    f.write('        return labels[class_index]\n')
    f.write('    return f"unknown_{class_index}"\n\n')

    f.write('\ndef get_num_classes(variant: str = "asl2000") -> int:\n')
    f.write('    """Get the total number of classes for a variant."""\n')
    f.write('    return int(variant.replace("asl", ""))\n\n')

    f.write('\nif __name__ == "__main__":\n')
    f.write(f'    print(f"Total labels: {{len(WLASL_LABELS)}}")\n')
    f.write('    print(f"ASL100: {WLASL100_LABELS[:5]}...")\n')
    f.write('    print(f"ASL2000: {WLASL2000_LABELS[:5]}...")\n')

print(f"\nGenerated wlasl_labels.py with {len(glosses)} labels")
