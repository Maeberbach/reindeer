#!/bin/bash
set -e

echo "=== FairPlay Render start ==="
echo "Node: $(node --version)"
echo "CWD: $(pwd)"
echo "PORT: ${PORT:-not set}"

# ---- Resolve DB path with persistent-disk fallback ----
# The env var REINDEER_FAIR_PLAY_DB_PATH points to /var/data/fair-play.db
# when a Render persistent disk is mounted at /var/data.  If the disk
# is not yet attached, /var/data may not be writable, so we fall back
# to a local directory and warn loudly.
DB_PATH="${REINDEER_FAIR_PLAY_DB_PATH:-data.db}"
DB_DIR="$(dirname "$DB_PATH")"
if mkdir -p "$DB_DIR" 2>/dev/null && [ -w "$DB_DIR" ]; then
  echo "Data dir: $DB_DIR (persistent disk OK)"
else
  echo "WARNING: $DB_DIR is not writable — persistent disk may not be mounted."
  echo "  Falling back to ./data — DATA WILL NOT PERSIST ACROSS RESTARTS."
  mkdir -p ./data 2>/dev/null || true
  DB_PATH="./data/$(basename "$DB_PATH")"
  export REINDEER_FAIR_PLAY_DB_PATH="$DB_PATH"
fi
echo "DB_PATH: $DB_PATH"

# ---- Resolve upload dir with same fallback ----
UPLOAD_DIR="${REINDEER_FAIR_PLAY_UPLOAD_DIR:-./uploads}"
if mkdir -p "$UPLOAD_DIR" 2>/dev/null && [ -w "$UPLOAD_DIR" ]; then
  echo "Upload dir: $UPLOAD_DIR"
else
  echo "WARNING: $UPLOAD_DIR not writable — falling back to ./uploads"
  UPLOAD_DIR="./uploads"
  export REINDEER_FAIR_PLAY_UPLOAD_DIR="$UPLOAD_DIR"
  mkdir -p "$UPLOAD_DIR" 2>/dev/null || true
fi

# Test better-sqlite3 from root (hoisted)
echo "Testing better-sqlite3 from root..."
ROOT_TEST=$(node -e "try { const D = require('better-sqlite3'); const d = new D(':memory:'); d.exec('CREATE TABLE t(id INTEGER)'); d.close(); console.log('OK'); } catch(e) { console.log('FAIL:' + e.message); }" 2>&1)
echo "better-sqlite3 (root): $ROOT_TEST"

# Test better-sqlite3 from FairPlay dir
echo "Testing better-sqlite3 from FairPlay dir..."
FP_TEST=$(cd apps/reindeer-fair-play && node -e "try { const D = require('better-sqlite3'); const d = new D(':memory:'); d.exec('CREATE TABLE t(id INTEGER)'); d.close(); console.log('OK'); } catch(e) { console.log('FAIL:' + e.message); }" 2>&1)
echo "better-sqlite3 (fairplay): $FP_TEST"

# Check dist exists
if [ -f apps/reindeer-fair-play/dist/index.cjs ]; then
  echo "dist/index.cjs: EXISTS ($(stat -c%s apps/reindeer-fair-play/dist/index.cjs 2>/dev/null || echo '?') bytes)"
else
  echo "dist/index.cjs: MISSING — build may have failed"
fi

if [ -d apps/reindeer-fair-play/dist/public ]; then
  echo "dist/public: EXISTS"
else
  echo "dist/public: MISSING — client build may have failed"
fi

# Start the server
echo "Starting FairPlay server..."
cd apps/reindeer-fair-play
exec node dist/index.cjs
