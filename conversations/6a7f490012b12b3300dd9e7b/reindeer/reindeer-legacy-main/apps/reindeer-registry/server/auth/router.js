import express from 'express';
import { setSessionCookie, clearSessionCookie } from './middleware.js';

/**
 * /api/auth routes.
 *
 * These routes deliberately live OUTSIDE the authRequired gate. They
 * are the only entry point for an unauthenticated visitor.
 *
 * POST /api/auth/request-link
 *   Body: { email, invite?: { scopeId, role } }
 *   Response: { ok: true, expiresAt, link?, emailError? }
 *   The `link` field is only echoed back when the install is running
 *   without a mailer configured — that's the local-dev / solo-owner
 *   path. In production with a mailer, the link is only sent to the
 *   inbox.
 *   When the mailer IS configured but delivery fails, `emailError` is
 *   included so the UI can surface a meaningful message.
 *
 * GET  /api/auth/verify?token=...
 *   Consumes the token, mints a session, sets the cookie, redirects
 *   to `next` (default '/') so the visitor lands in the app already
 *   signed in.
 *
 * POST /api/auth/sign-out
 *   Marks the current session as signed out and clears the cookie.
 *
 * GET  /api/auth/me
 *   Returns the current participant (or bootstrap owner). Never 401s
 *   — always returns { authenticated, bootstrap, participant }.
 */
export function createAuthRouter({ auth, sessionSecret, mailerConfigured = false }) {
  const router = express.Router();

  router.post('/auth/request-link', express.json(), async (req, res, next) => {
    try {
      const { email, invite = null } = req.body || {};
      const { link, expiresAt, emailError } = await auth.requestLink({ email, invite });
      const payload = { ok: true, expiresAt };
      // Only echo the link back when there is no mailer — otherwise
      // the client would leak the token into browser storage / history.
      if (!mailerConfigured) payload.link = link;
      // Surface email delivery errors so the user knows it didn't work
      if (emailError) payload.emailError = emailError;
      res.json(payload);
    } catch (err) { next(err); }
  });

  router.get('/auth/verify', async (req, res, next) => {
    try {
      const token = String(req.query.token || '');
      const userAgent = req.headers['user-agent'] || '';
      const result = await auth.verifyLink({ token, userAgent });
      setSessionCookie(res, { token: result.sessionToken }, sessionSecret);
      const next_ = typeof req.query.next === 'string' && req.query.next.startsWith('/')
        ? req.query.next : '/';
      // If the caller wants JSON (e.g. an API client), return it. Browsers
      // that hit the link get a redirect.
      const accept = String(req.headers.accept || '');
      if (accept.includes('application/json')) {
        res.json({
          ok: true,
          participant: {
            participant_id: result.participant.participant_id,
            email: result.participant.email,
            role: result.participant.role,
            display_name: result.participant.display_name,
          },
          expires_at: result.expiresAt,
        });
      } else {
        res.redirect(302, next_);
      }
    } catch (err) { next(err); }
  });

  router.post('/auth/sign-out', (req, res) => {
    if (req.session?.session_id && req.session.session_id !== 'bootstrap') {
      auth.signOutSession(req.session.session_id);
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  router.get('/auth/me', (req, res) => {
    const participant = req.participant ?? null;
    res.json({
      authenticated: !!participant && !req.isBootstrapOwner,
      bootstrap: !!req.isBootstrapOwner,
      participant: participant ? {
        participant_id: participant.participant_id,
        email: participant.email,
        role: participant.role,
        display_name: participant.display_name,
      } : null,
    });
  });

  return router;
}

/**
 * POST /api/auth/login (username/password)
 *
 * TOGGLED OFF — controlled by FEATURE_FLAGS.passwordLogin.
 * When enabled, this endpoint accepts { email, password } and
 * validates against the password_hash column on participants.
 * Currently returns 404 (feature disabled).
 *
 * To enable:
 *   1. Set FEATURE_FLAGS.passwordLogin = true in featureFlags.js
 *   2. Add bcrypt import
 *   3. Uncomment the handler below
 */
/*
router.post('/auth/login', express.json(), async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  const participant = auth.findByEmail(email);
  if (!participant?.password_hash) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }
  const valid = await bcrypt.compare(password, participant.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }
  const result = auth.createSession(participant, req.headers['user-agent'] || '');
  setSessionCookie(res, { token: result.sessionToken }, sessionSecret);
  res.json({ ok: true, participant: { participant_id: participant.participant_id, email: participant.email, role: participant.role, display_name: participant.display_name } });
});
*/
