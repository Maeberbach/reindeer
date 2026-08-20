/** Flat CSV projection for spreadsheets and attorney review. */

// The order here is the on-disk order. Anything reading by column position
// rather than by header will shift when new columns are added. The rule is:
// new columns append at the end — never rename, reorder, or drop existing ones
// — so an older reader that keeps its own column list keeps working, and a new
// reader that keys by header sees everything.
export const CSV_COLUMNS = [
  'item_id', 'title', 'room', 'category', 'quantity', 'condition',
  'description', 'story', 'brand', 'model', 'serial',
  'value_estimate_usd', 'value_basis', 'high_value',
  'intended_recipient', 'relationship', 'alternate_recipient', 'owner_note',
  'photo_count', 'primary_photo_file', 'recorded_at',
  // Owner's own "this matters" mark. Kept separate from `high_value` (that is
  // FairPlay's computed field). Reason is '', 'feeling', 'money', or 'both'.
  'owner_important', 'owner_important_reason',
  // Owner-authored comment, verbatim. Appended at the end so older readers
  // that key by fixed column position keep working. See
  // docs/decisions/2026-08-06-important-comment.md.
  'owner_important_comment',
  // AI advisory value range (low/high in USD). Appended at end for backwards
  // compat. Never printed on the memorandum — for owner and fiduciary use only.
  'ai_value_low_usd', 'ai_value_high_usd', 'ai_value_unknown_reason',
];

const cell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(envelope) {
  const rows = [CSV_COLUMNS.join(',')];
  for (const i of envelope.items) {
    const ids = i.identifiers ?? {};
    rows.push([
      i.item_id, i.title, i.room_name, i.category_name, i.quantity, i.condition,
      i.description, i.story, ids.brand, ids.model, ids.serial,
      i.value_estimate_cents == null ? '' : (i.value_estimate_cents / 100).toFixed(2),
      i.value_basis, i.high_value_flag ? 'yes' : 'no',
      i.recipient_hint?.recipient_name, i.recipient_hint?.relationship,
      i.recipient_hint?.alternate_name, i.recipient_hint?.owner_note,
      i.photos.length, i.photos[0]?.file, i.created_at,
      i.owner_high_value ? 'yes' : 'no', i.owner_high_value_reason ?? '',
      i.owner_important_comment ?? '',
      i.ai_value_suggestion?.low_cents == null ? '' : (i.ai_value_suggestion.low_cents / 100).toFixed(2),
      i.ai_value_suggestion?.high_cents == null ? '' : (i.ai_value_suggestion.high_cents / 100).toFixed(2),
      i.ai_value_unknown_reason ?? '',
    ].map(cell).join(','));
  }
  // Trailing note so a printed or emailed CSV carries the disclaimer too.
  rows.push('');
  rows.push(cell(`# ${envelope.disclaimer}`));
  return rows.join('\r\n');
}
