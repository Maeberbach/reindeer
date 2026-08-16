#!/bin/bash
set -e

echo "=== Render build starting ==="
node -e "console.log('Node:', process.version, 'ABI:', process.versions.modules, 'Platform:', process.platform, 'Arch:', process.arch)"

# Install deps without running native build scripts
npm install --ignore-scripts
echo "npm install --ignore-scripts completed"

# Copy the prebuilt better-sqlite3 binary for the current Node ABI
NODE_ABI=$(node -e "console.log(process.versions.modules)")
echo "Looking for prebuilt better-sqlite3 for ABI v${NODE_ABI}..."

PREBUILT_DIR="prebuilt/better-sqlite3/v${NODE_ABI}"
if [ -d "$PREBUILT_DIR" ]; then
  mkdir -p node_modules/better-sqlite3/build/Release
  cp "$PREBUILT_DIR/build/Release/better_sqlite3.node" node_modules/better-sqlite3/build/Release/
  echo "Installed prebuilt better-sqlite3 for ABI v${NODE_ABI}"
else
  echo "WARNING: No prebuilt binary for ABI v${NODE_ABI}. Available:"
  ls prebuilt/better-sqlite3/ || echo "  (no prebuilt directory found)"
  echo "Attempting to find closest match..."
  # Try to find any available prebuilt binary
  for dir in prebuilt/better-sqlite3/v*/; do
    if [ -d "$dir" ]; then
      echo "  Trying $dir..."
      mkdir -p node_modules/better-sqlite3/build/Release
      cp "$dir/build/Release/better_sqlite3.node" node_modules/better-sqlite3/build/Release/ 2>/dev/null && echo "  Copied from $dir" && break
    fi
  done
fi

# Try to verify it loads (don't fail the build if it doesn't — let the start command handle it)
node -e "
try {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  console.log('better-sqlite3 verification: OK');
  db.close();
} catch(e) {
  console.error('better-sqlite3 verification FAILED:', e.message);
  console.error('This will likely cause a startup error, but build will continue.');
}
" || echo "Verification step failed but build continues."

echo "=== Render build complete ==="
