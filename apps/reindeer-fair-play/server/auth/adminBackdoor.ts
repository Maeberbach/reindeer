/**
 * Backdoor admin access for FairPlay.
 *
 * Checks for a master admin key in the x-admin-key header or ?admin_key= query
 * param. When it matches REINDEER_ADMIN_KEY (env var), the request is
 * treated as a superuser — bypassing all session auth.
 *
 * The admin identity is a synthetic Participant with isAdmin=true so every
 * existing guard (denyIfNotHeirAdmin, isSelfOrPR, requireCaptain) lets it
 * through.
 *
 * Security: if REINDEER_ADMIN_KEY is unset or shorter than 16 chars, this
 * middleware is a complete no-op. The key is never logged or returned.
 */
import type { Request, Response, NextFunction } from "express";

const ADMIN_KEY = process.env.REINDEER_ADMIN_KEY || "";
const MIN_KEY_LENGTH = 16;
const isValidKey = ADMIN_KEY.length >= MIN_KEY_LENGTH;

/** Synthetic admin participant injected when the backdoor key matches. */
const ADMIN_PARTICIPANT = {
  id: -1,
  name: "Admin",
  email: "admin@reindeer.local",
  role: "representative",
  isAdmin: true,
  administersOnly: false,
  status: "active",
} as any;

/**
 * Express middleware. Mount BEFORE attachActor so the admin identity is set
 * before any session cookie logic. No-op when the key isn't configured.
 */
export function adminBackdoor(req: Request, _res: Response, next: NextFunction): void {
  if (!isValidKey) return next();

  const provided =
    (req.headers["x-admin-key"] as string) ||
    new URL(req.url, "http://localhost").searchParams.get("admin_key") ||
    "";

  if (provided && provided === ADMIN_KEY) {
    req.actor = ADMIN_PARTICIPANT;
    req.authSessionRowId = -1;
  }

  next();
}

/** True when the backdoor key is configured. */
export const backdoorEnabled = isValidKey;

/** True when the current request was authenticated via the backdoor. */
export function isBackdoorAdmin(req: Request): boolean {
  return req.actor?.id === -1;
}
