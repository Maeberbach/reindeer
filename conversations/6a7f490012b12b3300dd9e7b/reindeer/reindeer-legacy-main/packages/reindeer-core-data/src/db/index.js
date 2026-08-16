import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MIGRATIONS } from '../migrations/index.js';
import { deriveEstateKey } from '../crypto/estateKey.js';

/** Crockford base32 ULID — sortable, stable across export and import. */
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function ulid(now = Date.now()) {
  let ts = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    ts = B32[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  const rnd = crypto.randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += B32[rnd[i] % 32];
  return ts + rand;
}

/**
 * Open a database, optionally encrypted with SQLCipher, run pending
 * migrations inside a transaction, and enforce foreign keys.
 *
 * Used identically by Reindeer Registry and Reindeer: FairPlay;
 * only the file path and scope type differ.
 *
 * @param {string} filePath - Path to the SQLite database file.
 * @param {object} [opts]
 * @param {string} [opts.estateId] - Estate identifier for key derivation.
 *   When provided AND encryption is enabled, the DB is opened with
 *   SQLCipher using a key derived from REINDEER_MASTER_KEY + estateId.
 * @param {boolean} [opts.encrypt=false] - Whether to encrypt the DB.
 *   When false, opens as plain better-sqlite3 (testing mode).
 * @returns {import('better-sqlite3').Database}
 */
export function openDb(filePath, opts = {}) {
  const { estateId = null, encrypt = false } = opts;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  let db;

  if (encrypt && estateId) {
    // SQLCipher mode: derive a per-estate key and apply it immediately
    // after opening, before any other pragma or query.
    //
    // We use better-sqlite3-multiple-ciphers when encryption is on,
    // but it is a drop-in for better-sqlite3 - same API. When the
    // package is installed, we dynamically require it. When it is not
    // (testing mode), we fall back to plain better-sqlite3.
    try {
      // eslint-disable-next-line no-eval
      const EncryptedDatabase = eval('require')('better-sqlite3-multiple-ciphers');
      db = new EncryptedDatabase(filePath);
      const key = deriveEstateKey(estateId);
      db.pragma(`key = '${key}'`);
    } catch {
      // Fallback: if the encrypted sqlite package is not installed,
      // log a warning and open unencrypted. This should only happen
      // in dev environments that have not installed the optional dep.
      console.warn(
        '[reindeer] Encryption requested but better-sqlite3-multiple-ciphers ' +
        'is not installed. Opening database UNENCRYPTED. ' +
        'Run: npm install better-sqlite3-multiple-ciphers'
      );
      db = new Database(filePath);
    }
  } else {
    db = new Database(filePath);
  }

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

/**
 * Migrate an existing unencrypted database to an encrypted one.
 *
 * This is a one-time operation: it reads the unencrypted DB, creates
 * an encrypted copy, and swaps the files. The original is preserved
 * with a .plain backup extension.
 *
 * Call this once when enabling encryption for the first time on an
 * existing install. After that, openDb() with encrypt=true handles
 * normal operation.
 *
 * @param {string} filePath - Path to the existing unencrypted DB.
 * @param {string} estateId - Estate identifier for key derivation.
 * @returns {boolean} true if the migration succeeded.
 */
export function encryptExistingDb(filePath, estateId) {
  const backupPath = filePath + '.plain';

  // Already encrypted? Check if there is a .plain backup - means
  // we already migrated.
  if (fs.existsSync(backupPath)) {
    return true;
  }

  try {
    let EncryptedDb;
    try {
      // eslint-disable-next-line no-eval
      const EncryptedDatabase = eval('require')('better-sqlite3-multiple-ciphers');
      EncryptedDb = EncryptedDatabase;
    } catch {
      throw new Error(
        'better-sqlite3-multiple-ciphers is not installed. ' +
        'Run: npm install better-sqlite3-multiple-ciphers'
      );
    }

    // Open the source (unencrypted) and destination (encrypted) DBs.
    const source = new Database(filePath);
    const encPath = filePath + '.enc';
    const dest = new EncryptedDb(encPath);

    const key = deriveEstateKey(estateId);
    dest.pragma(`key = '${key}'`);

    // sqlcipher_export copies the entire database (schema + data)
    // from the source to the destination.
    source.exec(`ATTACH DATABASE '${encPath}' AS encrypted KEY '${key}'`);
    source.exec("SELECT sqlcipher_export('encrypted')");
    source.exec('DETACH DATABASE encrypted');
    source.close();

    dest.pragma('journal_mode = WAL');
    dest.pragma('foreign_keys = ON');
    dest.close();

    // Swap: original becomes .plain backup, encrypted becomes primary.
    fs.copyFileSync(filePath, backupPath);
    fs.unlinkSync(filePath);
    fs.renameSync(encPath, filePath);

    console.log(`[reindeer] Database encrypted. Backup at ${backupPath}`);
    return true;
  } catch (err) {
    console.error('[reindeer] Encryption migration failed:', err.message);
    return false;
  }
}

function runMigrations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id));
  const insert = db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)');

  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    const apply = db.transaction(() => {
      db.exec(m.sql);
      insert.run(m.id, m.name, new Date().toISOString());
    });
    apply();
  }
}

/** Standard OS data directory, matching the existing Reindeer: FairPlay posture. */
export function defaultDataDir(appName) {
  const home = process.env.HOME || process.env.USERPROFILE || '.';
  if (process.env.REINDEER_DATA_DIR) return path.join(process.env.REINDEER_DATA_DIR, appName);
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', appName);
  if (process.platform === 'win32') return path.join(process.env.APPDATA || home, appName);
  return path.join(home, '.local', 'share', appName);
}
