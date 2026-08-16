import {
  ItemRepository, validateItemRecord, validateRecipientHint,
  ValidationError, NotFoundError, EXPORT_STATE, PRINT_STATE,
} from '@reindeer/core-api';
import { ulid } from '../db/index.js';

const toRow = (i) => ({
  ...i,
  identifiers: JSON.stringify(i.identifiers ?? {}),
  high_value_flag: i.high_value_flag ? 1 : 0,
  // Owner's own "this matters" mark. Distinct from high_value_flag, which is
  // FairPlay's computed field — Registry never sets that one.
  owner_high_value: i.owner_high_value ? 1 : 0,
  owner_high_value_reason: i.owner_high_value_reason ?? '',
  // Owner-authored comment. Empty string is the "no comment" state; the
  // validator has already trimmed and length-checked it before we get here.
  owner_important_comment: i.owner_important_comment ?? '',
  ownership_tag: i.ownership_tag ?? 'mine',
});

const fromRow = (r) => r && ({
  ...r,
  identifiers: JSON.parse(r.identifiers || '{}'),
  high_value_flag: !!r.high_value_flag,
  ownership_tag: r.ownership_tag ?? 'mine',
  owner_high_value: !!r.owner_high_value,
  owner_high_value_reason: r.owner_high_value_reason ?? '',
  owner_important_comment: r.owner_important_comment ?? '',
});

export class SqliteItemRepository extends ItemRepository {
  constructor(db, audit) {
    super();
    this.db = db;
    this.audit = audit;
  }

  async create(input, ctx) {
    const { ok, value, errors } = validateItemRecord(input);
    if (!ok) throw ValidationError(errors);
    value.item_id = value.item_id || ulid();
    const row = toRow(value);

    this.db.prepare(`
      INSERT INTO items (item_id, scope_id, origin_app, origin_item_id, title, category_id, room_id,
        description, story, quantity, condition, identifiers, value_estimate_cents, value_basis,
        high_value_flag, owner_high_value, owner_high_value_reason, owner_important_comment,
        ownership_tag,
        ai_confidence, review_state, print_state, export_state, created_at, updated_at)
      VALUES (@item_id, @scope_id, @origin_app, @origin_item_id, @title, @category_id, @room_id,
        @description, @story, @quantity, @condition, @identifiers, @value_estimate_cents, @value_basis,
        @high_value_flag, @owner_high_value, @owner_high_value_reason, @owner_important_comment,
        @ownership_tag,
        @ai_confidence, @review_state, @print_state, @export_state, @created_at, @updated_at)
    `).run({ ...row, scope_id: ctx.scopeId });

    if (input.recipient_hint) await this.setRecipientHint(value.item_id, input.recipient_hint, ctx);
    await this.audit.append({ action: 'item.create', entity: 'item', entity_id: value.item_id, payload: { title: value.title } }, ctx);

    // If the item lands in a room the owner has not yet opened, promote that
    // room from 'not_started' to 'started' — an item in the room IS evidence
    // that the walk is under way. Only promote from 'not_started'; a room the
    // owner already marked 'done' or 'skipped' stays where it is, so a later
    // stray item cannot silently reopen a closed room. documented_at is set
    // on first evidence via COALESCE so the timestamp reflects the earliest
    // moment the room held anything.
    if (row.room_id) {
      const promoted = this.db.prepare(
        `UPDATE rooms
            SET walkthrough_state = 'started',
                documented_at     = COALESCE(documented_at, ?)
          WHERE room_id = ? AND scope_id = ? AND walkthrough_state = 'not_started'`,
      ).run(new Date().toISOString(), row.room_id, ctx.scopeId);
      if (promoted.changes) {
        await this.audit.append(
          { action: 'room.walkthrough', entity: 'room', entity_id: row.room_id, payload: { state: 'started', reason: 'first_item' } },
          ctx,
        );
      }
    }

    return this.get(value.item_id, ctx);
  }

