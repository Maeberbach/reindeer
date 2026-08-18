/**
 * Two-Output Delivery Model envelopes
 * (docs/specs/2026-08-09-registry-two-outputs.md).
 *
 * Registry has two distinct legal outputs, not one:
 *
 *   1. Household inventory   \u2014 the complete list, trustee-only, delivered
 *                              at death, one shared per household.
 *   2. Specific-giving addendum \u2014 only assigned items with owner-taken
 *                                 close-up photos and (optionally) an
 *                                 owner voice message; delivered every
 *                                 time it is signed, one per spouse in
 *                                 Couple mode; goes to BOTH the
 *                                 wills-storage caretaker and the trustee.
 *
 * These two shapes are additive alongside the existing v1 envelope
 * (`./envelope.js`), which continues to serve the current
 * writeBundle / importBundle path unchanged. Nothing else in the suite
 * consumes these new envelopes yet \u2014 the delivery layer, UI, and
 * signing flow follow in later commits.
 *
 * Distinguish by the top-level `envelope_type` field:
 *   \u2022 "inventory"  \u2014 whole household, one recipient (trustee)
 *   \u2022 "addendum"   \u2014 assigned items only, versioned, two recipients
 *
 * `envelope_version` is 1.0 for both. Bumping either shape is a major
 * schema change and gets its own migration + version bump.
 */

import { NON_BINDING_DISCLAIMER, ExchangeVersionError } from '@reindeer-legacy/core-api';

export const ENVELOPE_FORMAT = 'legacy-exchange';
export const ENVELOPE_TYPE_INVENTORY = 'inventory';
export const ENVELOPE_TYPE_ADDENDUM = 'addendum';
export const TYPED_ENVELOPE_VERSION = '1.0';

/**
 * Build the household inventory envelope.
 *
 * Wide-shot photos and AI-assisted crops are fine here \u2014 the inventory's
 * job is completeness, not per-item legal weight. Owner-Important marks
 * and comments ride through. No per-item assignments, no voice notes:
 * both belong to the addendum.
 */
export function buildInventoryEnvelope({
  items,
  rooms,
  categories,
  estateId,
  trigger = 'manual_test',
  recipient,
  source,
  generatedAt = new Date(),
}) {
  if (!estateId) throw new Error('buildInventoryEnvelope: estateId is required');
  if (!recipient?.role) throw new Error('buildInventoryEnvelope: recipient.role is required');
  if (!VALID_TRIGGERS.has(trigger)) {
    throw new Error(`buildInventoryEnvelope: unknown trigger ${JSON.stringify(trigger)}`);
  }
  const allMedia = (i) => i.media ?? i.photos ?? [];
  const envelopeItems = items.map((i) => ({
    id: i.item_id,
    name: i.title,
    room_id: i.room_id ?? null,
    room: i.room?.name ?? null,
    category_id: i.category_id ?? null,
    category: i.category?.name ?? null,
    description: i.description ?? '',
    story: i.story ?? '',
    quantity: i.quantity ?? 1,
    condition: i.condition ?? 'unknown',
    identifiers: i.identifiers ?? {},
    photos: allMedia(i)
      .filter((p) => (p.media_kind ?? 'photo') === 'photo')
      .map((p) => ({
        role: p.role ?? 'primary',
        file: `media/${p.file_name}`,
        crop_bbox: p.crop_bbox ?? null,
        checksum: p.sha256 ?? null,
      })),
    owner_important: {
      flagged: !!i.owner_high_value,
      reason: i.owner_high_value_reason ?? '',
      comment: i.owner_important_comment ?? '',
    },
    // Assignment lives in the addendum, not here. The inventory's job is
    // to answer "what personal property exists?" \u2014 not "who gets it?".
    assigned_to_heir_id: null,
    // No per-item audio in the inventory. A whole-family voice message
    // rides with the addendum, not with the inventory. Kept as null so
    // trustees consuming the JSON don't have to feature-detect the key.
    voice_note_ref: null,
  }));
  const roomsInUse = new Set(envelopeItems.map((it) => it.room_id).filter(Boolean));
  return {
    format: ENVELOPE_FORMAT,
    envelope_type: ENVELOPE_TYPE_INVENTORY,
    envelope_version: TYPED_ENVELOPE_VERSION,
    estate_id: estateId,
    trigger,
    generated_at: generatedAt.toISOString(),
    recipient: {
      role: recipient.role,
      name: recipient.name ?? '',
      contact: recipient.contact ?? '',
      delivery_method: recipient.delivery_method ?? 'email',
    },
    source: source ?? null,
    rooms: (rooms ?? []).map((r) => ({ id: r.room_id, name: r.name, is_custom: !!r.is_custom })),
    categories: (categories ?? []).map((c) => ({ id: c.category_id, name: c.name, is_custom: !!c.is_custom })),
    items: envelopeItems,
    counts: {
      total_items: envelopeItems.length,
      rooms: roomsInUse.size,
      // For visibility only \u2014 assignments never leave through this envelope.
      // If the number is non-zero, the addendum envelope carries the detail.
      assigned: items.filter((i) => i.assigned_to_heir_id).length,
      owner_important: envelopeItems.filter((it) => it.owner_important.flagged).length,
    },
    disclaimer: NON_BINDING_DISCLAIMER,
  };
}

