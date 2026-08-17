import { normalizeEmail } from '@reindeer/core-data';

/**
 * The auth service ties three repos together:
 *   ParticipantsRepo  — who is on file
 *   MagicLinksRepo    — issue and consume single-use email tokens
 *   SessionsRepo      — mint and resolve session cookies
 *
 * The service is intentionally free of Express types so it can be unit
 * tested without an HTTP layer. Route handlers translate its
 * `{status, ...}` errors to JSON responses.
 *
 * The mailer parameter is a function `({ to, subject, text }) => Promise`
 * — same shape the Registry uses for trustee delivery. Both `text` and
 * the `body` field name are accepted by the SmtpMailer.
 * `linkBaseUrl` is the outward-facing origin, used to build the URL that
 * lands in the email.
 */
export class AuthService {
  constructor({ participants, magicLinks, sessions, mailer, linkBaseUrl }) {
    this.participants = participants;
    this.magicLinks = magicLinks;
    this.sessions = sessions;
    this.mailer = mailer;
    this.linkBaseUrl = String(linkBaseUrl || '').replace(/\/$/, '');
  }

  /**
   * Bootstrap-owner mode.
   *
   * Returns true when no participant has actually signed in yet.
   * Placeholder participants with status='invited' (created when the owner
   * sends an invite) do NOT turn off bootstrap mode — only status='active'
   * does. This lets the owner invite people without losing their session.
   *
   * In that state, /api routes without a session mint a synthetic "owner"
   * identity so a fresh installer can start using the app. As soon as a
   * participant signs in (status='active'), this returns false and every
   * route requires a real session.
   */
  isBootstrapMode() {
    // Bootstrap mode stays on until someone has actually signed in.
    // Placeholder participants with status='invited' (created during the
    // invite flow) do NOT turn it off — only status='active' does.
    return this.participants.countActive() === 0;
  }

  /**
   * Request a magic link for `email`.
   *
   * Returns { link, expiresAt } always — never leaks whether the email
   * is on file. The email dispatch returns a result so the caller can
   * surface a meaningful error if SMTP is misconfigured.
   */
  async requestLink({ email, invite = null } = {}) {
    const normalized = normalizeEmail(email);
    if (!isEmailish(normalized)) {
      throw badRequest('Please give us a real-looking email address.');
    }
    const { token, expiresAt } = this.magicLinks.issue({
      email: normalized,
      purpose: invite ? 'invite' : 'signin',
      inviteScopeId: invite?.scopeId ?? null,
      inviteRole: invite?.role ?? null,
    });
    const link = `${this.linkBaseUrl}/api/auth/verify?token=${encodeURIComponent(token)}`;
    // The mailer is deliberately optional. When null, the email step is
    // skipped; the link URL is still returned to the caller. This keeps
    // tests deterministic and lets a solo owner sign in from the same
    // machine without a mail server.
    if (this.mailer) {
      const result = await this.mailer({
        to: normalized,
        subject: 'Your sign-in link for Reindeer Registry',
        text: `Click this link to sign in. It works once and expires in 20 minutes.\n\n${link}\n`,
      });
      // Surface the error instead of silently swallowing it.
      // The link is still valid, but the caller should know email failed.
      if (result && !result.ok) {
        return { link, expiresAt, emailError: result.error || 'Email delivery failed.' };
      }
    }
    return { link, expiresAt };
  }

  /**
   * Verify a token and mint a session for the resulting participant.
   *
   * For 'signin' purpose: creates a participant with role 'owner' if
   * bootstrap mode is on (no participants exist), otherwise expects the
   * email to be on file — an unrecognized email during verify returns
   * a friendly 400 rather than silently minting a new participant.
   *
   * For 'invite' purpose: idempotently upserts the participant with
   * the invited role.
   */
  async verifyLink({ token, userAgent = '' }) {
    const link = this.magicLinks.consume(token); // throws 400 on bad tokens
    const email = link.email;
    let participant = this.participants.findByEmail(email);

    if (link.purpose === 'invite') {
      participant = this.participants.upsertByEmail({
        email,
        role: link.invite_role || 'partner',
        status: 'active',
        householdScopeId: link.invite_scope_id ?? null,
      });
    } else if (!participant) {
      if (this.isBootstrapMode()) {
        participant = this.participants.upsertByEmail({
          email, role: 'owner', status: 'active',
        });
      } else {
        throw badRequest('That email is not on this Registry. Ask the owner to invite you.');
      }
    }

    const { sessionId, token: sessionToken, expiresAt } =
      this.sessions.create({ participantId: participant.participant_id, userAgent });
    this.participants.touchLastSeen(participant.participant_id);

    return {
      sessionId,
      sessionToken,
      expiresAt,
      participant,
      linkPurpose: link.purpose,
      inviteScopeId: link.invite_scope_id ?? null,
    };
  }

  /**
   * Resolve a cookie token to a participant. Returns null if no valid
   * session. Callers should treat null as "unauthenticated" and, if
   * bootstrap mode is on, synthesize an anonymous owner identity for
   * old routes.
   */
  resolveSession(rawToken) {
    const session = this.sessions.resolve(rawToken);
    if (!session) return null;
    const participant = this.participants.get(session.participant_id);
    if (!participant || participant.status === 'disabled' || participant.status === 'revoked') return null;
    return { session, participant };
  }

  signOutSession(sessionId) {
    this.sessions.signOut(sessionId);
  }

  /**
   * Find a participant by email (for future password login).
   * Currently unused — magic links remain the only auth method.
   * Toggle: FEATURE_FLAGS.passwordLogin
   */
  findByEmail(email) {
    const normalized = normalizeEmail(email);
    return this.participants.db
      .prepare('SELECT * FROM participants WHERE email = ? AND status = ?')
      .get(normalized, 'active') || null;
  }

  /**
   * Create a session directly (for future password login).
   * Currently unused — magic links remain the only auth method.
   */
  createSessionForParticipant(participant, userAgent = '') {
    const { token, session } = this.sessions.create({
      participantId: participant.participant_id,
      userAgent,
    });
    return { sessionToken: token, session };
  }
}

function isEmailish(s) {
  // Deliberately loose — we do not want to reject real addresses. The
  // token validation is the real gate.
  return typeof s === 'string' && s.length >= 5 && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
function badRequest(msg) { return Object.assign(new Error(msg), { status: 400 }); }
