/**
 * License key middleware for Reindeer Registry.
 *
 * TOGGLED OFF — controlled by FEATURE_FLAGS.licenseKeys.
 * When enabled, this middleware validates the user's license key
 * and enforces read-only mode for lapsed subscriptions.
 * Currently passes all requests through (testing mode = unlimited access).
 *
 * Mirrors apps/reindeer-fair-play/server/middleware/licenseMiddleware.ts.
 * If you change one, change the other.
 *
 * To enable:
 *   1. Set FEATURE_FLAGS.licenseKeys = true in featureFlags.js
 *   2. Implement JWT validation logic below
 *   3. Mount this middleware after session attachment (already wired in index.js)
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
 * Per-estate subscription status.
 * When the subscription gate is OFF (testing mode), always returns "active".
 * When ON, checks the estate_subscriptions table for the scope's status.
 */
export function getEstateSubscriptionStatus(_db, _scopeId) {
  // Testing mode — subscription is always active
  if (!isSubscriptionGateEnabled()) return 'active';

  // When enabled, query estate_subscriptions for the scope's status
  // const row = _db.prepare('SELECT status FROM estate_subscriptions WHERE scope_id = ?').get(_scopeId);
  // return row?.status ?? 'expired';
  return 'active'; // Fallback: always active (replace with real check when enabled)
}

/**
 * Express middleware factory: blocks write operations for expired/locked estates.
 * When the subscription gate is OFF, this is a no-op.
 *
 * Only intercepts write methods (POST, PUT, PATCH, DELETE).
 * GET requests always pass through — reading is never blocked.
 *
 * Returns HTTP 402 when the estate's subscription is expired or locked.
 */
export function requireSubscriptionForWrite(_db, _scopeId) {
  return function subscriptionGate(req, res, next) {
    // No-op in testing mode
    if (!isSubscriptionGateEnabled()) {
      return next();
    }

    // Only block write methods — reads are always allowed
    if (req.method === 'GET') {
      return next();
    }

    const status = getEstateSubscriptionStatus(_db, _scopeId);
    if (status === 'expired' || status === 'locked') {
      return res.status(402).json({
        error: 'Your subscription has expired. Your data is safe — renew to continue.',
        subscription_status: status,
        read_only: true,
      });
    }

    next();
  };
}
