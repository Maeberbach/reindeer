/**
 * Validation. Hand-rolled to keep @reindeer-legacy/core-api dependency-free —
 * swap for zod later without changing call sites, since every validator
 * returns { ok, value, errors }.
 */

import {
  CONDITION, VALUE_BASIS, REVIEW_STATE, PRINT_STATE, EXPORT_STATE,
  ORIGIN_APP, PHOTO_ROLE, makeItemRecord,
} from '../models/index.js';

const isStr = (v) => typeof v === 'string';
const oneOf = (obj) => Object.values(obj);

// The four values `owner_high_value_reason` may take. Kept as a plain array
// here rather than an exported enum: the field carries the owner's own words
// through the app, and treating it like a state machine invites callers to
// grow the list without thinking about what it means on paper.
export const OWNER_HIGH_VALUE_REASONS = Object.freeze(['', 'feeling', 'money', 'both']);

// Length cap on the owner-authored comment (see
// docs/decisions/2026-08-06-important-comment.md). 500 characters is enough
// for a real paragraph and short enough to fit on a print sheet without
// crowding out the item's other fields. Applied post-trim.
export const OWNER_IMPORTANT_COMMENT_MAX = 500;

export function validateItemRecord(input) {
  const errors = [];
  const item = makeItemRecord(input);

  // No title required — a photograph is enough. Falls back to a placeholder
  // so the owner is never blocked from saving an item they haven't named yet.
  if (!isStr(item.title) || item.title.trim() === '') {
    item.title = 'Unnamed item — see photograph';
  }
  if (item.title.length > 200) {
    errors.push({ field: 'title', message: 'Title must be 200 characters or fewer' });
  }
  if (!Number.isInteger(item.quantity) || item.quantity < 1) {
    errors.push({ field: 'quantity', message: 'Quantity must be a whole number of at least 1' });
  }
  if (!oneOf(CONDITION).includes(item.condition)) {
    errors.push({ field: 'condition', message: `Condition must be one of ${oneOf(CONDITION).join(', ')}` });
  }
  if (!oneOf(VALUE_BASIS).includes(item.value_basis)) {
    errors.push({ field: 'value_basis', message: 'Unknown value basis' });
  }
  if (!oneOf(REVIEW_STATE).includes(item.review_state)) {
    errors.push({ field: 'review_state', message: 'Unknown review state' });
  }
  if (!oneOf(PRINT_STATE).includes(item.print_state)) {
    errors.push({ field: 'print_state', message: 'Unknown print state' });
  }
  if (!oneOf(EXPORT_STATE).includes(item.export_state)) {
    errors.push({ field: 'export_state', message: 'Unknown export state' });
  }
  if (!oneOf(ORIGIN_APP).includes(item.origin_app)) {
    errors.push({ field: 'origin_app', message: 'Unknown origin app' });
  }
  if (item.value_estimate_cents !== null) {
    if (!Number.isInteger(item.value_estimate_cents) || item.value_estimate_cents < 0) {
      errors.push({ field: 'value_estimate_cents', message: 'Value must be a whole number of cents' });
    }
  }
  if (item.ai_confidence !== null) {
    const c = Number(item.ai_confidence);
    if (Number.isNaN(c) || c < 0 || c > 1) {
      errors.push({ field: 'ai_confidence', message: 'Confidence must be between 0 and 1' });
    }
  }
  if (item.identifiers && typeof item.identifiers !== 'object') {
    errors.push({ field: 'identifiers', message: 'Identifiers must be an object' });
  }
  // owner_high_value is a boolean; makeItemRecord already coerces the default,
  // but callers may pass 0/1 from the wire and we accept that shape here.
  if (item.owner_high_value !== undefined && item.owner_high_value !== null) {
    if (typeof item.owner_high_value !== 'boolean'
        && item.owner_high_value !== 0 && item.owner_high_value !== 1) {
      errors.push({ field: 'owner_high_value', message: 'Owner-important flag must be true or false' });
    } else {
      item.owner_high_value = !!item.owner_high_value;
    }
  }
  if (!OWNER_HIGH_VALUE_REASONS.includes(item.owner_high_value_reason ?? '')) {
    errors.push({
      field: 'owner_high_value_reason',
      message: `Reason must be one of ${OWNER_HIGH_VALUE_REASONS.filter((r) => r).join(', ')} (or left blank)`,
    });
  }
  // Ownership tag: mine (owner), theirs (partner), ours (joint).
  const OWNERSHIP_TAGS = ['mine', 'theirs', 'ours'];
  if (!OWNERSHIP_TAGS.includes(item.ownership_tag ?? 'mine')) {
    errors.push({
      field: 'ownership_tag',
      message: `Ownership tag must be one of ${OWNERSHIP_TAGS.join(', ')}`,
    });
    item.ownership_tag = 'mine';
  }
  // The owner-authored comment. Trim before length check so a hundred
  // trailing spaces don't tip a real sentence over the cap.
  if (typeof item.owner_important_comment !== 'string') {
    errors.push({
      field: 'owner_important_comment',
      message: 'Comment must be text',
    });
    item.owner_important_comment = '';
  } else {
    item.owner_important_comment = item.owner_important_comment.trim();
    if (item.owner_important_comment.length > OWNER_IMPORTANT_COMMENT_MAX) {
      errors.push({
        field: 'owner_important_comment',
        message: `Comment must be ${OWNER_IMPORTANT_COMMENT_MAX} characters or fewer`,
      });
    }
  }

  // Asymmetric coupling with owner_high_value, per the spec at
  // docs/decisions/2026-08-06-important-comment.md:
  //
  //   - a non-empty comment forces the flag on ("there was a reason to
  //     comment"). Auto-flag — the owner does not have to tick a separate
  //     box; typing the note IS the flag.
  //   - unflagging clears both the reason AND the comment ("nothing to say").
  //   - deleting a comment does NOT unflag; the flag persists once set,
  //     because "just a notice" is a valid final state.
  //
  // These are coercions, not rejections. A stale form submission cannot
  // create the impossible state "unflagged with a comment" — the coercion
  // resolves it in favour of the owner's most recent authorial act, which is
  // whichever field they last touched. That policy lives on the client; the
  // server just enforces the flag=false ⇒ comment='' constraint on write.
  if (item.owner_important_comment !== '') {
    item.owner_high_value = true;
  }
  if (!item.owner_high_value) {
    item.owner_high_value_reason = '';
    item.owner_important_comment = '';
  }

  return { ok: errors.length === 0, value: item, errors };
}

