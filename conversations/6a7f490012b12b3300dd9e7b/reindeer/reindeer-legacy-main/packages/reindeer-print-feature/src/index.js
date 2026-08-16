import express from 'express';
import { makeScopeCtx } from '@reindeer-legacy/core-api';
import { renderItemSheet, renderReport, PRINT_PROFILES } from './templates/index.js';
import { renderTrusteePacket, renderTrusteeEmail } from './templates/trusteePacket.js';
import { renderMemorandum } from './templates/memorandum.js';

export { renderItemSheet, renderReport, PRINT_PROFILES, renderTrusteePacket, renderTrusteeEmail, renderMemorandum };

/**
 * Print router. Renders print-ready HTML with proper @page rules; the browser
 * produces the PDF. That keeps the app free of a headless-browser dependency
 * and lets the same output work on desktop and phone.
 */
export function createPrintRouter({ itemRepo, resolveScope, ownerName = '' }) {
  const r = express.Router();
  const ctxOf = (req) => makeScopeCtx(resolveScope(req));
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  // Off unless a caller explicitly asks. The registry never asks.
  const showValues = (req) => req.query.values === 'show';

  // Single item sheet
  r.get('/print/item/:id', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const item = await itemRepo.get(req.params.id, ctx);
    if (!item) return res.status(404).send('Item not found');
    if (req.query.mark === 'true') await itemRepo.markPrinted([item.item_id], ctx);
    res.type('html').send(renderItemSheet(item, {
      profile: req.query.profile || 'letter_photo', base: '/api', showValues: showValues(req), ownerName,
    }));
  }));

  // Grouped reports: room, category, recipient, or the full inventory
  r.get('/print/report', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const { items } = await itemRepo.list({
      review_state: req.query.review_state || 'kept',
      room_id: req.query.room_id,
      category_id: req.query.category_id,
      recipient_name: req.query.recipient_name,
      high_value_only: req.query.high_value_only === 'true',
    }, ctx);

    const groupBy = req.query.group_by || 'room';
    const titles = {
      room: 'Reindeer: Registry by Room',
      category: 'Reindeer: Registry by Category',
      recipient: 'Reindeer: Registry by Intended Recipient',
    };
    if (req.query.mark === 'true' && items.length) await itemRepo.markPrinted(items.map((i) => i.item_id), ctx);

    res.type('html').send(renderReport(items, {
      title: req.query.title || titles[groupBy] || 'Reindeer: Registry',
      groupBy,
      layout: req.query.layout || 'table',
      profile: req.query.profile || 'letter_list',
      base: '/api',
      showValues: showValues(req),
      ownerName,
    }));
  }));

  // The execution page: the one document here meant to be signed and to have
  // effect. Only items with a named recipient are scheduled, because an item
  // with no recipient has nothing to say on a page that disposes of property.
  r.get('/print/memorandum', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const { items } = await itemRepo.list({ review_state: 'kept' }, ctx);
    res.type('html').send(renderMemorandum(items, {
      ownerName: req.query.owner_name || ownerName,
      ownerLocation: req.query.owner_location || '',
      willDate: req.query.will_date || '',
      witnessBlock: req.query.witnesses !== 'false',
      base: '/api',
    }));
  }));

  return r;
}
