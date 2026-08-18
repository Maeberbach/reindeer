/**
 * Two-tier backdoor admin access for Discovery.
 *
 * Tier 1 — Corporate Admin (REINDEER_ADMIN_KEY):
 *   Feature flag toggles, estate metadata (counts only), full estate reset.
 *   NO access to estate content data.
 *
 * Tier 2 — Support Admin (REINDEER_SUPPORT_KEY):
 *   Full data access — items, heirs, reactions.
 *   Not configured by default on sold installs. Every call is audit-logged.
 */
const ADMIN_KEY = process.env.REINDEER_ADMIN_KEY || '';
const SUPPORT_KEY = process.env.REINDEER_SUPPORT_KEY || '';
const MIN_KEY_LENGTH = 16;
const isValidKey = ADMIN_KEY.length >= MIN_KEY_LENGTH;
const isValidSupportKey = SUPPORT_KEY.length >= MIN_KEY_LENGTH;

export function adminBackdoor(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key, x-support-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const provided =
    req.headers['x-admin-key'] ||
    req.headers['x-support-key'] ||
    new URL(req.url, 'http://localhost').searchParams.get('admin_key') ||
    '';

  if (provided && isValidKey && provided === ADMIN_KEY) {
    req.isAdminBackdoor = true;
    req.isBackdoorSupport = false;
  } else if (provided && isValidSupportKey && provided === SUPPORT_KEY) {
    req.isAdminBackdoor = true;
    req.isBackdoorSupport = true;
    console.log(`[support-access] ${new Date().toISOString()} ${req.method} ${req.url}`);
  }
  next();
}

export const backdoorEnabled = isValidKey;
export const supportEnabled = isValidSupportKey;
