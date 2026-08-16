import { NON_BINDING_DISCLAIMER } from '@reindeer/core-api';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (c) => (c == null ? '' : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;
const dur = (ms) => (ms == null ? '' : `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}`);

/**
 * The cover packet a trustee prints and files with the estate documents.
 *
 * The paper is the durable copy. It must let a person who has never opened the
 * software confirm the package is complete, know what is inside it, and prove
 * years later that nothing was altered.
 */
const ROLE_WORDS = {
  trustee: 'Trustee', captain: 'Trustee',
  executor: 'Trustee (also called executor)', attorney: 'Attorney', other: 'Other',
};
const HOLDS_WORDS = {
  holds_original: 'Holds the signed original',
  seen_original: 'Has seen the signed original',
  copy_only: 'Copy only',
};

/** scope_media.transcript carries JSON for execution rows and plain text elsewhere. */
function safeMeta(row) {
  try { return JSON.parse(row?.transcript || '{}') || {}; } catch { return {}; }
}

export function renderTrusteePacket({
  ownerName, trustee, manifest, items = [], scopeMedia = [], delivery = {}, bundleSha256, generatedAt = new Date(),
  /*
   * Optional couple-mode context. If omitted, the cover sheet renders
   * exactly as it did before Slice 4 — back-compat with any caller that
   * has not been updated yet.
   *
   *   householdMode   'solo' | 'couple' — changes section copy
   *
   * Slice A rebuild: the Important section now reads directly from the
   * item flag (owner_high_value) plus the optional owner comment. The
   * old proposed/agreed workflow was removed; either partner tagging an
   * item Important is treated as the household's stated view, matching
   * the real-world model where couples agree in real time and one of
   * them records the outcome.
   */
  householdMode = 'solo',
}) {
  const counts = manifest?.counts ?? {};
  const withRecordings = items.filter((i) => (i.media ?? []).some((m) => m.media_kind !== 'photo'));
  const noRecipient = items.filter((i) => !i.recipient_hint?.recipient_name).length;
  /* Items where the owner wrote something in her own words about the item.
     These print verbatim below each row so the trustee reads the actual
     sentence, not just the recipient name from the structured hint. See
     docs/handoffs/2026-08-07-trustee-report-owner-comments-and-fc-preassignment.md. */
  const withOwnerComment = items.filter((i) => (i.owner_important_comment ?? '').trim().length > 0).length;

  /* The signed memorandum, if the owner got that far. It is the difference
     between a helpful inventory and a document with legal effect, so it leads
     the packet rather than being buried in the media table. */
  const signedRow = scopeMedia.find((m) => m.media_kind === 'signed_memorandum' && !safeMeta(m).superseded);
  const signed = signedRow ? safeMeta(signedRow) : null;
  const attestations = signed?.attestations ?? [];

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Estate inventory package — ${esc(ownerName)}</title>
<style>
  @page { size: letter; margin: 0.75in; }
  body { font: 12pt/1.5 Georgia, 'Times New Roman', serif; color: #111; }
  h1 { font-size: 20pt; margin: 0 0 2pt; }
  h2 { font-size: 13pt; border-bottom: 1.5pt solid #111; padding-bottom: 3pt; margin: 22pt 0 8pt; page-break-after: avoid; }
  .sub { font-size: 11pt; color: #444; margin: 0 0 18pt; }
  table { width: 100%; border-collapse: collapse; font-size: 10.5pt; }
  th, td { text-align: left; padding: 4pt 6pt; border-bottom: 0.5pt solid #bbb; vertical-align: top; }
  th { border-bottom: 1pt solid #111; font-size: 9.5pt; text-transform: uppercase; letter-spacing: .04em; }
  .num { text-align: right; white-space: nowrap; }
  .box { border: 1pt solid #111; padding: 10pt 12pt; margin: 12pt 0; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4pt 18pt; font-size: 11pt; }
  .k { color: #555; }
  .check { list-style: none; padding: 0; }
  .check li { margin: 0 0 9pt; padding-left: 26pt; text-indent: -26pt; }
  .check li::before { content: "\\2610"; font-size: 15pt; padding-right: 9pt; }
  .hash { font-family: 'Courier New', monospace; font-size: 8.5pt; word-break: break-all; }
  .sig { margin-top: 26pt; display: grid; grid-template-columns: 1fr 1fr; gap: 26pt; }
  .sig div { border-top: 0.75pt solid #111; padding-top: 4pt; font-size: 10pt; color: #444; }
  .warn { background: #f4f4f4; border-left: 3pt solid #111; padding: 8pt 12pt; font-size: 10.5pt; }
  footer { margin-top: 22pt; border-top: 0.5pt solid #999; padding-top: 6pt; font-size: 9pt; color: #555; }
  .pb { page-break-before: always; }
  /* Owner comment call-out under the item row. The comment is printed
     verbatim, including any dollar figures or valuation language the owner
     chose to include. Registry and this packet never censor the owner. */
  .owner-comment-row td { border-bottom: 0.5pt solid #bbb; padding: 0 6pt 8pt; }
  .owner-comment { background: #f8f3e4; border-left: 3pt solid #8a6d1f; padding: 6pt 10pt; margin: 2pt 0 0; font-size: 10.5pt; }
  .owner-comment .lbl { display: block; font-size: 9pt; letter-spacing: .06em; text-transform: uppercase; color: #6b571a; margin-bottom: 2pt; }
  .owner-comment .body { white-space: pre-wrap; font-style: italic; }
  .assigned-mark { display: inline-block; margin-left: 4pt; font-size: 9pt; letter-spacing: .04em; color: #6b571a; font-weight: bold; }
</style></head><body>

<h1>Estate inventory package</h1>
<p class="sub">Prepared by ${esc(ownerName)} &middot; delivered to ${esc(trustee?.name ?? 'the trustee')}
  &middot; ${generatedAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p>

<div class="box">
  <div class="grid">
    <div><span class="k">Package reference</span><br><strong>${esc(manifest?.batch_id ?? '—')}</strong></div>
    <div><span class="k">Delivered by</span><br><strong>${esc(labelMethod(delivery.method))}</strong></div>
    <div><span class="k">Items documented</span><br><strong>${counts.items ?? items.length}</strong></div>
    <div><span class="k">Photographs</span><br><strong>${counts.photos ?? 0}</strong></div>
    <div><span class="k">Video recordings</span><br><strong>${counts.videos ?? 0}</strong></div>
    <div><span class="k">Voice recordings</span><br><strong>${counts.audio ?? 0}</strong></div>
    <div><span class="k">Package size</span><br><strong>${mb(manifest?.total_media_bytes ?? delivery.byte_size ?? 0)}</strong></div>
    <div><span class="k">Items with a stated wish</span><br><strong>${counts.with_recipient_hint ?? 0}</strong></div>
    <div><span class="k">Items with a written comment</span><br><strong>${withOwnerComment}</strong></div>
  </div>
</div>

${signed ? `
<h2>The signed memorandum</h2>
<div class="box">
  <p><strong>A signed memorandum of tangible personal property exists.</strong>
  It was signed by hand${signed.signed_on ? ` on ${esc(signed.signed_on)}` : ''} and photographed on
  ${esc(new Date(signedRow.created_at).toLocaleDateString('en-US', { dateStyle: 'long' }))}.
  The image travels with this package as <span class="hash">${esc(signedRow.file_name)}</span>.</p>

  <p><strong>The image is a copy, not the operative document.</strong> The signed original is what takes effect,
  and it needs to be produced. Where an original was last known to be with the owner and cannot be found afterwards,
  a court may presume it was destroyed deliberately and treat it as revoked.</p>

  <div class="grid">
    <div><span class="k">Where the owner said the original is kept</span><br><strong>${esc(signed.original_location || 'Not recorded — ask, and write it down')}</strong></div>
    <div><span class="k">Image fingerprint</span><br><span class="hash">${esc((signedRow.sha256 || '').slice(0, 16))}</span></div>
  </div>

  ${signed.statement ? `<p style="margin-top:10pt"><strong>The owner also recorded a spoken statement</strong> at the time of signing.
  A recording is not a will, but it is ordinarily relevant to intent, mental capacity, the absence of undue influence,
  and identity. It is included in the package.</p>` : ''}

  ${attestations.length ? `<p style="margin-top:10pt"><strong>Confirmed by:</strong></p>
  <table>
    <thead><tr><th>Name</th><th>Role</th><th>Custody</th><th>Date</th></tr></thead>
    <tbody>${attestations.map((a) => `<tr>
      <td>${esc(a.name)}${a.firm ? `<br><span class="k">${esc(a.firm)}</span>` : ''}</td>
      <td>${esc(ROLE_WORDS[a.role] || a.role)}</td>
      <td>${esc(HOLDS_WORDS[a.holds] || a.holds)}</td>
      <td>${esc(new Date(a.confirmed_at).toLocaleDateString('en-US'))}</td>
    </tr>`).join('')}</tbody>
  </table>` : '<p class="k" style="margin-top:10pt">No professional has yet confirmed sight of the signed original. If you are the trustee or attorney, ask to see it and record that you have.</p>'}
</div>` : `
<h2>The signed memorandum</h2>
<div class="box">
  <p><strong>No signed memorandum is on file.</strong> This package is an inventory and a statement of wishes; on its own
  it does not dispose of anything. If the owner is living, the useful next step is for them to print the memorandum from
  the app, sign it by hand, and keep the signed original with the will &mdash; most states let a will refer to a separate
  signed list of tangible personal property, and a few do not recognise one at all.</p>
</div>`}

<h2>What to do with this package</h2>
<ul class="check">
  <li><strong>Print this packet and the item list</strong> that follows, and file the paper copy with the will and trust documents.</li>
  <li><strong>Save the data file</strong> <span class="hash">${esc(delivery.file_name || 'inventory.reindeer')}</span> in at least two places: the estate folder and one backup that is not in the same building.</li>
  <li><strong>Confirm the fingerprint below matches</strong> the one shown when the file is opened. If it does not match, the file has changed since it was sent.</li>
  <li><strong>Do not edit the data file.</strong> It is the sealed record. Corrections are made by the owner and re-sent as a new package.</li>
  <li><strong>Play the recordings once</strong> to confirm they open, then note the date you checked them at the bottom of this page.</li>
  <li><strong>Load it into the distribution software</strong> when the time comes. Everything lands in a review queue first; nothing is assigned to anyone automatically.</li>
</ul>

<div class="box">
  <div class="k">Package fingerprint (SHA-256)</div>
  <div class="hash">${esc(bundleSha256 ?? '—')}</div>
</div>

<div class="warn"><strong>${esc(NON_BINDING_DISCLAIMER)}</strong>
  Any name recorded beside an item is the owner's stated wish. It carries no legal force on its own and does not
  override the will, the trust, or a personal property memorandum.</div>

<div class="sig">
  <div>Trustee signature &middot; date received</div>
  <div>Recordings checked &middot; date</div>
</div>

<h2 class="pb">Everything in this package</h2>
<table>
  <thead><tr><th>#</th><th>Item</th><th>Room</th><th>Media</th><th>Stated wish</th><th class="num">Est. value</th></tr></thead>
  <tbody>
  ${items.map((i, n) => {
    const m = i.media ?? [];
    const bits = [
      m.filter((x) => (x.media_kind ?? 'photo') === 'photo').length && `${m.filter((x) => (x.media_kind ?? 'photo') === 'photo').length} photo`,
      m.filter((x) => x.media_kind === 'video').length && `${m.filter((x) => x.media_kind === 'video').length} video`,
      m.filter((x) => x.media_kind === 'audio').length && `${m.filter((x) => x.media_kind === 'audio').length} voice`,
    ].filter(Boolean).join(', ');
    const recipient = i.recipient_hint?.recipient_name ?? '';
    /* [ASSIGNED] mark is a scannable signal that this item carries an
       owner-stated wish. FairPlay honors the same signal by keeping the
       item out of the family selection process. See §4 of the handoff. */
    const assignedMark = recipient ? ' <span class="assigned-mark">[ASSIGNED]</span>' : '';
    const comment = (i.owner_important_comment ?? '').trim();
    return `<tr>
      <td class="num">${n + 1}</td>
      <td><strong>${esc(i.title)}</strong>${i.identifiers?.serial ? `<br><span class="k">Serial ${esc(i.identifiers.serial)}</span>` : ''}</td>
      <td>${esc(i.room?.name ?? '')}</td>
      <td>${esc(bits || '—')}</td>
      <td>${esc(recipient || '—')}${assignedMark}</td>
      <td class="num">${money(i.value_estimate_cents)}</td>
    </tr>${comment ? `<tr class="owner-comment-row"><td></td><td colspan="5"><div class="owner-comment"><span class="lbl">In the owner's own words</span><div class="body">${esc(comment)}</div></div></td></tr>` : ''}`;
  }).join('')}
  </tbody>
</table>
${noRecipient ? `<p class="k">${noRecipient} item${noRecipient === 1 ? '' : 's'} carr${noRecipient === 1 ? 'ies' : 'y'} no stated wish. Those are the ones families argue over, so they are listed here on purpose.</p>` : ''}

${renderImportanceSections({ householdMode, items })}
${withOwnerComment ? `<p class="k">Items marked <strong>[ASSIGNED]</strong> carry an owner-stated wish and are kept out of the family selection process in FairPlay. If any of these need to be reopened, the trustee (in Configuration 2) or an heir who is captain can return them to the pool. ${withOwnerComment} item${withOwnerComment === 1 ? '' : 's'} also carr${withOwnerComment === 1 ? 'ies' : 'y'} a written comment printed verbatim above. Please read each one before assigning or distributing that item.</p>` : ''}

${(scopeMedia.length || withRecordings.length) ? `
<h2>Recordings in this package</h2>
<table>
  <thead><tr><th>Recording</th><th>Kind</th><th class="num">Length</th><th>Belongs to</th></tr></thead>
  <tbody>
  ${scopeMedia.map((m) => `<tr><td>${esc(m.title || 'Untitled')}</td><td>${esc(m.media_kind)}</td><td class="num">${dur(m.duration_ms)}</td><td>The whole inventory</td></tr>`).join('')}
  ${withRecordings.flatMap((i) => (i.media ?? []).filter((m) => m.media_kind !== 'photo')
    .map((m) => `<tr><td>${esc(m.label || m.role)}</td><td>${esc(m.media_kind)}</td><td class="num">${dur(m.duration_ms)}</td><td>${esc(i.title)}</td></tr>`)).join('')}
  </tbody>
</table>
<p class="k">Written transcripts of every recording are included in the package as <span class="hash">transcripts.txt</span>,
so the contents can be read without playing a single file.</p>` : ''}

<footer>Package ${esc(manifest?.batch_id ?? '')} &middot; generated ${generatedAt.toLocaleString()} &middot;
  ${esc(NON_BINDING_DISCLAIMER)}</footer>
</body></html>`;
}

/*
 * The "Important" section of the trustee cover sheet.
 *
 * Reads directly from the item flag (owner_high_value) and the optional
 * owner comment. Either partner in couple mode can toggle the flag;
 * whichever partner recorded it, the household's stated view is that the
 * item matters. There is no proposed/agreed workflow — couples decide
 * in real life sitting together, and the app just records the outcome.
 *
 * Solo copy: "Items you marked Important".
 * Couple copy: "Important items — flagged by the household".
 *
 * When no items are flagged, this section renders nothing.
 */
function renderImportanceSections({ householdMode, items }) {
  const important = items.filter((i) => i.owner_high_value === 1 || i.owner_high_value === true);
  if (important.length === 0) return '';

  const isCouple = householdMode === 'couple';
  const heading = isCouple
    ? 'Important items \u2014 flagged by the household'
    : 'Items you marked Important';

  const renderRow = (item) => {
    const title = item.title || '(untitled)';
    const room = item.room?.name ? esc(item.room.name) : '';
    const comment = (item.owner_important_comment ?? '').trim();
    const reason = comment
      ? `<div class="k" style="font-size:9.5pt;margin-top:2pt">\u201c${esc(comment)}\u201d</div>`
      : '';
    return `<tr>
      <td><strong>${esc(title)}</strong>${reason}</td>
      <td>${room}</td>
    </tr>`;
  };

  const blurb = isCouple
    ? `<p class="k" style="margin-top:6pt">The household flagged these items as mattering more than the rest. Please make sure they travel with the rest of the package.</p>`
    : `<p class="k" style="margin-top:6pt">These are the items the owner singled out as mattering more than the rest. Please make sure they travel with the rest of the package and reach the intended person.</p>`;

  return `
<h2 class="pb">${heading}</h2>
${blurb}
<table>
  <thead><tr><th>Item</th><th>Room</th></tr></thead>
  <tbody>${important.map(renderRow).join('')}</tbody>
</table>`;
}

function labelMethod(m) {
  if (m === 'email_attachment') return 'Email, file attached';
  if (m === 'email_link') return 'Email, secure download link';
  return 'Direct download';
}

/** The short letter in the body of the email itself. */
export function renderTrusteeEmail({ ownerName, trustee, manifest, delivery = {}, downloadUrl, expiresAt }) {
  const c = manifest?.counts ?? {};
  const lines = [
    `${trustee?.name ?? 'Hello'},`,
    '',
    `${ownerName} has finished documenting the personal property of the estate and asked that the record be sent to you for safekeeping.`,
    '',
    `The package contains ${c.items ?? 0} items, ${c.photos ?? 0} photographs, ${c.videos ?? 0} video recordings, and ${c.audio ?? 0} voice recordings in ${ownerName}'s own voice.`,
    '',
    delivery.method === 'email_link'
      ? `The package is too large to attach, so it is available here:\n${downloadUrl}\n${expiresAt ? `This link stops working on ${new Date(expiresAt).toLocaleDateString()}.` : ''}`
      : `The package is attached as ${delivery.file_name}.`,
    '',
    'Please:',
    '  1. Print the enclosed cover packet and file it with the estate documents.',
    '  2. Save the data file in two separate places.',
    '  3. Leave the data file unedited. It is the sealed record.',
    '',
    `Package reference: ${manifest?.batch_id ?? ''}`,
    `Fingerprint: ${delivery.bundle_sha256 ?? ''}`,
    '',
    'This inventory records wishes, not legal directions. It does not override the will, the trust, or a personal property memorandum.',
  ];
  const text = lines.join('\n');
  const html = `<div style="font:14px/1.6 Georgia,serif;color:#111;max-width:620px">${
    text.split('\n\n').map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}</div>`;
  return { text, html, subject: `Estate inventory package from ${ownerName} — ${c.items ?? 0} items` };
}
