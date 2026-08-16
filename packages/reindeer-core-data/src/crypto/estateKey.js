/**
 * Per-estate encryption key derivation.
 *
 * Each estate's SQLite database is encrypted at rest with SQLCipher.
 * The encryption key is derived deterministically from a master key
 * (server environment) and the estate's unique identifier (ULID).
 *
 * Key hierarchy:
 *
 *   REINDEER_MASTER_KEY (env, never stored in DB)
 *     → HMAC-SHA256(masterKey, estateId) → 32-byte estate key
 *     → PRAGMA key = '<hex>' when opening the DB
 *
 * Why deterministic derivation (not random stored keys):
 *   - Single-estate installs: one master key, one estate. Simple.
 *   - Multi-estate installs: each estate gets a unique key without
 *     needing a key-management table or escrow.
 *   - The master key is the single secret; estate IDs are not secret.
 *   - If the master key is compromised, ALL estates are compromised.
 *     This is acceptable for the MVP — when we add key escrow later,
 *     we can switch to random per-estate keys wrapped by the master key.
 *
 * What this protects against:
 *   - Disk theft (stolen laptop, stolen backup, disk forensics)
 *   - Accidental data exposure (DB file copied to wrong location)
 *   - Cloud provider snapshot access (if disk is unencrypted at rest)
 *
 * What this does NOT protect against:
 *   - Server compromise (the master key is in the process env)
 *   - Memory dumps (the key is in RAM while the DB is open)
 *   - Print/export output (intentionally unencrypted — the estate's
 *     representatives need to read it, and it may need to survive
 *     the estate's own licensing)
 */

import crypto from 'node:crypto';

/**
 * The master encryption key from the environment.
 * Stored in REINDEER_MASTER_KEY. Must be at least 32 bytes.
 * In testing mode (encryption OFF), this is never read.
 *
 * @returns {string|null} The raw master key, or null if not configured.
 */
export function getMasterKey() {
  return process.env.REINDEER_MASTER_KEY || null;
}

/**
 * Derive a per-estate encryption key from the master key.
 *
 * Uses HMAC-SHA256 with the master key as the HMAC key and the
 * estate ID as the message. The output is a 64-character hex
 * string suitable for SQLCipher's `PRAGMA key`.
 *
 * @param {string} estateId — The estate's unique identifier (ULID or scope_id).
 * @param {string} [masterKey] — Override the env master key (for tests).
 * @returns {string} 64-char hex key for PRAGMA key.
 * @throws if the master key is not set.
 */
export function deriveEstateKey(estateId, masterKey = getMasterKey()) {
  if (!masterKey) {
    throw new Error(
      'REINDEER_MASTER_KEY is not set. Cannot derive estate encryption key. ' +
      'Set it in the environment or disable encryption via FEATURE_FLAGS.encryption.'
    );
  }
  if (!estateId) {
    throw new Error('Cannot derive an estate key without an estate ID.');
  }
  return crypto
    .createHmac('sha256', masterKey)
    .update(String(estateId))
    .digest('hex');
}

/**
 * Check whether encryption is properly configured.
 * Returns true if a master key is present. Does NOT check the
 * feature flag — the caller should check that separately.
 *
 * @returns {boolean}
 */
export function isEncryptionConfigured() {
  return !!getMasterKey();
}

/**
 * Generate a random master key suitable for REINDEER_MASTER_KEY.
 * Run once during initial server setup; store the output in the
 * environment (never in the database, never in version control).
 *
 * @returns {string} 64-char hex string (32 bytes of entropy).
 */
export function generateMasterKey() {
  return crypto.randomBytes(32).toString('hex');
}
