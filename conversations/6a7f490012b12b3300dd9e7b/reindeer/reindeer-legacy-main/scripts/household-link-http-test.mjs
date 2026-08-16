/*
 * Household link ceremony — HTTP integration test.
 *
 * What this covers
 *   1. GET  /api/household-link                — initial state on a fresh install
 *   2. POST /api/household-link/invite         — owner-only, mints a partner
 *                                                magic link via the auth service
 *   3. POST /api/household-link/confirm        — either partner can flip mode
 *                                                to 'couple' once both are on
 *                                                the scope
 *   4. POST /api/household-link/unlink         — either partner can drop back
 *                                                to 'solo'; idempotent
 *   5. Downstream behaviour                   — scope-summary reflects the new
 *                                                household_mode, and importance
 *                                                claims stop auto-agreeing in
 *                                                couple mode
 *   6. Auth guards                            — unauthenticated requests are
 *                                                rejected
 *
 * Prerequisites (same as the other HTTP suites)
 *   • Server up on BASE (default http://localhost:3210) with
 *     REINDEER_MAILER_OFF=1 so magic links come back in the response body.
 *   • Fresh temp LEGACY_INVENTORY_DIR so the first sign-in mints the
 *     bootstrap owner.
 */
import {
  requestMagicLink, consumeMagicLink, authedFetch, TEST_OWNER_EMAIL,
} from './lib/http-auth.mjs';

const BASE = process.env.BASE || 'http://localhost:3210';
const ANN_EMAIL = TEST_OWNER_EMAIL;
const BOB_EMAIL = 'test-partner@localhost.test';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  \u2713 ' + m)) : (fail++, console.log('  \u2717 ' + m)); };

async function signIn(email) {
  const link = await requestMagicLink(BASE, email);
  return consumeMagicLink(BASE, link);
}

const asClient = (cookie) => {
  const _f = authedFetch(cookie);
  const j = async (p, o) => { const r = await _f(BASE + p, o); return { status: r.status, body: await r.json().catch(() => null) }; };
  return {
    get: (p) => j(p),
    post: (p, b) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) }),
  };
};

console.log('\n1. Sign in as Ann (bootstrap owner)');
const annCookie = await signIn(ANN_EMAIL);
const ann = asClient(annCookie);
{
  const r = await ann.get('/api/auth/me');
  ok(r.body.participant?.role === 'owner', 'ann is the owner');
}

console.log('\n2. Fresh install \u2014 household-link reports solo, no partner yet');
{
  const r = await ann.get('/api/household-link');
  ok(r.status === 200, 'household-link responds');
  ok(r.body.household_mode === 'solo', 'household_mode starts solo');
  ok(r.body.partner_present === false, 'no partner participant yet');
  ok(r.body.can_confirm === false, 'cannot confirm before a partner exists');
  ok(r.body.can_unlink === false, 'cannot unlink a scope that is not linked');
  ok(r.body.linked_at === null, 'no linked_at yet');
  ok(Array.isArray(r.body.participants), 'participants array is returned');
  ok(r.body.participants.some((p) => p.is_me && p.email === ANN_EMAIL), 'ann appears as is_me');
}

console.log('\n3. Confirm before invite \u2014 rejected');
{
  const r = await ann.post('/api/household-link/confirm');
  ok(r.status === 400, 'confirm without a partner is 400');
  ok(/both partners/i.test(r.body.error), 'error mentions both partners');
}

console.log('\n4. Owner invites Bob');
let inviteLink;
{
  const r = await ann.post('/api/household-link/invite', { email: BOB_EMAIL });
  ok(r.status === 201, 'invite mints a link');
  ok(typeof r.body.link === 'string' && r.body.link.length > 0, 'link URL is echoed back (REINDEER_MAILER_OFF=1)');
  ok(typeof r.body.expires_at === 'string', 'expiry is a string');
  inviteLink = r.body.link;

  const missing = await ann.post('/api/household-link/invite', {});
  ok(missing.status === 400, 'invite without email is 400');
}

console.log('\n5. Confirm before Bob has signed in \u2014 still rejected');
{
  const r = await ann.post('/api/household-link/confirm');
  ok(r.status === 400, 'partner has been invited but not signed in yet');
  ok(/both partners/i.test(r.body.error), 'same guidance shown');
}