  async update(id, patch, ctx) {
    const current = await this.get(id, ctx);
    if (!current) throw NotFoundError('That item');

    const merged = { ...current, ...patch, item_id: id, updated_at: new Date().toISOString() };

    // Clear-on-unflag intent detection. If the caller explicitly sets
    // owner_high_value: false, honor that even when there is a persisted
    // owner_important_comment on the item — otherwise validateItemRecord's
    // auto-flag rule would re-assert the flag from the stale comment and
    // the unflag would silently no-op. The validator still runs the
    // asymmetric coupling; we just clear the comment first so auto-flag
    // has nothing to fire on. See
    // docs/decisions/2026-08-06-important-comment.md.
    if ('owner_high_value' in patch && patch.owner_high_value === false
        && !('owner_important_comment' in patch)) {
      merged.owner_important_comment = '';
    }
    // Any content change invalidates a previous print or export.
    const contentKeys = ['title', 'description', 'story', 'quantity', 'condition',
      'identifiers', 'value_estimate_cents', 'room_id', 'category_id'];
    const changed = contentKeys.filter((k) => k in patch && JSON.stringify(patch[k]) !== JSON.stringify(current[k]));
    if (changed.length) {
      if (current.print_state === PRINT_STATE.PRINTED) merged.print_state = PRINT_STATE.STALE;
      if (current.export_state === EXPORT_STATE.EXPORTED) merged.export_state = EXPORT_STATE.CHANGED_SINCE_EXPORT;
    }

    const { ok, value, errors } = validateItemRecord(merged);
    if (!ok) throw ValidationError(errors);
    const row = toRow(value);

    this.db.prepare(`
      UPDATE items SET origin_app=@origin_app, origin_item_id=@origin_item_id, title=@title,
        category_id=@category_id, room_id=@room_id, description=@description, story=@story,
        quantity=@quantity, condition=@condition, identifiers=@identifiers,
        value_estimate_cents=@value_estimate_cents, value_basis=@value_basis,
        high_value_flag=@high_value_flag,
        ownership_tag=@ownership_tag,
        owner_high_value=@owner_high_value, owner_high_value_reason=@owner_high_value_reason,
        owner_important_comment=@owner_important_comment,
        ai_confidence=@ai_confidence, review_state=@review_state,
        print_state=@print_state, export_state=@export_state, updated_at=@updated_at
      WHERE item_id=@item_id AND scope_id=@scope_id
    `).run({ ...row, scope_id: ctx.scopeId });

    if (patch.recipient_hint !== undefined) await this.setRecipientHint(id, patch.recipient_hint, ctx);
    await this.audit.append({ action: 'item.update', entity: 'item', entity_id: id, payload: { changed } }, ctx);
    return this.get(id, ctx);
  }

  /**
   * Assign the item to an heir on the Registry side (Two-Output addendum).
   *
   * Kept separate from `update` on purpose: assignment is not a content edit,
   * doesn't invalidate a previous print, and doesn't need to run through the
   * item validator. It is an addendum-side decision that lives on the item
   * only because the item is where it belongs — the addendum is a projection.
   *
   * Pass `heirId = null` to unassign.
   */
  async assignHeir(id, heirId, ctx) {
    const current = await this.get(id, ctx);
    if (!current) throw NotFoundError('That item');
    if (heirId != null) {
      const heir = this.db.prepare('SELECT heir_id FROM heirs WHERE heir_id = ? AND scope_id = ?')
        .get(heirId, ctx.scopeId);
      if (!heir) throw NotFoundError('That heir');
    }

    // Conflict detection: check the audit log for prior assignments by a
    // DIFFERENT participant. If someone else previously assigned this item
    // to a different heir, flag the conflict. Last write still wins on
    // assigned_to_heir_id — the flag is a notice, not a block. The trustee
    // resolves disagreements later.
    let conflict = 0;
    if (heirId != null) {
      const priorAssigns = this.db.prepare(
        `SELECT actor_id, json_extract(payload, '$.heir_id') AS heir_id
         FROM audit_log
         WHERE scope_id = ? AND entity = 'item' AND entity_id = ?
           AND action = 'item.assign' AND actor_id != ?
         ORDER BY seq DESC LIMIT 20`,
      ).all(ctx.scopeId, id, ctx.actorId);
      const hasConflict = priorAssigns.some((r) => r.heir_id && r.heir_id !== heirId);
      conflict = hasConflict ? 1 : 0;
    } else {
      // Unassigning clears the conflict — nobody is currently disagreeing.
      conflict = 0;
    }

    this.db.prepare(
      'UPDATE items SET assigned_to_heir_id = ?, assignment_conflict = ?, updated_at = ? WHERE item_id = ? AND scope_id = ?',
    ).run(heirId, conflict, new Date().toISOString(), id, ctx.scopeId);
    await this.audit.append({
      action: heirId ? 'item.assign' : 'item.unassign',
      entity: 'item', entity_id: id,
      payload: { heir_id: heirId, conflict },
    }, ctx);
    return this.get(id, ctx);
  }

