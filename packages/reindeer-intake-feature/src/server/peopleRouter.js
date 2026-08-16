import express from 'express';
import { makeScopeCtx } from '@reindeer/core-api';

/**
 * The people screen's API.
 *
 * deps: { people, audit, resolveScope }
 *
 * Nothing here decides anything. Every route reads or writes an address book;
 * the distribution decision is made in the will, and the operative document is
 * the signed memorandum. Keeping that boundary visible in the code is the
 * point — the moment this table grows a "share" column it has started to look
 * like an instrument, which it is not.
 */
export function createPeopleRouter({ people, audit, resolveScope }) {
  const r = express.Router();
  const json = express.json({ limit: '256kb' });
  const ctxOf = (req) => makeScopeCtx(resolveScope(req));
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  r.get('/people', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const counts = people.counts(ctx);
    res.json({
      people: people.list(ctx).map((p) => ({ ...p, item_count: counts.get(p.name.toLowerCase()) ?? 0 })),
      // Names the owner has already used on items but never added to the list.
      unlisted: people.unlisted(ctx),
      binding: false,
      note: 'Naming somebody here records a wish. It does not give them anything — the will, and the signed memorandum it refers to, decide that.',
    });
  }));

  r.post('/people', json, wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const person = people.upsert({
      name: req.body?.name,
      relationship: req.body?.relationship,
      note: req.body?.note,
      source: req.body?.source,
    }, ctx);
    if (person.created) {
      await audit.append({
        action: 'person.add', entity: 'person', entity_id: person.person_id,
        payload: { name: person.name, relationship: person.relationship, source: person.source },
      }, ctx);
    }
    res.status(person.created ? 201 : 200).json(person);
  }));

  /** Add several at once — the up-front "who is on your list?" question. */
  r.post('/people/bulk', json, wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const rows = Array.isArray(req.body?.people) ? req.body.people.slice(0, 50) : [];
    const added = [];
    const skipped = [];
    for (const row of rows) {
      try {
        const p = people.upsert({ name: row?.name, relationship: row?.relationship, source: row?.source }, ctx);
        if (p.created) {
          await audit.append({
            action: 'person.add', entity: 'person', entity_id: p.person_id,
            payload: { name: p.name, relationship: p.relationship, source: p.source },
          }, ctx);
        }
        added.push(p);
      } catch (err) {
        skipped.push({ name: row?.name ?? '', why: err.message });
      }
    }
    res.status(201).json({ added, skipped });
  }));

  r.patch('/people/:personId', json, wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const person = people.update(req.params.personId, {
      name: req.body?.name, relationship: req.body?.relationship, note: req.body?.note,
    }, ctx);
    await audit.append({
      action: 'person.update', entity: 'person', entity_id: person.person_id,
      payload: { name: person.name, relationship: person.relationship },
    }, ctx);
    res.json(person);
  }));

  /*
   * Removing somebody is archiving, never deleting. Items already recorded
   * keep the name they were given: a list that quietly drops a person the
   * owner once named would be lying about what the owner said.
   */
  r.delete('/people/:personId', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const person = people.archive(req.params.personId, ctx, true);
    await audit.append({
      action: 'person.archive', entity: 'person', entity_id: person.person_id,
      payload: { name: person.name },
    }, ctx);
    res.json({
      ...person,
      note: 'Removed from the list. Items you already recorded for them keep their name — nothing was erased.',
    });
  }));

  r.post('/people/:personId/restore', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    res.json(people.archive(req.params.personId, ctx, false));
  }));

  return r;
}
