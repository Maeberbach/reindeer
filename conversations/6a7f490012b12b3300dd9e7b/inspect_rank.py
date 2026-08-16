with open("reindeer/reindeer-legacy-main/apps/reindeer-fair-play/client/src/pages/rank.tsx", "r") as f:
    lines = f.readlines()

def print_section(start, end):
    for i in range(start, min(end, len(lines))):
        print(f"L{i+1}: {lines[i]}", end="")

print("--- client/src/pages/rank.tsx (lines 1-80) ---")
print_section(0, 80)

print("\n--- client/src/pages/rank.tsx (lines 180-250) ---")
print_section(180, 250)