  /**
   * Attach a close-up photo (or clear it) for the addendum. The photo must
   * already exist in item_photos for this item, and must be `media_kind =
   * 'photo'` — the addendum's close-up requirement is not satisfied by a
   * video frame.
   */
  async setCloseupPhoto(id, photoId, ctx) {
    const current = await this.get(id, ctx);
    if (!current) throw NotFoundError('That item');
    if (photoId != null) {
      const p = this.db.prepare(
        "SELECT photo_id FROM item_photos WHERE photo_id = ? AND item_id = ? AND scope_id = ? AND media_kind = 'photo'",
      ).get(photoId, id, ctx.scopeId);
      if (!p) throw NotFoundError('That photo');
    }
    this.db.prepare(
      'UPDATE items SET closeup_photo_id = ?, updated_at = ? WHERE item_id = ? AND scope_id = ?',
    ).run(photoId, new Date().toISOString(), id, ctx.scopeId);
    await this.audit.append({
      action: photoId ? 'item.closeup.set' : 'item.closeup.clear',
      entity: 'item', entity_id: id,
      payload: { photo_id: photoId },
    }, ctx);
    return this.get(id, ctx);
  }

  async get(id, ctx) {
    const row = this.db.prepare('SELECT * FROM items WHERE item_id = ? AND scope_id = ?').get(id, ctx.scopeId);
    if (!row) return null;
    const item = fromRow(row);
    const media = this.db.prepare("SELECT * FROM item_photos WHERE item_id = ? ORDER BY media_kind = 'photo' DESC, role = 'primary' DESC, created_at ASC")
      .all(id).map((p) => ({ ...p, crop_bbox: p.crop_bbox ? JSON.parse(p.crop_bbox) : null }));
    item.media = media;
    item.photos = media.filter((m) => m.media_kind === 'photo');
    item.recordings = media.filter((m) => m.media_kind === 'video' || m.media_kind === 'audio');
    item.recipient_hint = this.db.prepare('SELECT * FROM recipient_hints WHERE item_id = ?').get(id) ?? null;
    item.room = row.room_id ? this.db.prepare('SELECT * FROM rooms WHERE room_id = ?').get(row.room_id) : null;
    item.category = row.category_id ? this.db.prepare('SELECT * FROM categories WHERE category_id = ?').get(row.category_id) : null;
    return item;
  }

  async list(query = {}, ctx) {
    const where = ['i.scope_id = @scope_id'];
    const params = { scope_id: ctx.scopeId };
    if (query.review_state) { where.push('i.review_state = @review_state'); params.review_state = query.review_state; }
    if (query.room_id) { where.push('i.room_id = @room_id'); params.room_id = query.room_id; }
    if (query.category_id) { where.push('i.category_id = @category_id'); params.category_id = query.category_id; }
    if (query.high_value_only) where.push('i.high_value_flag = 1');
    // Owner's own mark — kept as a separate filter so a FairPlay caller
    // asking for "high_value_only" never picks up an owner‑flagged item that
    // FairPlay's own estimator did not agree with, and vice versa.
    if (query.owner_high_value_only) where.push('i.owner_high_value = 1');
    if (query.recipient_name) {
      where.push('EXISTS (SELECT 1 FROM recipient_hints h WHERE h.item_id = i.item_id AND h.recipient_name = @recipient_name)');
      params.recipient_name = query.recipient_name;
    }
    if (query.has_recipient === true) where.push("EXISTS (SELECT 1 FROM recipient_hints h WHERE h.item_id = i.item_id AND h.recipient_name <> '')");
    if (query.has_recipient === false) where.push("NOT EXISTS (SELECT 1 FROM recipient_hints h WHERE h.item_id = i.item_id AND h.recipient_name <> '')");
    if (query.search) { where.push('(i.title LIKE @q OR i.description LIKE @q OR i.story LIKE @q)'); params.q = `%${query.search}%`; }
    if (query.item_ids?.length) where.push(`i.item_id IN (${query.item_ids.map((x) => `'${String(x).replace(/'/g, '')}'`).join(',')})`);

