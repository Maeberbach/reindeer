/*
 * Household link ceremony.
 *
 * Slice 3 gave the Registry two claim tables (memorandum + importance)
 * that behave differently depending on scope.household_mode. Solo mode
 * auto-agrees importance flags at insert time; couple mode leaves them
 * as 'proposed' until the other partner reviews. This router is the one
 * place that flips a scope from 'solo' to 'couple' and back.
 *
 * Design
 *   - The invite itself is not new. `POST /api/auth/request-link` with
 *     `{ email, invite: { scopeId, role: 'partner' } }` already mints a
 *     magic link that upserts the partner as an authenticated participant
 *     on the scope. That path stays exactly as it was.
 *   - The link ceremony is a *second* act, after the partner has signed
 *     in at least once. Either partner can call `POST /household-link/confirm`
 *     to flip the scope to couple mode. This mirrors real relationships:
 *     the invited partner has to make an authenticated act (sign in) before
 *     their consent counts.
 *   - Either partner can unlink at any time. Unlink drops the scope back
 *     to solo mode but leaves the claim tables intact so the audit trail
 *     of who tagged what and when is preserved. Solo mode simply ignores
 *     the tables at read time.
 *
 * Identity is always taken from `req.participant.participant_id`. No body
 * field ever supplies an identity; only routable targets (like the email
 * to invite) come from the body.
 */
import express from 'express';
import { makeScopeCtx } from '@reindeer/core-api';

function ownerOnly(req, res, next) {
  const p = req.participant;
  if (!p) return res.status(401).json({ error: 'Sign in to continue.' });
  if (p.participant_id === 'bootstrap-owner') return next();
  if (p.role === 'owner') return next();
  return res.status(403).json({ error: 'Only the owner can invite a co-owner.' });
}

/**
 * Owner OR any active partner can invite and manage helpers (assistants).
 * This keeps control of guest helpers with the first logged-in owner and
 * any partner they have linked. Assistants themselves cannot invite others.
 */
function ownerOrPartner(req, res, next) {
  const p = req.participant;
  if (!p) return res.status(401).json({ error: 'Sign in to continue.' });
  if (p.participant_id === 'bootstrap-owner') return next();
  if (p.role === 'owner' || p.role === 'partner') return next();
  return res.status(403).json({ error: 'Only the owner or a partner can manage helpers.' });
}

