with open("reindeer/reindeer-legacy-main/apps/reindeer-fair-play/server/fiduciary/router.ts", "r") as f:
    lines = f.readlines()

def print_section(start, end):
    for i in range(start, min(end, len(lines))):
        print(f"L{i+1}: {lines[i]}", end="")

print("--- server/fiduciary/router.ts (lines 150-200) ---")
print_section(150, 200)

