/**
 * Two-Output Delivery Model — bundle round-trip + endpoint smoke.
 *
 * Commit 2. Verifies the two bundle types actually round-trip:
 *   • writeInventoryBundle → readInventoryBundle preserves envelope +
 *     checksums for scope-level media.
 *   • writeAddendumBundle → readAddendumBundle preserves envelope,
 *     closeup photo checksums, and voice message checksum.
 *   • gaps are surfaced in the manifest and in the parsed envelope.
 *   • The TwoOutputsService signs, persists, and produces a bundle on
 *     disk whose bytes match what was stored in addendum_versions.
 *   • Bundle format strings distinguish inventory (.inventory) from
 *     addendum (.addendum). Legacy .reindeer bundles are unaffected.
 *
 * Does NOT boot the HTTP server (that lives in people-test.mjs and
 * sign-test.mjs, which need live wiring). Exercises the service layer
 * directly, which is where the assertions carry information.
 *
 * Run:  node scripts/two-outputs-bundle-test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

import { SCOPE_TYPE, makeScopeCtx } from '@reindeer-legacy/core-api';
import {
  openDb, SqliteAuditLog, SqliteItemRepository, FsMediaStore, ScopeMediaStore,
  Registry, HeirsRepo, WillsCaretakersRepo, AddendumVersionsRepo, ulid,
} from '@reindeer-legacy/core-data';
import {
  writeInventoryBundle, readInventoryBundle,
  writeAddendumBundle, readAddendumBundle,
  writeBundle, readBundle,
  buildInventoryEnvelope, buildAddendumEnvelope,
  INVENTORY_BUNDLE_FORMAT, ADDENDUM_BUNDLE_FORMAT,
} from '@reindeer-legacy/exchange';
import { TrusteeRepository, TwoOutputsService, RecordingMailer } from '@reindeer-legacy/delivery';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'two-outputs-bundle-'));
let pass = 0;
const check = async (name, fn) => { await fn(); pass++; console.log(`  ✓ ${name}`); };

function wire(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const db = openDb(path.join(dir, `${name}.db`));
  const audit = new SqliteAuditLog(db);
  const itemRepo = new SqliteItemRepository(db, audit);
  const mediaStore = new FsMediaStore(db, path.join(dir, 'media'));
  const scopeMediaStore = new ScopeMediaStore(db, path.join(dir, 'media'));
  const registry = new Registry(db, audit);
  const heirs = new HeirsRepo(db, audit);
  const willsCaretakers = new WillsCaretakersRepo(db, audit);
  const addendumVersions = new AddendumVersionsRepo(db, audit);
  const trustees = new TrusteeRepository(db, audit);
  const scopeId = `${name}-scope`;
  registry.ensureScope({ scopeId, scopeType: SCOPE_TYPE.INVENTORY, name });
  const ctx = makeScopeCtx({ scopeType: SCOPE_TYPE.INVENTORY, scopeId, actorId: 'test' });
  const twoOutputs = new TwoOutputsService({
    db, audit, itemRepo, mediaStore, scopeMediaStore, registry,
    heirs, willsCaretakers, addendumVersions, trustees,
    storageDir: path.join(dir, 'two-outputs'),
    ownerName: 'Test Owner',
    estateId: scopeId,
  });
  return { db, audit, itemRepo, mediaStore, scopeMediaStore, registry, heirs, willsCaretakers, addendumVersions, trustees, twoOutputs, ctx, scopeId, dir };
}

// A one-pixel PNG so the exchange bundle has a real image to checksum.
const PIXEL = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489000000164944415478da62fbcfc0c8c0c0c0c0c0c0c0c0c000000900010001fbdb5b3d0000000049454e44ae426082',
  'hex',
);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

console.log('\nTwo-Output Delivery Model — bundle round-trip + service test\n');

/* -------------------------------------------------------------------------- */
console.log('1. Fixtures');
const w = wire('workshop');

const trustee = await w.trustees.create({ name: 'Alex Trust', email: 'alex@example.com' }, w.ctx);
await check('trustee stored with scope', () => assert.equal(w.trustees.list(w.ctx).length, 1));

