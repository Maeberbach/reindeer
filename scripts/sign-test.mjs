/* End-to-end exercise of the execution (signing) flow against a live server. */
import fs from 'node:fs';
/* A real photograph of a page, borrowed from the user's own test image so the
   size and encoding are realistic rather than a one-pixel stub. */
const PHOTO = fs.existsSync('/tmp/user-photo.jpg')
  ? fs.readFileSync('/tmp/user-photo.jpg')
  : Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

import { signInAsBootstrapOwner, authedFetch } from './lib/http-auth.mjs';
const B = process.env.BASE || 'http://localhost:3210';
// Bootstrap-owner sign-in \u2014 same rationale as people-test.mjs.
const _cookie = await signInAsBootstrapOwner(B);
const _f = authedFetch(_cookie);
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  \u2713 ' + m)) : (fail++, console.log('  \u2717 ' + m)); };
const j = async (p, o) => { const r = await _f(B + p, o); return { status: r.status, body: await r.json().catch(() => null) }; };

console.log('\n1. Before anything is signed');
{
  const { body } = await j('/api/execution');
  ok(body.signed === false, 'reports nothing signed yet');
  ok(body.record === null, 'no record');
  ok(body.electronic_signature_available === false, 'refuses to offer an electronic signature');
  ok(/hand/i.test(body.reason), 'and explains why in plain words');
}

console.log('\n2. The memorandum prints');
{
  const r = await _f(B + '/api/print/memorandum?owner_name=Margaret%20Ellis&owner_location=Hillsborough%20County%2C%20Florida&will_date=2019-04-11');
  const html = await r.text();
  ok(r.status === 200, 'the page renders');
  ok(html.includes('Margaret Ellis'), 'carries the owner name');
  ok(/tangible personal property/i.test(html), 'names itself as a memorandum of tangible personal property');
  ok(/sign/i.test(html) && /date/i.test(html), 'has signature and date lines');
  ok(!/non-?binding/i.test(html), 'does NOT print the non-binding footer used on every other page');
  ok(/money|indebtedness|securities/i.test(html), 'states the property it cannot cover');
  const w = await (await _f(B + '/api/print/memorandum?witnesses=true')).text();
  ok(/witness/i.test(w), 'witness block appears when asked for');
}

console.log('\n3. Photographing the signed page');
let mediaId;
{
  // A stand-in for a phone photo of a signed sheet.
  const buf = PHOTO;
  const r = await _f(B + '/api/execution/scan?signed_on=2026-08-04&original_location=' + encodeURIComponent('Fireproof box in the hall closet, with the will'), {
    method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: buf,
  });
  const body = await r.json();
  ok(r.status === 200 || r.status === 201, 'the scan is accepted');
  ok(!!body.media_id, 'a record comes back');
  ok(body.sha256 && body.sha256.length === 64, 'the image is fingerprinted');
  ok(body.signed_on === '2026-08-04', 'the signing date is kept');
  ok(/hall closet/.test(body.original_location), 'where the paper original lives is kept');
  mediaId = body.media_id;

  const bad = await _f(B + '/api/execution/scan', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'not an image' });
  ok(bad.status >= 400, 'a non-image is refused');
}

console.log('\n4. Reading it back');
{
  const { body } = await j('/api/execution');
  ok(body.signed === true, 'now reports signed');
  ok(body.record.media_id === mediaId, 'returns the record');
  const img = await _f(`${B}/api/execution/scan/${mediaId}`);
  ok(img.status === 200 && (img.headers.get('content-type') || '').startsWith('image/'), 'the image serves back');
}

