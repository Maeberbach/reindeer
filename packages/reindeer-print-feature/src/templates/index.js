import { NON_BINDING_DISCLAIMER } from '@reindeer/core-api';

export const PRINT_PROFILES = {
  letter_photo: { page: 'letter', margin: '0.6in', photoHeight: '3.2in', density: 'comfortable' },
  letter_list: { page: 'letter', margin: '0.5in', photoHeight: '0.9in', density: 'compact' },
  a4_photo: { page: 'A4', margin: '15mm', photoHeight: '80mm', density: 'comfortable' },
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const money = (cents) => (cents == null ? '—' : `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

const stamp = (d = new Date()) => d.toLocaleString('en-US', {
  year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

// showValues defaults to FALSE: Reindeer: Registry records what exists and
// makes no value claim. Valuation belongs to Reindeer: FairPlay, which has
// value estimates and a threshold the captain sets. A caller can
// still opt in for its own purposes, but nothing in the registry does.
function shell({ title, profile, body, subtitle = '', showValues = false }) {
  const p = PRINT_PROFILES[profile] ?? PRINT_PROFILES.letter_photo;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  @page { size: ${p.page}; margin: ${p.margin}; }
  * { box-sizing: border-box; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #1a1a1a; margin: 0; font-size: 12pt; line-height: 1.45; }
  header.doc { border-bottom: 2px solid #1a1a1a; padding-bottom: 8pt; margin-bottom: 14pt; }
  header.doc h1 { font-size: 20pt; margin: 0 0 2pt; letter-spacing: -0.01em; }
  header.doc .sub { font-size: 10pt; color: #555; }
  .item { page-break-inside: avoid; border-bottom: 1px solid #ddd; padding: 10pt 0; }
  .item.sheet { border: none; }
  .item h2 { font-size: 15pt; margin: 0 0 4pt; }
  .meta { font-size: 10pt; color: #444; margin-bottom: 6pt; }
  .meta span { margin-right: 14pt; white-space: nowrap; }
  .photo { height: ${p.photoHeight}; border: 1px solid #ccc; object-fit: contain; background: #fafafa; margin-right: 8pt; }
  .photos { display: flex; flex-wrap: wrap; gap: 6pt; margin: 6pt 0; }
  .story { font-style: italic; border-left: 3px solid #b8a06a; padding-left: 8pt; margin: 6pt 0; }
  .recipient { background: #f4f1e8; border: 1px solid #d8cfb4; padding: 6pt 8pt; margin-top: 6pt; font-size: 11pt; }
  .recipient strong { font-variant: small-caps; letter-spacing: .04em; }
  /* Owner's "Important" mark and optional comment on paper.
     See docs/decisions/2026-08-06-important-comment.md — the mark is a
     subdued word next to the title; the comment, if written, prints below
     it verbatim (Registry does not shape the owner's own words). */
  .important { display: inline-block; margin-left: 6pt; font-size: 10pt; font-style: italic; color: #555; font-weight: 500; letter-spacing: .01em; vertical-align: 1pt; }
  .important-mark { color: #555; font-style: italic; font-weight: 500; margin-right: 4pt; }
  .important-comment { border-left: 3px solid #b8a06a; background: #faf7ee; padding: 6pt 8pt; margin: 6pt 0; font-size: 10.5pt; color: #222; white-space: pre-wrap; }
  .important-comment strong { font-variant: small-caps; letter-spacing: .04em; color: #6a5a2a; margin-right: 6pt; }
  table.list { width: 100%; border-collapse: collapse; font-size: 10.5pt; }
  table.list th { text-align: left; border-bottom: 1.5px solid #1a1a1a; padding: 4pt 6pt 4pt 0; font-size: 9.5pt; text-transform: uppercase; letter-spacing: .05em; }
  table.list td { padding: 5pt 6pt 5pt 0; border-bottom: 1px solid #e5e5e5; vertical-align: top; }
  table.list td.thumb { width: 1in; } table.list img { width: .9in; height: .9in; object-fit: cover; border: 1px solid #ccc; }
  .group-title { font-size: 13pt; margin: 16pt 0 4pt; border-bottom: 1px solid #999; padding-bottom: 3pt; page-break-after: avoid; }
  footer.doc { margin-top: 18pt; padding-top: 8pt; border-top: 1px solid #999; font-size: 8.5pt; color: #555; }
  .sig { margin-top: 22pt; display: flex; gap: 30pt; page-break-inside: avoid; }
  .sig div { flex: 1; border-top: 1px solid #1a1a1a; padding-top: 4pt; font-size: 9pt; }
  @media print { .noprint { display: none !important; } }
  .noprint { position: sticky; top: 0; background: #1a1a1a; color: #fff; padding: 10px 14px; font-family: system-ui, sans-serif; font-size: 15px; display: flex; align-items: center; justify-content: space-between; }
  .noprint button { font-size: 16px; padding: 8px 18px; min-height: 44px; border: 0; border-radius: 6px; background: #f4f1e8; color: #1a1a1a; font-weight: 600; cursor: pointer; }
</style></head>
<body>
<div class="noprint"><span>Ready to print or save as PDF.</span><button onclick="window.print()">Print / Save as PDF</button></div>
<header class="doc">
  <h1>${esc(title)}</h1>
  <div class="sub">${esc(subtitle)}${subtitle ? ' · ' : ''}Prepared ${esc(stamp())}</div>
</header>
${body}
<footer class="doc">
  ${esc(NON_BINDING_DISCLAIMER)}<br>
  ${showValues ? 'Values shown are non-binding estimates, not appraisals. ' : ''}This document is a dated record of what existed at the time of preparation.
</footer>
</body></html>`;
}

const photoTag = (p, base) => `<img class="photo" src="${base}/photos/${esc(p.photo_id)}" alt="">`;

function itemBlock(item, { base, showValues, sheet = false }) {
  // The owner's "Important" mark is printed — always — as a single italic
  // word next to the item title when owner_high_value is true. Independent of
  // showValues on purpose: this is the owner's own feeling, not a valuation.
  // The reason word (feeling / money / both) never appears on paper.
  //
  // If the owner also wrote a comment, it prints verbatim under the title in
  // an "Important" callout box. Registry does not censor the owner's own
  // words — whatever they wrote is what appears, including dollar figures
  // or valuation language if they chose to include them. FairPlay handles
  // its own valuation work separately. See
  // docs/decisions/2026-08-06-important-comment.md.
  const important = item.owner_high_value ? ' <span class="important">Important</span>' : '';
  const importantComment = item.owner_important_comment
    ? `<div class="important-comment"><strong>Important</strong>${esc(item.owner_important_comment)}</div>`
    : '';
  const ids = Object.entries(item.identifiers || {}).filter(([, v]) => v).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(' · ');
  const rh = item.recipient_hint?.recipient_name;
  return `<div class="item${sheet ? ' sheet' : ''}">
    <h2>${esc(item.title)}${important}</h2>
    ${importantComment}
    <div class="meta">
      <span><b>Room:</b> ${esc(item.room?.name ?? '—')}</span>
      <span><b>Category:</b> ${esc(item.category?.name ?? '—')}</span>
      <span><b>Qty:</b> ${item.quantity}</span>
      <span><b>Condition:</b> ${esc(item.condition)}</span>
      ${showValues ? `<span><b>Est. value:</b> ${money(item.value_estimate_cents)}</span>` : ''}
    </div>
    ${item.photos?.length ? `<div class="photos">${item.photos.map((p) => photoTag(p, base)).join('')}</div>` : ''}
    ${item.description ? `<div>${esc(item.description)}</div>` : ''}
    ${ids ? `<div class="meta">${ids}</div>` : ''}
    ${item.story ? `<div class="story">“${esc(item.story)}”</div>` : ''}
    ${rh ? `<div class="recipient"><strong>Intended for</strong> ${esc(rh)}${item.recipient_hint.relationship ? ` (${esc(item.recipient_hint.relationship)})` : ''}${item.recipient_hint.alternate_name ? ` · alternate: ${esc(item.recipient_hint.alternate_name)}` : ''}${item.recipient_hint.owner_note ? `<br><em>${esc(item.recipient_hint.owner_note)}</em>` : ''}<br><span style="font-size:9pt;color:#666">A wish, not a legal direction.</span></div>` : ''}
    <div class="meta" style="margin-top:6pt;color:#888;font-size:8.5pt">Item ID ${esc(item.item_id)} · recorded ${esc(new Date(item.created_at).toLocaleDateString('en-US'))}</div>
  </div>`;
}

export function renderItemSheet(item, { profile = 'letter_photo', base = '/api', showValues = false, ownerName = '' } = {}) {
  return shell({
    title: item.title, subtitle: ownerName ? `Reindeer: Registry · ${ownerName}` : 'Reindeer: Registry',
    profile, showValues,
    body: itemBlock(item, { base, showValues, sheet: true }) + `<div class="sig"><div>Owner signature / date</div><div>Witness or trustee / date</div></div>`,
  });
}

export function renderReport(items, { title = 'Reindeer: Registry', groupBy = 'room', profile = 'letter_list', base = '/api', showValues = false, ownerName = '', layout = 'table' } = {}) {
  const groups = new Map();
  for (const it of items) {
    const key = groupBy === 'category' ? (it.category?.name ?? 'Uncategorized')
      : groupBy === 'recipient' ? (it.recipient_hint?.recipient_name || 'Not yet assigned')
        : (it.room?.name ?? 'No room recorded');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }

  const total = items.reduce((s, i) => s + (i.value_estimate_cents ?? 0), 0);
  const unassigned = items.filter((i) => !i.recipient_hint?.recipient_name).length;
  const noPhoto = items.filter((i) => !i.photos?.length).length;

  const summary = `<div class="meta" style="font-size:11pt">
    <span><b>${items.length}</b> items</span>
    ${showValues ? `<span><b>${money(total)}</b> estimated total</span>` : ''}
    <span><b>${unassigned}</b> with no intended recipient</span>
    <span><b>${noPhoto}</b> with no photo</span>
  </div>`;

  const body = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, list]) => {
    if (layout === 'blocks') {
      return `<h2 class="group-title">${esc(name)} (${list.length})</h2>` + list.map((i) => itemBlock(i, { base, showValues })).join('');
    }
    return `<h2 class="group-title">${esc(name)} (${list.length})</h2>
      <table class="list"><thead><tr>
        <th></th><th>Item</th><th>Qty</th><th>${groupBy === 'recipient' ? 'Room' : 'Intended for'}</th>${showValues ? '<th>Est. value</th>' : ''}<th>Recorded</th>
      </tr></thead><tbody>
      ${list.map((i) => `<tr>
        <td class="thumb">${i.photos?.[0] ? `<img src="${base}/photos/${esc(i.photos[0].photo_id)}" alt="">` : ''}</td>
        <td>${i.owner_high_value ? '<span class="important-mark">Important · </span>' : ''}<b>${esc(i.title)}</b>${i.story ? `<br><span style="font-size:9pt;color:#666">${esc(i.story.slice(0, 90))}${i.story.length > 90 ? '…' : ''}</span>` : ''}${i.owner_important_comment ? `<div class="important-comment"><strong>Important</strong>${esc(i.owner_important_comment)}</div>` : ''}</td>
        <td>${i.quantity}</td>
        <td>${esc(groupBy === 'recipient' ? (i.room?.name ?? '—') : (i.recipient_hint?.recipient_name || '—'))}</td>
        ${showValues ? `<td>${money(i.value_estimate_cents)}</td>` : ''}
        <td style="font-size:9pt">${esc(new Date(i.created_at).toLocaleDateString('en-US'))}</td>
      </tr>`).join('')}
      </tbody></table>`;
  }).join('');

  return shell({
    title, subtitle: ownerName ? `Prepared for ${ownerName}` : '', profile, showValues,
    body: summary + body + `<div class="sig"><div>Owner signature / date</div><div>Witness or trustee / date</div></div>`,
  });
}
