import { readSessionCookie, decodeSessionCookie, buildSetCookieHeader, encodeSessionCookie } from './cookie.js';
import { SESSION_TTL_MILLISECONDS } from '@reindeer-legacy/core-data';

/**
 * Attach `req.session` and `req.participant` if a valid session cookie
 * exists. Never throws — an invalid cookie is simply ignored (the
 * `authRequired` gate below decides whether the request may proceed).
 *
 * Bootstrap-owner mode: when the install has no participants at all,
 * this middleware synthesizes an owner identity so a fresh installer
 * can hit /api routes without signing in first. The synthesized
 * participant carries participant_id === 'bootstrap-owner' — real
 * participants get ULIDs, so there is no collision.
 */
export function attachSession({ auth, sessionSecret }) {
  return (req, _res, next) => {
    const raw = readSessionCookie(req);
    if (raw) {
      const decoded = decodeSessionCookie(raw, sessionSecret);
      if (decoded?.token) {
        const resolved = auth.resolveSession(decoded.token);
        if (resolved) {
          req.session = resolved.session;
          req.participant = resolved.participant;
        }
      }
    }
    if (!req.participant && auth.isBootstrapMode()) {
      req.session = { session_id: 'bootstrap', participant_id: 'bootstrap-owner' };
      req.participant = {
        participant_id: 'bootstrap-owner', email: '',
        role: 'owner', status: 'active', display_name: '',
      };
      req.isBootstrapOwner = true;
    }
    next();
  };
}

/**
 * Block requests that do not have `req.participant`. All /api routes
 * except the auth family and /api/health should sit behind this.
 */
export function authRequired(req, res, next) {
  if (req.participant) return next();
  res.status(401).json({
    error: 'auth_required',
    message: 'Please sign in to continue.',
  });
}

/**
 * Helper for auth route handlers: write the session cookie on the
 * response.
 */
export function setSessionCookie(res, { token }, sessionSecret) {
  const encoded = encodeSessionCookie({ token }, sessionSecret);
  res.setHeader('Set-Cookie', buildSetCookieHeader(encoded, {
    maxAgeSeconds: Math.floor(SESSION_TTL_MILLISECONDS / 1000),
  }));
}
export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', buildSetCookieHeader('', { clear: true }));
}
