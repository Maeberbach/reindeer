/**
 * The execution page.
 *
 * Every other document this app prints is explicitly non-binding. This one is
 * the exception: it is the page the owner signs in ink so that their itemised
 * list can take effect through the will that refers to it. It therefore has its
 * own shell and its own footer — reusing the standard one would print a
 * "nothing here is binding" disclaimer across the only page that is meant to be.
 *
 * Electronic signature is deliberately not offered. Both the federal ESIGN Act
 * and the state Uniform Electronic Transactions Act exclude wills, codicils and
 * testamentary trusts from electronic signing, and a memorandum takes effect
 * through the will, so it inherits that exclusion. A signature control here
 * would look authoritative and fail in probate.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const money = (cents) => (cents == null ? '' : `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`);

const longDate = (d = new Date()) => d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

const blank = (label, hint = '') =>
  `<div class="fill"><div class="rule"></div><div class="cap">${esc(label)}${hint ? ` <span class="hint">${esc(hint)}</span>` : ''}</div></div>`;

/**
 * Describes an item with enough particularity to satisfy the "reasonable
 * certainty" standard the separate-writing statutes impose: what it is, where
 * it was, and what distinguishes it from a similar object in the same house.
 */
function describe(item) {
  const bits = [];
  if (item.description) bits.push(item.description);
  const ident = safeIdentifiers(item);
  if (ident.maker) bits.push(`maker ${ident.maker}`);
  if (ident.marks) bits.push(`marked ${ident.marks}`);
  if (item.room_name) bits.push(`located in the ${String(item.room_name).toLowerCase()}`);
  if (item.quantity > 1) bits.push(`${item.quantity} in the set`);
  // Value estimates are deliberately excluded from the printed memorandum.
  // They remain in the database (visible to the owner in the app, transferred
  // to the fiduciary on export) but are omitted here because many states treat
  // stated values in estate documents as creating tax or probate complications.
  // The data is never thrown away — it just never reaches the printed page.
  bits.push('recorded with photograph');
  return bits.join('; ');
}

