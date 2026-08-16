with open("reindeer/reindeer-legacy-main/apps/reindeer-fair-play/server/fiduciary/fiduciaryStorage.ts", "r") as f:
    lines = f.readlines()

for i in range(495, 540):
    print(f"L{i+1}: {lines[i]}", end="")

print("\n--- server/storage.ts flagForAppraisal ---")
with open("reindeer/reindeer-legacy-main/apps/reindeer-fair-play/server/storage.ts", "r") as f:
    st_lines = f.readlines()

for i in range(1420, 1475):
    print(f"L{i+1}: {st_lines[i]}", end="")
