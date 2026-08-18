#!/bin/bash
echo "=== Discovery Render start ==="
echo "Node: $(node --version)"
echo "PORT: ${PORT:-not set}"

# ---- Resolve data dir ----
DATA_DIR="${REINDEER_DISCOVERY_DIR:-./data}"
if mkdir -p "$DATA_DIR" 2>/dev/null && [ -w "$DATA_DIR" ]; then
  echo "Data dir ready: $DATA_DIR"
else
  echo "WARNING: $DATA_DIR not writable — falling back to ./data"
  DATA_DIR="./data"
  export REINDEER_DISCOVERY_DIR="$DATA_DIR"
  mkdir -p "$DATA_DIR" 2>&1 || true
fi

# Test better-sqlite3
SQLITE_OK=$(node -e "try { const D = require('better-sqlite3'); const d = new D(':memory:'); d.close(); console.log('yes'); } catch(e) { console.log('no:' + e.message); }" 2>&1)
echo "better-sqlite3: $SQLITE_OK"

# Start Discovery server
echo "Starting Discovery server..."
exec node apps/reindeer-discovery/server/index.js
