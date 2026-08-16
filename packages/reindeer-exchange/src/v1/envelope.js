import { NON_BINDING_DISCLAIMER, ExchangeVersionError } from '@reindeer-legacy/core-api';

export const EXCHANGE_FORMAT = 'legacy-exchange';
export const EXCHANGE_VERSION = '1.0';

/**
 * Build the ReindeerExchange v1 envelope.
 * Rooms and categories travel by NAME as well as id, because the receiving
 * estate has its own registry and must map by something human-readable.
 */
export function buildEnvelope({
  items,
  rooms,
  categories,
  source,
  scopeMedia = [],
  generatedAt = new Date(),
  lockedMemoranda = [],
}) {
  const allMedia = (i) => i.media ?? i.photos ?? [];
  // Build the union of item_ids locked by any frozen memorandum. Downstream
  // apps (FairPlay) display these items but never let heirs interact with
  // them \u2014 they are handled as special gifts under the will.
  //
  // In Couple mode this may hold two memoranda (one per spouse) at second
  // death; in a single-estate export it holds one. The set is frozen at
  // export time \u2014 later re-signings do not retroactively change the
  // locked set already delivered to the trustee.
  const lockedItemIds = new Set();
  for (const mem of lockedMemoranda) {
    for (const id of mem.item_ids ?? []) lockedItemIds.add(id);
  }
  return {
    format: EXCHANGE_FORMAT,
    version: EXCHANGE_VERSION,
    generated_at: generatedAt.toISOString(),
    source,
    rooms: rooms.map((r) => ({ id: r.room_id, name: r.name, is_custom: !!r.is_custom })),
    categories: categories.map((c) => ({ id: c.category_id, name: c.name, is_custom: !!c.is_custom })),
    // Frozen memorandum snapshots \u2014 the item_id lists the deceased
    // owner(s) named in their signed specific-giving addendum. Additive in
    // v1; older importers ignore this field entirely.
    //
    // Privacy: only the count and item_ids travel here. Recipient names,
    // relationships, and per-item recipient details live only in the
    // addendum envelope delivered to the wills-storage caretaker and
    // trustee \u2014 never in this inventory envelope, which is what Fair
    // Choice's heirs will see indirectly.
    locked_memoranda: lockedMemoranda.map((m) => ({
      owner_name: m.owner_name ?? '',
      signed_at: m.signed_at ?? null,
      version_number: m.version_number ?? null,
      item_ids: [...(m.item_ids ?? [])],
    })),
    items: items.map((i) => ({
      item_id: i.item_id,
      title: i.title,
      category_id: i.category_id,
      category_name: i.category?.name ?? null,
      room_id: i.room_id,
      room_name: i.room?.name ?? null,
      description: i.description,
      story: i.story,
      quantity: i.quantity,
      condition: i.condition,
      identifiers: i.identifiers ?? {},
      value_estimate_cents: i.value_estimate_cents,
      value_basis: i.value_basis,
      high_value_flag: !!i.high_value_flag,
      // The owner's own "this matters" mark, carried in the envelope alongside
      // (never replacing) FairPlay's computed high_value_flag. Reason is one
      // of '', 'feeling', 'money', 'both'. The importer must not derive
      // high_value_flag from these fields — see importer.js.
      owner_high_value: !!i.owner_high_value,
      owner_high_value_reason: i.owner_high_value_reason ?? '',
      // Owner-authored comment (500 chars max, already trimmed by the
      // validator on the writing side). Additive in v1 — default '' on read.
      // FairPlay ignores this field today; if it grows a use for it, it
      // will re-derive its own state from these values. See
      // docs/decisions/2026-08-06-important-comment.md.
      owner_important_comment: i.owner_important_comment ?? '',
      ai_confidence: i.ai_confidence,
      created_at: i.created_at,
      updated_at: i.updated_at,
      photos: allMedia(i).filter((p) => (p.media_kind ?? 'photo') === 'photo').map((p) => ({
        role: p.role,
        file: `media/${p.file_name}`,
        crop_bbox: p.crop_bbox ?? null,
        sha256: p.sha256,
        source_frame_index: p.source_frame_index,
      })),
      // Video walkarounds and the owner's own voice telling the story.
      recordings: allMedia(i).filter((p) => p.media_kind === 'video' || p.media_kind === 'audio').map((p) => ({
        kind: p.media_kind,
        role: p.role,
        label: p.label ?? '',
        file: `media/${p.file_name}`,
        mime_type: p.mime_type,
        duration_ms: p.duration_ms ?? null,
        transcript: p.transcript ?? '',
        transcript_source: p.transcript_source ?? null,
        sha256: p.sha256,
        byte_size: p.byte_size,
      })),
      recipient_hint: i.recipient_hint?.recipient_name
        ? {
          recipient_name: i.recipient_hint.recipient_name,
          relationship: i.recipient_hint.relationship,
          alternate_name: i.recipient_hint.alternate_name,
          owner_note: i.recipient_hint.owner_note,
          is_binding: false,
        }
        : null,
      // True when this item's id appears in ANY frozen memorandum
      // travelling with this export. Downstream FairPlay displays
      // these items as greyed-out \u201chandled as a special gift under
      // the will\u201d and never places them in a rankable pool. Additive
      // in v1 \u2014 older importers ignore this field.
      is_locked_gift: lockedItemIds.has(i.item_id),
    })),
    // Recordings that belong to the whole inventory: a room walkthrough, or
    // the owner speaking once to the entire family.
    scope_media: scopeMedia.map((m) => ({
      kind: m.media_kind,
      title: m.title,
      file: `media/_scope/${m.file_name}`,
      mime_type: m.mime_type,
      duration_ms: m.duration_ms ?? null,
      transcript: m.transcript ?? '',
      sha256: m.sha256,
      byte_size: m.byte_size,
    })),
    counts: {
      items: items.length,
      photos: items.reduce((s, i) => s + allMedia(i).filter((p) => (p.media_kind ?? 'photo') === 'photo').length, 0),
      videos: items.reduce((s, i) => s + allMedia(i).filter((p) => p.media_kind === 'video').length, 0)
        + scopeMedia.filter((m) => m.media_kind === 'video').length,
      audio: items.reduce((s, i) => s + allMedia(i).filter((p) => p.media_kind === 'audio').length, 0)
        + scopeMedia.filter((m) => m.media_kind === 'audio').length,
      scope_media: scopeMedia.length,
      with_recipient_hint: items.filter((i) => i.recipient_hint?.recipient_name).length,
      // How many items are locked by a frozen memorandum on this export.
      // Zero when no memoranda travel with the bundle (e.g. a manual test
      // export before any signing). Non-zero after a death-triggered export.
      locked_by_memorandum: items.filter((i) => lockedItemIds.has(i.item_id)).length,
      locked_memoranda: (lockedMemoranda ?? []).length,
      high_value: items.filter((i) => i.high_value_flag).length,
      // Distinct from high_value — the owner's own mark, not a valuation.
      owner_flagged_important: items.filter((i) => i.owner_high_value).length,
      // Items the owner wrote a comment on — always a subset of
      // owner_flagged_important, because a non-empty comment auto-flags.
      owner_commented_important: items.filter((i) => (i.owner_important_comment ?? '').length > 0).length,
    },
    disclaimer: NON_BINDING_DISCLAIMER,
  };
}

export function parseEnvelope(json) {
  const env = typeof json === 'string' ? JSON.parse(json) : json;
  if (env.format !== EXCHANGE_FORMAT) throw ExchangeVersionError(`${env.format ?? 'unknown'}`);
  const major = String(env.version ?? '').split('.')[0];
  if (major !== '1') throw ExchangeVersionError(env.version);
  return env;
}