const VALID_TRIGGERS = new Set(['death', 'manual_test']);
const VALID_RECIPIENT_ROLES = new Set(['wills_caretaker', 'trustee']);
const VALID_CLOSEUP_SOURCES = new Set(['owner_camera']);

/**
 * Build the specific-giving addendum envelope.
 *
 * Assigned items only. Every item MUST carry an owner-taken close-up
 * photo (source='owner_camera') OR appear in the `gaps` list. Gaps do
 * NOT block signing per the spec, but they ARE surfaced to the legal
 * recipients so they know what's missing.
 *
 * Recipients: at minimum a trustee. The wills-storage caretaker is
 * strongly recommended per spec; if absent, the caller records that on
 * the print-out ("No wills-storage caretaker on file"), the envelope
 * does not force it.
 *
 * `voiceMessage` may be null; when present, it is Opus audio with a
 * transcript, per the owner-voice-message spec.
 */
export function buildAddendumEnvelope({
  estateId,
  owner,
  version,
  supersedes = null,
  supersedesDeliveredAt = null,
  recipients,
  voiceMessage = null,
  items,
  gaps = [],
  source,
  generatedAt = new Date(),
}) {
  if (!estateId) throw new Error('buildAddendumEnvelope: estateId is required');
  if (!owner?.participant_id) throw new Error('buildAddendumEnvelope: owner.participant_id is required');
  if (!Number.isInteger(version) || version < 1) {
    throw new Error('buildAddendumEnvelope: version must be a positive integer');
  }
  if (supersedes !== null && (!Number.isInteger(supersedes) || supersedes < 1 || supersedes >= version)) {
    throw new Error('buildAddendumEnvelope: supersedes must be null or a prior version number');
  }
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new Error('buildAddendumEnvelope: at least one recipient is required');
  }
  for (const r of recipients) {
    if (!VALID_RECIPIENT_ROLES.has(r.role)) {
      throw new Error(`buildAddendumEnvelope: unknown recipient role ${JSON.stringify(r.role)}`);
    }
  }
  if (!Array.isArray(items)) {
    throw new Error('buildAddendumEnvelope: items must be an array');
  }
  const gapItemIds = new Set(gaps.map((g) => g.item_id));
  const envelopeItems = items.map((i) => {
    if (!i.assigned_to?.name) {
      throw new Error(`buildAddendumEnvelope: item ${i.item_id ?? '(unknown)'} has no assigned_to.name`);
    }
    const closeup = i.closeup_photo ?? null;
    if (closeup && !VALID_CLOSEUP_SOURCES.has(closeup.source)) {
      throw new Error(
        `buildAddendumEnvelope: item ${i.item_id} closeup source must be 'owner_camera', not ${JSON.stringify(closeup.source)}`,
      );
    }
    if (!closeup && !gapItemIds.has(i.item_id)) {
      throw new Error(
        `buildAddendumEnvelope: item ${i.item_id} has no closeup_photo and is not listed in gaps`,
      );
    }
    return {
      id: i.item_id,
      name: i.title,
      room: i.room?.name ?? i.room_name ?? null,
      assigned_to: {
        name: i.assigned_to.name,
        relationship: i.assigned_to.relationship ?? '',
        heir_id: i.assigned_to.heir_id ?? null,
        // 'heir' = will-heir; 'named_recipient' = friend/godchild/charity/other.
        // Downstream FairPlay imports only heirs; a named_recipient is
        // handled by the memorandum alone and never enters the game.
        recipient_type: i.assigned_to.recipient_type ?? 'heir',
      },
      // The owner's own words for this item. Repurposes the existing
      // owner_important_comment for its addendum-legal role \u2014 same field,
      // more visible surface.
      owner_words: i.owner_words ?? i.owner_important_comment ?? '',
      closeup_photo: closeup
        ? {
          file: closeup.file ?? `media/${closeup.file_name}`,
          checksum: closeup.checksum ?? closeup.sha256 ?? null,
          captured_at: closeup.captured_at ?? null,
          source: closeup.source,
          gap_reason: null,
        }
        : null,
    };
  });
  const voice = voiceMessage
    ? {
      file: voiceMessage.file ?? (voiceMessage.file_name ? `media/${voiceMessage.file_name}` : null),
      transcript: voiceMessage.transcript ?? '',
      duration_seconds: voiceMessage.duration_seconds
        ?? (voiceMessage.duration_ms ? Math.round(voiceMessage.duration_ms / 1000) : null),
      recorded_at: voiceMessage.recorded_at ?? null,
      checksum: voiceMessage.checksum ?? voiceMessage.sha256 ?? null,
      byte_size: voiceMessage.byte_size ?? null,
    }
    : null;
  return {
    format: ENVELOPE_FORMAT,
    envelope_type: ENVELOPE_TYPE_ADDENDUM,
    envelope_version: TYPED_ENVELOPE_VERSION,
    estate_id: estateId,
    generated_at: generatedAt.toISOString(),
    owner: {
      participant_id: owner.participant_id,
      name: owner.name ?? '',
      signed_at: owner.signed_at ?? generatedAt.toISOString(),
      signature_evidence: owner.signature_evidence ?? {},
    },
    addendum_version: version,
    supersedes_version: supersedes,
    supersedes_delivered_at: supersedesDeliveredAt,
    recipients: recipients.map((r) => ({
      role: r.role,
      name: r.name ?? '',
      contact: r.contact ?? '',
      delivery_method: r.delivery_method ?? 'email',
      delivered_at: r.delivered_at ?? null,
    })),
    voice_message: voice,
    items: envelopeItems,
    gaps: gaps.map((g) => ({
      item_id: g.item_id,
      reason: g.reason ?? 'closeup_photo_missing',
    })),
    source: source ?? null,
    counts: {
      assigned_items: envelopeItems.length,
      items_with_closeup: envelopeItems.filter((i) => i.closeup_photo).length,
      items_with_gap: gaps.length,
      recipients: recipients.length,
      has_voice_message: !!voice,
    },
    disclaimer: NON_BINDING_DISCLAIMER,
  };
}

