#!/bin/bash
set -e

echo "=== Render build ==="
node -e "console.log('Node:', process.version, 'ABI:', process.versions.modules)"

# Install ALL dependencies including dev (tsx, vite, esbuild needed for build)
# NODE_ENV=production on the service would skip devDeps — override it
NODE_ENV=development npm install
echo "npm install done (with devDependencies)"

# npm workspaces may install a local copy of better-sqlite3 in FairPlay's
# node_modules without the compiled binary. Remove it so Node's module
# resolution falls through to the root's hoisted copy (which has the binary).
if [ -d apps/reindeer-fair-play/node_modules/better-sqlite3 ] && [ ! -f apps/reindeer-fair-play/node_modules/better-sqlite3/build/Release/better_sqlite3.node ]; then
  echo "Removing binary-less local better-sqlite3 from FairPlay (will use hoisted root copy)"
  rm -rf apps/reindeer-fair-play/node_modules/better-sqlite3
fi

# Verify better-sqlite3 from root
VERIFY=$(node -e "try { const D = require('better-sqlite3'); const d = new D(':memory:'); d.exec('CREATE TABLE t(id INTEGER)'); d.close(); console.log('OK'); } catch(e) { console.log('FAIL:' + e.message); }" 2>&1)
echo "better-sqlite3 (root): $VERIFY"

# Verify FairPlay can resolve better-sqlite3
FPVERIFY=$(cd apps/reindeer-fair-play && node -e "try { const D = require('better-sqlite3'); const d = new D(':memory:'); d.exec('CREATE TABLE t(id INTEGER)'); d.close(); console.log('OK'); } catch(e) { console.log('FAIL:' + e.message); }" 2>&1)
echo "better-sqlite3 (fairplay): $FPVERIFY"

echo "=== Build complete ==="