const heir = w.heirs.create({ name: 'Sarah', relationship: 'Daughter' }, w.ctx);
await check('heir stored with heir_id', () => assert.ok(heir.heir_id));

const caretaker = w.willsCaretakers.create({
  name: 'Priya Legal', firm: 'Alpharetta Estates', email: 'p@example.com', delivery_method: 'email',
}, w.ctx);
await check('wills caretaker stored', () => assert.equal(w.willsCaretakers.list(w.ctx).length, 1));

const ring = await w.itemRepo.create({
  title: "Grandmother's sapphire ring",
  room_id: w.registry.resolveRoom('Primary Bedroom', w.ctx).room_id,
  category_id: w.registry.resolveCategory('Jewelry', w.ctx).category_id,
  review_state: 'kept',
  owner_high_value: true,
  owner_high_value_reason: 'feeling',
  owner_important_comment: 'Grandma wore this every day.',
}, w.ctx);
const clock = await w.itemRepo.create({
  title: 'Grandfather clock',
  room_id: w.registry.resolveRoom('Living Room', w.ctx).room_id,
  category_id: w.registry.resolveCategory('Furniture', w.ctx).category_id,
  review_state: 'kept',
}, w.ctx);
const kettlebell = await w.itemRepo.create({
  title: 'Kettlebell',
  room_id: w.registry.resolveRoom('Garage', w.ctx).room_id,
  category_id: w.registry.resolveCategory('Fitness', w.ctx).category_id,
  review_state: 'kept',
}, w.ctx);
await check('three kept items in inventory', async () =>
  assert.equal((await w.itemRepo.list({ review_state: 'kept' }, w.ctx)).items.length, 3));

// Attach a close-up to the ring; leave the clock without one so it becomes a gap.
const ringPhoto = await w.mediaStore.put(PIXEL, {
  item_id: ring.item_id, mime_type: 'image/png', media_kind: 'photo', role: 'primary',
}, w.ctx);
await w.itemRepo.setCloseupPhoto(ring.item_id, ringPhoto.photo_id, w.ctx);
await check('close-up photo linked via setCloseupPhoto', async () => {
  const r = await w.itemRepo.get(ring.item_id, w.ctx);
  assert.equal(r.closeup_photo_id, ringPhoto.photo_id);
});

await w.itemRepo.assignHeir(ring.item_id, heir.heir_id, w.ctx);
await w.itemRepo.assignHeir(clock.item_id, heir.heir_id, w.ctx);
await check('two items assigned to heir via assignHeir', async () => {
  const r = await w.itemRepo.get(ring.item_id, w.ctx);
  const c = await w.itemRepo.get(clock.item_id, w.ctx);
  assert.equal(r.assigned_to_heir_id, heir.heir_id);
  assert.equal(c.assigned_to_heir_id, heir.heir_id);
});
await check('unassigned items reject wrong heir', async () => {
  await assert.rejects(w.itemRepo.assignHeir(kettlebell.item_id, 'no-such-heir', w.ctx));
});
await check('heir with assigned items refuses remove', () => {
  assert.throws(() => w.heirs.remove(heir.heir_id, w.ctx), /assign/i);
});

// A scope-level owner voice recording.
const voice = await w.scopeMediaStore.put(Buffer.from('opus-bytes-here'), {
  media_kind: 'audio', mime_type: 'audio/ogg', title: 'Owner voice',
  transcript: 'To my daughter Sarah, take good care of Grandma\u2019s ring.',
  duration_ms: 14200,
}, w.ctx);
await check('scope voice message stored', () => assert.ok(voice.media_id));

/* -------------------------------------------------------------------------- */
console.log('\n2. Inventory bundle round-trip');
const invItems = (await w.itemRepo.list({ review_state: 'kept' }, w.ctx)).items;

