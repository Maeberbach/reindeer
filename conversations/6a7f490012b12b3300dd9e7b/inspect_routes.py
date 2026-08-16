with open("reindeer/reindeer-legacy-main/apps/reindeer-fair-play/server/routes.ts", "r") as f:
    lines = f.readlines()

def print_section(start, end):
    for i in range(start, min(end, len(lines))):
        print(f"L{i+1}: {lines[i]}", end="")

print("--- server/routes.ts (lines 855-890) ---")
print_section(855, 890)

print("\n--- server/routes.ts (lines 1735-1800) ---")
print_section(1735, 1800)

print("\n--- server/routes.ts (lines 2000-2050) ---")
print_section(2000, 2050)
