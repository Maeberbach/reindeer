#!/bin/bash
echo "=== Render start ==="
echo "Node: $(node --version)"
echo "PORT: ${PORT:-not set}"
echo "INVENTORY_DIR: ${REINDEER_INVENTORY_DIR:-not set}"

# Create data directory
DATA_DIR="${REINDEER_INVENTORY_DIR:-/var/data}"
mkdir -p "$DATA_DIR" 2>/dev/null
echo "Data dir: $DATA_DIR"

# Quick check if better-sqlite3 loads (exits immediately, doesn't start a server)
SQLITE_OK=$(node -e "try { require('better-sqlite3'); console.log('yes'); } catch(e) { console.log('no:' + e.message); }" 2>&1)
echo "better-sqlite3 check: $SQLITE_OK"

if echo "$SQLITE_OK" | grep -q "^yes"; then
  echo "Starting Registry server..."
  exec node apps/reindeer-registry/server/index.js
else
  echo "better-sqlite3 failed — starting fallback server for health check"
  exec node -e "
    const h = require('http');
    const s = h.createServer((q, r) => {
      r.setHeader('Content-Type', 'text/plain');
      r.end('Reindeer Registry — DB module loading issue. Check render logs.');
    });
    s.listen(process.env.PORT || 10000, () => console.log('Fallback on', process.env.PORT || 10000));
  "
fi
