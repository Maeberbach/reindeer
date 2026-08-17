/**
 * Feature flags for Reindeer: FairPlay.
 *
 * These control which features are active. During testing, everything
 * is unlimited — no license checks, no password login. When ready
 * to go live, flip these on.
 *
 * Mirrors apps/reindeer-registry/server/featureFlags.js so both apps
 * stay in sync. If you change one, change the other.
 */

export const FEATURE_FLAGS = {
  // Username/password login (alternative to magic links).
  // OFF for now — magic links remain the only auth method.
  passwordLogin: false,

  // License key validation.
  // OFF for now — all access is unlimited during testing.
  // When ON: app validates JWT license key, enforces read-only on lapsed.
  licenseKeys: false,

  // Multi-estate mode (per-user scope_id instead of hardcoded).
  // OFF for now — single estate per install.
  multiEstate: false,

  // Estate database encryption (SQLCipher per-estate).
  // OFF for now — databases are stored as plain SQLite.
  // When ON: each estate DB is encrypted with a key derived from
  // REINDEER_MASTER_KEY + estateId. Requires that env var to be set.
  encryption: false,

  // Per-estate subscription gate.
  // When true, write endpoints are blocked for estates whose
  // subscription is expired or locked (HTTP 402 Payment Required).
  // OFF for now — all access is unlimited during testing.
  subscriptionGate: false,
};

/**
 * Returns true if license key enforcement is active.
 * When false, all access is unlimited (testing mode).
 */
export function isLicenseEnforced(): boolean {
  return FEATURE_FLAGS.licenseKeys === true;
}

/**
 * Returns true if password login is enabled.
 * When false, only magic links work.
 */
export function isPasswordLoginEnabled(): boolean {
  return FEATURE_FLAGS.passwordLogin === true;
}

/**
 * Returns true if multi-estate mode is enabled.
 * When false, uses hardcoded SCOPE_ID (single estate).
 */
/**
 * Returns true if estate database encryption is enabled.
 * When false, databases are stored as plain SQLite (testing mode).
 * Requires REINDEER_MASTER_KEY to be set when enabled.
 */
export function isEncryptionEnabled(): boolean {
  return FEATURE_FLAGS.encryption === true;
}

export function isMultiEstateEnabled(): boolean {
  return FEATURE_FLAGS.multiEstate === true;
}

/**
 * Returns true if the per-estate subscription gate is active.
 * When false, write access is unlimited (testing mode) and
 * requireSubscriptionForWrite is a no-op.
 */
export function isSubscriptionGateEnabled(): boolean {
  return FEATURE_FLAGS.subscriptionGate === true;
}