const invEnvelope = buildInventoryEnvelope({
  items: invItems,
  rooms: w.registry.rooms(w.ctx),
  categories: w.registry.categories(w.ctx),
  estateId: w.scopeId,
  trigger: 'manual_test',
  recipient: { role: 'trustee', name: trustee.name, contact: trustee.email, delivery_method: 'email' },
  source: { app: 'legacy-registry', app_version: '0.1.0', inventory_id: w.scopeId, owner_name: 'Test Owner' },
});
await check('inventory envelope has all three items', () => assert.equal(invEnvelope.items.length, 3));

const scopeMediaList = w.scopeMediaStore.list(w.ctx);
const invWritten = await writeInventoryBundle({
  envelope: invEnvelope, mediaStore: w.mediaStore, scopeMediaStore: w.scopeMediaStore,
  scopeMedia: scopeMediaList, ctx: w.ctx,
});
await check('inventory bundle bytes non-empty', () => assert.ok(invWritten.buffer.length > 400));
await check('inventory file ends with .inventory', () => assert.match(invWritten.fileName, /\.inventory$/));
await check('inventory envelope sha256 is 64 hex chars', () => assert.match(invWritten.envelopeSha256, /^[0-9a-f]{64}$/));
await check('inventory manifest counts total_items = 3', () => assert.equal(invWritten.manifest.counts.total_items, 3));

const invRead = readInventoryBundle(invWritten.buffer);
await check('read inventory bundle sees INVENTORY format', () =>
  assert.equal(invRead.manifest.format, INVENTORY_BUNDLE_FORMAT));
await check('round-tripped inventory envelope matches sha', () =>
  assert.equal(sha(Buffer.from(JSON.stringify(invRead.envelope))), sha(Buffer.from(JSON.stringify(invEnvelope)))));
await check('scope media rides through inventory bundle', () =>
  assert.ok([...invRead.files.keys()].some((k) => k.startsWith('media/_scope/'))));
await check('inventory bundle carries README.txt with the not-a-legal-document cover', () => {
  const readme = invRead.files.get('README.txt');
  assert.ok(readme, 'README.txt is packed in the inventory bundle');
  const text = readme.toString('utf8');
  assert.match(text, /Registry is a preparation tool, not a legal document/);
  assert.match(text, /paper the owner handed you/i);
  assert.match(text, /replace or amend this memorandum at any/i);
});

/* -------------------------------------------------------------------------- */
console.log('\n3. Addendum bundle round-trip (via service, with signing)');

const signResult = await w.twoOutputs.signAndWriteAddendum({
  ownerParticipantId: 'owner-mark',
  signature: { device: 'iPad Pro (test)', signed_at: '2026-08-09T14:30:00Z', ink_hash: 'sha256:aaa' },
  recipientCaretakerIds: [caretaker.caretaker_id],
  voiceMediaId: voice.media_id,
}, w.ctx);

await check('sign returned version v1', () => assert.equal(signResult.version.version_number, 1));
await check('sign persisted supersedes_version null', () => assert.equal(signResult.version.supersedes_version, null));
await check('bundle file written to disk', () => assert.ok(fs.existsSync(signResult.bundlePath)));
await check('bundle file ends with .addendum', () => assert.match(signResult.fileName, /\.addendum$/));

const bundleOnDisk = fs.readFileSync(signResult.bundlePath);
await check('bytes on disk match returned buffer', () => assert.equal(sha(bundleOnDisk), sha(signResult.buffer)));

const addRead = readAddendumBundle(bundleOnDisk);
await check('read addendum bundle sees ADDENDUM format', () =>
  assert.equal(addRead.manifest.format, ADDENDUM_BUNDLE_FORMAT));
await check('parsed envelope has both assigned items', () => assert.equal(addRead.envelope.items.length, 2));
await check('parsed envelope carries the signature evidence', () =>
  assert.equal(addRead.envelope.owner.signature_evidence.device, 'iPad Pro (test)'));
