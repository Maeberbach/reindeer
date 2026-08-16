/*
 * Reminders — HTTP integration test.
 *
 * What this covers
 *   1. Auth guard         — unauthenticated calls are 401
 *   2. GET default state  — new participant has an empty list + full vocab
 *   3. POST replaces      — full-replacement semantics
 *   4. Invalid input      — non-array body 400, unknown key 400
 *   5. Round trip         — POST followed by GET returns the saved picks
 *   6. Empty clears       — POST []  reduces stored picks to nothing
 *   7. De-duplication     — repeats in the payload are stored once
 *   8. Per-participant    — Ann's picks do not appear in Bob's GET
 *
 * Prerequisites (same as the other HTTP suites)
 *   • Server up on BASE (default http://localhost:3210) with
 *     REINDEER_MAILER_OFF=1 so magic links come back in the response body.
 *   • Fresh temp LEGACY_INVENTORY_DIR so the first sign-in mints the
 *     bootstrap owner.
 */
import {
  requestMagicLink, consumeMagicLink, TEST_OWNER_EMAIL,
} from './lib/http-auth.mjs';

const BASE = process.env.BASE || 'http://localhost:3210';
const ANN_EMAIL = TEST_OWNER_EMAIL;
const BOB_EMAIL = 'test-partner@localhost.test';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  OK: ' + m)) : (fail++, console.log('  FAIL: ' + m)); };

async function signIn(email) {
  const link = await requestMagicLink(BASE, email);
  return consumeMagicLink(BASE, link);
}

const asClient = (cookie) => {
  const headers = cookie ? { cookie } : {};
  const j = async (p, o = {}) => {
    const r = await fetch(BASE + p, { ...o, headers: { ...headers, ...(o.headers || {}) } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return {
    get: (p) => j(p),
    post: (p, b) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) }),
  };
};

console.log('\n1. Sign in as Ann (bootstrap owner) — must happen first so bootstrap mode ends');
const annCookie = await signIn(ANN_EMAIL);
const ann = asClient(annCookie);
{
  const r = await ann.get('/api/auth/me');
  ok(r.body?.participant?.role === 'owner', 'ann is the owner');
}

console.log('\n2. Unauthenticated GET is rejected once a real owner exists');
{
  const r = await asClient(null).get('/api/reminders/holidays');
  ok(r.status === 401, 'GET without cookie → 401');
}

console.log('\n3. Unauthenticated POST is rejected once a real owner exists');
{
  const r = await asClient(null).post('/api/reminders/holidays', { holidays: ['thanksgiving'] });
  ok(r.status === 401, 'POST without cookie → 401');
}

console.log('\n4. Fresh state: picked is empty, vocabulary is present');
{
  const r = await ann.get('/api/reminders/holidays');
  ok(r.status === 200, 'GET → 200');
  ok(Array.isArray(r.body.picked), 'picked is an array');
  ok(r.body.picked.length === 0, 'picked starts empty');
  ok(Array.isArray(r.body.vocabulary), 'vocabulary is an array');
  ok(r.body.vocabulary.length >= 8, 'vocabulary has at least eight entries');
  const hasThx = r.body.vocabulary.find((h) => h.key === 'thanksgiving');
  ok(hasThx && hasThx.label === 'Thanksgiving', 'thanksgiving key is labelled correctly');
  const hasBirthdays = r.body.vocabulary.find((h) => h.key === 'birthdays');
  ok(hasBirthdays && hasBirthdays.label === 'Family birthdays', 'birthdays key present');
}

console.log('\n5. POST valid list is saved');
{
  const r = await ann.post('/api/reminders/holidays', { holidays: ['thanksgiving', 'christmas'] });
  ok(r.status === 200, 'POST → 200');
  ok(r.body.ok === true, 'body.ok is true');
  ok(JSON.stringify(r.body.picked) === JSON.stringify(['thanksgiving', 'christmas']), 'response echoes picks');
}

