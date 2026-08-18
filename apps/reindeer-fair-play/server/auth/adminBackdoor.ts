/**
 * Two-tier backdoor admin access for FairPlay.
 *
 * Tier 1 — Corporate Admin (REINDEER_ADMIN_KEY):
 *   Feature flag toggles, estate metadata (counts only), full estate reset.
 *   NO access to estate content data.
 *
 * Tier 2 — Support Admin (REINDEER_SUPPORT_KEY):
 *   Full data access — items, participants, audit logs.
 *   Not configured by default on sold installs. Every call is audit-logged.
 */
import type { Request, Response, NextFunction } from "express";

const ADMIN_KEY = process.env.REINDEER_ADMIN_KEY || "";
const SUPPORT_KEY = process.env.REINDEER_SUPPORT_KEY || "";
const MIN_KEY_LENGTH = 16;
const isValidKey = ADMIN_KEY.length >= MIN_KEY_LENGTH;
const isValidSupportKey = SUPPORT_KEY.length >= MIN_KEY_LENGTH;

const ADMIN_PARTICIPANT = {
  id: -1, name: "Admin", email: "admin@reindeer.local",
  role: "representative", isAdmin: true, administersOnly: false, status: "active",
} as any;

const SUPPORT_PARTICIPANT = {
  id: -2, name: "Support", email: "support@reindeer.local",
  role: "representative", isAdmin: true, administersOnly: false, status: "active",
} as any;

export function adminBackdoor(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key, x-support-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const provided =
    (req.headers["x-admin-key"] as string) ||
    (req.headers["x-support-key"] as string) ||
    new URL(req.url, "http://localhost").searchParams.get("admin_key") || "";

  if (provided && isValidKey && provided === ADMIN_KEY) {
    req.actor = ADMIN_PARTICIPANT;
    req.authSessionRowId = -1;
  } else if (provided && isValidSupportKey && provided === SUPPORT_KEY) {
    req.actor = SUPPORT_PARTICIPANT;
    req.authSessionRowId = -2;
    console.log(`[support-access] ${new Date().toISOString()} ${req.method} ${req.url}`);
  }

  next();
}

export const backdoorEnabled = isValidKey;
export const supportEnabled = isValidSupportKey;

export function isBackdoorAdmin(req: Request): boolean {
  return req.actor?.id === -1 || req.actor?.id === -2;
}

export function isBackdoorSupport(req: Request): boolean {
  return req.actor?.id === -2;
}
