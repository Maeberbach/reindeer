#!/usr/bin/env node

/**
 * Migrate an existing unencrypted Reindeer database to SQLCipher encryption.
 *
 * This is a one-time operation, run when enabling encryption on an install
 * that already has data. It:
 *   1. Opens the existing unencrypted DB
 *   2. Creates an encrypted copy using sqlcipher_export
 *   3. Preserves the original as a .plain backup
 *   4. Swaps the encrypted copy into place
 *
 * Usage:
 *   REINDEER_MASTER_KEY=<key> node scripts/encrypt-existing-db.js <db-path> <estate-id>
 *
 * Example:
 *   REINDEER_MASTER_KEY=abc123... node scripts/encrypt-existing-db.js data/inventory.db inventory-default
 */

import fs from 'node:fs';
import path from 'node:path';
import { openDb, encryptExistingDb, isEncryptionConfigured } from '@reindeer/core-data';

const [dbPath, estateId] = process.argv.slice(2);

if (!dbPath || !estateId) {
  console.error('Usage: REINDEER_MASTER_KEY=<key> node scripts/encrypt-existing-db.js <db-path> <estate-id>');
  process.exit(1);
}

if (!isEncryptionConfigured()) {
  console.error('REINDEER_MASTER_KEY is not set. Set it in the environment first.');
  process.exit(1);
}

if (!fs.existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

console.log(`Encrypting ${dbPath} (estate: ${estateId})...`);

const ok = encryptExistingDb(dbPath, estateId);

if (ok) {
  console.log('✓ Encryption complete. Original backed up as ' + dbPath + '.plain');
  console.log('Verify the encrypted DB works, then delete the .plain backup.');
} else {
  console.error('✗ Encryption failed. See error above. The original DB is untouched.');
  process.exit(1);
}
