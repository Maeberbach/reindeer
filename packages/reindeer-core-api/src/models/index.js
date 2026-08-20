/**
 * Canonical domain models for the Legacy product line.
 * Both Reindeer Registry and Reindeer: FairPlay depend on these definitions
 * so the two apps can never drift apart on what an "item" is.
 */

export const ORIGIN_APP = Object.freeze({
  INVENTORY: 'inventory',
  DISTRIBUTION: 'distribution',
});

export const CONDITION = Object.freeze({
  NEW: 'new',
  GOOD: 'good',
  FAIR: 'fair',
  POOR: 'poor',
  UNKNOWN: 'unknown',
});

export const VALUE_BASIS = Object.freeze({
  AI_ESTIMATE: 'ai_estimate',
  OWNER: 'owner',
  APPRAISAL: 'appraisal',
  UNKNOWN: 'unknown',
});

export const REVIEW_STATE = Object.freeze({
  DRAFT: 'draft',
  KEPT: 'kept',
  REJECTED: 'rejected',
  DUPLICATE_PENDING: 'duplicate_pending',
});

export const PRINT_STATE = Object.freeze({
  UNPRINTED: 'unprinted',
  PRINTED: 'printed',
  STALE: 'stale',
});

export const EXPORT_STATE = Object.freeze({
  NEVER: 'never',
  EXPORTED: 'exported',
  CHANGED_SINCE_EXPORT: 'changed_since_export',
});

export const PHOTO_ROLE = Object.freeze({
  PRIMARY: 'primary',
  DETAIL: 'detail',
  SERIAL: 'serial',
  PROVENANCE: 'provenance',
});

export const MEDIA_KIND = Object.freeze({
  PHOTO: 'photo',
  VIDEO: 'video',
  AUDIO: 'audio',
});

/** Roles a voice or video recording can play. */
export const RECORDING_ROLE = Object.freeze({
  ITEM_STORY: 'item_story',          // "this is the watch my father carried"
  ITEM_WALKAROUND: 'item_walkaround', // video circling one object
  ROOM_WALKTHROUGH: 'room_walkthrough',
  OWNER_STATEMENT: 'owner_statement', // a message to the whole family
});

export const MEDIA_ACCEPT = Object.freeze({
  photo: ['image/jpeg', 'image/png', 'image/webp', 'image/heic'],
  video: ['video/mp4', 'video/quicktime', 'video/webm'],
  audio: ['audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav'],
});

export function mediaKindFor(mimeType = '') {
  if (mimeType.startsWith('video/')) return MEDIA_KIND.VIDEO;
  if (mimeType.startsWith('audio/')) return MEDIA_KIND.AUDIO;
  return MEDIA_KIND.PHOTO;
}

export const DELIVERY_METHOD = Object.freeze({
  EMAIL_ATTACHMENT: 'email_attachment',
  EMAIL_LINK: 'email_link',
  DOWNLOAD: 'download',
});

export const DELIVERY_STATE = Object.freeze({
  PREPARED: 'prepared',
  SENT: 'sent',
  FAILED: 'failed',
  DOWNLOADED: 'downloaded',
});

/**
 * Most mail servers reject messages over roughly 25 MB including encoding
 * overhead. Anything larger goes out as a link instead of an attachment.
 */
export const MAX_EMAIL_ATTACHMENT_BYTES = 18 * 1024 * 1024;

export const SCOPE_TYPE = Object.freeze({
  INVENTORY: 'inventory',
  ESTATE: 'estate',
});

/**
 * The five failure modes this product line exists to prevent.
 * Referenced by print templates and by the export envelope so the "why"
 * travels with the data instead of living only in a design document.
 */
export const FAILURE_MODE = Object.freeze({
  UNDOCUMENTED: 'undocumented',
  UNASSIGNED: 'unassigned',
  ABSENT_WHEN_LOOKED_FOR: 'absent_when_looked_for',
  PROMISED: 'promised',
  UNFAIR: 'unfair',
});

export const NON_BINDING_DISCLAIMER =
  'Owner wishes only. Not a will, codicil, or personal property memorandum. ' +
  'Consult an attorney to give these wishes legal effect.';

