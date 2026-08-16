import crypto from 'node:crypto';
import { ulid } from '../db/index.js';

/**
 * Sessions — 30-day sliding sessions anchored to a participant.
 *
 * The session token is a random 32-byte string. We persist only its
 * sha256 hash. The raw token is placed in a signed httpOnly cookie by
 * the auth service. On each request the middleware:
 *   1. reads the cookie, verifies the signature,
 *   2. hashes the token and looks it up here,
 *   3. rejects if expired or signed out,
 *   4. otherwise extends the sliding window by 30 days.
 *
 * The `signed_out_at` column is a tombstone: rows are never physically
 * deleted on sign-out so that an attacker who scrapes an old backup
 * cannot resurrect an invalidated session.
 */

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export class SessionsRepo {
  constructor(db) { this.db = db; }

  create({ participantId, userAgent = '' }) {
    if (!participantId) throw badRequest('A participant id is needed.');
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hash(token);
    const sessionId = ulid();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    this.db.prepare(
      `INSERT INTO sessions
         (session_id, token_hash, participant_id, created_at, last_used_at,
          expires_at, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId, tokenHash, participantId,
      now.toISOString(), now.toISOString(), expiresAt.toISOString(),
      String(userAgent ?? '').slice(0, 512),
    );
    return { sessionId, token, expiresAt: expiresAt.toISOString() };
  }

  /** Look up a session by its raw token, extending the sliding window. */
  resolve(token) {
    if (!token) return null;
    const tokenHash = hash(token);
    const row = this.db.prepare(
      `SELECT * FROM sessions WHERE token_hash = ?`,
    ).get(tokenHash);
    if (!row) return null;
    if (row.signed_out_at) return null;
    const now = new Date();
    if (new Date(row.expires_at) < now) return null;
    // Sliding window: only bump if the last update was more than 60s ago,
    // so we do not thrash the DB on every request.
    const lastUsed = new Date(row.last_used_at);
    if (now.getTime() - lastUsed.getTime() > 60_000) {
      const newExpires = new Date(now.getTime() + SESSION_TTL_MS);
      this.db.prepare(
        `UPDATE sessions
            SET last_used_at = ?, expires_at = ?
          WHERE session_id = ?`,
      ).run(now.toISOString(), newExpires.toISOString(), row.session_id);
      row.last_used_at = now.toISOString();
      row.expires_at = newExpires.toISOString();
    }
    return {
      session_id: row.session_id,
      participant_id: row.participant_id,
      created_at: row.created_at,
      last_used_at: row.last_used_at,
      expires_at: row.expires_at,
    };
  }

  signOut(sessionId) {
    const now = new Date().toISOString();
    this.db.prepare(
      'UPDATE sessions SET signed_out_at = ? WHERE session_id = ? AND signed_out_at IS NULL',
    ).run(now, sessionId);
  }

  signOutAllFor(participantId) {
    const now = new Date().toISOString();
    this.db.prepare(
      'UPDATE sessions SET signed_out_at = ? WHERE participant_id = ? AND signed_out_at IS NULL',
    ).run(now, participantId);
  }

  purgeExpired(nowIso = new Date().toISOString()) {
    return this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso).changes;
  }
}

function hash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}
function badRequest(msg) { return Object.assign(new Error(msg), { status: 400 }); }

export const SESSION_TTL_MILLISECONDS = SESSION_TTL_MS;
