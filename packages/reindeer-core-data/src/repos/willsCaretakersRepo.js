import { ulid } from '../db/index.js';

/**
 * The owner's wills caretakers \u2014 the law firm, the wills-and-probate lawyer,
 * or the safe-deposit holder who keeps the signed will alongside the
 * addendum. Migration 9 enforces `delivery_method IN ('email','signed_link','print_mail')`;
 * this repo does the same at the API surface so the owner sees a plain
 * message instead of a database error.
 */
const DELIVERY_METHODS = new Set(['email', 'signed_link', 'print_mail']);

export class WillsCaretakersRepo {
  constructor(db, audit = null) { this.db = db; this.audit = audit; }

  list(ctx) {
    return this.db.prepare(
      'SELECT * FROM wills_caretakers WHERE scope_id = ? ORDER BY name COLLATE NOCASE',
    ).all(ctx.scopeId).map(shape);
  }

  get(caretakerId, ctx) {
    const row = this.db.prepare('SELECT * FROM wills_caretakers WHERE caretaker_id = ? AND scope_id = ?')
      .get(caretakerId, ctx.scopeId);
    return row ? shape(row) : null;
  }

  create({ name, firm = '', email = '', phone = '', delivery_method, notes = '' }, ctx) {
    const clean = String(name ?? '').trim().replace(/\s+/g, ' ');
    if (!clean) throw Object.assign(new Error('A wills caretaker needs a name.'), { status: 400 });
    if (!DELIVERY_METHODS.has(delivery_method)) {
      throw Object.assign(
        new Error("Delivery method must be one of: email, signed_link, print_mail."),
        { status: 400 },
      );
    }
    // Only email and signed_link require an address. print_mail is picked up
    // in person or by the firm's own courier, so email is optional there.
    if (delivery_method !== 'print_mail' && !String(email).trim()) {
      throw Object.assign(new Error('An email address is needed for this delivery method.'), { status: 400 });
    }

    const caretakerId = ulid();
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO wills_caretakers
         (caretaker_id, scope_id, name, firm, email, phone, delivery_method, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      caretakerId, ctx.scopeId, clean, String(firm).trim(),
      String(email).trim(), String(phone).trim(),
      delivery_method, String(notes).trim(), now, now,
    );
    this.audit?.append?.({ action: 'wills_caretaker.create', entity: 'wills_caretaker', entity_id: caretakerId, payload: { name: clean } }, ctx);
    return this.get(caretakerId, ctx);
  }

  update(caretakerId, patch, ctx) {
    const cur = this.get(caretakerId, ctx);
    if (!cur) throw Object.assign(new Error('That wills caretaker is not on the list.'), { status: 404 });
    if (patch.delivery_method != null && !DELIVERY_METHODS.has(patch.delivery_method)) {
      throw Object.assign(
        new Error("Delivery method must be one of: email, signed_link, print_mail."),
        { status: 400 },
      );
    }
    this.db.prepare(
      `UPDATE wills_caretakers
          SET name = ?, firm = ?, email = ?, phone = ?, delivery_method = ?, notes = ?, updated_at = ?
        WHERE caretaker_id = ? AND scope_id = ?`,
    ).run(
      patch.name != null ? String(patch.name).trim().replace(/\s+/g, ' ') : cur.name,
      patch.firm != null ? String(patch.firm).trim() : cur.firm,
      patch.email != null ? String(patch.email).trim() : cur.email,
      patch.phone != null ? String(patch.phone).trim() : cur.phone,
      patch.delivery_method ?? cur.delivery_method,
      patch.notes != null ? String(patch.notes).trim() : cur.notes,
      new Date().toISOString(), caretakerId, ctx.scopeId,
    );
    this.audit?.append?.({ action: 'wills_caretaker.update', entity: 'wills_caretaker', entity_id: caretakerId, payload: {} }, ctx);
    return this.get(caretakerId, ctx);
  }

  remove(caretakerId, ctx) {
    const cur = this.get(caretakerId, ctx);
    if (!cur) throw Object.assign(new Error('That wills caretaker is not on the list.'), { status: 404 });
    this.db.prepare('DELETE FROM wills_caretakers WHERE caretaker_id = ? AND scope_id = ?')
      .run(caretakerId, ctx.scopeId);
    this.audit?.append?.({ action: 'wills_caretaker.remove', entity: 'wills_caretaker', entity_id: caretakerId, payload: { name: cur.name } }, ctx);
    return { ok: true };
  }
}

function shape(row) {
  return {
    caretaker_id: row.caretaker_id,
    name: row.name,
    firm: row.firm || '',
    email: row.email || '',
    phone: row.phone || '',
    delivery_method: row.delivery_method,
    notes: row.notes || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