export function validatePhoto(photo) {
  const errors = [];
  if (!oneOf(PHOTO_ROLE).includes(photo.role ?? PHOTO_ROLE.PRIMARY)) {
    errors.push({ field: 'role', message: 'Unknown photo role' });
  }
  if (photo.crop_bbox != null) {
    const b = photo.crop_bbox;
    const valid = Array.isArray(b) && b.length === 4 &&
      b.every((n) => typeof n === 'number' && n >= 0 && n <= 1);
    if (!valid) errors.push({ field: 'crop_bbox', message: 'bbox must be four numbers between 0 and 1' });
  }
  return { ok: errors.length === 0, value: photo, errors };
}

/** Recipient hints are never binding, no matter what the caller sends. */
export function validateRecipientHint(hint) {
  const errors = [];
  if (hint.recipient_name && hint.recipient_name.length > 120) {
    errors.push({ field: 'recipient_name', message: 'Name must be 120 characters or fewer' });
  }
  return { ok: errors.length === 0, value: { ...hint, is_binding: false }, errors };
}

/** JSON Schema published alongside the exchange format for outside consumers. */
export const ITEM_JSON_SCHEMA = {
  $id: 'https://legacy.local/schema/item-record-v1.json',
  type: 'object',
  required: ['item_id', 'title', 'quantity'],
  properties: {
    item_id: { type: 'string' },
    origin_app: { enum: oneOf(ORIGIN_APP) },
    origin_item_id: { type: ['string', 'null'] },
    title: { type: 'string', maxLength: 200 },
    category_id: { type: ['string', 'null'] },
    room_id: { type: ['string', 'null'] },
    description: { type: 'string' },
    story: { type: 'string' },
    quantity: { type: 'integer', minimum: 1 },
    condition: { enum: oneOf(CONDITION) },
    identifiers: { type: 'object' },
    value_estimate_cents: { type: ['integer', 'null'], minimum: 0 },
    value_basis: { enum: oneOf(VALUE_BASIS) },
    high_value_flag: { type: 'boolean' },
    // Owner's own mark, distinct from FairPlay's computed high_value_flag.
    owner_high_value: { type: 'boolean' },
    owner_high_value_reason: { enum: ['', 'feeling', 'money', 'both'] },
    // Free-text owner note. Server-side length cap enforced in the
    // validator, not in the schema, so the number can move without a
    // schema-format bump.
    owner_important_comment: { type: 'string' },
    ai_confidence: { type: ['number', 'null'], minimum: 0, maximum: 1 },
  },
};
