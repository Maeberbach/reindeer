/**
 * Per-estate subscription gate middleware for Reindeer: FairPlay.
 *
 * TOGGLED OFF — controlled by FEATURE_FLAGS.subscriptionGate.
 *
 * When the gate is ON, this middleware blocks write operations
 * (POST / PUT / PATCH / DELETE) for estates whose subscription is
 * expired or locked, returning HTTP 402 Payment Required. Read access
 * (GET) is never blocked — heirs can always read and export their
 * data; data is never deleted for non-payment.
 *
 * While the gate is OFF (current testing mode) this is a no-op: every
 * request passes through unchanged, so existing functionality is
 * unaffected until the flag is explicitly enabled.
 *
 * Mirrors apps/reindeer-discovery requireSubscriptionForWrite. When
 * multi-estate is enabled the scope id will be resolved per request
 * (from req.actor / the estate's session) rather than the single
 * ESTATE_ID; for now the single-estate install uses ESTATE_ID.
 */

import type { Request, Response, NextFunction } from "express";
import { isSubscriptionGateEnabled } from "../featureFlags";
import { sqlite, ESTATE_ID } from "../storage";

/** Statuses that explicitly block write access when the gate is on. */
const BLOCKING_STATUSES = new Set(["expired", "locked", "cancelled"]);

/** Subset of the estate_subscriptions row used by the gate. */
interface SubscriptionGateRow {
  status: string;
  subscription_expires_at: string | null;
  license_expires_at: string | null;
}

/**
 * Read the subscription row that governs the current estate.
 * Returns null when no row exists yet — treated as a grace period
 * (active) so a fresh estate is never locked out before onboarding.
 */
export function getEstateSubscription(
  scopeId: string = ESTATE_ID,
): SubscriptionGateRow | null {
  const row = sqlite
    .prepare(
      "SELECT status, subscription_expires_at, license_expires_at " +
        "FROM estate_subscriptions WHERE scope_id = ?",
    )
    .get(scopeId) as SubscriptionGateRow | undefined;
  return row ?? null;
}

/**
 * True when the estate's subscription is expired or locked and writes
 * should be refused (gate-on behaviour). A missing record is never
 * blocking — the estate is in its grace period.
 */
export function isEstateWriteBlocked(scopeId: string = ESTATE_ID): boolean {
  const sub = getEstateSubscription(scopeId);
  if (!sub) return false;

  if (BLOCKING_STATUSES.has(sub.status)) return true;

  const now = Date.now();
  if (
    sub.subscription_expires_at &&
    !Number.isNaN(new Date(sub.subscription_expires_at).getTime()) &&
    new Date(sub.subscription_expires_at).getTime() < now
  ) {
    return true;
  }
  if (
    sub.license_expires_at &&
    !Number.isNaN(new Date(sub.license_expires_at).getTime()) &&
    new Date(sub.license_expires_at).getTime() < now
  ) {
    return true;
  }

  return false;
}

/**
 * Express middleware: blocks write operations for lapsed / locked estates.
 * No-op while the subscription gate flag is off. Only intercepts write
 * methods — GET requests always pass through.
 *
 * Mounted after attachActor + deny-by-default + requireLicenseForWrite so
 * the actor is resolved and authenticated first. See routes.ts.
 */
export function requireSubscriptionForWrite(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Testing mode — everything is unlimited.
  if (!isSubscriptionGateEnabled()) {
    return next();
  }

  // Reads are never blocked, even for lapsed subscriptions.
  if (req.method === "GET") {
    return next();
  }

  if (isEstateWriteBlocked()) {
    res.status(402).json({
      error: "ESTATE_SUBSCRIPTION_INACTIVE",
      message:
        "This estate's subscription is not active. Your data is safe — renew to continue adding.",
      read_only: true,
    });
    return;
  }

  next();
}
