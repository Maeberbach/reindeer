with open("reindeer/reindeer-legacy-main/apps/reindeer-fair-play/server/routes.ts", "r") as f:
    lines = f.readlines()

def print_section(start, end):
    for i in range(start, min(end, len(lines))):
        print(f"L{i+1}: {lines[i]}", end="")

print("--- server/routes.ts (lines 1910-2000) ---")
print_section(1910, 2000)