console.log('\n6. GET round trip returns the saved picks');
{
  const r = await ann.get('/api/reminders/holidays');
  ok(JSON.stringify(r.body.picked) === JSON.stringify(['thanksgiving', 'christmas']), 'picks survived');
}

console.log('\n7. POST full-replacement semantics');
{
  const r = await ann.post('/api/reminders/holidays', { holidays: ['easter'] });
  ok(JSON.stringify(r.body.picked) === JSON.stringify(['easter']), 'the new list replaces the old');
  const g = await ann.get('/api/reminders/holidays');
  ok(JSON.stringify(g.body.picked) === JSON.stringify(['easter']), 'and reads back the same way');
}

console.log('\n8. POST empty array clears everything');
{
  const r = await ann.post('/api/reminders/holidays', { holidays: [] });
  ok(r.body.picked.length === 0, 'server returns empty picks');
  const g = await ann.get('/api/reminders/holidays');
  ok(g.body.picked.length === 0, 'GET confirms empty state');
}

console.log('\n9. POST rejects non-array body');
{
  const r = await ann.post('/api/reminders/holidays', { holidays: 'thanksgiving' });
  ok(r.status === 400, 'string body → 400');
  const r2 = await ann.post('/api/reminders/holidays', { holidays: null });
  ok(r2.status === 400, 'null body → 400');
  const r3 = await ann.post('/api/reminders/holidays', {});
  ok(r3.status === 400, 'missing field → 400');
}

console.log('\n10. POST rejects unknown holiday keys');
{
  const r = await ann.post('/api/reminders/holidays', { holidays: ['thanksgiving', 'not_a_holiday'] });
  ok(r.status === 400, 'unknown key → 400');
  ok(String(r.body?.error || '').includes('not_a_holiday'), 'error names the bad key');
  const g = await ann.get('/api/reminders/holidays');
  ok(g.body.picked.length === 0, 'rejected request did not partially save');
}

console.log('\n11. POST rejects non-string entries');
{
  const r = await ann.post('/api/reminders/holidays', { holidays: ['thanksgiving', 42] });
  ok(r.status === 400, 'number entry → 400');
}

console.log('\n12. POST de-duplicates repeats');
{
  const r = await ann.post('/api/reminders/holidays', { holidays: ['thanksgiving', 'christmas', 'thanksgiving'] });
  ok(JSON.stringify(r.body.picked) === JSON.stringify(['thanksgiving', 'christmas']), 'duplicates collapsed once');
}

console.log('\n13. Per-participant isolation');
{
  // Ann invites Bob as partner, Bob signs in, Bob's picks start empty.
  const inv = await ann.post('/api/household-link/invite', { email: BOB_EMAIL });
  ok(inv.status === 201, 'invite issued');
  const bobLink = inv.body.link;
  const bobCookie = await consumeMagicLink(BASE, bobLink);
  const bob = asClient(bobCookie);
  const g = await bob.get('/api/reminders/holidays');
  ok(g.status === 200 && g.body.picked.length === 0, 'bob starts with an empty list even though ann has picks');
  const gAnn = await ann.get('/api/reminders/holidays');
  ok(JSON.stringify(gAnn.body.picked) === JSON.stringify(['thanksgiving', 'christmas']), 'ann\u2019s list is untouched');
  // Bob saves his own picks; ann's stay separate.
  await bob.post('/api/reminders/holidays', { holidays: ['diwali'] });
  const gBob2 = await bob.get('/api/reminders/holidays');
  const gAnn2 = await ann.get('/api/reminders/holidays');
  ok(JSON.stringify(gBob2.body.picked) === JSON.stringify(['diwali']), 'bob has diwali');
  ok(JSON.stringify(gAnn2.body.picked) === JSON.stringify(['thanksgiving', 'christmas']), 'ann still has her two');
}

console.log(`\n${pass} checks passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
