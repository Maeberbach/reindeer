import re

with open("reindeer/reindeer-legacy-main/apps/reindeer-fair-play/shared/schema.ts", "r") as f:
    content = f.read()

# Extract items table block
match = re.search(r'export const items = sqliteTable\("items", \{(.*?)\}\);', content, re.DOTALL)
if match:
    items_block = match.group(1)
    for line in items_block.split('\n'):
        if ':' in line and not line.strip().startswith('//') and not line.strip().startswith('/*') and not line.strip().startswith('*'):
            col_name = line.split(':')[0].strip()
            print(f"  {col_name}: {line.strip()}")