await check('parsed envelope carries the voice message', () => {
  const f = addRead.envelope.voice_message.file || '';
  assert.ok(f.endsWith(voice.file_name), `expected voice_message.file to end with ${voice.file_name}, got ${f}`);
});
await check('parsed envelope lists the missing-closeup gap', () => {
  const gap = addRead.envelope.gaps.find((g) => g.reason === 'closeup_photo_missing');
  assert.ok(gap && gap.item_id === clock.item_id);
});
// missing_closeups tracks references the bundler could not resolve to a
// file on disk. Our clock has no closeup reference in the envelope at all,
// so it belongs in envelope.gaps (asserted above), not in missing_closeups.
await check('manifest.missing_closeups is empty when all referenced files exist', () =>
  assert.equal(addRead.manifest.missing_closeups?.length ?? 0, 0));
await check('closeup photo file is in bundle', () =>
  assert.ok([...addRead.files.keys()].some((k) => k.startsWith('media/closeups/'))));
await check('voice message file is in bundle', () =>
  assert.ok([...addRead.files.keys()].some((k) => k.startsWith('media/voice/'))));
await check('addendum bundle carries README.txt with the not-a-legal-document cover', () => {
  const readme = addRead.files.get('README.txt');
  assert.ok(readme, 'README.txt is packed in the addendum bundle');
  const text = readme.toString('utf8');
  assert.match(text, /Registry is a preparation tool, not a legal document/);
  assert.match(text, /paper the owner handed you/i);
  assert.match(text, /replace or amend this memorandum at any/i);
});

/* -------------------------------------------------------------------------- */
console.log('\n4. Addendum versioning');
const versionsAfterFirst = w.addendumVersions.list(w.ctx, 'owner-mark');
await check('versions list has one row', () => assert.equal(versionsAfterFirst.length, 1));
await check('version row carries bundle_path', () => assert.ok(versionsAfterFirst[0].bundle_path));

const secondSign = await w.twoOutputs.signAndWriteAddendum({
  ownerParticipantId: 'owner-mark',
  signature: { device: 'iPad Pro (test)', signed_at: '2026-08-09T14:35:00Z' },
  recipientCaretakerIds: [caretaker.caretaker_id],
}, w.ctx);
await check('second sign returns v2', () => assert.equal(secondSign.version.version_number, 2));
await check('second sign supersedes v1', () => assert.equal(secondSign.version.supersedes_version, 1));
await check('versions list now has two rows', () => assert.equal(w.addendumVersions.list(w.ctx, 'owner-mark').length, 2));

/* -------------------------------------------------------------------------- */
console.log('\n5. Guardrails');

await check('signing without evidence is rejected', () =>
  assert.rejects(w.twoOutputs.signAndWriteAddendum({
    ownerParticipantId: 'owner-mark', signature: null,
    recipientCaretakerIds: [caretaker.caretaker_id],
  }, w.ctx), /signature/i));

// Wipe assignments to prove the "nothing to add" path is loud.
await w.itemRepo.assignHeir(ring.item_id, null, w.ctx);
await w.itemRepo.assignHeir(clock.item_id, null, w.ctx);
await check('signing with no assigned items is rejected', () =>
  assert.rejects(w.twoOutputs.signAndWriteAddendum({
    ownerParticipantId: 'owner-mark',
    signature: { device: 'iPad Pro (test)' },
    recipientCaretakerIds: [caretaker.caretaker_id],
  }, w.ctx), /assigned/i));

// Now the heir has no assignments -> removal must succeed.
await check('heir with no assignments can be removed', () => {
  w.heirs.remove(heir.heir_id, w.ctx);
  assert.equal(w.heirs.list(w.ctx).length, 0);
});

// Legacy bundle format must remain distinct.
await check('inventory format string is not the legacy one', () =>
  assert.notEqual(INVENTORY_BUNDLE_FORMAT, 'legacy-exchange-bundle'));
await check('addendum format string is not the inventory one', () =>
  assert.notEqual(ADDENDUM_BUNDLE_FORMAT, INVENTORY_BUNDLE_FORMAT));

/* -------------------------------------------------------------------------- */
console.log('\n6. Freeze flow \u2014 memorandum lifecycle across owner death');

