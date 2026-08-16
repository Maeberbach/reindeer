// FairPlay diagnostic — at repo root to avoid any build-step interference
const http = require('http');
const fs = require('fs');

const info = {
  node: process.version,
  abi: process.versions.modules,
  cwd: process.cwd(),
  rootBs3: fs.existsSync('node_modules/better-sqlite3'),
  rootBin: fs.existsSync('node_modules/better-sqlite3/build/Release/better_sqlite3.node'),
  fpBs3: fs.existsSync('apps/reindeer-fair-play/node_modules/better-sqlite3'),
  fpBin: fs.existsSync('apps/reindeer-fair-play/node_modules/better-sqlite3/build/Release/better_sqlite3.node'),
  dist: fs.existsSync('apps/reindeer-fair-play/dist/index.cjs'),
  diagFile: fs.existsSync('apps/reindeer-fair-play/diag.js'),
};

// Try to copy binary from root to FairPlay
if (info.rootBin && info.fpBs3 && !info.fpBin) {
  try {
    fs.mkdirSync('apps/reindeer-fair-play/node_modules/better-sqlite3/build/Release', { recursive: true });
    fs.copyFileSync(
      'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
      'apps/reindeer-fair-play/node_modules/better-sqlite3/build/Release/better_sqlite3.node'
    );
    info.copy = 'ok';
    info.fpBin = true;
  } catch (e) {
    info.copy = 'fail: ' + e.message;
  }
} else {
  info.copy = 'not needed';
}

// Try requiring better-sqlite3 from FairPlay dir
try {
  process.chdir('apps/reindeer-fair-play');
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t(id INTEGER)');
  db.close();
  info.require = 'ok';
} catch (e) {
  info.require = 'fail: ' + e.message.slice(0, 300);
}

http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(info, null, 2));
}).listen(process.env.PORT || 10000);
