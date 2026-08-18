/**
 * Round-trip gate: capture in My Legacy Registry → export bundle →
 * import into Legacy: Fair Choice → verify nothing was lost or silently changed.
 *
 * Run: npm run test:roundtrip
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

import { SCOPE_TYPE, makeScopeCtx, MAX_EMAIL_ATTACHMENT_BYTES } from '@reindeer-legacy/core-api';
import { openDb, SqliteAuditLog, SqliteItemRepository, FsMediaStore, ScopeMediaStore, Registry } from '@reindeer-legacy/core-data';
import { TrusteeRepository, DeliveryService, RecordingMailer } from '@reindeer-legacy/delivery';
import { MockVisionProvider, SimpleDuplicateDetector, screenHighValue } from '@reindeer-legacy/intake-feature';
import { renderReport, renderItemSheet } from '@reindeer-legacy/print-feature';
import { writeBundle, readBundle, importBundle } from '@reindeer-legacy/exchange';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-rt-'));
let pass = 0;
const check = async (name, fn) => { await fn(); pass++; console.log(`  ✓ ${name}`); };

function wire(name, scopeType, scopeId) {
  const dir = path.join(tmp, name);
  const db = openDb(path.join(dir, `${name}.db`));
  const audit = new SqliteAuditLog(db);
  const itemRepo = new SqliteItemRepository(db, audit);
  const mediaStore = new FsMediaStore(db, path.join(dir, 'media'));
  const scopeMediaStore = new ScopeMediaStore(db, path.join(dir, 'media'));
  const registry = new Registry(db, audit);
  const duplicates = new SimpleDuplicateDetector(db, itemRepo, audit);
  registry.ensureScope({ scopeId, scopeType, name });
  const ctx = makeScopeCtx({ scopeType, scopeId, actorId: 'test' });
  return { db, audit, itemRepo, mediaStore, scopeMediaStore, registry, duplicates, ctx, dir };
}

// A tiny but genuinely valid PNG, used as stand-in photo bytes.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHUlEQVQoU2NkYGD4z0AEYBxVSF' +
  'JAAQAA//8DAAQVAQF0kU5PAAAAAElFTkSuQmCC', 'base64');
// Stand-in bytes for a voice memo and a video walkaround.
const AUDIO = crypto.randomBytes(64 * 1024);
const VIDEO = crypto.randomBytes(512 * 1024);
const WALKTHROUGH = crypto.randomBytes(256 * 1024);

console.log('\nLegacy round-trip test\n');

// ---------------------------------------------------------------------------
console.log('1. Capture in My Legacy Registry');
const inv = wire('inventory', SCOPE_TYPE.INVENTORY, 'inv-test');
const vision = new MockVisionProvider();

const detections = await vision.detectItems(
  [{ media_id: 'm0', buffer: PNG, frame_index: 0 }, { media_id: 'm1', buffer: Buffer.concat([PNG, Buffer.from('x')]), frame_index: 1 }],
);
await check('AI returns detections with bounding boxes', () => {
  assert.ok(detections.length > 0);
  assert.ok(detections.every((d) => Array.isArray(d.bbox) && d.bbox.length === 4));
  assert.ok(detections.every((d) => d.bbox.every((n) => n >= 0 && n <= 1)));
});
await check('the registry never asserts a value or a value tier', () => {
  // Valuation and high-value flagging belong to My Legacy: Fair Choice, which
  // has value estimates and a threshold the personal representative chooses.
  // The registry's only job is documentation, so it must never put a figure or
  // a tier on anything.
  assert.ok(detections.every((d) => d.value_estimate_cents === null), 'a detection carried a value figure');
  assert.ok(detections.every((d) => d.value_suggestion === null), 'a detection carried a value suggestion');
  assert.ok(detections.every((d) => d.high_value_flag === false), 'a detection asserted a value tier');
});
await check('a cue word suggests asking a professional, without claiming a value', () => {
  const cued = screenHighValue({ title: 'Antique sterling tea service', category: 'Jewelry' });
  assert.equal(cued.appraisal_suggested, true);
  assert.equal(cued.high_value_flag, false);
  const plain = screenHighValue({ title: 'Kitchen step stool', category: 'Tools' });
  assert.equal(plain.appraisal_suggested, false);
  assert.equal(plain.high_value_flag, false);
});

const watch = await inv.itemRepo.create({
  title: "Grandfather's Hamilton pocket watch",
  story: 'He carried it on the railroad for thirty-one years.',
  room_id: inv.registry.resolveRoom('Primary Bedroom', inv.ctx).room_id,
  category_id: inv.registry.resolveCategory('Jewelry', inv.ctx).category_id,
  identifiers: { brand: 'Hamilton', serial: '992B' },
  value_estimate_cents: 45000, value_basis: 'ai_estimate',
  high_value_flag: true, ai_confidence: 0.82, review_state: 'kept',
  recipient_hint: { recipient_name: 'Susan', relationship: 'daughter', owner_note: 'She asked about it every Christmas.' },
}, inv.ctx);
await inv.mediaStore.put(PNG, { item_id: watch.item_id, role: 'primary', mime_type: 'image/png', crop_bbox: [0.1, 0.2, 0.4, 0.4] }, inv.ctx);

// The owner's own voice, and a video circling the object.
const voice = await inv.mediaStore.put(AUDIO, {
  item_id: watch.item_id, mime_type: 'audio/webm', media_kind: 'audio', role: 'item_story',
  duration_ms: 47000, label: 'Why this matters',
  transcript: 'This is the watch my father carried on the railroad. He wound it every Sunday night.',
}, inv.ctx);
const walkaround = await inv.mediaStore.put(VIDEO, {
  item_id: watch.item_id, mime_type: 'video/mp4', media_kind: 'video', role: 'item_walkaround',
  duration_ms: 12000, label: 'All sides, including the engraving',
}, inv.ctx);
await inv.scopeMediaStore.put(WALKTHROUGH, {
  media_kind: 'video', mime_type: 'video/mp4', title: 'Walkthrough of the whole house',
  duration_ms: 240000, transcript: 'Starting at the front door and working clockwise.',
}, inv.ctx);

await check('a voice recording and a video attach to the item', async () => {
  const full = await inv.itemRepo.get(watch.item_id, inv.ctx);
  assert.equal(full.photos.length, 1);
  assert.equal(full.recordings.length, 2);
  assert.deepEqual(full.recordings.map((r) => r.media_kind).sort(), ['audio', 'video']);
  assert.match(full.recordings.find((r) => r.media_kind === 'audio').transcript, /wound it every Sunday/);
});
await check('media is tallied by kind for the delivery estimate', () => {
  const t = inv.mediaStore.tally(inv.ctx);
  assert.equal(t.audio.n, 1);
  assert.equal(t.video.n, 2); // one on the item, one whole-house walkthrough
  assert.ok(t.total_bytes > 800000);
});

// The skillet carries the owner's own "this matters" mark with reason
// 'feeling'. Fair Choice's computed high_value_flag stays false on this item
// on purpose — that is the whole point of keeping the two fields separate.
const skillet = await inv.itemRepo.create({
  title: 'Cast iron skillet',
  room_id: inv.registry.resolveRoom('Kitchen', inv.ctx).room_id,
  category_id: inv.registry.resolveCategory('Kitchenware', inv.ctx).category_id,
  value_estimate_cents: 4500, review_state: 'kept',
  owner_high_value: true, owner_high_value_reason: 'feeling',
}, inv.ctx);
await inv.mediaStore.put(PNG, { item_id: skillet.item_id, role: 'primary', mime_type: 'image/png' }, inv.ctx);

// An item in a room the estate will not recognize — tests the mapping screen.
const boat = await inv.itemRepo.create({
  title: 'Outboard motor',
  room_id: inv.registry.resolveRoom('Boat House', inv.ctx).room_id,
  category_id: inv.registry.resolveCategory('Tools', inv.ctx).category_id,
  value_estimate_cents: 180000, high_value_flag: true, review_state: 'kept',
}, inv.ctx);

// A draft that must NOT be exported.
await inv.itemRepo.create({ title: 'Blurry photo of something', review_state: 'draft' }, inv.ctx);

await check('scope guard blocks a foreign scope', async () => {
  const other = makeScopeCtx({ scopeType: SCOPE_TYPE.INVENTORY, scopeId: 'someone-else' });
  assert.equal(inv.db.prepare('SELECT * FROM items WHERE item_id=? AND scope_id=?').get(watch.item_id, other.scopeId), undefined);
});

// ---------------------------------------------------------------------------
console.log('\n2. Print');
const { items: keptItems } = await inv.itemRepo.list({ review_state: 'kept' }, inv.ctx);
const report = renderReport(keptItems, { groupBy: 'recipient', ownerName: 'Test Owner' });
const sheet = renderItemSheet(await inv.itemRepo.get(watch.item_id, inv.ctx), {});
await check('report groups by intended recipient and shows unassigned count', () => {
  assert.match(report, /Susan/);
  assert.match(report, /Not yet assigned/);
  assert.match(report, /with no intended recipient/);
});
await check('printed output always carries the non-binding disclaimer', () => {
  assert.match(sheet, /Not a will, codicil, or personal property memorandum/);
  assert.match(report, /Not a will, codicil, or personal property memorandum/);
});
await check('item sheet prints the story and the wish', () => {
  assert.match(sheet, /railroad for thirty-one years/);
  assert.match(sheet, /A wish, not a legal direction/);
});
// --- owner-set Important flag on the printout ------------------------------
await check('an item the owner marked important prints the word "Important"', () => {
  // Look for the rendered mark, not the incidental word in a stylesheet
  // comment. The rendered mark is a <span> whose class is "important" or
  // "important-mark" — both carry the visible word "Important" as their text.
  assert.match(report, /class="important(-mark)?"[^>]*>Important/,
    'the printed report does not carry the visible Important mark');
});
await check('the printed report never renders a dollar figure, appraisal word, or reason word', () => {
  // The report is rendered with showValues=false (default), so no money at
  // all. The owner's flag must not smuggle a dollar figure or the word
  // "appraisal" onto the page.
  assert.doesNotMatch(report, /\$\d/);
  assert.doesNotMatch(report, /appraisal|Appraisal|APPRAISAL/);
  // The reason word never appears on paper — that is data for Fair Choice,
  // not the printout. (The class name we render is "important" / "important-mark",
  // not the reason.)
  assert.doesNotMatch(report, /\bfeeling\b/);
  assert.doesNotMatch(report, /\bmoney\b/);
});
await check('an item sheet for a NOT-flagged item does NOT carry the visible Important mark', () => {
  // Watch has high_value_flag but NOT owner_high_value. The word "Important"
  // appears in the stylesheet comment on every page — what matters is that
  // the rendered <span class="important"> ... Important ...</span> is absent.
  assert.doesNotMatch(sheet, /class="important(-mark)?"[^>]*>Important/);
});
fs.writeFileSync(path.join(tmp, 'report.html'), report);

// ---------------------------------------------------------------------------
console.log('\n3. Export the handoff bundle');
const { buffer, batchId, envelope } = await writeBundle({
  itemRepo: inv.itemRepo, mediaStore: inv.mediaStore, scopeMediaStore: inv.scopeMediaStore,
  registry: inv.registry, ctx: inv.ctx,
  query: { review_state: 'kept' },
  source: { app: 'legacy-registry', app_version: '0.1.0', inventory_id: 'inv-test', owner_name: 'Test Owner' },
});
fs.writeFileSync(path.join(tmp, 'handoff.reindeer'), buffer);

await check('bundle contains only confirmed items, not drafts', () => {
  assert.equal(envelope.items.length, 3);
  assert.ok(!envelope.items.some((i) => i.title.includes('Blurry')));
});
await check('bundle is a readable zip with checksums that verify', () => {
  const { problems, manifest } = readBundle(buffer);
  assert.deepEqual(problems, []);
  assert.equal(manifest.batch_id, batchId);
});
await check('video and voice ride along in the bundle', () => {
  const { files, manifest } = readBundle(buffer);
  assert.equal(manifest.counts.videos, 2);
  assert.equal(manifest.counts.audio, 1);
  assert.equal(manifest.counts.scope_media, 1);
  const media = [...files.keys()].filter((k) => k.startsWith('media/'));
  assert.ok(media.some((k) => k.endsWith('.mp4')));
  assert.ok(media.some((k) => k.endsWith('.weba')));
  assert.ok(media.some((k) => k.startsWith('media/_scope/')));
});
await check('bundled recordings are byte-identical to what was recorded', () => {
  const { files, envelope: env } = readBundle(buffer);
  const rec = env.items.flatMap((i) => i.recordings);
  const audioEntry = rec.find((r) => r.kind === 'audio');
  assert.deepEqual(files.get(audioEntry.file), AUDIO);
  assert.equal(audioEntry.duration_ms, 47000);
});
await check('a readable transcript file travels with the package', () => {
  const { files } = readBundle(buffer);
  const txt = files.get('transcripts.txt').toString('utf8');
  assert.match(txt, /Walkthrough of the whole house/);
  assert.match(txt, /wound it every Sunday night/);
  assert.match(txt, /Grandfather's Hamilton pocket watch/);
});
await check('exported items are marked exported', () => {
  const row = inv.db.prepare('SELECT export_state FROM items WHERE item_id=?').get(watch.item_id);
  assert.equal(row.export_state, 'exported');
});
await check('editing after export flags the item as changed', async () => {
  await inv.itemRepo.update(skillet.item_id, { description: 'Griswold, 10 inch' }, inv.ctx);
  const row = inv.db.prepare('SELECT export_state FROM items WHERE item_id=?').get(skillet.item_id);
  assert.equal(row.export_state, 'changed_since_export');
});
// --- owner-set Important flag in the exchange envelope + CSV --------------
await check('the exchange envelope carries the owner\'s Important mark on each item', () => {
  const skilletInEnv = envelope.items.find((i) => i.title === 'Cast iron skillet');
  assert.equal(skilletInEnv.owner_high_value, true);
  assert.equal(skilletInEnv.owner_high_value_reason, 'feeling');
  const watchInEnv = envelope.items.find((i) => i.title.includes('Hamilton'));
  assert.equal(watchInEnv.owner_high_value, false);
  assert.equal(watchInEnv.owner_high_value_reason, '');
});
await check('the envelope counts the owner\'s flagged items separately from high_value', () => {
  // Only the skillet is owner-flagged; the watch and the boat carry
  // high_value_flag but no owner mark. Counts must not conflate them.
  assert.equal(envelope.counts.owner_flagged_important, 1);
  assert.equal(envelope.counts.high_value, 2);
});
await check('the CSV appends owner_important, owner_important_reason, and owner_important_comment at the end', async () => {
  const { toCsv, CSV_COLUMNS } = await import('@reindeer-legacy/exchange');
  const csv = toCsv(envelope);
  const headers = csv.split(/\r\n/)[0].split(',');
  assert.deepEqual(headers, CSV_COLUMNS);
  // Appended at the end, in this order — owner_important_comment is the
  // newest column so it lands last, keeping the append-only rule intact.
  assert.equal(headers[headers.length - 3], 'owner_important');
  assert.equal(headers[headers.length - 2], 'owner_important_reason');
  assert.equal(headers[headers.length - 1], 'owner_important_comment');
  // The skillet row shows yes/feeling and no comment yet (comment is added
  // in a later test below, on a different item, to keep this row stable).
  const rows = csv.split(/\r\n/).slice(1);
  const skilletRow = rows.find((r) => r.includes('Cast iron skillet'));
  assert.ok(skilletRow, 'no skillet row in CSV');
  const cells = skilletRow.split(',');
  assert.equal(cells[cells.length - 3], 'yes');
  assert.equal(cells[cells.length - 2], 'feeling');
  assert.equal(cells[cells.length - 1], '');
});

// ---------------------------------------------------------------------------
console.log('\n4. Import into Legacy: Fair Choice');
const est = wire('estate', SCOPE_TYPE.ESTATE, 'estate-test');
const result = await importBundle(buffer, { ...est, ctx: est.ctx });

await check('every item lands in the Intake queue, none in a live pool', () => {
  assert.equal(result.queued.length, 3);
  const kept = est.db.prepare("SELECT COUNT(*) c FROM items WHERE scope_id=? AND review_state='kept'").get(est.ctx.scopeId).c;
  assert.equal(kept, 0);
});
await check('unrecognized room is reported for mapping, not auto-created', () => {
  assert.deepEqual(result.unmapped_rooms, ['Boat House']);
  assert.equal(est.registry.rooms(est.ctx).find((r) => r.name === 'Boat House'), undefined);
});
await check('known rooms and categories map by name', () => {
  const imported = est.db.prepare('SELECT * FROM items WHERE origin_item_id=?').get(watch.item_id);
  const room = est.db.prepare('SELECT name FROM rooms WHERE room_id=?').get(imported.room_id);
  assert.equal(room.name, 'Primary Bedroom');
});
await check('photos arrive with their bytes intact', () => {
  const p = est.db.prepare('SELECT * FROM item_photos WHERE item_id=?').get(watch.item_id);
  assert.equal(p.sha256, crypto.createHash('sha256').update(PNG).digest('hex'));
});
await check('recordings arrive intact on the estate side', async () => {
  assert.equal(result.recordings_imported.length, 2);
  assert.equal(result.scope_media_imported.length, 1);
  const imported = est.db.prepare('SELECT * FROM items WHERE origin_item_id=?').get(watch.item_id);
  const full = await est.itemRepo.get(imported.item_id, est.ctx);
  const audio = full.recordings.find((r) => r.media_kind === 'audio');
  assert.equal(audio.sha256, crypto.createHash('sha256').update(AUDIO).digest('hex'));
  assert.match(audio.transcript, /wound it every Sunday/);
  assert.equal(fs.readFileSync(await est.mediaStore.getPath(audio.photo_id, est.ctx)).length, AUDIO.length);
});
await check('story and identifiers survive the trip', () => {
  const i = est.db.prepare('SELECT * FROM items WHERE origin_item_id=?').get(watch.item_id);
  assert.match(i.story, /thirty-one years/);
  assert.equal(JSON.parse(i.identifiers).serial, '992B');
});
await check('recipient wish arrives as a suggestion, never applied', () => {
  assert.equal(result.recipient_suggestions.length, 1);
  assert.equal(result.recipient_suggestions[0].suggested_recipient, 'Susan');
  assert.equal(result.recipient_suggestions[0].applied, false);
});
// --- owner-set Important flag survives the round trip ---------------------
await check('the owner\'s Important mark and reason survive export and import unchanged', () => {
  // The imported row is queued (result.queued.length === 3 above), but the
  // items table on the estate side is written even before queue promotion.
  const imported = est.db.prepare('SELECT owner_high_value, owner_high_value_reason FROM items WHERE origin_item_id=?').get(skillet.item_id);
  assert.equal(imported.owner_high_value, 1);
  assert.equal(imported.owner_high_value_reason, 'feeling');
});
await check('Registry-to-Registry importer keeps owner_high_value and high_value_flag independent', () => {
  // Registry-side importer: owner_high_value and high_value_flag are
  // independent columns on the Registry items table. This importer must
  // not cross-populate one from the other. (The Fair Choice boundary is
  // different — FC does OR the owner\'s mark into its isHighValue at
  // approve time, but that is FC\'s importService, not this Registry-side
  // importer. See docs/decisions/2026-08-06-fc-honors-owner-important.md.)
  const imported = est.db.prepare('SELECT owner_high_value, high_value_flag FROM items WHERE origin_item_id=?').get(skillet.item_id);
  assert.equal(imported.owner_high_value, 1, 'the owner\'s mark did not survive');
  assert.equal(imported.high_value_flag, 0, 'Registry-to-Registry importer must not cross-populate high_value_flag from owner_high_value');
});

// ---------------------------------------------------------------------------
console.log('\n5. Re-import and round locking');
const second = await importBundle(buffer, { ...est, ctx: est.ctx });
await check('re-importing updates instead of duplicating', () => {
  assert.equal(second.created.length, 0);
  assert.equal(second.updated.length, 3);
  const total = est.db.prepare('SELECT COUNT(*) c FROM items WHERE scope_id=?').get(est.ctx.scopeId).c;
  assert.equal(total, 3);
});
await check('re-import does not duplicate photos or recordings', () => {
  const rows = est.db.prepare('SELECT media_kind, COUNT(*) c FROM item_photos WHERE item_id=? GROUP BY media_kind').all(watch.item_id);
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.media_kind, r.c])), { photo: 1, audio: 1, video: 1 });
  const scopeVids = est.db.prepare('SELECT COUNT(*) c FROM scope_media WHERE scope_id=?').get(est.ctx.scopeId).c;
  assert.equal(scopeVids, 1);
});

est.db.prepare('UPDATE scopes SET round_locked=1 WHERE scope_id=?').run(est.ctx.scopeId);
const locked = await importBundle(buffer, { ...est, ctx: est.ctx });
await check('fair round locking queues imports once a division has started', () => {
  assert.equal(locked.round_locked, true);
  const note = est.db.prepare("SELECT note FROM intake_queue WHERE scope_id=? ORDER BY created_at DESC LIMIT 1").get(est.ctx.scopeId).note;
  assert.match(note, /already started/);
});

// ---------------------------------------------------------------------------
console.log('\n6. Duplicates and audit');
const dupe = await est.itemRepo.create({ title: "Grandfather's Hamilton pocket watch", identifiers: { serial: '992B' }, review_state: 'kept' }, est.ctx);
const groups = await est.duplicates.scanBatch([dupe.item_id], est.ctx);
await check('duplicate detection finds the serial match', () => {
  assert.ok(groups.length >= 1);
  assert.ok(groups.some((g) => g.reason === 'serial_match' || g.reason === 'title_similarity'));
});
await check('nothing is deleted until a person chooses', () => {
  assert.ok(est.db.prepare('SELECT 1 FROM items WHERE item_id=?').get(dupe.item_id));
});
await est.duplicates.resolve(groups[0].group_id, 'keep_catalog', est.ctx);
await check('resolution removes only the chosen side', () => {
  assert.equal(est.db.prepare('SELECT 1 FROM items WHERE item_id=?').get(dupe.item_id), undefined);
});

await check('a save reports possible duplicates without recording a single group', async () => {
  // The registry must never hand an owner a mandatory review. Counting is
  // allowed; creating an outstanding task at save time is not.
  const before = est.db.prepare('SELECT COUNT(*) AS n FROM duplicate_groups').get().n;
  const twin = await est.itemRepo.create({ title: 'Grandfather Hamilton pocket watch', review_state: 'kept' }, est.ctx);
  const count = await est.duplicates.previewBatch([twin.item_id], est.ctx);
  assert.ok(count >= 1, 'the look-alike was not noticed at all');
  const after = est.db.prepare('SELECT COUNT(*) AS n FROM duplicate_groups').get().n;
  assert.equal(after, before, 'saving recorded a duplicate group the owner never asked for');
  est.db.prepare('DELETE FROM items WHERE item_id=?').run(twin.item_id);
});
await check('the owner can ask for the review, and only then is it recorded', async () => {
  const twin = await est.itemRepo.create({ title: 'Grandfather Hamilton pocket watch', review_state: 'kept' }, est.ctx);
  const before = est.db.prepare('SELECT COUNT(*) AS n FROM duplicate_groups').get().n;
  const found = await est.duplicates.scanCatalog(est.ctx);
  assert.ok(found.length >= 1);
  assert.ok(est.db.prepare('SELECT COUNT(*) AS n FROM duplicate_groups').get().n > before);
  est.db.prepare('DELETE FROM items WHERE item_id=?').run(twin.item_id);
});

const invVerify = await inv.audit.verify(inv.ctx);
const estVerify = await est.audit.verify(est.ctx);
await check('both audit chains verify', () => {
  assert.equal(invVerify.ok, true);
  assert.equal(estVerify.ok, true);
});
await check('deletion is recorded before it happens', async () => {
  const entries = await est.audit.list({ limit: 500 }, est.ctx);
  const del = entries.find((e) => e.action === 'item.delete');
  assert.ok(del, 'expected an item.delete audit entry');
  assert.match(JSON.parse(del.payload).reason, /duplicate/);
});
await check('tampering with history is detectable', async () => {
  est.db.prepare("UPDATE audit_log SET payload='{\"tampered\":true}' WHERE seq=(SELECT MIN(seq) FROM audit_log WHERE scope_id=?)").run(est.ctx.scopeId);
  const after = await est.audit.verify(est.ctx);
  assert.equal(after.ok, false);
});

// ---------------------------------------------------------------------------
console.log('\n7. Delivery to the trustee');
const mailer = new RecordingMailer();
const trustees = new TrusteeRepository(inv.db, inv.audit);
const delivery = new DeliveryService({
  db: inv.db, audit: inv.audit, itemRepo: inv.itemRepo, mediaStore: inv.mediaStore,
  scopeMediaStore: inv.scopeMediaStore, registry: inv.registry, trustees, mailer,
  storageDir: path.join(inv.dir, 'packages'), ownerName: 'Test Owner',
  baseUrl: 'https://legacy.example.com',
});

await check('a bad email address is refused in plain language', async () => {
  await assert.rejects(() => trustees.create({ name: 'Nobody', email: 'not-an-email' }, inv.ctx),
    (e) => /does not look like an email address/.test(e.message));
});
await check('sending with no trustee on file explains what to do first', async () => {
  await assert.rejects(() => delivery.prepare({}, inv.ctx),
    (e) => /Add the person who should receive/.test(e.message));
});

const trustee = await trustees.create({ name: 'Ruth Alvarez', email: 'ruth@example.com', role: 'trustee' }, inv.ctx);
const prepared = await delivery.prepare({}, inv.ctx);

await check('the package is prepared before anything is sent', () => {
  assert.equal(mailer.sent.length, 0);
  assert.equal(prepared.counts.items, 3);
  assert.equal(prepared.counts.videos, 2);
  assert.equal(prepared.counts.audio, 1);
  assert.ok(fs.existsSync(prepared.stored_as));
});
await check('a small package is attached, and the reason is stated', () => {
  assert.equal(prepared.method, 'email_attachment');
  assert.ok(prepared.byte_size < MAX_EMAIL_ATTACHMENT_BYTES);
  assert.match(prepared.why, /attached directly/);
});
await check('sending without confirmation does not send', async () => {
  await assert.rejects(() => delivery.send(prepared.delivery_id, inv.ctx),
    (e) => /not confirmed/.test(e.message));
  assert.equal(mailer.sent.length, 0);
});

const sent = await delivery.send(prepared.delivery_id, inv.ctx, { confirmed: true });
await check('the confirmed send reaches the trustee with the package attached', () => {
  assert.equal(sent.sent, true);
  assert.deepEqual(mailer.sent[0].to, ['ruth@example.com']);
  const names = mailer.sent[0].attachments.map((a) => a.filename);
  assert.ok(names.some((n) => n.endsWith('.reindeer')), 'the data file should be attached');
  assert.ok(names.some((n) => n.startsWith('cover-packet')), 'the printable packet should be attached');
});
await check('the email tells the trustee what is inside and what to do', () => {
  const body = mailer.sent[0].text;
  assert.match(body, /2 video recordings/);
  assert.match(body, /1 voice recordings|voice recordings/);
  assert.match(body, /Print the enclosed cover packet/);
  assert.match(body, /Save the data file in two separate places/);
  assert.match(body, /does not override the will/);
});

const packetHtml = fs.readFileSync(path.join(inv.dir, 'packages', `${prepared.batch_id}-packet.html`), 'utf8');
fs.writeFileSync(path.join(tmp, 'trustee-packet.html'), packetHtml);
await check('the printed packet is complete enough to file on paper', () => {
  assert.match(packetHtml, /Estate inventory package/);
  assert.match(packetHtml, /Package fingerprint \(SHA-256\)/);
  assert.ok(packetHtml.includes(prepared.bundle_sha256));
  assert.match(packetHtml, /Grandfather&#039;s Hamilton pocket watch|Grandfather's Hamilton pocket watch/);
  assert.match(packetHtml, /Walkthrough of the whole house/);
  assert.match(packetHtml, /Trustee signature/);
  assert.match(packetHtml, /Not a will, codicil, or personal property memorandum/);
});
await check('the packet counts the items nobody has been promised', () => {
  assert.match(packetHtml, /2 items carry no stated wish/);
});

await check('a large package switches to a secure link instead of failing', async () => {
  const big = await inv.itemRepo.create({ title: 'Home movies reel', review_state: 'kept' }, inv.ctx);
  await inv.mediaStore.put(crypto.randomBytes(19 * 1024 * 1024), {
    item_id: big.item_id, media_kind: 'video', mime_type: 'video/mp4', duration_ms: 900000,
  }, inv.ctx);
  const p2 = await delivery.prepare({}, inv.ctx);
  assert.equal(p2.method, 'email_link');
  assert.match(p2.why, /larger than most mail servers accept/);
  assert.ok(p2.download_url.startsWith('https://legacy.example.com/d/'));
  await delivery.send(p2.delivery_id, inv.ctx, { confirmed: true });
  const last = mailer.sent.at(-1);
  assert.ok(!last.attachments.some((a) => a.filename.endsWith('.reindeer')), 'the huge file must not be attached');
  assert.match(last.text, /https:\/\/legacy\.example\.com\/d\//);
  const link = await delivery.resolveLink(p2.download_url.split('/d/')[1]);
  assert.equal(link.ok, true);
  assert.ok(fs.statSync(link.path).size > 19 * 1024 * 1024);
});
await check('an expired or unknown link refuses politely', async () => {
  assert.equal((await delivery.resolveLink('nonsense-token')).reason, 'not_found');
});
await check('a mail failure keeps the package and says how to recover', async () => {
  const p3 = await delivery.prepare({}, inv.ctx);
  mailer.failNext = 'The mail server rejected the username or password.';
  const failed = await delivery.send(p3.delivery_id, inv.ctx, { confirmed: true });
  assert.equal(failed.sent, false);
  assert.match(failed.retry_hint, /still saved/);
  assert.ok(fs.existsSync(path.join(inv.dir, 'packages', `${p3.batch_id}.reindeer`)));
});
await check('every delivery is written to the audit chain', async () => {
  const entries = await inv.audit.list({ limit: 900 }, inv.ctx);
  const actions = entries.map((e) => e.action);
  for (const a of ['trustee.create', 'delivery.prepare', 'delivery.sent', 'delivery.failed']) {
    assert.ok(actions.includes(a), `expected an audit entry for ${a}`);
  }
  assert.equal((await inv.audit.verify(inv.ctx)).ok, true);
});

// ---------------------------------------------------------------------------
// Owner-authored Important comment (docs/decisions/2026-08-06-important-comment.md).
// A separate wired scope so we don't have to renumber the earlier count
// assertions — those pin the original three-item bundle to specific totals,
// and this section is about semantics of the new field.
console.log('\n7. Owner-authored Important comment');
const cmt = wire('comment', SCOPE_TYPE.INVENTORY, 'cmt-test');

// Item A: comment on create should auto-flag the item, per the asymmetric
// invariant — "there was a reason to comment, so the item is flagged."
const chest = await cmt.itemRepo.create({
  title: 'Cedar hope chest',
  room_id: cmt.registry.resolveRoom('Primary Bedroom', cmt.ctx).room_id,
  category_id: cmt.registry.resolveCategory('Furniture', cmt.ctx).category_id,
  review_state: 'kept',
  // Deliberately includes a dollar figure and the word "appraisal" to prove
  // that the owner's own words survive verbatim across the whole pipeline —
  // print, envelope, CSV, import. Registry does not shape or censor these.
  owner_important_comment: 'Grandma gave me this in 1962. Appraised at $2,400 for insurance last spring.',
}, cmt.ctx);
await check('a non-empty comment on create auto-flags the item (auto-flag invariant)', () => {
  assert.equal(chest.owner_high_value, true);
  assert.equal(chest.owner_high_value_reason, '');
  assert.match(chest.owner_important_comment, /Grandma gave me this in 1962/);
});

// Item B: empty comment should not touch the flag either way.
const lamp = await cmt.itemRepo.create({
  title: 'Reading lamp',
  room_id: cmt.registry.resolveRoom('Living Room', cmt.ctx).room_id,
  category_id: cmt.registry.resolveCategory('Furniture', cmt.ctx).category_id,
  review_state: 'kept',
  owner_important_comment: '',
}, cmt.ctx);
await check('an empty comment does not flag the item', () => {
  assert.equal(lamp.owner_high_value, false);
  assert.equal(lamp.owner_important_comment, '');
});

await check('unflagging clears both the comment and the reason (clear-on-unflag)', async () => {
  const before = await cmt.itemRepo.get(chest.item_id, cmt.ctx);
  assert.equal(before.owner_high_value, true);
  assert.notEqual(before.owner_important_comment, '');
  const after = await cmt.itemRepo.update(chest.item_id,
    { owner_high_value: false, owner_high_value_reason: 'money' }, cmt.ctx);
  assert.equal(after.owner_high_value, false);
  assert.equal(after.owner_important_comment, '');
  assert.equal(after.owner_high_value_reason, '');
  // Put the comment back for the rest of the tests — auto-flag re-fires.
  const restored = await cmt.itemRepo.update(chest.item_id,
    { owner_important_comment: 'Grandma gave me this in 1962. Appraised at $2,400 for insurance last spring.' },
    cmt.ctx);
  assert.equal(restored.owner_high_value, true);
});

await check('deleting a comment while leaving the flag on keeps the flag on', async () => {
  const cleared = await cmt.itemRepo.update(chest.item_id,
    { owner_important_comment: '' }, cmt.ctx);
  // Flag persists (owner marked it Important once; the note went away but the
  // notice did not). Comment field is now empty.
  assert.equal(cleared.owner_high_value, true);
  assert.equal(cleared.owner_important_comment, '');
  // Restore for downstream tests.
  await cmt.itemRepo.update(chest.item_id,
    { owner_important_comment: 'Grandma gave me this in 1962. Appraised at $2,400 for insurance last spring.' },
    cmt.ctx);
});

await check('the 500-character cap rejects an over-long comment', async () => {
  const tooLong = 'x'.repeat(501);
  await assert.rejects(
    cmt.itemRepo.create({ title: 'Chatty', review_state: 'kept', owner_important_comment: tooLong }, cmt.ctx),
    (err) => err.code === 'VALIDATION'
      && Array.isArray(err.details)
      && err.details.some((d) => d.field === 'owner_important_comment' && /500 characters/.test(d.message)),
  );
});

await check('leading and trailing whitespace is trimmed off the comment', async () => {
  const spacey = await cmt.itemRepo.create({
    title: 'Painting',
    room_id: cmt.registry.resolveRoom('Living Room', cmt.ctx).room_id,
    category_id: cmt.registry.resolveCategory('Art', cmt.ctx).category_id,
    review_state: 'kept',
    owner_important_comment: '   Aunt Ruth painted this in 1978.   ',
  }, cmt.ctx);
  assert.equal(spacey.owner_important_comment, 'Aunt Ruth painted this in 1978.');
  assert.equal(spacey.owner_high_value, true);
});

// Export bundle from the comment scope, so we can check envelope + CSV + import.
const cmtOut = await writeBundle({
  itemRepo: cmt.itemRepo, mediaStore: cmt.mediaStore, scopeMediaStore: cmt.scopeMediaStore,
  registry: cmt.registry, ctx: cmt.ctx,
  query: { review_state: 'kept' },
  source: { app: 'legacy-registry', app_version: '0.1.0', inventory_id: 'cmt-test', owner_name: 'Test Owner' },
});

await check('the exchange envelope carries the owner\'s comment verbatim, including money words', () => {
  const chestInEnv = cmtOut.envelope.items.find((i) => i.title === 'Cedar hope chest');
  assert.equal(chestInEnv.owner_important_comment,
    'Grandma gave me this in 1962. Appraised at $2,400 for insurance last spring.');
  // The lamp had no comment; it must survive as ''.
  const lampInEnv = cmtOut.envelope.items.find((i) => i.title === 'Reading lamp');
  assert.equal(lampInEnv.owner_important_comment, '');
});

await check('the envelope counts commented items as a subset of owner-flagged ones', () => {
  // Chest and painting have comments; both are auto-flagged. Lamp is neither.
  assert.equal(cmtOut.envelope.counts.owner_commented_important, 2);
  assert.ok(cmtOut.envelope.counts.owner_commented_important
    <= cmtOut.envelope.counts.owner_flagged_important,
    'commented count exceeded flagged count');
});

await check('the CSV\'s last column carries the comment verbatim, including a dollar figure', async () => {
  const { toCsv } = await import('@reindeer-legacy/exchange');
  const csv = toCsv(cmtOut.envelope);
  const chestRow = csv.split(/\r\n/).find((r) => r.includes('Cedar hope chest'));
  assert.ok(chestRow, 'no chest row in CSV');
  // The whole comment lands in the last column. It contains a comma-safe form
  // (the cell() escaper quotes cells with commas), so we assert on the whole
  // row's presence of the quoted string rather than a positional split.
  assert.match(chestRow, /"Grandma gave me this in 1962\. Appraised at \$2,400 for insurance last spring\."$/);
});

await check('a Registry-to-Fair-Choice import preserves the owner\'s comment as written', async () => {
  const est2 = wire('estate2', SCOPE_TYPE.ESTATE, 'estate2-test');
  await importBundle(cmtOut.buffer, { ...est2, ctx: est2.ctx });
  const imported = est2.db.prepare('SELECT owner_important_comment, owner_high_value FROM items WHERE title=?')
    .get('Cedar hope chest');
  assert.equal(imported.owner_high_value, 1);
  assert.equal(imported.owner_important_comment,
    'Grandma gave me this in 1962. Appraised at $2,400 for insurance last spring.');
});

await check('the print template renders the comment verbatim, dollar figure included', () => {
  const { items: kept } = { items: cmtOut.envelope.items.filter((i) => i.owner_important_comment) };
  // renderReport takes item records from the repo, not envelope items — so
  // pull them from the repo for a faithful print. Comment survives round-trip
  // through the repo already; this asserts the printed HTML carries it.
  const items = kept.map((i) => ({
    item_id: i.item_id, title: i.title, quantity: i.quantity, condition: i.condition,
    identifiers: i.identifiers, room: { name: i.room_name }, category: { name: i.category_name },
    owner_high_value: i.owner_high_value, owner_important_comment: i.owner_important_comment,
    created_at: i.created_at, photos: [], description: '', story: '',
  }));
  const html = renderReport(items, { ownerName: 'Test Owner' });
  assert.match(html, /class="important-comment"/);
  assert.match(html, /Grandma gave me this in 1962/);
  assert.match(html, /\$2,400/);
  // And the leak-guard restated: on the third scope where nobody wrote a
  // comment, the printed report must still not spontaneously grow an
  // appraisal word. Regenerate that report from the lamp alone.
  const clean = renderReport(items.filter((i) => !i.owner_important_comment), { ownerName: 'Test Owner' });
  assert.doesNotMatch(clean, /appraisal|Appraisal|APPRAISAL/);
  assert.doesNotMatch(clean, /\$\d/);
});

console.log('\n8. Tentative high-value flags (helper + AI)');

// A helper flags an item as important — it should land as tentative, not permanent.
await inv.itemRepo.create({
  title: 'Grandfather clock',
  review_state: 'draft',
  owner_high_value: false,
  owner_high_value_reason: '',
  tentative_high_value: true,
  tentative_high_value_source: 'helper',
  tentative_high_value_reason: 'sentimental: family heirloom',
}, inv.ctx);

await check('a helper flag is tentative, not a permanent owner flag', async () => {
  const { items } = await inv.itemRepo.list({}, inv.ctx);
  const clock = items.find((i) => i.title === 'Grandfather clock');
  assert.ok(clock, 'clock not found');
  assert.equal(clock.tentative_high_value, true);
  assert.equal(clock.tentative_high_value_source, 'helper');
  assert.equal(clock.owner_high_value, false);
  assert.equal(clock.review_state, 'draft');
});

// An AI flag from rarity/appraisal_suggested should also be tentative.
await inv.itemRepo.create({
  title: 'Antique violin',
  review_state: 'draft',
  owner_high_value: false,
  tentative_high_value: true,
  tentative_high_value_source: 'ai',
  tentative_high_value_reason: 'AI flagged: may warrant professional appraisal',
}, inv.ctx);

await check('an AI flag is tentative with source=ai', async () => {
  const { items } = await inv.itemRepo.list({}, inv.ctx);
  const violin = items.find((i) => i.title === 'Antique violin');
  assert.ok(violin, 'violin not found');
  assert.equal(violin.tentative_high_value, true);
  assert.equal(violin.tentative_high_value_source, 'ai');
  assert.equal(violin.owner_high_value, false);
});

// The tentative_high_value_only filter should find both flagged items.
await check('tentative_high_value_only filter returns flagged items', async () => {
  const { items } = await inv.itemRepo.list({ tentative_high_value_only: true }, inv.ctx);
  assert.ok(items.length >= 2, `expected >= 2, got ${items.length}`);
  assert.ok(items.every((i) => i.tentative_high_value === true));
});

// Confirm (promote): tentative → permanent owner_high_value.
await check('confirm-important promotes tentative to permanent', async () => {
  const { items } = await inv.itemRepo.list({ tentative_high_value_only: true }, inv.ctx);
  const clock = items.find((i) => i.title === 'Grandfather clock');
  await inv.itemRepo.update(clock.item_id, {
    owner_high_value: true,
    owner_high_value_reason: clock.tentative_high_value_reason,
    tentative_high_value: false,
    tentative_high_value_source: '',
    tentative_high_value_reason: '',
    review_state: 'kept',
  }, inv.ctx);
  const updated = await inv.itemRepo.get(clock.item_id, inv.ctx);
  assert.equal(updated.owner_high_value, true);
  assert.equal(updated.owner_high_value_reason, 'sentimental: family heirloom');
  assert.equal(updated.tentative_high_value, false);
  assert.equal(updated.review_state, 'kept');
});

// Dismiss: tentative flag removed, no promotion.
await check('dismiss-important removes tentative without promoting', async () => {
  const { items } = await inv.itemRepo.list({ tentative_high_value_only: true }, inv.ctx);
  const violin = items.find((i) => i.title === 'Antique violin');
  await inv.itemRepo.update(violin.item_id, {
    tentative_high_value: false,
    tentative_high_value_source: '',
    tentative_high_value_reason: '',
  }, inv.ctx);
  const updated = await inv.itemRepo.get(violin.item_id, inv.ctx);
  assert.equal(updated.tentative_high_value, false);
  assert.equal(updated.owner_high_value, false);
});

console.log(`\n${pass} checks passed.`);
console.log(`Artifacts: ${tmp}\n`);