export function createHouseholdLinkRouter({ registry, participants, auth, resolveScope }) {
  const r = express.Router();
  const ctxOf = (req) => makeScopeCtx(resolveScope(req));
  const me = (req) => req.participant?.participant_id;

  /*
   * GET /household-link
   *   Reports the current state of the ceremony so the client can render
   *   the right screen. Every field the household-link UI needs is here;
   *   the client should not call scope-summary AND this endpoint on the
   *   same screen.
   *
   * Response shape:
   *   {
   *     scope_id, household_mode,
   *     participants: [{ participant_id, email, display_name, role, is_me }],
   *     partner_present: boolean,      // >=1 partner participant exists
   *     can_confirm: boolean,          // caller may POST /confirm
   *     can_unlink: boolean,           // caller may POST /unlink
   *     linked_at, linked_by_participant_id, linked_household_id,
   *   }
   */
  r.get('/household-link', (req, res) => {
    const ctx = ctxOf(req);
    const scope = registry.getScope(ctx);
    if (!scope) return res.status(404).json({ error: 'Scope not found.' });
    const rows = participants.list();
    const meId = me(req);
    const list = rows.map((p) => ({
      participant_id: p.participant_id,
      email: p.email,
      display_name: p.display_name || '',
      role: p.role,
      is_me: p.participant_id === meId,
    }));
    // Bootstrap owner is synthesized by the middleware, not stored in the
    // participants table. Include them in the list so the client can detect
    // ownership and show the invite form instead of the "not yet linked" gate.
    if (meId === 'bootstrap-owner' && !list.some((p) => p.is_me)) {
      list.unshift({
        participant_id: 'bootstrap-owner',
        email: '',
        display_name: '',
        role: 'owner',
        is_me: true,
      });
    }
    const partners = rows.filter((p) => p.role === 'partner' && p.status === 'active')
      .map((p) => ({ participant_id: p.participant_id, email: p.email, display_name: p.display_name || '' }));
    const partnerPresent = partners.length > 0;
    const assistants = rows.filter((p) => p.role === 'assistant' && p.status === 'active')
      .map((p) => ({ participant_id: p.participant_id, email: p.email, display_name: p.display_name || '' }));
    // Pending invites — invited but not yet signed in (status='invited' or 'invited-assistant')
    const pendingInvites = rows
      .filter((p) => p.status === 'invited' || p.status === 'invited-assistant')
      .map((p) => ({
        participant_id: p.participant_id,
        email: p.email,
        display_name: p.display_name || '',
        role: p.role === 'invited-assistant' ? 'assistant' : p.role,
        status: p.status,
      }));
    const alreadyCouple = scope.household_mode === 'couple';
    res.json({
      scope_id: scope.scope_id,
      household_mode: scope.household_mode || 'solo',
      linked_at: scope.linked_at || null,
      linked_by_participant_id: scope.linked_by_participant_id || null,
      linked_household_id: scope.linked_household_id || null,
      participants: list,
      partner_present: partnerPresent,
      partners,
      can_confirm: !alreadyCouple && partnerPresent,
      can_unlink: alreadyCouple,
      assistants,
      pending_invites: pendingInvites,
    });
  });

  /*
   * POST /household-link/invite
   *   Owner-only. Thin wrapper around the existing auth invite path so
   *   the client has one purpose-built endpoint to mint a partner invite.
   *   Body: { email }. Returns { link, expires_at }.
   */
  r.post('/household-link/invite', async (req, res, next) => {
    // Permission depends on the role being invited:
    //   partner  → owner only (adding a co-owner is a bigger decision)
    //   assistant → owner or any partner (helpers are day-to-day help)
    const { role: requestedRole } = req.body || {};
    const role = (requestedRole === 'assistant') ? 'assistant' : 'partner';
    if (role === 'partner') {
      return ownerOnly(req, res, next);
    }
    return ownerOrPartner(req, res, next);
  }, async (req, res, next) => {
    try {
      const { email, display_name: partnerNameSuggestion, role: requestedRole } = req.body || {};
      const role = (requestedRole === 'assistant') ? 'assistant' : 'partner';
      // Soft partner limit — the owner can invite up to 5 partners by default.
      // The limit is advisory, not a hard schema constraint, so a future
      // config could raise it without a migration.
      const MAX_PARTNERS = 1;
      if (role === 'partner') {
        const activePartners = participants.list()
          .filter((p) => p.role === 'partner' && p.status === 'active').length;
        const invitedPartners = participants.list()
          .filter((p) => (p.role === 'invited' || p.role === 'partner') && p.status === 'invited').length;
        if (activePartners + invitedPartners >= MAX_PARTNERS) {
          return res.status(400).json({
            error: `You can invite up to ${MAX_PARTNERS} co-owner. To add more, contact support.`,
          });
        }
      }
      if (role === 'assistant') {
        const MAX_ASSISTANTS = 10;
        const activeAssistants = participants.list()
          .filter((p) => p.role === 'assistant' && p.status === 'active').length;
        const invitedAssistants = participants.list()
          .filter((p) => p.role === 'invited-assistant' && p.status === 'invited').length;
        if (activeAssistants + invitedAssistants >= MAX_ASSISTANTS) {
          return res.status(400).json({
            error: `You can invite up to ${MAX_ASSISTANTS} helpers. To add more, contact support.`,
          });
        }
      }
      if (!email || typeof email !== 'string') {
        return res.status(400).json({ error: 'An email address is needed.' });
      }
      const scope = registry.getScope(ctxOf(req));
      const scopeId = scope?.scope_id || 'inventory-default';
      const { link, expiresAt, emailError } = await auth.requestLink({
        email,
        invite: { scopeId, role },
      });
      // If the owner told us how the partner likes to be called, park the
      // name on a placeholder participant now (role='invited',
      // status='invited'). That status does NOT satisfy partner_present
      // (which requires status='active'), so it cannot be used to fake a
      // confirm without the invitee authenticating. When the invitee later
      // signs in via their magic link the auth path calls upsertByEmail
      // with role='partner' status='active', which now correctly promotes
      // the placeholder without clobbering the name.
      const suggested = String(partnerNameSuggestion ?? '').trim();
      if (suggested) {
        const existing = participants.findByEmail?.(email);
        if (existing) {
          participants.updateDisplayName?.(existing.participant_id, suggested);
        } else if (participants.upsertByEmail) {
          participants.upsertByEmail({
            email, displayName: suggested, role: role === 'assistant' ? 'invited-assistant' : 'invited', status: 'invited',
            householdScopeId: scopeId,
          });
        }
      }
      // link is null in production when a real mailer sent it; only echoed
      // back in tests / REINDEER_MAILER_OFF=1 mode.
      res.status(201).json({ ok: true, link, expires_at: expiresAt, emailError: emailError || null });
    } catch (e) { next(e); }
  });

  /*
   * POST /household-link/confirm
   *   Either partner. Preconditions:
   *     1. At least one participant with role='partner' AND status='active'
   *        exists on the scope (i.e. the invited co-owner has signed in).
   *     2. The scope is not already in couple mode.
   *   On success, flips household_mode to 'couple' and records who did it.
   */
  r.post('/household-link/confirm', (req, res) => {
    const ctx = ctxOf(req);
    const scope = registry.getScope(ctx);
    if (!scope) return res.status(404).json({ error: 'Scope not found.' });
    if (scope.household_mode === 'couple') {
      return res.status(200).json({ ok: true, already_linked: true, scope: publicScope(scope) });
    }
    const rows = participants.list();
    const partnerPresent = rows.some((p) => p.role === 'partner' && p.status === 'active');
    const assistants = rows.filter((p) => p.role === 'assistant' && p.status === 'active')
      .map((p) => ({ participant_id: p.participant_id, email: p.email, display_name: p.display_name || '' }));
    if (!partnerPresent) {
      return res.status(400).json({
        error: 'Both partners need to be on this Registry before you can link. Invite your co-owner and ask them to sign in first.',
      });
    }
    const meId = me(req);
    if (!meId || meId === 'bootstrap-owner') {
      return res.status(400).json({
        error: 'Sign in with your own email before confirming the link. The link ceremony records who confirmed it.',
      });
    }
    // Optional: the confirming partner may set (or override) their own
    // display name at this moment. This is how the app learns Bob is Bob
    // rather than showing his raw email in the "Linked with" line. If the
    // client didn't send a name, we keep whatever's already on file.
    const myName = String(req.body?.display_name ?? '').trim();
    if (myName && participants.updateDisplayName) {
      participants.updateDisplayName(meId, myName);
    }
    const updated = registry.linkHousehold(ctx, { linkedByParticipantId: meId });
    res.status(200).json({ ok: true, scope: publicScope(updated) });
  });

  /**
   * POST /household-link/revoke
   *   Owner or partner. Removes a pending invite (status='invited' or
   *   'invited-assistant') so it no longer shows in the pending list.
   *   If the participant already signed in (status='active'), returns 400
   *   — they're a real participant now and must be unlinked instead.
   */
  r.post('/household-link/revoke', ownerOrPartner, (req, res, next) => {
    try {
      const { participant_id } = req.body || {};
      if (!participant_id) return res.status(400).json({ error: 'A participant id is needed.' });
      const p = participants.get(participant_id);
      if (!p) return res.status(404).json({ error: 'That person is not on this Registry.' });
      if (p.status !== 'invited' && p.status !== 'invited-assistant') {
        return res.status(400).json({ error: 'That person has already signed in. You can unlink instead.' });
      }
      // Delete the pending invite — they haven't signed in yet so there's
      // nothing to preserve.
      db.prepare('DELETE FROM participants WHERE participant_id = ?').run(participant_id);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  /*
   * POST /household-link/unlink
   *   Either partner. Idempotent. Returns the scope back to solo mode.
   *   Claim rows are preserved; solo mode simply ignores them.
   */
  r.post('/household-link/unlink', (req, res) => {
    const ctx = ctxOf(req);
    const scope = registry.getScope(ctx);
    if (!scope) return res.status(404).json({ error: 'Scope not found.' });
    if (scope.household_mode !== 'couple') {
      return res.status(200).json({ ok: true, already_solo: true, scope: publicScope(scope) });
    }
    const meId = me(req);
    const updated = registry.unlinkHousehold(ctx, { unlinkedByParticipantId: meId });
    res.status(200).json({ ok: true, scope: publicScope(updated) });
  });

  return r;
}

function publicScope(s) {
  if (!s) return null;
  return {
    scope_id: s.scope_id,
    household_mode: s.household_mode || 'solo',
    linked_household_id: s.linked_household_id || null,
    linked_at: s.linked_at || null,
    linked_by_participant_id: s.linked_by_participant_id || null,
  };
}
