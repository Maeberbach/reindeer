import crypto from 'node:crypto';

/**
 * Magic links — single-use, 20-minute email tokens that mint a session.
 *
 * We never store the raw token. We store a sha256 hash and match on that
 * at verify time. This means a database leak does not hand attackers
 * usable sign-in links.
 *
 * Two purposes:
 *   'signin'  — the returning user requests a link to their known email.
 *   'invite'  — the owner invites a partner (or trustee) to join the
 *               household. The invite carries the scope and role so
 *               verify can accept them in one round-trip.
 */

const TOKEN_TTL_MINUTES = 20;

export class MagicLinksRepo {
  constructor(db) { this.db = db; }

  /**
   * Issue a new token for `email`. Returns { token, expiresAt } to the
   * caller so it can be embedded in an email. The token is opaque; only
   * its hash is persisted.
   */
  issue({ email, purpose = 'signin', inviteScopeId = null, inviteRole = null }) {
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hash(token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + TOKEN_TTL_MINUTES * 60_000);
    this.db.prepare(
      `INSERT INTO magic_links
         (token_hash, email, purpose, issued_at, expires_at, invite_scope_id, invite_role)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(tokenHash, String(email).trim().toLowerCase(), purpose,
          now.toISOString(), expiresAt.toISOString(),
          inviteScopeId, inviteRole);
    return { token, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Consume the token in one atomic step. Returns the link record on
   * success (with `email`, `purpose`, invite fields). Throws 400 on
   * unknown / expired / already-consumed tokens. Deliberately does not
   * distinguish those cases in the error message — that keeps token
   * lookup a one-bit-of-information oracle.
   */
  consume(token) {
    if (!token) throw badRequest('That link is not valid or has expired.');
    const tokenHash = hash(token);
    const row = this.db.prepare(
      'SELECT * FROM magic_links WHERE token_hash = ?',
    ).get(tokenHash);
    if (!row) throw badRequest('That link is not valid or has expired.');
    if (row.consumed_at) throw badRequest('That link is not valid or has expired.');
    const now = new Date();
    if (new Date(row.expires_at) < now) throw badRequest('That link is not valid or has expired.');
    this.db.prepare(
      'UPDATE magic_links SET consumed_at = ? WHERE token_hash = ?',
    ).run(now.toISOString(), tokenHash);
    return {
      email: row.email,
      purpose: row.purpose,
      invite_scope_id: row.invite_scope_id ?? null,
      invite_role: row.invite_role ?? null,
      issued_at: row.issued_at,
      expires_at: row.expires_at,
      consumed_at: now.toISOString(),
    };
  }

  /** Called by a periodic cleanup task. Not called on the hot path. */
  purgeExpired(nowIso = new Date().toISOString()) {
    return this.db.prepare(
      'DELETE FROM magic_links WHERE expires_at < ? OR consumed_at IS NOT NULL',
    ).run(nowIso).changes;
  }
}

function hash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function badRequest(msg) { return Object.assign(new Error(msg), { status: 400 }); }

export const MAGIC_LINK_TTL_MINUTES = TOKEN_TTL_MINUTES;
