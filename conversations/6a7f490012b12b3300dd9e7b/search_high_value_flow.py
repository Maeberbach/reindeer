import re

with open("reindeer/reindeer-legacy-main/apps/reindeer-fair-play/server/routes.ts", "r") as f:
    routes = f.readlines()

print("--- routes related to high value / appraisal / fiduciary ---")
for idx, line in enumerate(routes, 1):
    if any(k in line for k in ["flag-high-value", "appraisal/flag", "/api/items/:id/flags", "ai-high-value", "high_value_state"]):
        print(f"L{idx}: {line.strip()}")

