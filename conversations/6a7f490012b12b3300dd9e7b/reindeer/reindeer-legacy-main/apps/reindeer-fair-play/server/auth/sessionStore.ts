/**
 * Session lifecycle: create (by redeeming a token), look up, touch (sliding
 * expiry), revoke, and revoke-all-for-participant.
 *
 * Sessions live 30 days from last use (AUTH_SESSION_TTL_MS), sliding forward
 * on every authenticated request via `touchSession`. A revoked or expired
 * row is never treated as valid — every lookup here fails closed.
 *
 * `redeemToken` is the one place a magic link becomes a session, and it runs
 * inside a single synchronous better-sqlite3 transaction: the token is
 * marked consumed and the session row is created together, or neither
 * happens. That is what makes a replayed link fail on its second use even
 * under concurrent requests.
 */
import { randomUUID } from "node:crypto";
import crypto from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import { db, sqlite } from "../storage";
import { authSessions, authTokens, AUTH_SESSION_TTL_MS, type AuthSession, type Participant } from "@shared/schema";
import { sha256Hex, findTokenRow, checkTokenFresh } from "./tokens";
import { storage } from "../storage";
import { recordAuthEvent } from "./events";

export type RedeemOutcome =
  | { ok: true; sessionRow: AuthSession; rawSessionToken: string; participant: Participant }
  | { ok: false; reason: "not_found" | "expired" | "already_used" | "participant_missing" };

/**
 * Redeem a magic-link token (by raw value or short code) into a new signed-in
 * session. Atomic: consuming the token and creating the session happen in
 * one transaction, so concurrent or replayed redemptions cannot both win.
 */
