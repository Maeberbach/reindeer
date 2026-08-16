with open("reindeer/reindeer-legacy-main/apps/reindeer-fair-play/server/import/importService.ts", "r") as f:
    lines = f.readlines()

print("--- importService.ts (lines 455-475) ---")
for i in range(454, 475):
    print(f"L{i+1}: {lines[i]}", end="")

print("\n--- importService.ts (lines 930-990) ---")
for i in range(929, min(990, len(lines))):
    print(f"L{i+1}: {lines[i]}", end="")

