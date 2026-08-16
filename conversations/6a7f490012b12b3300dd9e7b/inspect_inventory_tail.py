with open("reindeer/reindeer-legacy-main/apps/reindeer-fair-play/client/src/pages/inventory.tsx", "r") as f:
    lines = f.readlines()

for i in range(965, len(lines)):
    print(f"L{i+1}: {lines[i]}", end="")
