import express from 'express';
import { ReindeerError, makeScopeCtx } from '@reindeer/core-api';

/**
 * Execution: the signed original, and who says they are holding it.
 *
 * Why this exists as its own surface. Everything else in this app is a record
 * the owner keeps for themselves. This is the one place the app touches a
 * document intended to have legal effect, and the law is unhelpfully specific
 * about it: the federal ESIGN Act and the state Uniform Electronic Transactions
 * Act both exclude wills, codicils and testamentary trusts from electronic
 * signing. A memorandum of tangible personal property takes effect through the
 * will that refers to it, so it inherits that exclusion. There is deliberately
 * no way to sign anything inside this app.
 *
 * What the app can usefully do instead is the boring, valuable part: prove the
 * signing happened, capture what was signed, and record where the paper went.
 * So we store three things.
 *
 *   1. A photograph or scan of the signed page. This is evidence, never the
 *      operative document.
 *   2. Where the owner says the signed original is kept. This matters more than
 *      it sounds: where an original was last known to be with the owner and is
 *      not found after death, a court may presume it was destroyed on purpose
 *      and treat it as revoked. A scan does not cure that; knowing which drawer
 *      it is in does.
 *   3. An attestation from the trustee or attorney confirming they have seen
 *      or hold the signed original. That is the chain of custody a copy cannot
 *      supply on its own.
 *
 * Storage note: this rides on the existing scope_media table rather than a new
 * one, so no migration is required and FairPlay's database is untouched. The
 * scan is a genuine media file; the surrounding facts live as JSON in the
 * transcript column.
 */

const KIND = 'signed_memorandum';
const STATEMENT_KIND = 'execution_statement';

const readMeta = (row) => {
  try { return JSON.parse(row?.transcript || '{}') || {}; } catch { return {}; }
};

const shape = (row) => {
  if (!row) return null;
  const meta = readMeta(row);
  return {
    media_id: row.media_id,
    captured_at: row.created_at,
    mime_type: row.mime_type,
    byte_size: row.byte_size,
    sha256: row.sha256,
    signed_on: meta.signed_on ?? null,
    original_location: meta.original_location ?? '',
    superseded: !!meta.superseded,
    attestations: Array.isArray(meta.attestations) ? meta.attestations : [],
    statement: meta.statement ?? null,
    participant_id: meta.participant_id ?? null,
  };
};

/**
 * deps: { db, scopeMediaStore, itemRepo, audit, resolveScope }
 */
