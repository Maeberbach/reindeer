import re
import os

BASE = "reindeer/reindeer-legacy-main/apps/reindeer-fair-play"

def search_in_file(rel_path, keywords):
    path = os.path.join(BASE, rel_path)
    if not os.path.exists(path):
        return
    with open(path, 'r', encoding='utf-8') as f:
        lines = f.readlines()
    print(f"=== Searching {rel_path} ===")
    for idx, line in enumerate(lines, 1):
        if any(kw.lower() in line.lower() for kwkw in keywords for kw in [kwkw]):
            print(f"L{idx}: {line.strip()[:140]}")

search_in_file("server/import/importService.ts", ["highvalue", "high_value", "appraisal", "threshold"])
search_in_file("server/routes.ts", ["highvalue", "high_value", "appraisal_flags", "appraisal", "flag"])

