/**
 * License & subscription middleware for Reindeer Registry.
 *
 * Both are TOGGLED OFF — controlled by FEATURE_FLAGS.
 * When enabled, this middleware validates the user's license/subscription
 * and enforces read-only mode for lapsed subscriptions.
 * Currently passes all requests through (testing mode = unlimited access).
 *
 * Mirrors apps/reindeer-fair-play/server/middleware/licenseMiddleware.ts.
 * If you change one, change the other.
 *
 * To enable license keys:
 *   1. Set FEATURE_FLAGS.licenseKeys = true in featureFlags.js
 *   2. Implement JWT validation logic below
 *   3. Mount this middleware after session attachment (already wired in index.js)
 *
 * To enable subscription gate:
 *   1. Set FEATURE_FLAGS.subscriptionGate = true in featureFlags.js
 *      (or set REINDEER_FEATURE_SUBSCRIPTION_GATE=true env var)
 *   2. The estate_subscriptions table must exist (migration #23)
 *   3. requireSubscriptionForWrite is mounted after requireLicenseForWrite
 */

import { isLicenseEnforced, isSubscriptionGateEnabled } from './featureFlags.js';

/**
 * Returns true if the request has full read/write access.
 * When license enforcement is OFF (current state), always returns true.
 * When ON, checks the license_keys table for an active key.
 */
export function hasWriteAccess(req) {
  // Testing mode — everything is unlimited
  if (!isLicenseEnforced()) return true;
  // When enabled, check req.participant for a valid license
  // const license = req.participant?.license;
  // if (!license || license.status !== 'active') return false;
  // return true;
  return true; // Fallback: allow all (replace with real check when enabled)
}

/**
 * Returns true if the request has read access.
 * Read access is NEVER revoked — even lapsed subscriptions can read
 * and export their data. Data is never deleted for non-payment.
 */
export function hasReadAccess(_req) {
  return true; // Always true — reading is never blocked
}

/**
 * Express middleware: blocks write operations for lapsed licenses.
 * When license enforcement is OFF, this is a no-op.
 *
 * Only intercepts write methods (POST, PUT, PATCH, DELETE).
 * GET requests always pass through — reading is never blocked.
 */
export function requireLicenseForWrite(req, res, next) {
  if (!isLicenseEnforced()) {
    return next(); // No-op in testing mode
  }

  // Only block write methods — reads are always allowed
  if (req.method === 'GET') {
    return next();
  }

  if (!hasWriteAccess(req)) {
    return res.status(403).json({
      error: 'Your subscription has lapsed. Your data is safe — renew to continue adding.',
      read_only: true,
    });
  }

  next();
}

/**
 * Express middleware: blocks write operations for expired/locked estates.
 * When subscription gate is OFF (current state), this is a no-op.
 *
 * Only intercepts write methods (POST, PUT, PATCH, DELETE).
 * GET requests always pass through — reading is never blocked.
 * Estates with no subscription record default to 'active' (grace period).
 */
export function requireSubscriptionForWrite(req, res, next) {
  if (!isSubscriptionGateEnabled()) {
    return next(); // No-op in testing mode
  }

  // Only block write methods — reads are always allowed
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }

  // Check estate_subscriptions table for the current scope_id
  // Uses the db instance attached to req.app or imported
  try {
    const scopeId = req.session?.scopeId || process.env.REINDEER_SCOPE_ID || 'inventory-default';
    const db = req.app?.locals?.db;
    if (db) {
      const sub = db.prepare('SELECT status FROM estate_subscriptions WHERE scope_id = ?').get(scopeId);
      if (sub && (sub.status === 'expired' || sub.status === 'locked')) {
        return res.status(402).json({
          error: 'Subscription expired. Data is preserved — renew to continue.',
          read_only: true,
        });
      }
    }
  } catch (err) {
    // If table doesn't exist or query fails, allow the request (grace period)
    console.error('Subscription check error:', err.message);
  }

  next();
}
