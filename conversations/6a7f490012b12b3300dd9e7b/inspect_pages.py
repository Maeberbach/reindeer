import os

BASE = "reindeer/reindeer-legacy-main/apps/reindeer-fair-play/client/src/pages"

pages = [f for f in os.listdir(BASE) if f.endswith('.tsx')]
print("Pages list:", pages)

def inspect_file(filename, keywords):
    path = os.path.join(BASE, filename)
    if not os.path.exists(path):
        return
    with open(path, 'r', encoding='utf-8') as f:
        lines = f.readlines()
    print(f"\n==================== {filename} ====================")
    for idx, line in enumerate(lines, 1):
        if any(k.lower() in line.lower() for k in keywords):
            print(f"L{idx}: {line.strip()[:140]}")

inspect_file("inventory.tsx", ["item", "photo", "media", "appraisal", "highvalue", "dialog", "drawer", "card"])
