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
with open(CACHE, 'r') as f:
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

    # Subsets
    f.write('# Convenience subsets\n')
    f.write(f'WLASL100_LABELS = WLASL_LABELS[:100]\n')
    f.write(f'WLASL300_LABELS = WLASL_LABELS[:300]\n')
    f.write(f'WLASL1000_LABELS = WLASL_LABELS[:1000]\n')
    f.write(f'WLASL2000_LABELS = WLASL_LABELS[:2000]\n\n')

    f.write('\ndef get_label(class_index: int, num_classes: int = 2000) -> str:\n')
    f.write('    """Get the ASL word for a given class index."""\n')
    f.write('    labels = WLASL_LABELS[:num_classes]\n')
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