export async function redeemToken(
  input: { rawToken?: string; shortCode?: string },
  ctx: { ip: string | null; userAgent: string | null },
): Promise<RedeemOutcome> {
  const candidate = findTokenRow(input);
  const fresh = checkTokenFresh(candidate);
  if (!fresh.ok) {
    await recordAuthEvent({
      participantId: candidate?.participantId ?? null,
      kind: "sign_in_failed",
      detail: fresh.reason,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { ok: false, reason: fresh.reason };
  }

  const token = fresh.token;
  const participants = await storage.listParticipants();
  const participant = participants.find((p) => p.id === token.participantId) ?? null;
  if (!participant) {
    return { ok: false, reason: "participant_missing" };
  }

  const rawSessionToken = crypto.randomBytes(32).toString("base64url");
  const tokenHash = sha256Hex(rawSessionToken);
  const sessionId = randomUUID();
  const now = Date.now();

  // Real, synchronous better-sqlite3 transaction: consume-token and
  // create-session succeed or fail together. A concurrent redeemer racing
  // the same token will see `changes !== 1` on the UPDATE and abort.
  const tx = sqlite.transaction(() => {
    const consumeResult = sqlite
      .prepare(
        `UPDATE auth_tokens SET consumed_at = ?, consumed_ip = ? WHERE id = ? AND consumed_at IS NULL`,
      )
      .run(now, ctx.ip, token.id);
    if (consumeResult.changes !== 1) {
      throw new TokenAlreadyConsumedError();
    }
    sqlite
      .prepare(
        `INSERT INTO auth_sessions
           (id, session_id, participant_id, token_hash, created_at, last_seen_at, expires_at, revoked_at, revoked_by_participant_id, user_agent, ip)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        sessionId,
        token.sessionId,
        token.participantId,
        tokenHash,
        now,
        now,
        now + AUTH_SESSION_TTL_MS,
        ctx.userAgent,
        ctx.ip,
      );
  });

  try {
    tx();
  } catch (e) {
    if (e instanceof TokenAlreadyConsumedError) {
      await recordAuthEvent({
        participantId: token.participantId,
        kind: "sign_in_failed",
        detail: "already_used",
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return { ok: false, reason: "already_used" };
    }
    throw e;
  }

  const sessionRow = db.select().from(authSessions).where(eq(authSessions.id, sessionId)).get()!;

  await recordAuthEvent({
    participantId: token.participantId,
    kind: "sign_in",
    detail: token.purpose,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  return { ok: true, sessionRow, rawSessionToken, participant };
}

class TokenAlreadyConsumedError extends Error {}

/**
 * Look up a session by its raw cookie value. Returns null for anything that
 * is missing, revoked, or expired — the caller must treat null as "no
 * session", never fall back to any other identity signal.
 */
export async function lookupSession(
  rawSessionToken: string | null | undefined,
): Promise<{ session: AuthSession; participant: Participant } | null> {
  if (!rawSessionToken) return null;
  const tokenHash = sha256Hex(rawSessionToken);
  const row = db.select().from(authSessions).where(eq(authSessions.tokenHash, tokenHash)).get();
  if (!row) return null;
  if (row.revokedAt !== null) return null;
  if (row.expiresAt <= Date.now()) return null;

  const participants = await storage.listParticipants();
  const participant = participants.find((p) => p.id === row.participantId) ?? null;
  if (!participant) return null;

  return { session: row, participant };
}

/** Slide the session's expiry forward and stamp lastSeenAt. Fire-and-forget safe. */
export async function touchSession(sessionRowId: string): Promise<void> {
  const now = Date.now();
  db.update(authSessions)
    .set({ lastSeenAt: now, expiresAt: now + AUTH_SESSION_TTL_MS })
    .where(eq(authSessions.id, sessionRowId))
    .run();
}

/** Revoke one session by its row id. Idempotent. */
export async function revokeSession(
  sessionRowId: string,
  revokedByParticipantId: number | null,
): Promise<boolean> {
  const result = db
    .update(authSessions)
    .set({ revokedAt: Date.now(), revokedByParticipantId })
    .where(and(eq(authSessions.id, sessionRowId), isNull(authSessions.revokedAt)))
    .run();
  return result.changes === 1;
}

/** Revoke every active session belonging to a participant (e.g. on suspicion, or self sign-out-everywhere). */
export async function revokeAllForParticipant(
  participantId: number,
  revokedByParticipantId: number | null,
): Promise<number> {
  const result = db
    .update(authSessions)
    .set({ revokedAt: Date.now(), revokedByParticipantId })
    .where(and(eq(authSessions.participantId, participantId), isNull(authSessions.revokedAt)))
    .run();
  return result.changes;
}

/** List a participant's own sessions (active and past), most recent first. */
export async function listSessionsForParticipant(participantId: number): Promise<AuthSession[]> {
  const rows = db
    .select()
    .from(authSessions)
    .where(eq(authSessions.participantId, participantId))
    .all();
  return rows.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

/** Look up a single session row by id, scoped to nothing (caller must check ownership). */
export async function getSessionRow(sessionRowId: string): Promise<AuthSession | null> {
  return db.select().from(authSessions).where(eq(authSessions.id, sessionRowId)).get() ?? null;
}

/**
 * Creates a session directly, with no token to redeem — used ONLY by the
 * one-time bootstrap (`POST /api/session/welcome`), which creates the first
 * Captain and needs to sign them in immediately. Safe to
 * call here because `storage.createWelcome` (the caller's caller) already
 * refuses with 409 once any participant with `isAdmin` exists, so this path
 * can never mint a session for anyone but the estate's first-ever captain.
 */
export async function createBootstrapSession(
  participantId: number,
  ip: string | null,
  userAgent: string | null,
): Promise<{ sessionRow: AuthSession; rawSessionToken: string }> {
  const session = await storage.getSession();
  const rawSessionToken = crypto.randomBytes(32).toString("base64url");
  const tokenHash = sha256Hex(rawSessionToken);
  const id = randomUUID();
  const now = Date.now();
  db.insert(authSessions)
    .values({
      id,
      sessionId: session.id,
      participantId,
      tokenHash,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + AUTH_SESSION_TTL_MS,
      revokedAt: null,
      revokedByParticipantId: null,
      userAgent,
      ip,
    })
    .run();
  const sessionRow = db.select().from(authSessions).where(eq(authSessions.id, id)).get()!;
  return { sessionRow, rawSessionToken };
}
