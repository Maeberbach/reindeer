/**
 * The two-lane intake, checked at the two places it could go wrong.
 *
 * 1. Value. Bulk intake must never attach a figure to an object. A fabricated
 *    number wearing an 'ai_estimate' label is worse than no number at all,
 *    because a trustee has no way to tell it was a guess.
 * 2. The two schedules. Schedule A is operative and Schedule B must not be.
 *    An item with no named recipient must appear in B and must never appear
 *    in A, and Schedule B must offer nowhere to write a name.
 */
import { renderMemorandum } from '../packages/reindeer-print-feature/src/templates/memorandum.js';
import { MockVisionProvider } from '../packages/reindeer-intake-feature/src/vision/index.js';

let pass = 0;
const fail = [];
const ok = (name, cond) => { if (cond) { pass++; console.log(`  \u2713 ${name}`); } else { fail.push(name); console.log(`  \u2717 ${name}`); } };

console.log('\n1. Bulk intake never invents a value');
const list = await new MockVisionProvider().detectItems(
  [{ buffer: Buffer.from('one'), media_id: 'm0' }, { buffer: Buffer.from('two'), media_id: 'm1' }], {});
ok('the mock provider returns at least one detection', Array.isArray(list) && list.length > 0);
ok('no detection carries a value figure', list.every((d) => d.value_estimate_cents == null));
ok('no detection carries a value suggestion either', list.every((d) => d.value_suggestion == null));

console.log('\n2. The memorandum splits into two schedules');
const items = [
  { item_id: 'a', title: 'Grandmother\u2019s pearl brooch', description: 'small, in a velvet box',
    recipient_hint: { name: 'Ruth Alvarez', relationship: 'daughter', alternate: 'Peter Alvarez' }, room: { name: 'Bedroom' } },
  { item_id: 'b', title: 'Kitchen toaster', description: 'two slice', recipient_hint: {}, room: { name: 'Kitchen' } },
  { item_id: 'c', title: 'Oak dining chairs', description: 'six of them', room: { name: 'Dining room' } },
];
const html = renderMemorandum(items, { ownerName: 'Alice Marie Bell', ownerLocation: 'Keystone, Florida', willDate: '3 March 2019' });

// Anchor on the headings, not the words. The stylesheet mentions both by name.
const A = 'Schedule A &mdash;';
const B = 'Schedule B &mdash;';
ok('Schedule A is headed on the page', html.includes(A));
ok('Schedule B is headed on the page', html.includes(B));
const aStart = html.indexOf(A);
const bStart = html.indexOf(B);
ok('Schedule A comes before Schedule B', aStart > -1 && bStart > aStart);

const scheduleA = html.slice(aStart, bStart);
const scheduleB = html.slice(bStart);
ok('the named item appears in Schedule A', scheduleA.includes('pearl brooch'));
ok('the named recipient appears in Schedule A', scheduleA.includes('Ruth Alvarez'));
ok('the alternate appears in Schedule A', scheduleA.includes('Peter Alvarez'));

ok('an unnamed item does NOT appear in Schedule A', !scheduleA.includes('toaster'));
ok('an unnamed item appears in Schedule B', scheduleB.includes('toaster'));
ok('an item with no hint at all appears in Schedule B', scheduleB.includes('Oak dining chairs'));
ok('a named item is not repeated in Schedule B', !scheduleB.includes('pearl brooch'));

ok('Schedule B disclaims giving anything to anyone', /gives nothing to anyone/.test(scheduleB));
ok('Schedule B tells the reader not to write a name on it', /Do not write a name/.test(scheduleB));
ok('Schedule B has no recipient column', !/To receive it/.test(scheduleB));
ok('Schedule B starts on its own page', /page-break-before: always/.test(html));
ok('the omission note points the reader to Schedule B', /recorded in Schedule B/.test(html));

console.log('\n3. Nothing is lost when every item is named');
const allNamed = renderMemorandum([items[0]], { ownerName: 'Alice Marie Bell' });
ok('Schedule B is omitted entirely when there is nothing to list', !allNamed.includes(B));
ok('Schedule A still prints', allNamed.includes('Schedule A'));

console.log('\n4. And when nothing is named');
const noneNamed = renderMemorandum([items[1]], { ownerName: 'Alice Marie Bell' });
ok('Schedule A says plainly that nothing names a recipient', /no intended recipient|No item in the register/i.test(noneNamed));
ok('Schedule B still lists the item', noneNamed.slice(noneNamed.indexOf(B)).includes('toaster'));

console.log(`\n${pass} checks passed.`);
if (fail.length) { console.log(`${fail.length} FAILED:`); fail.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
