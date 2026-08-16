/* The people roster, exercised against a live server. */
import { signInAsBootstrapOwner, authedFetch } from './lib/http-auth.mjs';
const B = process.env.BASE || 'http://localhost:3210';
// Sign in as the bootstrap owner up front so every request below carries
// a valid session cookie. Requires LEGACY_MAILER_OFF=1 on the server so
// the magic link URL is echoed back to us.
const _cookie = await signInAsBootstrapOwner(B);
const _f = authedFetch(_cookie);
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  \u2713 ' + m)) : (fail++, console.log('  \u2717 ' + m)); };
const j = async (p, o) => { const r = await _f(B + p, o); return { status: r.status, body: await r.json().catch(() => null) }; };
const post = (p, b) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

console.log('\n1. Adding people up front');
let kathy;
{
  const r = await post('/api/people', { name: 'Kathy', relationship: 'daughter' });
  ok(r.status === 201, 'a person can be added');
  ok(r.body.name === 'Kathy' && r.body.relationship === 'daughter', 'name and relationship come back');
  ok(r.body.created === true, 'reported as newly created');
  kathy = r.body.person_id;

  const bulk = await post('/api/people/bulk', {
    people: [{ name: 'Robert', relationship: 'son' }, { name: 'Elena', relationship: 'granddaughter' }, { name: '  ', relationship: 'x' }],
  });
  ok(bulk.body.added.length === 2, 'several can be added at once');
  ok(bulk.body.skipped.length === 1, 'a blank name is skipped rather than crashing the batch');
}

console.log('\n2. The same person is never added twice');
{
  const again = await post('/api/people', { name: 'kathy' });
  ok(again.status === 200 && again.body.created === false, 'a different capitalisation matches the existing person');
  ok(again.body.person_id === kathy, 'and returns the same person');

  const spaced = await post('/api/people', { name: '  Kathy  ' });
  ok(spaced.body.person_id === kathy, 'stray spaces do not make a second Kathy');

  const fill = await post('/api/people', { name: 'Robert', relationship: 'stepson' });
  ok(fill.body.relationship === 'son', 'a later guess does not overwrite what the owner already said');

  const { body } = await j('/api/people');
  ok(body.people.length === 3, 'the list still holds three people, not six');
}

console.log('\n3. The list says plainly that it decides nothing');
{
  const { body } = await j('/api/people');
  ok(body.binding === false, 'flagged non-binding');
  ok(/does not give them anything/i.test(body.note), 'and says so in words the owner can read');
  ok(!('share' in (body.people[0] ?? {})), 'no share or percentage field exists to be mistaken for an allocation');
}

console.log('\n4. Names typed on items are noticed');
{
  await post('/api/items', {
    title: 'Wrought iron wall sconce', review_state: 'kept', value_basis: 'unknown',
    recipient_hint: { recipient_name: 'Marjorie', relationship: 'sister' },
  });
  await post('/api/items', {
    title: 'Walnut side table', review_state: 'kept', value_basis: 'unknown',
    recipient_hint: { recipient_name: 'Marjorie', relationship: 'sister' },
  });
  await post('/api/items', {
    title: 'Blue willow platter', review_state: 'kept', value_basis: 'unknown',
    recipient_hint: { recipient_name: 'Kathy', relationship: 'daughter' },
  });

  const { body } = await j('/api/people');
  const marj = body.unlisted.find((u) => u.name === 'Marjorie');
  ok(!!marj, 'a name used on items but missing from the roster is surfaced');
  ok(marj.item_count === 2, 'with a count of how many items name her');
  ok(marj.relationship === 'sister', 'and the relationship the owner already gave');
  ok(!body.unlisted.some((u) => u.name === 'Kathy'), 'somebody already on the roster is not offered again');
  ok(body.people.find((p) => p.name === 'Kathy').item_count === 1, 'the roster shows how many items each person has');
}

console.log('\n5. Adopting the names already used');
{
  const before = (await j('/api/people')).body.unlisted;
  const res = await post('/api/people/bulk', { people: before.map((u) => ({ name: u.name, relationship: u.relationship, source: 'from_item' })) });
  ok(res.body.added.length === before.length, 'they can all be adopted in one tap');
  const { body } = await j('/api/people');
  ok(body.unlisted.length === 0, 'nothing is left unlisted afterwards');
  ok(body.people.find((p) => p.name === 'Marjorie').item_count === 2, 'and the adopted person keeps her items');
}

console.log('\n6. Correcting a name');
{
  const r = await j(`/api/people/${kathy}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Katherine Ellis', relationship: 'daughter' }),
  });
  ok(r.status === 200 && r.body.name === 'Katherine Ellis', 'a name can be corrected');

  const clash = await j(`/api/people/${kathy}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Robert' }),
  });
  ok(clash.status === 409, 'renaming onto somebody already there is refused');
  ok(/already on your list/i.test(clash.body.error || ''), 'in plain words rather than a database error');

  const blank = await j(`/api/people/${kathy}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '   ' }),
  });
  ok(blank.status === 400, 'a blank name is refused');
}

console.log('\n7. Removing somebody destroys nothing');
{
  const r = await j(`/api/people/${kathy}`, { method: 'DELETE' });
  ok(r.status === 200, 'a person can be taken off the list');
  ok(/nothing was erased/i.test(r.body.note), 'and the app says the items are untouched');

  const { body } = await j('/api/people');
  ok(!body.people.some((p) => p.person_id === kathy), 'she is gone from the list');

  const items = (await j('/api/items')).body.items;
  const hers = items.filter((i) => i.recipient_hint?.recipient_name === 'Kathy');
  ok(hers.length === 1, 'but the item recorded for her still names her');

  const back = await post(`/api/people/${kathy}/restore`, {});
  ok(back.status === 200 && back.body.archived === false, 'and she can be put back');
}

console.log('\n8. Nonsense is refused politely');
{
  const empty = await post('/api/people', { name: '' });
  ok(empty.status === 400, 'an empty name is refused');
  const huge = await post('/api/people', { name: 'x'.repeat(500) });
  ok(huge.status === 400, 'an absurdly long name is refused');
  const missing = await j('/api/people/nope-not-real', { method: 'DELETE' });
  ok(missing.status === 404, 'an unknown person gives a clean not-found');
}

console.log('\n9. It is written to the audit chain');
{
  const { body } = await j('/api/audit');
  const entries = body.entries ?? body.audit ?? [];
  ok(entries.some((e) => e.action === 'person.add'), 'adding a person is recorded');
  ok(entries.some((e) => e.action === 'person.archive'), 'so is removing one');
  const v = (await j('/api/audit/verify')).body;
  ok(v.ok === true, 'and the chain still verifies');
}

console.log(`\n${pass} checks passed${fail ? `, ${fail} FAILED` : ''}.`);
process.exit(fail ? 1 : 0);
