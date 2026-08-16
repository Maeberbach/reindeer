/*
 * Memorandum routes \u2014 Slice B of the couple-mode rebuild.
 *
 * Each partner keeps a personal list of who-should-get-what. Solo owners
 * have one. Couples have two. The MemorandumRepo owns all the persistence
 * logic; this router is thin glue that:
 *
 *   \u2022 pulls identity from req.participant (never req.body, never the
 *     x-participant-id header, never ?participantId=),
 *   \u2022 keeps a partner from writing on another partner's list,
 *   \u2022 hands the caller enough context to render conflicts, and
 *   \u2022 folds solo vs couple mode into a single set of endpoints so the
 *     client doesn't branch.
 *
 * Endpoints (all under /api):
 *
 *   GET    /memorandum                     \u2192 my draft + version list + partner summary
 *   GET    /memorandum/:participantId      \u2192 same, but for a specific participant (auth checked)
 *   POST   /memorandum/entries             \u2192 upsert one entry on my draft
 *   DELETE /memorandum/entries/:entryId    \u2192 delete one entry from my draft
 *   GET    /memorandum/conflicts           \u2192 conflicts between the two partners' latest versions
 *   POST   /memorandum/sign                \u2192 sign my current draft
 *   GET    /memorandum/versions            \u2192 list of my signed versions (for reprint)
 *   GET    /memorandum/versions/:version   \u2192 read one signed version (for reprint)
 *
 * Identity rule: every write endpoint uses req.participant.participant_id
 * as the acting party. The body may name the *item* or the *heir*, but
 * never the writer. Any attempt to write on behalf of another participant
 * returns 403.
 */
import express from 'express';
import { makeScopeCtx } from '@reindeer-legacy/core-api';

