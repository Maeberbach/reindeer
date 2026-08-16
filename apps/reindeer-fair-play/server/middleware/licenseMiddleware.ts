/**
 * License key middleware for Reindeer: FairPlay.
 *
 * TOGGLED OFF — controlled by FEATURE_FLAGS.licenseKeys.
 * When enabled, this middleware validates the user's license key
 * and enforces read-only mode for lapsed subscriptions.
 * Currently passes all requests through (testing mode = unlimited access).
 *
 * Mirrors apps/reindeer-registry/server/licenseMiddleware.js.
 * If you change one, change the other.
 *
 * To enable:
 *   1. Set FEATURE_FLAGS.licenseKeys = true in featureFlags.ts
 *   2. Implement JWT validation logic below
 *   3. Mount this middleware after attachActor (see routes.ts)
 */

import type { Request, Response, NextFunction } from "express";
import { isLicenseEnforced } from "../featureFlags";

/**
 * Returns true if the request has full read/write access.
 * When license enforcement is OFF (current state), always returns true.
 * When ON, checks the license_keys table for an active key.
 */
export function hasWriteAccess(_req: Request): boolean {
  // Testing mode — everything is unlimited
  if (!isLicenseEnforced()) return true;

  // When enabled, check req.actor's license
  // const license = (req as any).license;
  // if (!license || license.status !== 'active') return false;
  // return true;

  return true; // Fallback: allow all (replace with real check when enabled)
}

/**
 * Returns true if the request has read access.
 * Read access is NEVER revoked — even lapsed subscriptions can read
 * and export their data. Data is never deleted for non-payment.
 */
export function hasReadAccess(_req: Request): boolean {
  return true; // Always true — reading is never blocked
}

/**
 * Express middleware: blocks write operations for lapsed licenses.
 * When license enforcement is OFF, this is a no-op.
 *
 * Only intercepts write methods (POST, PUT, PATCH, DELETE).
 * GET requests always pass through — reading is never blocked.
 */
export function requireLicenseForWrite(req: Request, res: Response, next: NextFunction): void {
  if (!isLicenseEnforced()) {
    return next(); // No-op in testing mode
  }

  // Only block write methods — reads are always allowed
  if (req.method === "GET") {
    return next();
  }

  if (!hasWriteAccess(req)) {
    res.status(403).json({
      message: "Your subscription has lapsed. Your data is safe — renew to continue adding.",
      read_only: true,
    });
    return;
  }

  next();
}
