import { ulid } from '../db/index.js';

/**
 * The owner's heirs \u2014 people who receive items in the addendum.
 *
 * This is a Registry-side list. FairPlay has its own heir table because it
 * runs the distribution game and tracks per-heir participation, budget, and
 * ranking. The two lists overlap by name but are not the same table \u2014
 * Registry's heirs exist so the addendum can point at "Sarah" the same way
 * every signing, even if Sarah never opens FairPlay.
 *
 * Names still route through `PeopleRepo` for auto-fill on capture screens.
 * `heirs` is the smaller, more deliberate list used only when the owner sits
 * down to assign items and sign the addendum.
 */
export class HeirsRepo {
  constructor(db, audit = null) { this.db = db; this.audit = audit; }

  list(ctx) {
    return this.db.prepare(
      'SELECT * FROM heirs WHERE scope_id = ? ORDER BY name COLLATE NOCASE',
    ).all(ctx.scopeId).map(shape);
  }

  get(heirId, ctx) {
    const row = this.db.prepare('SELECT * FROM heirs WHERE heir_id = ? AND scope_id = ?')
      .get(heirId, ctx.scopeId);
    return row ? shape(row) : null;
  }

  create({ name, relationship = '', email = '', notes = '', recipient_type = 'heir' }, ctx) {
    const clean = String(name ?? '').trim().replace(/\s+/g, ' ');
    if (!clean) throw Object.assign(new Error('That person needs a name.'), { status: 400 });
    if (clean.length > 120) throw Object.assign(new Error('That name is too long.'), { status: 400 });
    const type = normalizeType(recipient_type);

    const heirId = ulid();
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO heirs (heir_id, scope_id, name, relationship, email, notes, recipient_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(heirId, ctx.scopeId, clean, String(relationship).trim(), String(email).trim(), String(notes).trim(), type, now, now);
    this.audit?.append?.({ action: 'heir.create', entity: 'heir', entity_id: heirId, payload: { name: clean, recipient_type: type } }, ctx);
    return this.get(heirId, ctx);
  }

  update(heirId, patch, ctx) {
    const heir = this.get(heirId, ctx);
    if (!heir) throw Object.assign(new Error('That person is not on the list.'), { status: 404 });
    const name = patch.name != null ? String(patch.name).trim().replace(/\s+/g, ' ') : heir.name;
    if (!name) throw Object.assign(new Error('That person needs a name.'), { status: 400 });
    const type = patch.recipient_type != null ? normalizeType(patch.recipient_type) : heir.recipient_type;

    this.db.prepare(
      `UPDATE heirs SET name = ?, relationship = ?, email = ?, notes = ?, recipient_type = ?, updated_at = ?
        WHERE heir_id = ? AND scope_id = ?`,
    ).run(
      name,
      patch.relationship != null ? String(patch.relationship).trim() : heir.relationship,
      patch.email != null ? String(patch.email).trim() : heir.email,
      patch.notes != null ? String(patch.notes).trim() : heir.notes,
      type,
      new Date().toISOString(), heirId, ctx.scopeId,
    );
    this.audit?.append?.({ action: 'heir.update', entity: 'heir', entity_id: heirId, payload: { name, recipient_type: type } }, ctx);
    return this.get(heirId, ctx);
  }

  /**
   * Delete rather than archive. An heir with no items assigned is safe to
   * remove; an heir with assigned items requires the caller to reassign or
   * unassign first, so the addendum never carries a phantom heir_id.
   */
  remove(heirId, ctx) {
    const heir = this.get(heirId, ctx);
    if (!heir) throw Object.assign(new Error('That person is not on the list.'), { status: 404 });
    const assigned = this.db.prepare(
      'SELECT COUNT(*) AS n FROM items WHERE scope_id = ? AND assigned_to_heir_id = ?',
    ).get(ctx.scopeId, heirId).n;
    if (assigned > 0) {
      throw Object.assign(
        new Error(`${heir.name} has ${assigned} item${assigned === 1 ? '' : 's'} assigned. Unassign them first.`),
        { status: 409 },
      );
    }
    this.db.prepare('DELETE FROM heirs WHERE heir_id = ? AND scope_id = ?').run(heirId, ctx.scopeId);
    this.audit?.append?.({ action: 'heir.remove', entity: 'heir', entity_id: heirId, payload: { name: heir.name } }, ctx);
    return { ok: true };
  }

  /** How many items each heir has been assigned. */
  counts(ctx) {
    const rows = this.db.prepare(
      `SELECT assigned_to_heir_id AS heir_id, COUNT(*) AS n
         FROM items
        WHERE scope_id = ? AND assigned_to_heir_id IS NOT NULL AND review_state != 'rejected'
        GROUP BY assigned_to_heir_id`,
    ).all(ctx.scopeId);
    return new Map(rows.map((r) => [r.heir_id, r.n]));
  }
}

function shape(row) {
  return {
    heir_id: row.heir_id,
    name: row.name,
    relationship: row.relationship || '',
    email: row.email || '',
    notes: row.notes || '',
    recipient_type: row.recipient_type || 'heir',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeType(t) {
  const v = String(t ?? 'heir').trim();
  if (v !== 'heir' && v !== 'named_recipient') {
    throw Object.assign(new Error('That kind of recipient is not one of the allowed choices.'), { status: 400 });
  }
  return v;
}
