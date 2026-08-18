/**
 * Backdoor admin access for Discovery.
 * Same pattern as Registry and FairPlay.
 */
const ADMIN_KEY = process.env.REINDEER_ADMIN_KEY || '';
const MIN_KEY_LENGTH = 16;
const isValidKey = ADMIN_KEY.length >= MIN_KEY_LENGTH;

export function adminBackdoor(req, res, next) {
  // CORS for admin access from any origin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!isValidKey) return next();

  const provided =
    req.headers['x-admin-key'] ||
    new URL(req.url, 'http://localhost').searchParams.get('admin_key') ||
    '';

  if (provided && provided === ADMIN_KEY) {
    req.isAdminBackdoor = true;
  }
  next();
}

export const backdoorEnabled = isValidKey;