/*
 * Registry starts small on purpose.
 *
 * FairPlay is the comprehensive one: fifteen rooms and twenty-five legally
 * aware categories, because a captain dividing an estate needs every
 * distinction the law draws. Registry has the opposite job. Someone
 * standing in their own living room with a phone is trying to get things
 * written down at all, and a wall of thirty buttons is how that stops. So the
 * seeded list is the handful of rooms nearly every house has, and everything
 * else waits in a dropdown until the owner asks for it.
 *
 * Safe Deposit Box is in the visible list rather than the dropdown, even though
 * it is not a room in the house. It holds the small valuable things and it is
 * the single most commonly forgotten place in an estate. Burying it behind a
 * dropdown would mean it is only found by someone who already remembered it,
 * which defeats the point of listing it.
 *
 * Spellings match FairPlay's STANDARD_ROOMS exactly wherever both lists
 * carry the same room, so a handed-off inventory maps by name with nothing to
 * accept. Safe Deposit Box has no FairPlay equivalent and will be offered
 * there as a new name.
 *
 * Nothing here is required. An item saves with no room at all, and always has.
 */
export const DEFAULT_ROOMS = Object.freeze([
  'Living Room', 'Kitchen', 'Dining Room', 'Family Room',
  'Primary Bedroom', 'Bedroom 2', 'Bedroom 3',
  'Office/Study', 'Garage', 'Safe Deposit Box', 'Other',
]);

/**
 * Offered in the "Add another room" dropdown, not seeded.
 *
 * A room only becomes a button once the owner picks it, so the list they see
 * stays as short as the house they actually have.
 */
export const MORE_ROOMS = Object.freeze([
  'Attic', 'Basement', 'Bathroom', 'Closet',
  'Outdoor/Yard', 'Shed', 'Storage', 'Miscellaneous',
]);

/*
 * Nine categories on screen, and twenty more kept silent behind a dropdown.
 *
 * This list is not a filing system. It is a prompt. Every visible name except
 * "Everything else" is a kind of thing families are known to fall out over, so
 * seeing it asks the owner a question: is there someone particular you want to
 * have this? If the answer is yes the item belongs in the memorandum by name.
 * If it is no, "Everything else" takes it and the app handles the rest.
 *
 * That is why the words are the owner's rather than the law's. FairPlay
 * carries twenty-five legally aware categories because a personal
 * representative needs every distinction the law draws, but the person standing
 * in their own hallway with a phone is not serving the law yet. "Guns" is what
 * an owner calls them; Firearms is what the statute calls them; both can be
 * true, in the place each belongs.
 *
 * Four of the nine map to a FairPlay label exactly and arrive locked, with
 * no AI involved: Jewelry, Photographs, Vehicles, and Guns by way of the alias
 * to Firearms. The other five are the owner's shorthand and FairPlay may
 * unpack them after import. Unpacking only ever changes the category — an heir
 * the owner named is never touched. See REGISTRY_CATEGORY_MAP in
 * @reindeer-legacy/exchange for the mapping.
 *
 * Guns and Vehicles sit below "Everything else" rather than above it. They are
 * not household goods to be argued over so much as regulated and titled
 * property that has to be handled on its own terms, and the break in the list
 * says so without a word of explanation.
 *
 * Nothing here is required. An item saves with no category at all.
 */
export const DEFAULT_CATEGORIES = Object.freeze([
  'Sentimental items',
  'Jewelry',
  'Holiday ornaments',
  'Heirloom and special furniture',
  'Collectibles — artwork, rare wine or spirits',
  'Photographs',
  'Everything else',
  'Guns',
  'Vehicles',
]);

/**
 * Offered in the "Add another kind" dropdown, not seeded.
 *
 * These stay silent until the owner pulls one out, and every name here is a
 * FairPlay label spelled exactly — so an owner who deliberately reaches for
 * "Coins & Stamps" rather than accepting a coarse bucket gets the precise
 * category, and it arrives locked with no AI involved. Choosing precisely is
 * always allowed; it is simply never demanded.
 *
 * Miscellaneous is absent on purpose: "Everything else" already fills that
 * role, in plainer words, and maps onto it.
 */
export const MORE_CATEGORIES = Object.freeze([
  'Art & Decor', 'Precious Metals & Bullion', 'Coins & Stamps', 'Silver & China',
  'Rugs & Antiques', 'Collectibles', 'Musical Instruments', 'Wine & Spirits',
  'Heirlooms', 'Personal Possessions', 'Furniture', 'Real Property Contents',
  'Kitchenware', 'Electronics', 'Tools', 'Books',
  'Sporting Goods', 'Clothing', 'Documents', 'Digital Assets',
  // Added for the "Things families fight over" flow. These are categories
  // trustees repeatedly report as the hardest to divide because they carry
  // strong personal memory and no market price. They stay in MORE (not
  // DEFAULT) so they only appear when the owner opts in.
  'Letters & Journals', 'Recipes', 'Watches', 'Handmade Items',
]);