    /*
     * Things with someone's name on them come first.
     *
     * An owner who has gone to the trouble of saying "the clock is Robert's" has
     * told us that item carries the most meaning, and those are the entries they
     * return to, re-read and check. Sinking them beneath forty unnamed chairs
     * because a chair was photographed more recently gets the priority exactly
     * backwards. Ordering by recency within each group keeps the familiar
     * newest-first feel inside the part of the list they are working on.
     *
     * This orders the display only. It confers nothing: a hint is non-binding
     * here by design, and appearing at the top of a list is not a bequest.
     */
    const rows = this.db.prepare(
      `SELECT i.item_id,
              EXISTS (SELECT 1 FROM recipient_hints h
                       WHERE h.item_id = i.item_id AND h.recipient_name <> '') AS has_recipient
         FROM items i
        WHERE ${where.join(' AND ')}
        ORDER BY has_recipient DESC, i.created_at DESC`,
    ).all(params);
    const items = [];
    for (const r of rows) items.push(await this.get(r.item_id, ctx));
    return { items, total: items.length };
  }

  async setRecipientHint(itemId, hint, ctx) {
    if (hint === null) {
      this.db.prepare('DELETE FROM recipient_hints WHERE item_id = ?').run(itemId);
      return null;
    }
    const { ok, value, errors } = validateRecipientHint(hint);
    if (!ok) throw ValidationError(errors);
    this.db.prepare(`
      INSERT INTO recipient_hints (item_id, scope_id, recipient_name, relationship, alternate_name, owner_note, is_binding, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)
      ON CONFLICT(item_id) DO UPDATE SET recipient_name=excluded.recipient_name,
        relationship=excluded.relationship, alternate_name=excluded.alternate_name,
        owner_note=excluded.owner_note, updated_at=excluded.updated_at
    `).run(itemId, ctx.scopeId, value.recipient_name ?? '', value.relationship ?? '',
      value.alternate_name ?? '', value.owner_note ?? '', new Date().toISOString());
    await this.audit.append({ action: 'item.recipient_hint', entity: 'item', entity_id: itemId, payload: { recipient_name: value.recipient_name } }, ctx);
    return value;
  }

  async remove(id, reason, ctx) {
    const item = await this.get(id, ctx);
    if (!item) throw NotFoundError('That item');
    // Deletion is recorded before it happens so the chain retains the evidence.
    await this.audit.append({
      action: 'item.delete', entity: 'item', entity_id: id,
      payload: { title: item.title, reason: reason ?? '', photos: item.photos.length },
    }, ctx);
    this.db.prepare('DELETE FROM items WHERE item_id = ? AND scope_id = ?').run(id, ctx.scopeId);
    return { deleted: true };
  }

  async markExported(ids, batchId, ctx) {
    const stmt = this.db.prepare("UPDATE items SET export_state = 'exported' WHERE item_id = ? AND scope_id = ?");
    const tx = this.db.transaction(() => ids.forEach((id) => stmt.run(id, ctx.scopeId)));
    tx();
    await this.audit.append({ action: 'item.exported', entity: 'batch', entity_id: batchId, payload: { count: ids.length } }, ctx);
  }

  async markPrinted(ids, ctx) {
    const stmt = this.db.prepare("UPDATE items SET print_state = 'printed' WHERE item_id = ? AND scope_id = ?");
    const tx = this.db.transaction(() => ids.forEach((id) => stmt.run(id, ctx.scopeId)));
    tx();
    await this.audit.append({ action: 'item.printed', entity: 'item', entity_id: null, payload: { count: ids.length } }, ctx);
  }
}