function safeIdentifiers(item) {
  try {
    const v = typeof item.identifiers === 'string' ? JSON.parse(item.identifiers || '{}') : (item.identifiers || {});
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

/*
 * The stored hint uses recipient_name / alternate_name. Older callers passed
 * name / alternate. Accept both, because reading the wrong key here silently
 * emptied Schedule A — the one page on which a name has legal effect.
 */
function recipientOf(item) {
  try {
    const h = typeof item.recipient_hint === 'string' ? JSON.parse(item.recipient_hint || '{}') : (item.recipient_hint || {});
    if (!h || typeof h !== 'object') return {};
    return {
      ...h,
      name: h.name ?? h.recipient_name ?? '',
      alternate: h.alternate ?? h.alternate_name ?? '',
    };
  } catch { return {}; }
}

/**
 * @param {Array} items    items to schedule, in print order
 * @param {object} opts
 * @param {string} opts.ownerName      full legal name of the testator
 * @param {string} opts.ownerLocation  "City, State"
 * @param {string} opts.willDate       date the will was executed, as the owner states it
 * @param {boolean} opts.witnessBlock  print the optional witness lines
 */
export function renderMemorandum(items, {
  ownerName = '', ownerLocation = '', willDate = '', witnessBlock = true, base = '/api',
} = {}) {
  const named = items.filter((i) => (recipientOf(i).name || '').trim());
  const unnamed = items.length - named.length;

  const unnamedItems = items.filter((i) => !(recipientOf(i).name || '').trim());

  /* Schedule B is an inventory, not a disposition. It exists because a trustee
     who knows what was in the house can tell whether anything is missing, and
     because an owner should not have to name a recipient for a toaster in order
     for the toaster to be on the record. Nothing here directs where a thing
     goes; the columns deliberately offer nowhere to write a name. */
  const inventoryRows = unnamedItems.map((item, n) => `<tr>
      <td class="num">${n + 1}</td>
      <td><strong>${esc(item.title)}</strong><div class="desc">${esc(describe(item))}</div></td>
      <td>${esc(item.room?.name ?? '')}</td>
    </tr>`).join('\n');

  const rows = named.map((item, n) => {
    const h = recipientOf(item);
    const who = [h.name, h.relationship ? `(${h.relationship})` : ''].filter(Boolean).join(' ');
    return `<tr>
      <td class="num">${n + 1}</td>
      <td><strong>${esc(item.title)}</strong><div class="desc">${esc(describe(item))}</div></td>
      <td>${esc(who)}</td>
      <td>${esc(h.alternate || '')}</td>
    </tr>`;
  }).join('\n');

  const owner = ownerName.trim();
  const where = ownerLocation.trim();

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Memorandum Disposing of Tangible Personal Property</title>
<style>
  @page { size: letter; margin: 0.9in; }
  * { box-sizing: border-box; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #1a1a1a; margin: 0; font-size: 12pt; line-height: 1.5; }
  h1 { font-size: 15pt; text-align: center; letter-spacing: .04em; text-transform: uppercase; margin: 0 0 4pt; }
  .under { text-align: center; font-size: 10pt; color: #555; margin-bottom: 20pt; padding-bottom: 10pt; border-bottom: 2px solid #1a1a1a; }
  /* Plain-language scope note. Deliberately set apart from the recitals below
     it, in a smaller face and behind a rule, so that nothing about it reads as
     part of the operative text a court would be construing. It is here because
     the commonest mistake with a memorandum is treating it as a second copy of
     the inventory, which buries the few items that were genuinely meant. */
  .scope { font-size: 9.5pt; color: #444; line-height: 1.45; margin: 0 0 18pt;
           padding: 9pt 11pt; border: 1px solid #bbb; background: #fafafa; }
  p.rec { margin: 0 0 11pt; text-align: justify; }
  .blankname { border-bottom: 1px solid #1a1a1a; display: inline-block; min-width: 2.4in; }
  table.sched { width: 100%; border-collapse: collapse; font-size: 10.5pt; margin: 14pt 0 6pt; }
  table.sched th { text-align: left; border-bottom: 1.5px solid #1a1a1a; padding: 5pt 7pt 5pt 0; font-size: 9pt; text-transform: uppercase; letter-spacing: .05em; }
  table.sched td { padding: 7pt 7pt 7pt 0; border-bottom: 1px solid #ddd; vertical-align: top; page-break-inside: avoid; }
  table.sched td.num { width: .35in; color: #666; }
  h2.schedhead { font-size: 11pt; text-transform: uppercase; letter-spacing: .05em; margin: 18pt 0 0; }
  /* Schedule B starts its own page so no one can mistake it for part of the
     operative gift list, or for something the signature below covers. */
  .schedb { page-break-before: always; }
  .schedb .why { font-size: 9.5pt; color: #555; text-align: justify; margin: 6pt 0 0; }
  .desc { font-size: 9.5pt; color: #444; margin-top: 2pt; line-height: 1.35; }
  .attest { margin-top: 18pt; page-break-inside: avoid; }
  .sigrow { display: flex; gap: 34pt; margin-top: 26pt; page-break-inside: avoid; }
  .fill { flex: 1; }
  .fill .rule { border-bottom: 1px solid #1a1a1a; height: 26pt; }
  .fill .cap { font-size: 9pt; color: #555; padding-top: 4pt; }
  .fill .hint { color: #888; }
  .date { flex: 0 0 2.1in; }
  .optional { margin-top: 26pt; padding-top: 10pt; border-top: 1px solid #bbb; page-break-inside: avoid; }
  .optional h2 { font-size: 10pt; text-transform: uppercase; letter-spacing: .05em; margin: 0 0 2pt; }
  .optional .why { font-size: 9.5pt; color: #555; font-style: italic; margin: 0; }
  .keep { margin-top: 24pt; background: #f4f1e8; border: 1px solid #d8cfb4; border-left: 4px solid #8a6d24; padding: 10pt 12pt; font-size: 10.5pt; page-break-inside: avoid; }
  .keep strong { display: block; margin-bottom: 3pt; }
  footer.doc { margin-top: 20pt; padding-top: 8pt; border-top: 1px solid #999; font-size: 8.5pt; color: #555; }
  .omitted { font-size: 9.5pt; color: #666; font-style: italic; margin-top: 6pt; }
  @media print { .noprint { display: none !important; } }
  .noprint { position: sticky; top: 0; background: #1a1a1a; color: #fff; padding: 10px 14px; font-family: system-ui, sans-serif; font-size: 15px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .noprint button { font-size: 16px; padding: 8px 18px; min-height: 44px; border: 0; border-radius: 6px; background: #f4f1e8; color: #1a1a1a; font-weight: 600; cursor: pointer; }
</style></head>
<body>
<div class="noprint">
  <span>Print this, then sign it in ink. A signature typed on a screen will not do.</span>
  <button onclick="window.print()">Print / Save as PDF</button>
</div>

<h1>Memorandum Disposing of Tangible Personal Property</h1>
<div class="under">To be signed by hand and kept with the will it refers to</div>

<p class="scope">This memorandum lists only the items left to a particular person &mdash; the things
meant to pass to someone by name. Everything else in the inventory is not listed here, and is divided
under the instructions in the Will or Trust.</p>

<p class="rec">I, ${owner ? `<strong>${esc(owner)}</strong>` : '<span class="blankname">&nbsp;</span>'}, of
${where ? esc(where) : '<span class="blankname">&nbsp;</span>'}, make this memorandum with reference to my Last Will
and Testament dated ${willDate ? esc(willDate) : '<span class="blankname">&nbsp;</span>'}. My Will refers to a
written statement or list disposing of items of my tangible personal property, and I make this writing for that purpose.</p>

<p class="rec">I give the items of tangible personal property described below to the persons named beside them. If a
named person does not survive me, that item passes to the alternate named beside it; if no alternate is named, that item
shall be disposed of as though it had not been listed here. This memorandum does not dispose of money, evidences of
indebtedness, documents of title, securities, real property, or property used in a trade or business, nor any item
specifically disposed of by my Will. This memorandum supersedes any earlier memorandum I have made for this purpose.</p>

<h2 class="schedhead">Schedule A &mdash; Property I give to a named person</h2>
<table class="sched">
  <thead><tr><th></th><th>Description of tangible personal property</th><th>To receive it</th><th>Alternate</th></tr></thead>
  <tbody>
${rows || '<tr><td class="num">1</td><td colspan="3" class="desc">No item in the register yet names an intended recipient.</td></tr>'}
  </tbody>
</table>
${unnamed ? `<p class="omitted">${unnamed} further item${unnamed === 1 ? '' : 's'} in the register ${unnamed === 1 ? 'is' : 'are'} deliberately not listed above, because no intended recipient has been named. ${unnamed === 1 ? 'It passes' : 'They pass'} under the general terms of the Will. ${unnamed === 1 ? 'It is' : 'They are'} recorded in Schedule B for identification only.</p>` : ''}

<div class="attest">
  <p class="rec">Signed by me on the date written below. I am of sound mind, and I make this memorandum freely.</p>
  <div class="sigrow">
    ${blank(owner ? `Signature of ${owner}` : 'Signature', '(sign in ink)')}
    <div class="date">${blank('Date signed')}</div>
  </div>
</div>

${witnessBlock ? `<div class="optional">
  <h2>Witnesses — optional</h2>
  <p class="why">Not required in states that allow a separate writing, but never harmful, and useful if anyone later
  questions authenticity or capacity.</p>
  <div class="sigrow">
    ${blank('Witness one — name and address')}
    ${blank('Witness two — name and address')}
  </div>
</div>` : ''}

${unnamedItems.length ? `<div class="schedb">
  <h2 class="schedhead">Schedule B &mdash; The rest of my household property</h2>
  <p class="why">This schedule gives nothing to anyone. It is a list of what was in my home, recorded so that the person
  settling my estate knows what there was and can tell whether anything is missing. Everything on this list passes under
  the general terms of my Will, exactly as it would if this list did not exist. Do not write a name on this page. If I
  decide I want a particular person to receive something listed here, it belongs in Schedule A instead.</p>
  <table class="sched">
    <thead><tr><th></th><th>Description</th><th>Where it was kept</th></tr></thead>
    <tbody>
${inventoryRows}
    </tbody>
  </table>
  <p class="why">${unnamedItems.length} item${unnamedItems.length === 1 ? '' : 's'} listed for identification only.</p>
</div>` : ''}

<div class="keep">
  <strong>Keep the signed original with your Will.</strong>
  A photograph or scan is a copy, not the original. If the signed original cannot be found after your death, a court may
  presume you destroyed it on purpose and treat it as cancelled. Store it where the Will is stored, and tell your trustee
  it exists. To change it later, print and sign a fresh page and destroy this one — never cross out or write on a page
  you have already signed.
</div>

<footer class="doc">
  Prepared ${esc(longDate())} from Reindeer: Registry. This page becomes effective only when signed by hand and referred
  to by a valid will. Requirements differ by state and some states give a memorandum of this kind no effect at all.
  Confirm the wording and the signing procedure with your own attorney. This is not legal advice.
</footer>
</body></html>`;
}
