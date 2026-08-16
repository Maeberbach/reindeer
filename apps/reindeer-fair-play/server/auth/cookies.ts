/**
 * Minimal signed-cookie helpers, in the same style Express's own
 * `cookie-parser` uses (HMAC-SHA256 via the `cookie-signature` package,
 * which is already a transitive dependency of express-session). Written
 * directly rather than adding another middleware dependency.
 *
 * The cookie carries the raw session token. It is httpOnly, `sameSite:
 * "lax"`, `secure` only in production, signed with the auth secret, and
 * long-lived (30 days, matching AUTH_SESSION_TTL_MS) with path "/".
 */
import type { Request, Response } from "express";
import cookie from "cookie";
import cookieSignature from "cookie-signature";
import { getAuthSecret } from "./secret";
import { AUTH_SESSION_TTL_MS } from "@shared/schema";

export const COOKIE_NAME = "fc_session";

/** Parses and verifies the signed session cookie off a raw request, without needing cookie-parser middleware. */
export function readSignedSessionCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  const parsed = cookie.parse(header);
  const raw = parsed[COOKIE_NAME];
  if (!raw) return null;
  // cookie-signature expects the "s:" prefix format used by cookie-parser.
  if (!raw.startsWith("s:")) return null;
  const unsigned = cookieSignature.unsign(raw.slice(2), getAuthSecret());
  return unsigned === false ? null : unsigned;
}

/** Sets the signed session cookie. */
export function setSessionCookie(res: Response, rawSessionToken: string): void {
  const signed = "s:" + cookieSignature.sign(rawSessionToken, getAuthSecret());
  res.cookie(COOKIE_NAME, signed, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    signed: false, // we sign manually above, so express shouldn't double-sign
    maxAge: AUTH_SESSION_TTL_MS,
    path: "/",
  });
}

/** Clears the session cookie on sign-out. */
export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
}