// A brand-new scope so we can walk the whole lifecycle without stepping
// on the fixtures used above (which already ran two signings and left
// v2 as latest).
const f = wire('freeze-flow');
const fTrustee = await f.trustees.create({ name: 'Family Trustee', email: 't@example.com' }, f.ctx);
const fHeir = f.heirs.create({ name: 'Ann', relationship: 'Daughter' }, f.ctx);
const fCaretaker = f.willsCaretakers.create({
  name: 'Family Attorney', firm: 'Elm Law', email: 'e@example.com', delivery_method: 'email',
}, f.ctx);

const watch = await f.itemRepo.create({
  title: "Father's pocket watch",
  room_id: f.registry.resolveRoom('Study', f.ctx).room_id,
  category_id: f.registry.resolveCategory('Jewelry', f.ctx).category_id,
  review_state: 'kept',
}, f.ctx);
const watchPhoto = await f.mediaStore.put(PIXEL, {
  item_id: watch.item_id, mime_type: 'image/png', media_kind: 'photo', role: 'primary',
}, f.ctx);
await f.itemRepo.setCloseupPhoto(watch.item_id, watchPhoto.photo_id, f.ctx);
await f.itemRepo.assignHeir(watch.item_id, fHeir.heir_id, f.ctx);

// A stub "people" lookup so the exporter can label the frozen memorandum
// with the deceased owner's first name for grouping in Fair Choice.
const peopleStub = {
  get(id) {
    if (id === 'owner-mark-freeze') return { name: 'Mark Freeze' };
    return null;
  },
};

// (a) A living owner signs.
const firstSignFreeze = await f.twoOutputs.signAndWriteAddendum({
  ownerParticipantId: 'owner-mark-freeze',
  signature: { device: 'iPad Pro (test)', signed_at: '2026-08-09T09:00:00Z' },
  recipientCaretakerIds: [fCaretaker.caretaker_id],
}, f.ctx);
await check('first sign returns v1', () =>
  assert.equal(firstSignFreeze.version.version_number, 1));

// (b) A pre-death export must NOT carry any locked memoranda. Living
//     owners' signings never leak into a Fair Choice export.
const preFreezeBundle = await writeBundle({
  itemRepo: f.itemRepo, mediaStore: f.mediaStore, scopeMediaStore: f.scopeMediaStore,
  registry: f.registry, ctx: f.ctx,
  query: { review_state: 'kept' },
  source: { app: 'legacy-registry', app_version: '0.1.0', inventory_id: f.scopeId, owner_name: 'Mark Freeze' },
  addendumVersions: f.addendumVersions,
  people: peopleStub,
});
await check('export before freeze carries zero locked_memoranda', () =>
  assert.equal(preFreezeBundle.envelope.locked_memoranda?.length ?? 0, 0));
await check('export before freeze reports counts.locked_memoranda === 0', () =>
  assert.equal(preFreezeBundle.envelope.counts?.locked_memoranda ?? 0, 0));

// (c) The trustee marks the owner deceased \u2014 freezing the latest version.
const frozen = f.addendumVersions.freezeLatest({
  ownerParticipantId: 'owner-mark-freeze',
  frozenAt: '2026-08-10T12:00:00Z',
  frozenNote: 'Death notice received.',
}, f.ctx);
await check('freezeLatest returns the row it froze', () =>
  assert.ok(frozen?.frozen_at));
await check('freezing is idempotent', () => {
  const again = f.addendumVersions.freezeLatest({ ownerParticipantId: 'owner-mark-freeze' }, f.ctx);
  assert.equal(again.frozen_at, frozen.frozen_at);
});

// (d) A second sign after the freeze is refused with the exact copy the
//     user approved. This is the guard-rail against a well-meaning family
//     member trying to \u201cupdate\u201d a dead person's memorandum.
await check('signing after freeze is refused with the frozen-memorandum message', () =>
  assert.rejects(
    f.twoOutputs.signAndWriteAddendum({
      ownerParticipantId: 'owner-mark-freeze',
      signature: { device: 'iPad Pro (test)', signed_at: '2026-08-11T09:00:00Z' },
      recipientCaretakerIds: [fCaretaker.caretaker_id],
    }, f.ctx),
    (err) => /memorandum has been frozen/i.test(err.message)
      && /paper the trustee holds is what governs/i.test(err.message),
  ));

