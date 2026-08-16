/**
 * The signing/hashing secret behind every session cookie and token.
 *
 * Production MUST set `REINDEER_FAIR_PLAY_AUTH_SECRET`. When it is absent (local
 * development, CI, a fresh sandbox) this module generates 32 random bytes,
 * persists them to a gitignored file beside the database, and reuses that
 * file on every subsequent boot — so sessions survive a restart in dev, but
 * the secret is never hardcoded and never checked in.
 *
 * The file lives beside "data.db", matching how storage.ts resolves the
 * database itself (relative to process.cwd(), no override).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const SECRET_FILE = path.resolve(process.cwd(), ".auth-secret");

let cached: string | null = null;
let warned = false;

function loadOrCreateDevSecret(): string {
  try {
    const existing = fs.readFileSync(SECRET_FILE, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* file does not exist yet — fall through and create it */
  }
  const generated = crypto.randomBytes(32).toString("base64url");
  fs.writeFileSync(SECRET_FILE, generated, { mode: 0o600 });
  return generated;
}

/**
 * The active auth secret. Reads `REINDEER_FAIR_PLAY_AUTH_SECRET` first; only ever
 * falls back to a generated, file-persisted development secret, and logs
 * exactly one warning the first time that fallback is used.
 */
export function getAuthSecret(): string {
  if (cached) return cached;
  const fromEnv = process.env.REINDEER_FAIR_PLAY_AUTH_SECRET;
  if (fromEnv && fromEnv.trim().length > 0) {
    cached = fromEnv.trim();
    return cached;
  }
  if (!warned) {
    warned = true;
    // eslint-disable-next-line no-console
    console.warn(
      "[auth] REINDEER_FAIR_PLAY_AUTH_SECRET is not set. Using a generated development-only " +
        `secret persisted at ${SECRET_FILE}. This is fine for local development, but ` +
        "production MUST set REINDEER_FAIR_PLAY_AUTH_SECRET to a strong, stable value — " +
        "every session and sign-in token is invalidated whenever this secret changes.",
    );
  }
  cached = loadOrCreateDevSecret();
  return cached;
}
