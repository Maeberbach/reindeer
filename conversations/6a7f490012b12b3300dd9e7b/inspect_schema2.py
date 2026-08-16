with open("reindeer/reindeer-legacy-main/apps/reindeer-fair-play/shared/schema.ts", "r") as f:
    lines = f.readlines()

def show_lines(start, end):
    for i in range(start, min(end, len(lines))):
        print(f"{i+1}: {lines[i]}", end="")

print("--- ITEM MEDIA & STAGED MEDIA (lines 1700-1780) ---")
show_lines(1700, 1780)

print("--- IS_IMPORTANT / HIGH VALUE IN ITEMS TABLE (lines 350-400) ---")
show_lines(350, 400)