// (e) Only the same latest version stays on record \u2014 no ghost v2 got
//     written despite the refusal.
await check('addendum_versions still holds only v1 after refused second sign', () =>
  assert.equal(f.addendumVersions.list(f.ctx, 'owner-mark-freeze').length, 1));

// (f) A post-death Fair Choice export MUST carry the frozen memorandum.
//     Owner name for grouping travels; recipient identity does not.
const postFreezeBundle = await writeBundle({
  itemRepo: f.itemRepo, mediaStore: f.mediaStore, scopeMediaStore: f.scopeMediaStore,
  registry: f.registry, ctx: f.ctx,
  query: { review_state: 'kept' },
  source: { app: 'legacy-registry', app_version: '0.1.0', inventory_id: f.scopeId, owner_name: 'Mark Freeze' },
  addendumVersions: f.addendumVersions,
  people: peopleStub,
});
await check('post-freeze export carries exactly one locked memorandum', () =>
  assert.equal(postFreezeBundle.envelope.locked_memoranda.length, 1));
await check('locked memorandum carries the deceased owner\u2019s name', () =>
  assert.equal(postFreezeBundle.envelope.locked_memoranda[0].owner_name, 'Mark Freeze'));
await check('locked memorandum carries the item_ids it locks', () =>
  assert.deepEqual(postFreezeBundle.envelope.locked_memoranda[0].item_ids, [watch.item_id]));
await check('the locked item carries is_locked_gift: true in the envelope', () => {
  // envelope.items keeps id under `id` (see buildEnvelope) but the source
  // rows out of itemRepo.list arrive as raw DB shapes with `item_id`.
  // buildEnvelope normalizes id -> item_id, so search on both.
  const it = postFreezeBundle.envelope.items.find(
    (i) => (i.id ?? i.item_id) === watch.item_id,
  );
  assert.ok(it, `expected an item row for ${watch.item_id}`);
  assert.equal(it.is_locked_gift, true);
});
await check('counts.locked_by_memorandum matches item_ids length', () =>
  assert.equal(postFreezeBundle.envelope.counts.locked_by_memorandum, 1));

// (g) The written .reindeer zip is readable and the envelope survives.
await check('post-freeze .reindeer bundle re-reads with the locked memorandum intact', () => {
  const { problems, manifest } = readBundle(postFreezeBundle.buffer);
  assert.deepEqual(problems, []);
  assert.ok(manifest?.batch_id);
});

/* -------------------------------------------------------------------------- */
// Email preview: an owner can send an unsigned preview of the latest signed
// version to a wills caretaker they've configured for email. Uses a fresh
// wire so the mailer is scoped to this section.
function wireWithMailer(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const db = openDb(path.join(dir, `${name}.db`));
  const audit = new SqliteAuditLog(db);
  const itemRepo = new SqliteItemRepository(db, audit);
  const mediaStore = new FsMediaStore(db, path.join(dir, 'media'));
  const scopeMediaStore = new ScopeMediaStore(db, path.join(dir, 'media'));
  const registry = new Registry(db, audit);
  const heirs = new HeirsRepo(db, audit);
  const willsCaretakers = new WillsCaretakersRepo(db, audit);
  const addendumVersions = new AddendumVersionsRepo(db, audit);
  const trustees = new TrusteeRepository(db, audit);
  const scopeId = `${name}-scope`;
  registry.ensureScope({ scopeId, scopeType: SCOPE_TYPE.INVENTORY, name });
  const ctx = makeScopeCtx({ scopeType: SCOPE_TYPE.INVENTORY, scopeId, actorId: 'test' });
  const mailer = new RecordingMailer();
  const twoOutputs = new TwoOutputsService({
    db, audit, itemRepo, mediaStore, scopeMediaStore, registry,
    heirs, willsCaretakers, addendumVersions, trustees,
    storageDir: path.join(dir, 'two-outputs'),
    ownerName: 'Test Owner', estateId: scopeId, mailer,
  });
  return { db, audit, itemRepo, registry, heirs, willsCaretakers,
    addendumVersions, trustees, twoOutputs, mailer, ctx, scopeId, dir };
}

