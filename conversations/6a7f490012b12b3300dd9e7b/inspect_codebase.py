import os
import re

BASE_DIR = "reindeer/reindeer-legacy-main/apps/reindeer-fair-play"

def read_file_lines(rel_path):
    path = os.path.join(BASE_DIR, rel_path)
    if not os.path.exists(path):
        return f"File not found: {path}"
    with open(path, 'r', encoding='utf-8') as f:
        return f.readlines()

print("=== 1. shared/schema.ts ===")
lines = read_file_lines("shared/schema.ts")
for idx, line in enumerate(lines, 1):
    if "items = " in line or "export const items" in line or "photo" in line.lower() or "value" in line.lower() or "appraisal" in line.lower() or "media" in line.lower():
        print(f"L{idx}: {line.strip()}")

