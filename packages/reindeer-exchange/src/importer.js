import { ulid } from '@reindeer/core-data';
import { ORIGIN_APP, REVIEW_STATE } from '@reindeer/core-api';
import { readBundle } from './bundle.js';

/**
 * Import a ReindeerExchange bundle into Reindeer: FairPlay.
 *
 * Non-negotiable rules, enforced here rather than in the UI:
 *  1. Everything lands in the Intake queue as a draft. Nothing joins a live
 *     game silently.
 *  2. If the division has started, imports are queued regardless — fair round
 *     locking means participants see a consistent pool at pick time.
 *  3. Rooms and categories map BY NAME. Unmatched names are reported for an
 *     administrator mapping screen and are never auto-created.
 *  4. recipient_hint is a suggestion. It never becomes an heir preference
 *     without an explicit administrator action.
 *  5. Re-importing the same item_id updates instead of duplicating.
 *  6. Every branch is written to the hash-chained audit log.
 */
export async function importBundle(buffer, {
  itemRepo, mediaStore, scopeMediaStore, registry, duplicates, audit, db, ctx,
  autoCreateMissingRegistry = false,
}) {
  const { envelope, manifest, files, problems } = readBundle(buffer);
  const scope = db.prepare('SELECT * FROM scopes WHERE scope_id = ?').get(ctx.scopeId);
  const roundLocked = !!scope?.round_locked;
  const batchId = manifest?.batch_id ?? ulid();

  const result = {
    batch_id: batchId,
    source: envelope.source,
    round_locked: roundLocked,
    created: [], updated: [], queued: [],
    unmapped_rooms: new Set(), unmapped_categories: new Set(),
    recipient_suggestions: [], duplicate_groups: [], problems: [...problems],
    recordings_imported: [], scope_media_imported: [],
  };

  // Whole-inventory recordings: a room walkthrough or a message to the family.
  for (const m of envelope.scope_media ?? []) {
    const data = files.get(m.file);
    if (!data) { result.problems.push(`Missing ${m.kind} recording ${m.file}`); continue; }
    if (!scopeMediaStore) { result.problems.push(`This app cannot store whole-inventory recordings yet: ${m.title || m.file}`); continue; }
    const existing = scopeMediaStore.list(ctx).some((x) => x.sha256 === m.sha256);
    if (existing) continue;
    await scopeMediaStore.put(data, {
      media_kind: m.kind, title: m.title, mime_type: m.mime_type,
      duration_ms: m.duration_ms ?? null, transcript: m.transcript ?? '',
    }, ctx);
    result.scope_media_imported.push({ kind: m.kind, title: m.title });
  }

  const roomByName = new Map(registry.rooms(ctx).map((r) => [r.name.toLowerCase(), r]));
  const catByName = new Map(registry.categories(ctx).map((c) => [c.name.toLowerCase(), c]));

  for (const src of envelope.items) {
    // --- registry mapping by name -----------------------------------------
    let room = src.room_name ? roomByName.get(src.room_name.toLowerCase()) : null;
    if (!room && src.room_name) {
      if (autoCreateMissingRegistry) {
        room = registry.resolveRoom(src.room_name, ctx);
        roomByName.set(src.room_name.toLowerCase(), room);
      } else {
        result.unmapped_rooms.add(src.room_name);
      }
    }
    let cat = src.category_name ? catByName.get(src.category_name.toLowerCase()) : null;
    if (!cat && src.category_name) {
      if (autoCreateMissingRegistry) {
        cat = registry.resolveCategory(src.category_name, ctx);
        catByName.set(src.category_name.toLowerCase(), cat);
      } else {
        result.unmapped_categories.add(src.category_name);
      }
    }

    const payload = {
      origin_app: ORIGIN_APP.INVENTORY,
      origin_item_id: src.item_id,
      title: src.title,
      description: src.description ?? '',
      story: src.story ?? '',
      quantity: src.quantity ?? 1,
      condition: src.condition ?? 'unknown',
      identifiers: src.identifiers ?? {},
      value_estimate_cents: src.value_estimate_cents ?? null,
      value_basis: src.value_basis ?? 'unknown',
      // Registry's own high-value flag, carried through unchanged on a
      // Registry-to-Registry transfer. The FC boundary is where owner
      // promotion is honored (see
      // docs/decisions/2026-08-06-fc-honors-owner-important.md and
      // apps/reindeer-fair-play/server/import/importService.ts): FC OR's
      // this with owner_high_value into its own isHighValue and writes an
      // audited classification-change row. This importer is not that
      // boundary; it stays a straight copy of the independent fields.
      high_value_flag: !!src.high_value_flag,
      // The owner's own "this matters" mark, carried through import so Fair
      // Choice can sort flagged items forward and route money-flagged ones to
      // an appraiser first — but never as a valuation.
      owner_high_value: !!src.owner_high_value,
      owner_high_value_reason: src.owner_high_value_reason ?? '',
      // Owner-authored comment. Default '' when the envelope pre-dates this
      // field. The importer feeds it through validateItemRecord downstream,
      // which will trim, cap at 500 chars, and apply the asymmetric coupling
      // with owner_high_value — so a corrupt file that says
      // {owner_high_value: false, owner_important_comment: 'hi'} still ends
      // up as {flag: true, comment: 'hi'} on disk. See
      // docs/decisions/2026-08-06-important-comment.md.
      owner_important_comment: src.owner_important_comment ?? '',
      ai_confidence: src.ai_confidence ?? null,
      room_id: room?.room_id ?? null,
      category_id: cat?.category_id ?? null,
      review_state: REVIEW_STATE.DRAFT,
    };

    // --- update-or-create by origin_item_id --------------------------------
    const existing = db.prepare(
      'SELECT item_id FROM items WHERE scope_id = ? AND origin_item_id = ?',
    ).get(ctx.scopeId, src.item_id);

    let itemId;
    if (existing) {
      await itemRepo.update(existing.item_id, payload, ctx);
      itemId = existing.item_id;
      result.updated.push(itemId);
    } else {
      const created = await itemRepo.create({ ...payload, item_id: src.item_id }, ctx);
      itemId = created.item_id;
      result.created.push(itemId);
    }

    // --- photos, video, and voice -------------------------------------------
    const have = new Set((await mediaStore.listForItem(itemId, ctx)).map((p) => p.sha256));
    for (const p of src.photos ?? []) {
      const data = files.get(p.file);
      if (!data) { result.problems.push(`Missing photo ${p.file} for "${src.title}"`); continue; }
      if (p.sha256 && have.has(p.sha256)) continue; // idempotent re-import
      await mediaStore.put(data, {
        item_id: itemId, role: p.role ?? 'primary', media_kind: 'photo',
        crop_bbox: p.crop_bbox ?? null, mime_type: p.file.endsWith('.png') ? 'image/png' : 'image/jpeg',
        source_frame_index: p.source_frame_index ?? null,
      }, ctx);
    }
    for (const r of src.recordings ?? []) {
      const data = files.get(r.file);
      if (!data) { result.problems.push(`Missing ${r.kind} recording ${r.file} for "${src.title}"`); continue; }
      if (r.sha256 && have.has(r.sha256)) continue;
      await mediaStore.put(data, {
        item_id: itemId, role: r.role, media_kind: r.kind, mime_type: r.mime_type,
        duration_ms: r.duration_ms ?? null, transcript: r.transcript ?? '',
        transcript_source: r.transcript_source ?? null, label: r.label ?? '',
      }, ctx);
      result.recordings_imported.push({ item_id: itemId, kind: r.kind, label: r.label ?? r.role });
    }

    // --- recipient hint stays a suggestion ---------------------------------
    if (src.recipient_hint?.recipient_name) {
      result.recipient_suggestions.push({
        item_id: itemId,
        title: src.title,
        suggested_recipient: src.recipient_hint.recipient_name,
        relationship: src.recipient_hint.relationship ?? '',
        owner_note: src.recipient_hint.owner_note ?? '',
        applied: false,
      });
    }

    // --- intake queue --------------------------------------------------------
    const intakeId = ulid();
    db.prepare(`
      INSERT INTO intake_queue (intake_id, scope_id, source, source_batch, item_id, payload, state, note, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(intakeId, ctx.scopeId, 'reindeer-registry', batchId, itemId,
      JSON.stringify({ origin_item_id: src.item_id, recipient_hint: src.recipient_hint ?? null }),
      'pending',
      roundLocked ? 'Queued: the division has already started.' : '',
      new Date().toISOString());
    result.queued.push(intakeId);
  }

  // --- duplicate scan against the estate catalog ---------------------------
  const touched = [...result.created, ...result.updated];
  if (touched.length && duplicates) {
    result.duplicate_groups = await duplicates.scanBatch(touched, ctx);
  }

  // Re-importing the same bundle is legitimate and idempotent, so the batch
  // row is upserted rather than inserted.
  db.prepare(`
    INSERT INTO export_batches (batch_id, scope_id, format, item_count, file_name, created_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(batch_id) DO UPDATE SET item_count=excluded.item_count, created_at=excluded.created_at
  `).run(batchId, ctx.scopeId, 'import:reindeer-exchange-1.0', envelope.items.length,
    manifest?.files?.[0] ?? 'items.json', new Date().toISOString());

  await audit.append({
    action: 'exchange.import', entity: 'batch', entity_id: batchId,
    payload: {
      source: envelope.source, created: result.created.length, updated: result.updated.length,
      queued: result.queued.length, round_locked: roundLocked,
      unmapped_rooms: [...result.unmapped_rooms], unmapped_categories: [...result.unmapped_categories],
      duplicate_groups: result.duplicate_groups.length, problems: result.problems.length,
    },
  }, ctx);

  result.unmapped_rooms = [...result.unmapped_rooms];
  result.unmapped_categories = [...result.unmapped_categories];
  return result;
}

/** Explicit, audited promotion of a suggestion into a real heir preference. */
export async function applyRecipientSuggestion({ db, audit, ctx, itemId, heirId, heirName }) {
  db.prepare("UPDATE intake_queue SET state='applied', resolved_at=? WHERE item_id=? AND scope_id=?")
    .run(new Date().toISOString(), itemId, ctx.scopeId);
  await audit.append({
    action: 'exchange.recipient_applied', entity: 'item', entity_id: itemId,
    payload: { heir_id: heirId, heir_name: heirName, basis: 'owner wish from Reindeer Registry' },
  }, ctx);
  return { item_id: itemId, heir_id: heirId, applied: true };
}
