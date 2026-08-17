/**
 * Feature flags for Reindeer Registry.
 *
 * These control which features are active. During testing, everything
 * is unlimited — no license checks, no password login. When ready
 * to go live, flip these on.
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
  // OFF for now — all access is unlimited during testing.
  // When ON: write operations blocked for expired/locked estates (HTTP 402).
  // Can also be enabled via env: REINDEER_FEATURE_SUBSCRIPTION_GATE=true
  subscriptionGate: false,

  // Heir visibility restrictions — controls what heirs/participants can see
  // in Discovery and FairPlay. When ON (default for client distribution):
  //   - value_estimate_cents, value_basis stripped from heir-facing endpoints
  //   - recipient_hint, recipient_name, owner_note stripped
  //   - owner_high_value, owner_high_value_reason stripped
  //   - ownership_tag, ai_confidence stripped
  // When OFF (testing mode): heirs see everything (useful for QA/demo).
  // Toggled by Reindeer Corp admin before client distribution.
  heirVisibility: true,
};

/**
 * Returns true if license key enforcement is active.
 * When false, all access is unlimited (testing mode).
 */
export function isLicenseEnforced() {
  return FEATURE_FLAGS.licenseKeys === true;
}

/**
 * Returns true if password login is enabled.
 * When false, only magic links work.
 */
export function isPasswordLoginEnabled() {
  return FEATURE_FLAGS.passwordLogin === true;
}

/**
 * Returns true if multi-estate mode is enabled.
 * When false, uses hardcoded SCOPE_ID (single estate).
 */
export function isMultiEstateEnabled() {
  return FEATURE_FLAGS.multiEstate === true;
}

/**
 * Returns true if estate database encryption is enabled.
 * When false, databases are stored as plain SQLite (testing mode).
 * Requires REINDEER_MASTER_KEY to be set when enabled.
 */
export function isEncryptionEnabled() {
  return FEATURE_FLAGS.encryption === true;
}

/**
 * Returns true if the per-estate subscription gate is active.
 * When false, all access is unlimited (testing mode).
 * Can be overridden via REINDEER_FEATURE_SUBSCRIPTION_GATE env var.
 */
export function isSubscriptionGateEnabled() {
  if (process.env.REINDEER_FEATURE_SUBSCRIPTION_GATE === 'true') return true;
  return FEATURE_FLAGS.subscriptionGate === true;
}

/**
 * Returns true when heir visibility restrictions are active.
 * When true, Discovery and FairPlay strip private fields (pricing,
 * recipient, ownership tags) from heir/participant-facing endpoints.
 * When false (testing mode), all fields are visible.
 * Can be overridden via env: REINDEER_FEATURE_HEIR_VISIBILITY=false
 */
export function isHeirVisibilityEnabled() {
  if (process.env.REINDEER_FEATURE_HEIR_VISIBILITY === 'false') return false;
  return FEATURE_FLAGS.heirVisibility === true;
}