console.log('\n5. Correcting where the original is kept');
{
  const r = await j(`/api/execution/${mediaId}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ original_location: 'Safe deposit box 114, First Citizens, Tampa' }),
  });
  ok(r.status === 200, 'the correction is accepted');
  const { body } = await j('/api/execution');
  ok(/Safe deposit box 114/.test(body.record.original_location), 'and it sticks');
  ok(body.record.signed_on === '2026-08-04', 'without losing the signing date');
}

console.log('\n6. The owner\u2019s spoken statement');
{
  const audio = Buffer.alloc(4096, 7);
  const r = await _f(`${B}/api/execution/${mediaId}/statement?duration_ms=21000`, {
    method: 'POST', headers: { 'content-type': 'audio/webm' }, body: audio,
  });
  ok(r.status === 200 || r.status === 201, 'the recording is accepted');
  const { body } = await j('/api/execution');
  ok(!!body.record.statement, 'it attaches to the signed page');
  ok(!!body.record.statement.sha256, 'and is fingerprinted, so it can be shown to be unedited');
  const play = await _f(`${B}/api/execution/statement/${body.record.statement.media_id}`);
  ok(play.status === 200, 'it plays back');
}

console.log('\n7. The professional\u2019s confirmation');
{
  const r = await j(`/api/execution/${mediaId}/attest`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Alan Reyes', role: 'trustee', firm: 'Gulfshore Trust', email: 'areyes@example.com', holds: 'holds_original', note: 'Original placed in the trust file.' }),
  });
  ok(r.status === 200 || r.status === 201, 'a trustee can confirm');

  const lawyer = await j(`/api/execution/${mediaId}/attest`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'D. Okafor', role: 'attorney', holds: 'seen_original' }),
  });
  ok(lawyer.status === 200 || lawyer.status === 201, 'so can an attorney');

  const nameless = await j(`/api/execution/${mediaId}/attest`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'trustee' }),
  });
  ok(nameless.status >= 400, 'an unnamed confirmation is refused \u2014 the whole point is who said it');

  const badRole = await j(`/api/execution/${mediaId}/attest`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'X', role: 'notary-public-ish' }),
  });
  ok(badRole.status >= 400, 'an unknown role is refused');

  const { body } = await j('/api/execution');
  ok(body.record.attestations.length === 2, 'both confirmations are listed');
  ok(body.record.attestations.every((a) => a.confirmed_at), 'each is dated');
}

console.log('\n8. Re-signing supersedes rather than overwrites');
{
  const r = await _f(B + '/api/execution/scan?signed_on=2026-09-01', {
    method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: PHOTO,
  });
  const fresh = await r.json();
  ok(fresh.media_id !== mediaId, 'a second signing makes a new record');
  const { body } = await j('/api/execution');
  ok(body.record.media_id === fresh.media_id, 'the newest is the current one');
  ok(body.history.length >= 1, 'the earlier one is kept in history, not deleted');
  const old = await _f(`${B}/api/execution/scan/${mediaId}`);
  ok(old.status === 200, 'the superseded image is still retrievable');
}

console.log('\n9. It reaches the trustee packet');
{
  const { renderTrusteePacket } = await import('../packages/reindeer-print-feature/src/index.js');
  const { body } = await j('/api/execution');
  const rec = body.record;
  const scopeMedia = [{
    media_id: rec.media_id, media_kind: 'signed_memorandum', title: 'Signed memorandum',
    file_name: 'signed-memorandum.jpg', mime_type: 'image/jpeg', byte_size: rec.byte_size,
    sha256: rec.sha256, created_at: rec.captured_at,
    transcript: JSON.stringify({ signed_on: rec.signed_on, original_location: 'Safe deposit box 114', attestations: [{ name: 'Alan Reyes', role: 'trustee', firm: 'Gulfshore Trust', holds: 'holds_original', confirmed_at: new Date().toISOString() }], statement: { media_id: 'x', sha256: 'y' } }),
  }];
  const html = renderTrusteePacket({ ownerName: 'Margaret Ellis', trustee: { name: 'Alan Reyes', email: 'a@e.com' }, manifest: { counts: {} }, items: [], scopeMedia, delivery: { file_name: 'inventory.reindeer', byte_size: 1000 }, bundleSha256: 'abc' });
  ok(/signed memorandum/i.test(html), 'the packet has a signed-memorandum section');
  ok(/Safe deposit box 114/.test(html), 'it tells the trustee where the paper is');
  ok(/Alan Reyes/.test(html) && /Holds the signed original/.test(html), 'it shows who confirmed and what custody they have');
  ok(/presume/.test(html), 'it warns that a missing original can be presumed revoked');
  ok(/spoken statement/i.test(html), 'it flags the recording');

  const none = renderTrusteePacket({ ownerName: 'X', trustee: { name: 'T', email: 't@e.com' }, manifest: { counts: {} }, items: [], scopeMedia: [], delivery: {}, bundleSha256: 'a' });
  ok(/No signed memorandum is on file/.test(none), 'and says so plainly when there is none');
}

console.log(`\n${pass} checks passed${fail ? `, ${fail} FAILED` : ''}.`);
process.exit(fail ? 1 : 0);
