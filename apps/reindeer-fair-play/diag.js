// FairPlay diagnostic — reports filesystem state and tries to fix the binary
const http = require('http');
const fs = require('fs');
const path = require('path');

const info = {
  node: process.version,
  abi: process.versions.modules,
  cwd: process.cwd(),
  rootBs3Exists: false,
  rootBinaryExists: false,
  fpBs3Exists: false,
  fpBinaryExists: false,
  distExists: false,
  copyResult: null,
  requireResult: null,
};

// Check root better-sqlite3
try {
  fs.accessSync('node_modules/better-sqlite3');
  info.rootBs3Exists = true;
  info.rootBinaryExists = fs.existsSync('node_modules/better-sqlite3/build/Release/better_sqlite3.node');
} catch (e) {}

// Check FairPlay local better-sqlite3
try {
  fs.accessSync('apps/reindeer-fair-play/node_modules/better-sqlite3');
  info.fpBs3Exists = true;
  info.fpBinaryExists = fs.existsSync('apps/reindeer-fair-play/node_modules/better-sqlite3/build/Release/better_sqlite3.node');
} catch (e) {}

// Check dist
try {
  info.distExists = fs.existsSync('apps/reindeer-fair-play/dist/index.cjs');
} catch (e) {}

// Try to copy binary from root to FairPlay
if (info.rootBinaryExists && info.fpBs3Exists && !info.fpBinaryExists) {
  try {
    fs.mkdirSync('apps/reindeer-fair-play/node_modules/better-sqlite3/build/Release', { recursive: true });
    fs.copyFileSync(
      'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
      'apps/reindeer-fair-play/node_modules/better-sqlite3/build/Release/better_sqlite3.node'
    );
    info.copyResult = 'success';
    info.fpBinaryExists = true;
  } catch (e) {
    info.copyResult = 'failed: ' + e.message;
  }
}

// Try requiring better-sqlite3 from FairPlay dir
try {
  process.chdir('apps/reindeer-fair-play');
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t(id INTEGER)');
  db.close();
  info.requireResult = 'OK';
} catch (e) {
  info.requireResult = 'FAIL: ' + e.message.slice(0, 300);
}

// Start HTTP server
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(info, null, 2));
});

const port = process.env.PORT || 10000;
server.listen(port, () => {
  console.log('Diagnostic server on port', port);
});