const m = wireWithMailer('email-preview');
const mHeir = m.heirs.create({ name: 'Jamie Doe' }, m.ctx);
const mAtty = m.willsCaretakers.create({
  name: 'Alex Reed', firm: 'Reed & Co', email: 'alex@example.com',
  phone: '', delivery_method: 'email',
}, m.ctx);
const mCourier = m.willsCaretakers.create({
  name: 'Print & Post', firm: '', email: '', phone: '', delivery_method: 'print_mail',
}, m.ctx);
const mBook = await m.itemRepo.create({
  title: 'Field guide',
  room_id: m.registry.resolveRoom('Study', m.ctx).room_id,
  category_id: m.registry.resolveCategory('Books', m.ctx).category_id,
  condition_note: '', quantity: 1, review_state: 'kept', notes_free_text: '',
}, m.ctx);
await m.itemRepo.assignHeir(mBook.item_id, mHeir.heir_id, m.ctx);
const mOwner = 'owner-mail-1';
m.trustees.create({ name: 'A Trustee', email: 'trustee@example.com', phone: '' }, m.ctx);
const mSign = await m.twoOutputs.signAndWriteAddendum({
  ownerParticipantId: mOwner,
  signature: {
    device: 'iPad (test)',
    signed_at: '2026-08-09T14:30:00Z',
    signer_name: 'Owner Signer',
    typed_acknowledgement: 'These are my wishes today',
  },
  recipientCaretakerIds: [mAtty.caretaker_id],
}, m.ctx);

await check('email preview refuses when no signed version exists', async () => {
  const empty = wireWithMailer('email-preview-empty');
  const c2 = empty.willsCaretakers.create({
    name: 'X', firm: '', email: 'x@example.com', phone: '', delivery_method: 'email',
  }, empty.ctx);
  await assert.rejects(
    empty.twoOutputs.sendUnsignedPreviewEmail({
      ownerParticipantId: 'nobody', caretakerId: c2.caretaker_id,
    }, empty.ctx),
    /no signed memorandum/i,
  );
});

await check('email preview refuses caretaker not set to email delivery', async () => {
  await assert.rejects(
    m.twoOutputs.sendUnsignedPreviewEmail({
      ownerParticipantId: mOwner, caretakerId: mCourier.caretaker_id,
    }, m.ctx),
    /print mail|email/i,
  );
});

const previewOut = await m.twoOutputs.sendUnsignedPreviewEmail({
  ownerParticipantId: mOwner, caretakerId: mAtty.caretaker_id,
}, m.ctx);

await check('email preview reports sent + recipient email', () => {
  assert.equal(previewOut.sent, true);
  assert.equal(previewOut.recipient.email, 'alex@example.com');
  assert.equal(previewOut.version_number, mSign.version.version_number);
});
await check('recording mailer captured the message', () => {
  assert.equal(m.mailer.sent.length, 1);
  const msg = m.mailer.sent[0];
  assert.equal(msg.to, 'alex@example.com');
  assert.match(msg.subject, /Unsigned preview/i);
  assert.match(msg.text, /not legally binding/i);
  assert.equal(msg.attachments.length, 1);
  assert.match(msg.attachments[0].filename, /\.addendum$/);
  assert.ok(msg.attachments[0].content.length > 400);
});
await check('email preview refuses a frozen version', async () => {
  m.addendumVersions.freezeLatest({
    ownerParticipantId: mOwner,
    frozenByParticipantId: 'trustee-freeze',
    frozenNote: 'handoff',
  }, m.ctx);
  await assert.rejects(
    m.twoOutputs.sendUnsignedPreviewEmail({
      ownerParticipantId: mOwner, caretakerId: mAtty.caretaker_id,
    }, m.ctx),
    /handed off|frozen/i,
  );
});

/* -------------------------------------------------------------------------- */
console.log(`\nAll ${pass} checks passed.\n`);
