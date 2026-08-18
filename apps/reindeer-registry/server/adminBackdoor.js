/**
 * Two-tier backdoor admin access middleware.
 *
 * Tier 1 — Corporate Admin (REINDEER_ADMIN_KEY):
 *   Feature flag toggles, license management, estate metadata (counts only),
 *   and full estate reset. NO access to estate content data.
 *
 * Tier 2 — Support Admin (REINDEER_SUPPORT_KEY):
 *   Full data access — items, participants, audit logs.
 *   Not configured by default on sold installs. Every call is audit-logged.
 */
const ADMIN_KEY = process.env.REINDEER_ADMIN_KEY || '';
const SUPPORT_KEY = process.env.REINDEER_SUPPORT_KEY || '';
const MIN_KEY_LENGTH = 16;

const isValidAdminKey = ADMIN_KEY.length >= MIN_KEY_LENGTH;
const isValidSupportKey = SUPPORT_KEY.length >= MIN_KEY_LENGTH;

const ADMIN_IDENTITY = {
  participant_id: 'backdoor-admin',
  email: 'admin@reindeer.local',
  role: 'owner',
  status: 'active',
  display_name: 'Admin',
};

const SUPPORT_IDENTITY = {
  participant_id: 'backdoor-support',
  email: 'support@reindeer.local',
  role: 'owner',
  status: 'active',
  display_name: 'Support',
};

export function adminBackdoor(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key, x-support-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const provided =
    req.headers['x-admin-key'] ||
    req.headers['x-support-key'] ||
    new URL(req.url, 'http://localhost').searchParams.get('admin_key') ||
    '';

  if (provided && isValidAdminKey && provided === ADMIN_KEY) {
    req.participant = ADMIN_IDENTITY;
    req.session = { session_id: 'backdoor', participant_id: 'backdoor-admin' };
    req.isBackdoorAdmin = true;
    req.isBackdoorSupport = false;
  } else if (provided && isValidSupportKey && provided === SUPPORT_KEY) {
    req.participant = SUPPORT_IDENTITY;
    req.session = { session_id: 'backdoor', participant_id: 'backdoor-support' };
    req.isBackdoorAdmin = true;
    req.isBackdoorSupport = true;
    console.log(`[support-access] ${new Date().toISOString()} ${req.method} ${req.url}`);
  }

  next();
}

export function isBackdoorAdmin(req) { return !!req.isBackdoorAdmin; }
export function isBackdoorSupport(req) { return !!req.isBackdoorSupport; }
export const backdoorEnabled = isValidAdminKey;
export const supportEnabled = isValidSupportKey;