/**
 * Parse an inventory or addendum envelope from JSON or an already-parsed
 * object. Dispatches on the `envelope_type` field.
 *
 * Rejects the legacy untyped envelope (format='legacy-exchange',
 * version='1.0' with no envelope_type) with a clear message \u2014 that
 * envelope is served by the existing parseEnvelope() in envelope.js.
 */
export function parseTypedEnvelope(json) {
  const env = typeof json === 'string' ? JSON.parse(json) : json;
  if (env.format !== ENVELOPE_FORMAT) {
    throw ExchangeVersionError(`${env.format ?? 'unknown'}`);
  }
  if (!env.envelope_type) {
    throw new Error(
      'parseTypedEnvelope: envelope is not a typed envelope (missing envelope_type). '
      + 'Use parseEnvelope() from envelope.js for the legacy v1 shape.',
    );
  }
  const major = String(env.envelope_version ?? '').split('.')[0];
  if (major !== '1') throw ExchangeVersionError(env.envelope_version);
  if (env.envelope_type !== ENVELOPE_TYPE_INVENTORY && env.envelope_type !== ENVELOPE_TYPE_ADDENDUM) {
    throw new Error(`parseTypedEnvelope: unknown envelope_type ${JSON.stringify(env.envelope_type)}`);
  }
  return env;
}
