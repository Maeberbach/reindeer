#!/bin/bash
echo "=== Render start ==="
echo "Node: $(node --version)"
echo "PORT: ${PORT:-not set}"

# ---- Resolve data dir with persistent-disk fallback ----
# The env var REINDEER_INVENTORY_DIR points to /var/data when a Render
# persistent disk is mounted there.  If the disk is not yet attached,
# /var/data may not be writable, so we fall back to ./data.
DATA_DIR="${REINDEER_INVENTORY_DIR:-./data}"
if mkdir -p "$DATA_DIR" 2>/dev/null && [ -w "$DATA_DIR" ]; then
  echo "Data dir ready: $DATA_DIR (persistent disk OK)"
else
  echo "WARNING: $DATA_DIR is not writable — persistent disk may not be mounted."
  echo "  Falling back to ./data — DATA WILL NOT PERSIST ACROSS RESTARTS."
  DATA_DIR="./data"
  export REINDEER_INVENTORY_DIR="$DATA_DIR"
  mkdir -p "$DATA_DIR" 2>&1 && echo "Fallback data dir ready: $DATA_DIR" || echo "WARNING: could not create $DATA_DIR"
fi

# Test better-sqlite3
SQLITE_OK=$(node -e "try { const D = require('better-sqlite3'); const d = new D(':memory:'); d.close(); console.log('yes'); } catch(e) { console.log('no:' + e.message); }" 2>&1)
echo "better-sqlite3: $SQLITE_OK"

if echo "$SQLITE_OK" | grep -q "^yes"; then
  echo "Starting Registry server..."
  # Capture stderr to see the crash error
  SERVER_ERROR=$(node apps/reindeer-registry/server/index.js 2>&1)
  EXIT_CODE=$?
  echo "Server exited with code $EXIT_CODE"
  echo "Server error: $SERVER_ERROR"
else
  echo "better-sqlite3 not available"
  SERVER_ERROR="sqlite_failed: $SQLITE_OK"
fi

# Fallback server — include crash details for debugging
exec node -e "const h=require('http');h.createServer((q,r)=>{r.setHeader('Content-Type','application/json');r.end(JSON.stringify({status:'fallback',node:process.version,abi:process.versions.modules,sqlite:'$SQLITE_OK',error:$(printf '%s' "$SERVER_ERROR" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()[:500]))')}));}).listen(process.env.PORT||10000,()=>console.log('Fallback on '+process.env.PORT))"
