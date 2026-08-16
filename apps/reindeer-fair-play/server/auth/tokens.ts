/**
 * Magic-link / short-code token issuance and verification.
 *
 * The raw token is 32 random bytes, base64url-encoded, and is shown to the
 * user exactly once (in the link, or read back from the recording mailer in
 * tests). Only `sha256(rawToken)` is ever written to the database — see
 * `auth_tokens.tokenHash` in shared/schema.ts. Comparisons against a
 * candidate token use `crypto.timingSafeEqual` so a mistyped guess cannot be
 * timed apart from a near-miss.
 *
 * Magic-link tokens expire in 20 minutes (AUTH_TOKEN_TTL_MS) and are single
 * use: `consumeToken` sets `consumedAt` inside the same better-sqlite3
 * transaction that creates the session row, so two concurrent redemptions of
 * the same link can never both succeed — the second transaction always sees
 * the first one's `consumedAt` and fails closed.
 */
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../storage";
import {
  authTokens,
  SHORT_CODE_ALPHABET,
  SHORT_CODE_LENGTH,
  AUTH_TOKEN_TTL_MS,
  type AuthToken,
  type AuthTokenPurpose,
} from "@shared/schema";

/** sha256, hex-encoded. Used for both token hashes and session hashes. */
export function sha256Hex(raw: string): string {
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

/** Constant-time string comparison, safe against timing side-channels. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Still do a comparison of equal-length buffers so the failure path
    // takes comparable time to the equal-length mismatch path.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/** 32 random bytes, base64url — the raw magic-link token. */
function generateRawToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** 6-character human-readable code. Ambiguous characters excluded. */
function generateShortCode(): string {
  let out = "";
  for (let i = 0; i < SHORT_CODE_LENGTH; i++) {
    const idx = crypto.randomInt(0, SHORT_CODE_ALPHABET.length);
    out += SHORT_CODE_ALPHABET[idx];
  }
  return out;
}

export type IssuedToken = {
  row: AuthToken;
  /** The raw token — shown/mailed once, never persisted. */
  rawToken: string;
  /** The raw short code — also shown/mailed once. */
  shortCode: string;
};

/** Issue a new token for a participant. Retries on the rare short-code collision. */
export async function issueToken(input: {
  sessionId: number;
  participantId: number;
  purpose: AuthTokenPurpose;
  requestedIp: string | null;
  requestedUserAgent: string | null;
  ttlMs?: number;
}): Promise<IssuedToken> {
  const rawToken = generateRawToken();
  const tokenHash = sha256Hex(rawToken);
  const now = Date.now();
  const expiresAt = now + (input.ttlMs ?? AUTH_TOKEN_TTL_MS);

  // Short codes are 6 chars from a 33-char alphabet (~33^6 ≈ 1.29B
  // combinations) — collisions are rare but not impossible; retry a few times.
  let shortCode = generateShortCode();
  for (let attempt = 0; attempt < 5; attempt++) {
    const clash = db
      .select({ id: authTokens.id })
      .from(authTokens)
      .where(eq(authTokens.shortCode, shortCode))
      .get();
    if (!clash) break;
    shortCode = generateShortCode();
  }

  const id = randomUUID();
  db.insert(authTokens)
    .values({
      id,
      sessionId: input.sessionId,
      participantId: input.participantId,
      tokenHash,
      shortCode,
      purpose: input.purpose,
      createdAt: now,
      expiresAt,
      consumedAt: null,
      consumedIp: null,
      requestedIp: input.requestedIp,
      requestedUserAgent: input.requestedUserAgent,
    })
    .run();

  const row = db.select().from(authTokens).where(eq(authTokens.id, id)).get()!;
  return { row, rawToken, shortCode };
}

export type ConsumeResult =
  | { ok: true; token: AuthToken }
  | { ok: false; reason: "not_found" | "expired" | "already_used" };

/**
 * Look up a token by raw value or short code, without consuming it. Used to
 * validate before starting the transactional consume+session-create step.
 */
export function findTokenRow(input: { rawToken?: string; shortCode?: string }): AuthToken | null {
  if (input.rawToken) {
    const tokenHash = sha256Hex(input.rawToken);
    const rows = db.select().from(authTokens).where(eq(authTokens.tokenHash, tokenHash)).all();
    return rows[0] ?? null;
  }
  if (input.shortCode) {
    const code = input.shortCode.trim().toUpperCase();
    const rows = db.select().from(authTokens).where(eq(authTokens.shortCode, code)).all();
    return rows[0] ?? null;
  }
  return null;
}

/**
 * Validate a token row is fresh and unused. Does NOT mutate anything — the
 * actual consume (setting consumedAt) happens inside sessionStore.redeemToken's
 * synchronous better-sqlite3 transaction, atomically with session creation,
 * so a replayed link cannot also succeed.
 */
export function checkTokenFresh(row: AuthToken | null): ConsumeResult {
  if (!row) return { ok: false, reason: "not_found" };
  if (row.consumedAt !== null) return { ok: false, reason: "already_used" };
  if (row.expiresAt <= Date.now()) return { ok: false, reason: "expired" };
  return { ok: true, token: row };
}

/**
 * Marks a token consumed. Must only be called from inside the same
 * transaction that creates the resulting session (see sessionStore.ts).
 * Returns false if the row was already consumed by a concurrent transaction
 * (lost the race) — the caller must then fail the whole redemption closed.
 */
export function markTokenConsumedInTx(tokenId: string, ip: string | null): boolean {
  const result = db
    .update(authTokens)
    .set({ consumedAt: Date.now(), consumedIp: ip })
    .where(and(eq(authTokens.id, tokenId), isNull(authTokens.consumedAt)))
    .run();
  return result.changes === 1;
}