/**
 * Create a well-formed ItemRecord with every field defaulted.
 * Callers should never hand-build item objects.
 */
export function makeItemRecord(input = {}) {
  const now = new Date().toISOString();
  return {
    item_id: input.item_id ?? null,
    origin_app: input.origin_app ?? ORIGIN_APP.INVENTORY,
    origin_item_id: input.origin_item_id ?? null,
    title: input.title ?? '',
    category_id: input.category_id ?? null,
    room_id: input.room_id ?? null,
    description: input.description ?? '',
    story: input.story ?? '',
    quantity: input.quantity ?? 1,
    condition: input.condition ?? CONDITION.UNKNOWN,
    identifiers: input.identifiers ?? {},
    value_estimate_cents: input.value_estimate_cents ?? null,
    value_basis: input.value_basis ?? VALUE_BASIS.UNKNOWN,
    high_value_flag: input.high_value_flag ?? false,
    // The owner's own "this matters" mark, kept strictly separate from
    // high_value_flag (which FairPlay computes from an AI value estimate).
    // owner_high_value_reason is '' when unflagged or flagged without a stated
    // reason, and 'feeling' | 'money' | 'both' when the owner offered one.
    owner_high_value: input.owner_high_value ?? false,
    owner_high_value_reason: input.owner_high_value_reason ?? '',
    // Owner-authored comment kept with the item for legacy value. Prints on
    // paper as written; travels through export/import. Empty string is the
    // "no comment" state. Coupling with owner_high_value is asymmetric and
    // is applied in validateItemRecord, not here — see the spec at
    // docs/decisions/2026-08-06-important-comment.md.
    owner_important_comment: input.owner_important_comment ?? '',
    ownership_tag: input.ownership_tag ?? 'mine',
    // Tentative high-value: helper or AI flag that queues for owner review
    // before becoming a permanent owner_high_value mark. Source is 'helper'
    // or 'ai'; reason is free text explaining why it was flagged.
    tentative_high_value: input.tentative_high_value ?? false,
    tentative_high_value_source: input.tentative_high_value_source ?? '',
    tentative_high_value_reason: input.tentative_high_value_reason ?? '',
    ai_confidence: input.ai_confidence ?? null,
    // Geolocation — browser GPS captured at intake, plus EXIF GPS extracted
    // from the photo itself. Two independent sources that corroborate each
    // other for room/site verification. captured_lat/lon = browser;
    // photo_lat/lon + photo_taken_at = JPEG EXIF metadata.
    captured_lat: input.captured_lat ?? null,
    captured_lon: input.captured_lon ?? null,
    photo_lat: input.photo_lat ?? null,
    photo_lon: input.photo_lon ?? null,
    photo_taken_at: input.photo_taken_at ?? null,
    // AI-suggested value range stored as metadata. Advisory only — the
    // registry never treats it as authoritative. Persisted so the owner
    // can see it on the final review screen before printing.
    ai_value_suggestion: input.ai_value_suggestion ?? null,
    ai_value_unknown_reason: input.ai_value_unknown_reason ?? null,
    review_state: input.review_state ?? REVIEW_STATE.DRAFT,
    print_state: input.print_state ?? PRINT_STATE.UNPRINTED,
    export_state: input.export_state ?? EXPORT_STATE.NEVER,
    created_at: input.created_at ?? now,
    updated_at: input.updated_at ?? now,
  };
}

/** Intended recipient. Deliberately free text and never binding. */
export function makeRecipientHint(input = {}) {
  return {
    item_id: input.item_id ?? null,
    recipient_name: input.recipient_name ?? '',
    relationship: input.relationship ?? '',
    alternate_name: input.alternate_name ?? '',
    owner_note: input.owner_note ?? '',
    is_binding: false,
  };
}

/** Scope context. Generalizes the estate-scoped query guard to both apps. */
export function makeScopeCtx({ scopeType, scopeId, actorId = 'owner', permissions = {} }) {
  if (!Object.values(SCOPE_TYPE).includes(scopeType)) {
    throw new Error(`Unknown scopeType: ${scopeType}`);
  }
  if (!scopeId) throw new Error('scopeId is required — unscoped queries are forbidden');
  return Object.freeze({ scopeType, scopeId, actorId, permissions });
}