export function createExecutionRouter({ db, scopeMediaStore, audit, resolveScope }) {
  const r = express.Router();
  const ctxOf = (req) => makeScopeCtx(resolveScope(req));
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  const rows = (ctx, participantId) => {
    const all = db.prepare(
      'SELECT * FROM scope_media WHERE scope_id = ? AND media_kind = ? ORDER BY created_at DESC',
    ).all(ctx.scopeId, KIND);
    if (!participantId) return all;
    return all.filter((row) => readMeta(row).participant_id === participantId);
  };

  const current = (ctx, participantId) => rows(ctx, participantId).find((row) => !readMeta(row).superseded) ?? null;

  const writeMeta = (mediaId, ctx, meta) => {
    db.prepare('UPDATE scope_media SET transcript = ? WHERE media_id = ? AND scope_id = ?')
      .run(JSON.stringify(meta), mediaId, ctx.scopeId);
  };

  const rowOf = (mediaId, ctx) => db.prepare(
    'SELECT * FROM scope_media WHERE media_id = ? AND scope_id = ? AND media_kind = ?',
  ).get(mediaId, ctx.scopeId, KIND);

  // What is the signing state of this registry?
  const me = (req) => req.participant?.participant_id;

  r.get('/execution', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const myId = me(req);
    const row = current(ctx, myId);
    res.json({
      signed: !!row,
      record: shape(row),
      history: rows(ctx, myId).map(shape),
      // Restated on every response so a client cannot drift away from it.
      electronic_signature_available: false,
      reason: 'Wills and the writings that take effect through them are excluded from the ESIGN Act and from state electronic-transaction law. The page has to be signed by hand.',
    });
  }));

  // The owner photographs or scans the page they have just signed in ink.
  // Any earlier scan is marked superseded rather than deleted, because a
  // replaced memorandum is itself a fact worth being able to show.
  r.post('/execution/scan', express.raw({ type: '*/*', limit: '25mb' }), wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const myId = me(req);
    if (!req.body || !req.body.length) {
      throw new ReindeerError('No photograph of the signed page was received. Please try taking it again.', 'NO_IMAGE', 400);
    }
    const mime = req.get('content-type') || 'image/jpeg';
    if (!/^image\//.test(mime) && mime !== 'application/pdf') {
      throw new ReindeerError('That file is not a photograph or a scan. Please take a picture of the signed page.', 'BAD_MEDIA', 400);
    }

    // Only supersede THIS participant's previous scans, not the partner's.
    for (const row of rows(ctx, myId)) {
      const meta = readMeta(row);
      if (!meta.superseded) writeMeta(row.media_id, ctx, { ...meta, superseded: true, superseded_at: new Date().toISOString() });
    }

    const meta = {
      signed_on: (req.query.signed_on || '').toString().slice(0, 40) || null,
      original_location: (req.query.original_location || '').toString().slice(0, 300),
      attestations: [],
      participant_id: myId,
    };
    const saved = await scopeMediaStore.put(req.body, {
      media_kind: KIND,
      mime_type: mime,
      title: 'Signed memorandum of tangible personal property',
      transcript: JSON.stringify(meta),
    }, ctx);

    await audit.append({
      action: 'execution.scan', entity: 'scope', entity_id: ctx.scopeId,
      payload: { media_id: saved.media_id, sha256: saved.sha256, signed_on: meta.signed_on },
    }, ctx);

    res.status(201).json({ ...shape(rowOf(saved.media_id, ctx)) });
  }));

  // Where the paper itself lives. Editable on its own, because people move it.
  r.patch('/execution/:mediaId', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const row = rowOf(req.params.mediaId, ctx);
    if (!row) return res.status(404).json({ error: 'That signed page is not on file.' });
    const meta = readMeta(row);
    if (req.body.original_location !== undefined) meta.original_location = String(req.body.original_location).slice(0, 300);
    if (req.body.signed_on !== undefined) meta.signed_on = String(req.body.signed_on).slice(0, 40) || null;
    writeMeta(row.media_id, ctx, meta);
    await audit.append({ action: 'execution.update', entity: 'scope', entity_id: ctx.scopeId, payload: { media_id: row.media_id } }, ctx);
    res.json(shape(rowOf(row.media_id, ctx)));
  }));

  r.get('/execution/scan/:mediaId', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    if (!rowOf(req.params.mediaId, ctx)) return res.status(404).end();
    const p = scopeMediaStore.getPath(req.params.mediaId, ctx);
    if (!p) return res.status(404).end();
    res.sendFile(p);
  }));

  /**
   * The trustee or attorney confirms the signing.
   *
   * Deliberately narrow. They are not signing anything and they are not
   * approving the contents; they are stating, on a date, that they have seen or
   * are holding the signed original. Anything more would be the app inventing a
   * legal role for itself.
   */
  r.post('/execution/:mediaId/attest', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const row = rowOf(req.params.mediaId, ctx);
    if (!row) return res.status(404).json({ error: 'That signed page is not on file.' });

    const name = String(req.body.name || '').trim();
    const role = String(req.body.role || 'trustee').trim().toLowerCase();
    const holds = String(req.body.holds || '').trim();

    if (!name) throw new ReindeerError('Please give the name of the person confirming.', 'NO_NAME', 400);
    const ROLES = ['trustee', 'captain', 'executor', 'attorney', 'other'];
    if (!ROLES.includes(role)) throw new ReindeerError(`Role must be one of: ${ROLES.join(', ')}.`, 'BAD_ROLE', 400);
    const HOLDS = ['holds_original', 'seen_original', 'copy_only'];
    if (!HOLDS.includes(holds)) {
      throw new ReindeerError('Please say whether the original is held, has been seen, or only a copy was received.', 'BAD_HOLDS', 400);
    }

    const meta = readMeta(row);
    meta.attestations = Array.isArray(meta.attestations) ? meta.attestations : [];
    const entry = {
      name,
      role,
      email: String(req.body.email || '').trim().slice(0, 200),
      firm: String(req.body.firm || '').trim().slice(0, 200),
      holds,
      note: String(req.body.note || '').trim().slice(0, 600),
      confirmed_at: new Date().toISOString(),
    };
    meta.attestations.push(entry);
    writeMeta(row.media_id, ctx, meta);

    await audit.append({
      action: 'execution.attest', entity: 'scope', entity_id: ctx.scopeId,
      payload: { media_id: row.media_id, name: entry.name, role: entry.role, holds: entry.holds },
    }, ctx);

    res.status(201).json(shape(rowOf(row.media_id, ctx)));
  }));

  /**
   * The owner, in their own voice, at the moment of signing.
   *
   * This is not a will and cannot become one. A recording on its own fails the
   * writing-and-signature formalities everywhere except a handful of narrow
   * deathbed exceptions. But as corroboration it is unusually strong, and it is
   * the part of this app that a probate court or a trust officer is most likely
   * to find persuasive: it speaks to intent, to mental capacity, to the absence
   * of anyone standing over the person, and to identity. Indiana has written
   * exactly that list into statute, and Louisiana provides for admitting a
   * recording of an execution by name.
   *
   * Admission is still discretionary and needs a foundation, so we store what a
   * foundation needs: an unedited single file, its hash, and its timestamp.
   */
  r.post('/execution/:mediaId/statement', express.raw({ type: '*/*', limit: '25mb' }), wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const row = rowOf(req.params.mediaId, ctx);
    if (!row) return res.status(404).json({ error: 'Photograph the signed page first, then record.' });
    if (!req.body || !req.body.length) throw new ReindeerError('No recording was received. Please try again.', 'NO_MEDIA', 400);

    const mime = req.get('content-type') || 'audio/webm';
    if (!/^(audio|video)\//.test(mime)) throw new ReindeerError('That file is not a recording.', 'BAD_MEDIA', 400);

    const saved = await scopeMediaStore.put(req.body, {
      media_kind: STATEMENT_KIND,
      mime_type: mime,
      title: 'Spoken statement made when signing',
      transcript: JSON.stringify({ for_media_id: row.media_id }),
    }, ctx);

    const meta = readMeta(row);
    meta.statement = {
      media_id: saved.media_id,
      mime_type: mime,
      sha256: saved.sha256,
      byte_size: saved.byte_size,
      duration_ms: req.query.duration_ms ? Number(req.query.duration_ms) : null,
      recorded_at: new Date().toISOString(),
      participant_id: me(req),
    };
    writeMeta(row.media_id, ctx, meta);

    await audit.append({
      action: 'execution.statement', entity: 'scope', entity_id: ctx.scopeId,
      payload: { media_id: saved.media_id, for_media_id: row.media_id, sha256: saved.sha256 },
    }, ctx);

    res.status(201).json(shape(rowOf(row.media_id, ctx)));
  }));

  r.get('/execution/statement/:mediaId', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const p = scopeMediaStore.getPath(req.params.mediaId, ctx);
    if (!p) return res.status(404).end();
    res.sendFile(p);
  }));

  return r;
}
