import fs from 'node:fs';
import express from 'express';
import { makeScopeCtx } from '@reindeer/core-api';

/**
 * Two-Output Delivery Model routes.
 *
 * Mounted at `/api/two-outputs`. Purpose-built for the addendum flow and
 * inventory preview \u2014 the existing `/api/delivery/*` routes continue to
 * drive the .reindeer bundle path unchanged.
 *
 * Heirs and wills caretakers get their own thin CRUD here so the addendum
 * has a roster to point at. Item assignment is handled by the intake
 * router's PATCH /items/:id/assign \u2014 that's the piece the app already had a
 * canonical writer for.
 */
export function createTwoOutputsRouter({ heirs, willsCaretakers, twoOutputs, addendumVersions, resolveScope }) {
  const r = express.Router();
  const ctxOf = (req) => makeScopeCtx(resolveScope(req));
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  /* ---- heirs ------------------------------------------------------------ */
  r.get('/heirs', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const list = heirs.list(ctx);
    const counts = heirs.counts(ctx);
    res.json({ heirs: list.map((h) => ({ ...h, item_count: counts.get(h.heir_id) ?? 0 })) });
  }));
  r.post('/heirs', wrap(async (req, res) => res.status(201).json(heirs.create(req.body ?? {}, ctxOf(req)))));
  r.patch('/heirs/:id', wrap(async (req, res) => res.json(heirs.update(req.params.id, req.body ?? {}, ctxOf(req)))));
  r.delete('/heirs/:id', wrap(async (req, res) => res.json(heirs.remove(req.params.id, ctxOf(req)))));

  /* ---- wills caretakers -------------------------------------------------- */
  r.get('/wills-caretakers', wrap(async (req, res) => res.json({ wills_caretakers: willsCaretakers.list(ctxOf(req)) })));
  r.post('/wills-caretakers', wrap(async (req, res) => res.status(201).json(willsCaretakers.create(req.body ?? {}, ctxOf(req)))));
  r.patch('/wills-caretakers/:id', wrap(async (req, res) => res.json(willsCaretakers.update(req.params.id, req.body ?? {}, ctxOf(req)))));
  r.delete('/wills-caretakers/:id', wrap(async (req, res) => res.json(willsCaretakers.remove(req.params.id, ctxOf(req)))));

  /* ---- inventory --------------------------------------------------------- */
  r.get('/inventory/preview', wrap(async (req, res) => {
    const out = await twoOutputs.previewInventory({ trusteeId: req.query.trustee_id || null }, ctxOf(req));
    res.json(out);
  }));
  r.post('/inventory/write', wrap(async (req, res) => {
    const out = await twoOutputs.writeInventory({
      trusteeId: req.body?.trustee_id || null,
      trigger: req.body?.trigger || 'manual_test',
    }, ctxOf(req));
    res.status(201).json({
      bundle_path: out.bundlePath,
      file_name: out.fileName,
      envelope_sha256: out.envelopeSha256,
      counts: out.manifest.counts,
    });
  }));

  /* ---- addendum ---------------------------------------------------------- */
  r.get('/addendum/preview', wrap(async (req, res) => {
    const owner = req.query.owner_participant_id;
    if (!owner) return res.status(400).json({ error: 'owner_participant_id is required' });
    const out = await twoOutputs.previewAddendum({
      ownerParticipantId: owner,
      recipientCaretakerIds: parseIds(req.query.caretaker_ids),
      trusteeId: req.query.trustee_id || null,
    }, ctxOf(req));
    res.json(out);
  }));

  r.post('/addendum/sign', wrap(async (req, res) => {
    const body = req.body ?? {};
    if (!body.owner_participant_id) return res.status(400).json({ error: 'owner_participant_id is required' });
    if (!body.signature) return res.status(400).json({ error: 'signature is required' });
    const out = await twoOutputs.signAndWriteAddendum({
      ownerParticipantId: body.owner_participant_id,
      signature: body.signature,
      recipientCaretakerIds: body.caretaker_ids ?? [],
      trusteeId: body.trustee_id ?? null,
      voiceMediaId: body.voice_media_id ?? null,
    }, ctxOf(req));
    res.status(201).json({
      version_id: out.version.version_id,
      version_number: out.version.version_number,
      supersedes_version: out.version.supersedes_version,
      signed_at: out.version.signed_at,
      envelope_sha256: out.envelopeSha256,
      bundle_path: out.bundlePath,
      file_name: out.fileName,
      counts: out.manifest.counts,
    });
  }));

  r.get('/addendum/versions', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const owner = req.query.owner_participant_id ?? null;
    res.json({ versions: addendumVersions.list(ctx, owner) });
  }));

  r.get('/addendum/versions/:id', wrap(async (req, res) => {
    const v = addendumVersions.get(req.params.id, ctxOf(req));
    if (!v) return res.status(404).json({ error: 'That signed addendum is not on file.' });
    res.json({ version: v });
  }));

  r.post('/addendum/email-preview', wrap(async (req, res) => {
    const body = req.body ?? {};
    if (!body.owner_participant_id) return res.status(400).json({ error: 'owner_participant_id is required' });
    if (!body.caretaker_id) return res.status(400).json({ error: 'caretaker_id is required' });
    const out = await twoOutputs.sendUnsignedPreviewEmail({
      ownerParticipantId: body.owner_participant_id,
      caretakerId: body.caretaker_id,
    }, ctxOf(req));
    res.status(200).json(out);
  }));

  r.get('/addendum/versions/:id/file', wrap(async (req, res) => {
    const v = addendumVersions.get(req.params.id, ctxOf(req));
    if (!v || !v.bundle_path) return res.status(404).send('That addendum bundle is not on file.');
    if (!fs.existsSync(v.bundle_path)) return res.status(410).send('That addendum bundle is no longer on disk.');
    res.download(v.bundle_path);
  }));

  return r;
}

function parseIds(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}
