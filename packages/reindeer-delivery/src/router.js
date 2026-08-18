import fs from 'node:fs';
import express from 'express';
import { makeScopeCtx } from '@reindeer-legacy/core-api';

/**
 * Delivery routes. Two-step by design: prepare, then confirm and send.
 */
export function createDeliveryRouter({ delivery, trustees, resolveScope }) {
  const r = express.Router();
  const ctxOf = (req) => makeScopeCtx(resolveScope(req));
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  // --- trustees -------------------------------------------------------------
  r.get('/trustees', wrap(async (req, res) => res.json({ trustees: trustees.list(ctxOf(req)) })));
  r.post('/trustees', wrap(async (req, res) => res.status(201).json(await trustees.create(req.body, ctxOf(req)))));
  r.patch('/trustees/:id', wrap(async (req, res) => res.json(await trustees.update(req.params.id, req.body, ctxOf(req)))));
  r.delete('/trustees/:id', wrap(async (req, res) => res.json(await trustees.remove(req.params.id, ctxOf(req)))));

  // --- delivery -------------------------------------------------------------
  // Build the package and show the owner exactly what is about to be sent.
  r.post('/delivery/prepare', wrap(async (req, res) => {
    res.status(201).json(await delivery.prepare({
      query: req.body?.query,
      trusteeIds: req.body?.trustee_ids ?? [],
      forceLink: req.body?.force_link === true,
    }, ctxOf(req)));
  }));

  // The printable cover packet, on screen before it is sent.
  r.get('/delivery/:id/packet', wrap(async (req, res) => {
    const d = delivery.getDelivery(req.params.id, ctxOf(req));
    if (!d) return res.status(404).send('That package was not found.');
    const p = delivery.packetPath(d);
    if (!fs.existsSync(p)) return res.status(404).send('The cover packet is no longer on disk.');
    res.type('html').send(fs.readFileSync(p, 'utf8'));
  }));

  // Download the package to a USB stick or a filing folder instead of emailing it.
  r.get('/delivery/:id/file', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const d = delivery.getDelivery(req.params.id, ctx);
    if (!d) return res.status(404).json({ error: 'That package was not found.' });
    res.download(`${delivery.storageDir}/${d.batch_id}.reindeer`, d.file_name);
  }));

  // Confirmed send.
  r.post('/delivery/:id/send', wrap(async (req, res) => {
    res.json(await delivery.send(req.params.id, ctxOf(req), { confirmed: req.body?.confirmed === true }));
  }));

  r.get('/delivery', wrap(async (req, res) => res.json({ deliveries: delivery.history(ctxOf(req)) })));

  return r;
}

/** The public link route. Mounted outside /api because trustees click it in email. */
export function createLinkRouter({ delivery }) {
  const r = express.Router();
  r.get('/d/:token', async (req, res) => {
    const out = await delivery.resolveLink(req.params.token);
    if (!out.ok) {
      const msg = {
        not_found: 'This download link is not valid. Please ask for a new one.',
        expired: 'This download link has expired. Please ask for a new one.',
        missing_file: 'The file for this link is no longer available. Please ask for a new one.',
      }[out.reason];
      return res.status(410).type('html').send(page(msg));
    }
    res.download(out.path, out.file_name);
  });
  return r;
}

const page = (msg) => `<!doctype html><meta charset="utf-8">
<div style="font:18px/1.6 Georgia,serif;max-width:34em;margin:12vh auto;padding:0 6vw;color:#111">
  <h1 style="font-size:24px">Estate inventory package</h1><p>${msg}</p></div>`;
