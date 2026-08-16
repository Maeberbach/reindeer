/*
 * Seed a scope for the browser check of the memorandum writer.
 *   • signs Ann in as the bootstrap owner
 *   • invites Bob as the partner and consumes his link
 *   • adds three heirs (Sarah, Mike, David) and three items
 *   • adds one entry on Ann's draft so the writer shows content
 *   • adds one entry on Bob's draft that conflicts with Ann's on the china
 *   • signs Bob's v1 so the conflict banner fires for Ann
 *
 * Prints Ann's cookie so the browser can be launched with it.
 */
import {
  requestMagicLink, consumeMagicLink, authedFetch, TEST_OWNER_EMAIL,
} from './lib/http-auth.mjs';

const BASE = process.env.BASE || 'http://localhost:3260';
const ANN_EMAIL = TEST_OWNER_EMAIL;
const BOB_EMAIL = 'test-partner@localhost.test';

async function signIn(email) {
  const link = await requestMagicLink(BASE, email);
  return consumeMagicLink(BASE, link);
}
function asClient(cookie) {
  const f = authedFetch(cookie);
  const j = async (p, o) => {
    const r = await f(BASE + p, o);
    let body = null;
    try { body = await r.json(); } catch { body = null; }
    return { status: r.status, body };
  };
  return {
    get: (p) => j(p),
    post: (p, b) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) }),
    del:  (p) => j(p, { method: 'DELETE' }),
  };
}

const annCookie = await signIn(ANN_EMAIL);
const ann = asClient(annCookie);

// three heirs
const heirSarah = (await ann.post('/api/two-outputs/heirs', { name: 'Sarah', relationship: 'daughter' })).body.heir_id;
const heirMike  = (await ann.post('/api/two-outputs/heirs', { name: 'Mike', relationship: 'son' })).body.heir_id;
const heirDavid = (await ann.post('/api/two-outputs/heirs', { name: 'David', relationship: 'nephew' })).body.heir_id;

// three items
const room = (await ann.post('/api/rooms', { name: 'Dining room' })).body;
const cat  = (await ann.post('/api/categories', { name: 'China' })).body;
async function addItem(title) {
  return (await ann.post('/api/items', {
    title, room_id: room.room_id, category_id: cat.category_id, review_state: 'kept',
  })).body;
}
const china = await addItem('Wedding china (Grandmother\u2019s set)');
const clock = await addItem('Grandfather clock');
const books = await addItem('Complete Dickens set');

// invite Bob, sign him in, and confirm the household to couple mode
const invite = await ann.post('/api/household-link/invite', { email: BOB_EMAIL, display_name: 'Bob' });
const bobCookie = await consumeMagicLink(BASE, invite.body.link);
const bob = asClient(bobCookie);
await ann.post('/api/household-link/confirm', {});

// Ann promises china to Sarah, clock to Mike
await ann.post('/api/memorandum/entries', { item_id: china.item_id, assigned_to_heir_id: heirSarah, note: 'This was my mother\u2019s; Sarah always loved it.' });
await ann.post('/api/memorandum/entries', { item_id: clock.item_id, assigned_to_heir_id: heirMike, note: '' });

// Bob promises the china to David \u2014 conflict with Ann.
await bob.post('/api/memorandum/entries', { item_id: china.item_id, assigned_to_heir_id: heirDavid, note: 'For David from my side of the family.' });

// Bob signs v1 so the conflict banner fires for Ann on her next open.
await bob.post('/api/memorandum/sign', {});

console.log(JSON.stringify({ annCookie, bobCookie, itemIds: { china: china.item_id, clock: clock.item_id, books: books.item_id } }, null, 2));