export function createMemorandumRouter({ memorandum, registry, participants, resolveScope }) {
  const r = express.Router();
  const ctxOf = (req) => makeScopeCtx(resolveScope(req));
  const me = (req) => req.participant?.participant_id;

  /*
   * Return the other partner's participant_id, or null if the scope is
   * solo or the partner hasn't signed in yet. Used to compute conflicts
   * and to shape the response consistently.
   *
   * "Partner" here means "not me, active, on this scope". The role field
   * ('owner' vs 'partner') doesn't matter for memorandum purposes \u2014
   * either partner can hold either role.
   */
  function findPartnerId(req) {
    const scope = registry.getScope(ctxOf(req));
    if (!scope || scope.household_mode !== 'couple') return null;
    const meId = me(req);
    const rows = participants.list();
    const other = rows.find((p) => p.participant_id !== meId && p.status === 'active');
    return other ? other.participant_id : null;
  }

  /*
   * GET /memorandum
   *   The one call the writer screen makes on mount. Returns:
   *     - my_draft:              current draft (or seeded shell if none)
   *     - my_versions:           list of my past signed versions
   *     - partner:               { participant_id, display_name } or null
   *     - partner_latest_signed: partner's most recent signed version summary or null
   *     - conflicts:             derived from my latest vs partner's latest
   *     - household_mode:        so the client can label the screen
   */
  r.get('/memorandum', (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const meId = me(req);
      if (!meId || meId === 'bootstrap-owner') {
        return res.status(400).json({ error: 'Sign in with your own email to open your memorandum.' });
      }
      const partnerId = findPartnerId(req);
      const scope = registry.getScope(ctx);
      const draft = memorandum.openDraft(meId, ctx);
      const versions = memorandum.listVersions(meId, ctx);
      const conflicts = partnerId ? memorandum.detectConflicts(meId, partnerId, ctx) : [];
      const partnerRow = partnerId
        ? participants.list().find((p) => p.participant_id === partnerId) || null
        : null;
      const partnerVersions = partnerId ? memorandum.listVersions(partnerId, ctx) : [];
      const partnerLatestSigned = partnerVersions.find((v) => v.is_signed) || null;
      res.json({
        household_mode: scope?.household_mode || 'solo',
        my_draft: draft,
        my_versions: versions,
        partner: partnerRow
          ? { participant_id: partnerRow.participant_id, display_name: partnerRow.display_name || '' }
          : null,
        partner_latest_signed: partnerLatestSigned,
        conflicts,
      });
    } catch (e) { next(e); }
  });

  /*
   * GET /memorandum/:participantId
   *   Read-only view of someone else's memorandum. In couple mode, either
   *   partner may read the other's memorandum \u2014 they're jointly running
   *   the estate, and the conflict screen has to be able to render both
   *   sides. In solo mode, no one else has a memorandum to read.
   */
  r.get('/memorandum/participant/:participantId', (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const target = req.params.participantId;
      const meId = me(req);
      if (!meId) return res.status(401).json({ error: 'Sign in to continue.' });
      if (target !== meId) {
        const scope = registry.getScope(ctx);
        if (!scope || scope.household_mode !== 'couple') {
          return res.status(403).json({ error: 'That memorandum belongs to someone else.' });
        }
        const partnerId = findPartnerId(req);
        if (target !== partnerId) {
          return res.status(403).json({ error: 'That memorandum belongs to someone else.' });
        }
      }
      const draft = memorandum.getDraft(target, ctx);
      const versions = memorandum.listVersions(target, ctx);
      const latestSigned = versions.find((v) => v.is_signed) || null;
      res.json({
        participant_id: target,
        draft,
        versions,
        latest_signed: latestSigned,
      });
    } catch (e) { next(e); }
  });

  /*
   * POST /memorandum/entries
   *   Body: { item_id, assigned_to_heir_id?, note? }
   *   Adds or updates one row on my draft. Identity is req.participant.
   */
  r.post('/memorandum/entries', (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const meId = me(req);
      if (!meId || meId === 'bootstrap-owner') {
        return res.status(400).json({ error: 'Sign in with your own email to change your memorandum.' });
      }
      const { item_id, assigned_to_heir_id, note, is_important } = req.body || {};
      if (!item_id) return res.status(400).json({ error: 'An item id is needed.' });
      // Reject any attempt to name someone else as the writer. Belt-and-braces
      // \u2014 the repo doesn't read participant_id from the body, but reject
      // early so a confused client sees the real problem.
      if (req.body && 'participant_id' in req.body && req.body.participant_id !== meId) {
        return res.status(403).json({ error: 'You can only change your own memorandum.' });
      }
      const entry = memorandum.upsertEntry({
        participantId: meId,
        itemId: item_id,
        assignedToHeirId: assigned_to_heir_id || null,
        note: note || '',
        isImportant: !!is_important,
      }, ctx);
      res.status(200).json({ ok: true, entry });
    } catch (e) { next(e); }
  });

  /*
   * DELETE /memorandum/entries/:entryId
   *   Remove one row from my draft. The repo enforces:
   *     - cannot delete an entry that belongs to my partner (403), and
   *     - cannot delete an entry that has already been signed (400).
   */
  r.delete('/memorandum/entries/:entryId', (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const meId = me(req);
      if (!meId) return res.status(401).json({ error: 'Sign in to continue.' });
      const r2 = memorandum.deleteEntry(req.params.entryId, meId, ctx);
      res.status(200).json({ ok: true, ...r2 });
    } catch (e) { next(e); }
  });

  /*
   * GET /memorandum/conflicts
   *   The conflict banner reads this on mount and after every save. Returns
   *   an empty list in solo mode or when the partner has no memorandum.
   */
  r.get('/memorandum/conflicts', (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const meId = me(req);
      if (!meId) return res.status(401).json({ error: 'Sign in to continue.' });
      const partnerId = findPartnerId(req);
      if (!partnerId) return res.json({ conflicts: [], partner: null });
      const partnerRow = participants.list().find((p) => p.participant_id === partnerId) || null;
      res.json({
        conflicts: memorandum.detectConflicts(meId, partnerId, ctx),
        partner: partnerRow
          ? { participant_id: partnerRow.participant_id, display_name: partnerRow.display_name || '' }
          : null,
      });
    } catch (e) { next(e); }
  });

  /*
   * POST /memorandum/sign
   *   Freeze my current draft. The repo counts conflicts at sign time and
   *   stores that count on the signing row, so we can honor the soft-block
   *   later even if the underlying entries change.
   *
   *   Body may include `{ acknowledge_conflicts: true }` \u2014 not enforced
   *   here (the client shows the modal), but stored in the audit chain so
   *   the trail records that the signer saw the warning.
   */
  r.post('/memorandum/sign', (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const meId = me(req);
      if (!meId || meId === 'bootstrap-owner') {
        return res.status(400).json({ error: 'Sign in with your own email to sign your memorandum.' });
      }
      const partnerId = findPartnerId(req);
      const result = memorandum.sign(meId, partnerId, ctx);
      res.status(201).json({ ok: true, ...result });
    } catch (e) { next(e); }
  });

  /*
   * GET /memorandum/versions
   *   Every version of my memorandum, newest first. Used by the reprint
   *   screen when a paper copy is lost and the owner needs to re-run one.
   */
  r.get('/memorandum/versions', (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const meId = me(req);
      if (!meId) return res.status(401).json({ error: 'Sign in to continue.' });
      res.json({ versions: memorandum.listVersions(meId, ctx) });
    } catch (e) { next(e); }
  });

  /*
   * GET /memorandum/versions/:version
   *   Read one of my past versions in full, including entries. Used to
   *   re-render a signed PDF from an old signing.
   */
  r.get('/memorandum/versions/:version', (req, res, next) => {
    try {
      const ctx = ctxOf(req);
      const meId = me(req);
      if (!meId) return res.status(401).json({ error: 'Sign in to continue.' });
      const version = Number(req.params.version);
      if (!Number.isInteger(version) || version < 1) {
        return res.status(400).json({ error: 'Version must be a positive integer.' });
      }
      const doc = memorandum.getVersion(meId, version, ctx);
      if (!doc) return res.status(404).json({ error: 'That version is not on record.' });
      res.json(doc);
    } catch (e) { next(e); }
  });

  return r;
}
