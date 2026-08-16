with open("reindeer/reindeer-legacy-main/apps/reindeer-fair-play/shared/schema.ts", "r") as f:
    lines = f.readlines()

def show_lines(start, end):
    for i in range(start, min(end, len(lines))):
        print(f"{i+1}: {lines[i]}", end="")

print("--- ITEMS TABLE (lines 240-350) ---")
show_lines(240, 350)

print("\n--- APPRAISAL FLAGS & ITEM MEDIA (lines 550-600 & 1700-1770) ---")
show_lines(550, 600)
show_lines(1700, 1770)

