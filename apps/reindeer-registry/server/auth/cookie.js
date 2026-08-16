import crypto from 'node:crypto';

/**
 * Minimal signed-cookie helpers. We avoid pulling in a full cookie
 * library to stay on the node stdlib.
 *
 * Cookie format:  base64url(json({token})).base64url(hmac-sha256)
 *   The payload is opaque to the client; the signature prevents tampering.
 *   HttpOnly + SameSite=Lax + Secure (when NODE_ENV=production) at emit
 *   time. The session TTL lives in the persisted `sessions.expires_at`
 *   column; the cookie itself is a `Max-Age` in seconds so browsers can
 *   evict expired cookies on their own.
 */

const COOKIE_NAME = 'reindeer_session';

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}
function b64urlDecode(str) {
  return Buffer.from(String(str), 'base64url');
}

function sign(payloadB64, secret) {
  return b64url(crypto.createHmac('sha256', secret).update(payloadB64).digest());
}

export function encodeSessionCookie({ token }, secret) {
  const payloadB64 = b64url(JSON.stringify({ token }));
  const sig = sign(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

export function decodeSessionCookie(raw, secret) {
  if (!raw || typeof raw !== 'string') return null;
  const [payloadB64, sig] = raw.split('.');
  if (!payloadB64 || !sig) return null;
  const expectedSig = sign(payloadB64, secret);
  // constant-time compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
    if (!parsed || typeof parsed.token !== 'string') return null;
    return parsed;
  } catch { return null; }
}

/**
 * Parse a raw Cookie header. Only reads reindeer_session. Returns the raw
 * cookie value (still to be verified via decodeSessionCookie) or null.
 */
export function readSessionCookie(req) {
  const raw = req.headers?.cookie;
  if (!raw) return null;
  const parts = raw.split(';').map((s) => s.trim());
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name !== COOKIE_NAME) continue;
    const value = part.slice(eq + 1).trim();
    // Strip surrounding quotes if any
    return value.replace(/^"|"$/g, '');
  }
  return null;
}

export function buildSetCookieHeader(encodedValue, { maxAgeSeconds, clear = false } = {}) {
  const parts = [
    `${COOKIE_NAME}=${clear ? '' : encodedValue}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  if (clear) parts.push('Max-Age=0');
  else if (maxAgeSeconds != null) parts.push(`Max-Age=${maxAgeSeconds}`);
  return parts.join('; ');
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;
