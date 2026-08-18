/**
 * Backdoor admin access middleware.
 *
 * Checks for a master admin key in the x-admin-key header or ?admin_key= query
 * param. When it matches REINDEER_ADMIN_KEY (env var), the request is
 * treated as a superuser — bypassing all session auth and role checks.
 *
 * The admin identity is synthetic (participant_id = 'backdoor-admin') and
 * carries role='owner' so every existing role guard lets it through.
 *
 * Security: the key is never logged, never returned in responses, and must
 * be at least 16 characters. If no key is set in the environment, this
 * middleware is a complete no-op — the backdoor cannot be opened by default.
 */
const ADMIN_KEY = process.env.REINDEER_ADMIN_KEY || '';
const MIN_KEY_LENGTH = 16;

const isValidKey = ADMIN_KEY.length >= MIN_KEY_LENGTH;

const ADMIN_IDENTITY = {
  participant_id: 'backdoor-admin',
  email: 'admin@reindeer.local',
  role: 'owner',
  status: 'active',
  display_name: 'Admin',
};

/**
 * Express middleware. Mount this BEFORE attachSession so the admin identity
 * is set before any session cookie logic runs. If the key doesn't match (or
 * isn't configured), this is a silent no-op and the normal auth pipeline
 * proceeds unchanged.
 */
export function adminBackdoor(req, _res, next) {
  if (!isValidKey) return next();

  const provided =
    req.headers['x-admin-key'] ||
    new URL(req.url, 'http://localhost').searchParams.get('admin_key') ||
    '';

  if (provided && provided === ADMIN_KEY) {
    req.participant = ADMIN_IDENTITY;
    req.session = { session_id: 'backdoor', participant_id: 'backdoor-admin' };
    req.isBackdoorAdmin = true;
  }

  next();
}

/** True when the current request was authenticated via the admin backdoor. */
export function isBackdoorAdmin(req) {
  return !!req.isBackdoorAdmin;
}

export { isValidKey as backdoorEnabled };