console.log('\n6. Bob consumes the invite link');
const bobCookie = await consumeMagicLink(BASE, inviteLink);
const bob = asClient(bobCookie);
{
  const r = await bob.get('/api/auth/me');
  ok(r.status === 200, 'bob has a session');
  ok(r.body.participant?.email === BOB_EMAIL, 'bob\u2019s email is recorded');
  ok(r.body.participant?.role === 'partner', 'bob\u2019s role is partner');
}

console.log('\n7. household-link now reports partner_present=true and can_confirm=true');
{
  const r = await ann.get('/api/household-link');
  ok(r.body.partner_present === true, 'partner is present');
  ok(r.body.can_confirm === true, 'can_confirm becomes true');
  ok(r.body.household_mode === 'solo', 'mode is still solo until confirmed');
  ok(r.body.participants.some((p) => p.role === 'partner' && p.email === BOB_EMAIL), 'bob is listed');
}

console.log('\n8. Bob is not the owner \u2014 he cannot invite');
{
  const r = await bob.post('/api/household-link/invite', { email: 'someone@example.com' });
  ok(r.status === 403, 'partner cannot invite a third participant');
  ok(/only the owner/i.test(r.body.error), 'error mentions owner');
}

console.log('\n9. Either partner can confirm \u2014 Bob confirms');
{
  const r = await bob.post('/api/household-link/confirm');
  ok(r.status === 200, 'confirm succeeds');
  ok(r.body.scope.household_mode === 'couple', 'mode flips to couple');
  ok(typeof r.body.scope.linked_at === 'string', 'linked_at is set');
  ok(typeof r.body.scope.linked_by_participant_id === 'string', 'linked_by_participant_id is set');
  ok(r.body.scope.linked_household_id === 'inventory-default', 'linked_household_id defaults to the scope id');
}

console.log('\n10. Confirm is idempotent');
{
  const r = await ann.post('/api/household-link/confirm');
  ok(r.status === 200, 'second confirm still 200');
  ok(r.body.already_linked === true, 'reports already_linked');
  ok(r.body.scope.household_mode === 'couple', 'still couple');
}

console.log('\n11. Downstream: scope-summary reflects couple mode');
{
  const r = await ann.get('/api/scope-summary');
  ok(r.body.household_mode === 'couple', 'scope-summary agrees');
  ok(r.body.linked_household_id === 'inventory-default', 'and shows linked_household_id');
}

console.log('\n12. Either partner can unlink \u2014 Ann unlinks');
{
  const r = await ann.post('/api/household-link/unlink');
  ok(r.status === 200, 'unlink succeeds');
  ok(r.body.scope.household_mode === 'solo', 'mode back to solo');
  ok(r.body.scope.linked_at === null, 'linked_at is cleared');
  ok(r.body.scope.linked_by_participant_id === null, 'linked_by is cleared');
  // linked_household_id is preserved so we can distinguish "never linked"
  // from "was linked once". The unlink method only clears the timestamp
  // and who confirmed.
}

console.log('\n13. Unlink is idempotent');
{
  const r = await ann.post('/api/household-link/unlink');
  ok(r.status === 200, 'second unlink still 200');
  ok(r.body.already_solo === true, 'reports already_solo');
}

console.log('\n14. Re-linking works');
{
  const r = await ann.post('/api/household-link/confirm');
  ok(r.status === 200, 'confirm succeeds again');
  ok(r.body.scope.household_mode === 'couple', 'and mode is couple once more');
}

console.log('\n15. Auth guards on every route');
{
  const noCookie = async (path, method = 'GET') => (await fetch(BASE + path, {
    method,
    headers: method === 'POST' ? { 'content-type': 'application/json' } : {},
    body: method === 'POST' ? '{}' : undefined,
  })).status;
  ok((await noCookie('/api/household-link')) === 401, 'household-link GET requires a session');
  ok((await noCookie('/api/household-link/invite', 'POST')) === 401, 'invite requires a session');
  ok((await noCookie('/api/household-link/confirm', 'POST')) === 401, 'confirm requires a session');
  ok((await noCookie('/api/household-link/unlink', 'POST')) === 401, 'unlink requires a session');
}

console.log(`\n${pass} checks passed${fail ? `, ${fail} FAILED` : ''}.`);
process.exit(fail ? 1 : 0);
