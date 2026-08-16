/**
 * Two-Output Delivery Model \u2014 envelope + schema contract test.
 *
 * Covers commit 1 of docs/specs/2026-08-09-registry-two-outputs.md:
 *   \u2022 migration 9 shape (assigned_to_heir_id, closeup_photo_id, heirs,
 *     wills_caretakers, addendum_versions)
 *   \u2022 buildInventoryEnvelope: one-recipient, whole-household, no
 *     assignments, no voice
 *   \u2022 buildAddendumEnvelope: versioned, two-recipient, owner-camera
 *     closeups required (or listed as gap), optional voice message
 *   \u2022 parseTypedEnvelope: dispatch + rejection of legacy shape
 *
 * Does NOT touch delivery, import, UI, or the legacy .reindeer bundle
 * path. Those keep behaving exactly as they do today \u2014 verified by the
 * existing roundtrip test.
 *
 * Run:  node scripts/two-outputs-envelope-test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

import { SCOPE_TYPE, makeScopeCtx } from '@reindeer-legacy/core-api';
import { openDb, SqliteAuditLog, SqliteItemRepository, FsMediaStore, Registry, ulid } from '@reindeer-legacy/core-data';
import {
  buildInventoryEnvelope,
  buildAddendumEnvelope,
  parseTypedEnvelope,
  buildEnvelope,
  ENVELOPE_TYPE_INVENTORY,
  ENVELOPE_TYPE_ADDENDUM,
  TYPED_ENVELOPE_VERSION,
} from '@reindeer-legacy/exchange';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'two-outputs-'));
let pass = 0;
const check = async (name, fn) => { await fn(); pass++; console.log(`  \u2713 ${name}`); };

function wire(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const db = openDb(path.join(dir, `${name}.db`));
  const audit = new SqliteAuditLog(db);
  const itemRepo = new SqliteItemRepository(db, audit);
  const mediaStore = new FsMediaStore(db, path.join(dir, 'media'));
  const registry = new Registry(db, audit);
  const scopeId = `${name}-scope`;
  registry.ensureScope({ scopeId, scopeType: SCOPE_TYPE.INVENTORY, name });
  const ctx = makeScopeCtx({ scopeType: SCOPE_TYPE.INVENTORY, scopeId, actorId: 'test' });
  return { db, audit, itemRepo, mediaStore, registry, ctx, scopeId, dir };
}

console.log('\nTwo-Output Delivery Model \u2014 envelope + schema contract test\n');

/* -------------------------------------------------------------------------- */
console.log('1. Migration 9 shape');
const w = wire('workshop');

await check('items table gained assigned_to_heir_id (nullable)', () => {
  const cols = w.db.prepare("PRAGMA table_info(items)").all();
  const col = cols.find((c) => c.name === 'assigned_to_heir_id');
  assert.ok(col, 'assigned_to_heir_id column missing');
  assert.equal(col.notnull, 0, 'assigned_to_heir_id must be nullable');
});
await check('items table gained closeup_photo_id (nullable)', () => {
  const cols = w.db.prepare("PRAGMA table_info(items)").all();
  const col = cols.find((c) => c.name === 'closeup_photo_id');
  assert.ok(col, 'closeup_photo_id column missing');
  assert.equal(col.notnull, 0, 'closeup_photo_id must be nullable');
});
await check('assigned_to_heir_id has a scope-scoped index', () => {
  const idx = w.db.prepare("PRAGMA index_list(items)").all();
  assert.ok(idx.some((i) => i.name === 'idx_items_assigned_heir'));
});
await check('heirs table exists with the expected columns', () => {
  const cols = w.db.prepare("PRAGMA table_info(heirs)").all().map((c) => c.name);
  for (const expected of ['heir_id', 'scope_id', 'name', 'relationship', 'email', 'notes', 'created_at', 'updated_at']) {
    assert.ok(cols.includes(expected), `heirs.${expected} missing`);
  }
});
await check('wills_caretakers table exists with delivery_method CHECK', () => {
  const cols = w.db.prepare("PRAGMA table_info(wills_caretakers)").all().map((c) => c.name);
  for (const expected of ['caretaker_id', 'scope_id', 'name', 'firm', 'email', 'delivery_method']) {
    assert.ok(cols.includes(expected), `wills_caretakers.${expected} missing`);
  }
  const now = new Date().toISOString();
  assert.throws(() => {
    w.db.prepare(
      "INSERT INTO wills_caretakers (caretaker_id, scope_id, name, delivery_method, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(ulid(), w.scopeId, 'Bad Firm', 'carrier_pigeon', now, now);
  }, /CHECK constraint failed/);
});
await check('addendum_versions table exists and enforces unique (scope, owner, version)', () => {
  const cols = w.db.prepare("PRAGMA table_info(addendum_versions)").all().map((c) => c.name);
  for (const expected of ['version_id', 'scope_id', 'owner_participant_id', 'version_number', 'supersedes_version', 'signed_at', 'signature_evidence', 'recipients', 'voice_message', 'items_snapshot', 'gaps', 'envelope_sha256']) {
    assert.ok(cols.includes(expected), `addendum_versions.${expected} missing`);
  }
  const now = new Date().toISOString();
  const insert = w.db.prepare(
    "INSERT INTO addendum_versions (version_id, scope_id, owner_participant_id, version_number, signed_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  insert.run(ulid(), w.scopeId, 'owner-a', 1, now, now);
  assert.throws(
    () => insert.run(ulid(), w.scopeId, 'owner-a', 1, now, now),
    /UNIQUE constraint failed/,
    'the same (scope, owner, version_number) must not be insertable twice',
  );
  // A different owner with the same version number IS allowed \u2014 Couple mode
  // gives each spouse their own version stream.
  insert.run(ulid(), w.scopeId, 'owner-b', 1, now, now);
});
await check('addendum_versions rejects version_number < 1 via CHECK', () => {
  const now = new Date().toISOString();
  assert.throws(() => {
    w.db.prepare(
      "INSERT INTO addendum_versions (version_id, scope_id, owner_participant_id, version_number, signed_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(ulid(), w.scopeId, 'owner-c', 0, now, now);
  }, /CHECK constraint failed/);
});

/* -------------------------------------------------------------------------- */
console.log('\n2. buildInventoryEnvelope');

// Fixture: one assigned item and one unassigned item.
const ring = await w.itemRepo.create({
  title: "Grandmother's sapphire ring",
  room_id: w.registry.resolveRoom('Primary Bedroom', w.ctx).room_id,
  category_id: w.registry.resolveCategory('Jewelry', w.ctx).category_id,
  review_state: 'kept',
  owner_high_value: true,
  owner_high_value_reason: 'feeling',
  owner_important_comment: "Grandma wore this every day of her life.",
}, w.ctx);
// Manually set assigned_to_heir_id since the repo layer doesn't know about
// this column yet \u2014 that's a later commit. Migration 9 exists; this is a
// direct-SQL smoke test that the column is writable.
w.db.prepare('UPDATE items SET assigned_to_heir_id=? WHERE item_id=?').run('heir-sarah', ring.item_id);
const kettlebell = await w.itemRepo.create({
  title: 'Kettlebell',
  room_id: w.registry.resolveRoom('Garage', w.ctx).room_id,
  category_id: w.registry.resolveCategory('Fitness', w.ctx).category_id,
  review_state: 'kept',
}, w.ctx);

const invItems = (await w.itemRepo.list({ review_state: 'kept' }, w.ctx)).items;
// Re-read to pick up assigned_to_heir_id on the raw row (repo.list may not
// project the new column; do a manual join for the envelope input).
const invItemsWithHeir = invItems.map((it) => {
  const row = w.db.prepare('SELECT assigned_to_heir_id FROM items WHERE item_id=?').get(it.item_id);
  return { ...it, assigned_to_heir_id: row?.assigned_to_heir_id ?? null };
});

const invEnv = buildInventoryEnvelope({
  items: invItemsWithHeir,
  rooms: w.registry.rooms(w.ctx),
  categories: w.registry.categories(w.ctx),
  estateId: 'estate-eberbach',
  trigger: 'manual_test',
  recipient: { role: 'trustee', name: 'Trustee Tanya', contact: 'tanya@example.com', delivery_method: 'email' },
  source: { app: 'legacy-registry', app_version: '0.1.0' },
});

await check('inventory envelope has envelope_type="inventory" and version 1.0', () => {
  assert.equal(invEnv.envelope_type, ENVELOPE_TYPE_INVENTORY);
  assert.equal(invEnv.envelope_version, TYPED_ENVELOPE_VERSION);
});
await check('inventory envelope carries every kept item (no assignment filter)', () => {
  assert.equal(invEnv.items.length, 2);
  const names = invEnv.items.map((i) => i.name).sort();
  assert.deepEqual(names, ['Kettlebell', "Grandmother's sapphire ring"].sort());
});
await check('inventory items strip per-item assignment and per-item voice ref', () => {
  for (const it of invEnv.items) {
    assert.equal(it.assigned_to_heir_id, null, 'inventory items must not carry heir assignment');
    assert.equal(it.voice_note_ref, null, 'inventory items must not carry a per-item voice ref');
  }
});
await check('inventory envelope has exactly one recipient (trustee)', () => {
  assert.equal(invEnv.recipient.role, 'trustee');
  assert.equal(invEnv.recipient.name, 'Trustee Tanya');
  assert.ok(!Array.isArray(invEnv.recipient), 'inventory recipient is a single object, not a list');
});
await check("inventory envelope carries the owner's Important mark verbatim", () => {
  const r = invEnv.items.find((i) => i.name === "Grandmother's sapphire ring");
  assert.deepEqual(r.owner_important, {
    flagged: true,
    reason: 'feeling',
    comment: "Grandma wore this every day of her life.",
  });
});
await check('inventory envelope counts include an assigned tally for visibility', () => {
  assert.equal(invEnv.counts.total_items, 2);
  // The ring is assigned; kettlebell is not. Assignment lives in the
  // addendum envelope, but the count is shown here for the trustee to
  // know "N items are earmarked; look for the addendum in the will file".
  assert.equal(invEnv.counts.assigned, 1);
  assert.equal(invEnv.counts.owner_important, 1);
});
await check('inventory envelope rejects an unknown trigger', () => {
  assert.throws(
    () => buildInventoryEnvelope({
      items: [], rooms: [], categories: [],
      estateId: 'x', trigger: 'birthday',
      recipient: { role: 'trustee' },
    }),
    /unknown trigger/,
  );
});
await check('inventory envelope refuses to build without an estateId', () => {
  assert.throws(
    () => buildInventoryEnvelope({
      items: [], rooms: [], categories: [],
      trigger: 'manual_test',
      recipient: { role: 'trustee' },
    }),
    /estateId is required/,
  );
});
await check('inventory envelope refuses to build without a recipient role', () => {
  assert.throws(
    () => buildInventoryEnvelope({
      items: [], rooms: [], categories: [],
      estateId: 'x', trigger: 'manual_test',
      recipient: {},
    }),
    /recipient\.role is required/,
  );
});

/* -------------------------------------------------------------------------- */
console.log('\n3. buildAddendumEnvelope');

const addItems = [
  {
    item_id: ring.item_id,
    title: "Grandmother's sapphire ring",
    room_name: 'Primary Bedroom',
    assigned_to: { name: 'Sarah Eberbach', relationship: 'daughter', heir_id: 'heir-sarah' },
    owner_important_comment: 'This was my grandmother\u2019s engagement ring.',
    closeup_photo: {
      file_name: 'ring-closeup.jpg',
      sha256: 'a'.repeat(64),
      captured_at: '2026-08-09T13:00:00Z',
      source: 'owner_camera',
    },
  },
  {
    item_id: 'itm_missing_closeup',
    title: 'Clock',
    assigned_to: { name: 'Ben', relationship: 'grandson' },
    owner_words: 'Wind it once a week.',
    closeup_photo: null,
  },
];
const addEnv = buildAddendumEnvelope({
  estateId: 'estate-eberbach',
  owner: {
    participant_id: 'owner-ann',
    name: 'Ann Eberbach',
    signed_at: '2026-08-09T13:04:00Z',
    signature_evidence: { wet_ink_hash: 'deadbeef', device: 'Surface Pro 8' },
  },
  version: 2,
  supersedes: 1,
  supersedesDeliveredAt: '2025-03-11T15:00:00Z',
  recipients: [
    { role: 'wills_caretaker', name: 'Smith & Jones LLP', contact: 'wills@smithjones.example', delivery_method: 'signed_link' },
    { role: 'trustee', name: 'Trustee Tanya', contact: 'tanya@example.com', delivery_method: 'email' },
  ],
  voiceMessage: {
    file_name: 'ann-voice.opus',
    transcript: "I wanted to say a few things to each of you before the day comes\u2026",
    duration_seconds: 240,
    recorded_at: '2026-08-09T13:02:00Z',
    sha256: 'b'.repeat(64),
    byte_size: 512000,
  },
  items: addItems,
  gaps: [{ item_id: 'itm_missing_closeup', reason: 'closeup_photo_missing' }],
  source: { app: 'legacy-registry', app_version: '0.1.0' },
});

await check('addendum envelope has envelope_type="addendum" and version 1.0', () => {
  assert.equal(addEnv.envelope_type, ENVELOPE_TYPE_ADDENDUM);
  assert.equal(addEnv.envelope_version, TYPED_ENVELOPE_VERSION);
});
await check('addendum carries the signed owner block and signature evidence', () => {
  assert.equal(addEnv.owner.participant_id, 'owner-ann');
  assert.equal(addEnv.owner.name, 'Ann Eberbach');
  assert.equal(addEnv.owner.signed_at, '2026-08-09T13:04:00Z');
  assert.equal(addEnv.owner.signature_evidence.wet_ink_hash, 'deadbeef');
});
await check('addendum records version, supersedes, and supersedes_delivered_at', () => {
  assert.equal(addEnv.addendum_version, 2);
  assert.equal(addEnv.supersedes_version, 1);
  assert.equal(addEnv.supersedes_delivered_at, '2025-03-11T15:00:00Z');
});
await check('addendum carries BOTH recipients (wills_caretaker + trustee)', () => {
  const roles = addEnv.recipients.map((r) => r.role).sort();
  assert.deepEqual(roles, ['trustee', 'wills_caretaker']);
});
await check('addendum items travel with assigned_to, owner_words, and closeup', () => {
  const r = addEnv.items.find((i) => i.name.includes('sapphire'));
  assert.equal(r.assigned_to.name, 'Sarah Eberbach');
  assert.equal(r.assigned_to.heir_id, 'heir-sarah');
  assert.match(r.owner_words, /engagement ring/);
  assert.equal(r.closeup_photo.source, 'owner_camera');
  assert.equal(r.closeup_photo.checksum, 'a'.repeat(64));
});
await check('addendum surfaces the item without a closeup in the gaps list', () => {
  const clock = addEnv.items.find((i) => i.name === 'Clock');
  assert.equal(clock.closeup_photo, null, 'clock has no closeup');
  assert.deepEqual(addEnv.gaps, [{ item_id: 'itm_missing_closeup', reason: 'closeup_photo_missing' }]);
});
await check('addendum carries the voice message with transcript and checksum', () => {
  assert.ok(addEnv.voice_message);
  assert.equal(addEnv.voice_message.duration_seconds, 240);
  assert.match(addEnv.voice_message.transcript, /before the day comes/);
  assert.equal(addEnv.voice_message.checksum, 'b'.repeat(64));
  assert.equal(addEnv.voice_message.file, 'media/ann-voice.opus');
});
await check('addendum counts total assigned, with-closeup, and gap items', () => {
  assert.equal(addEnv.counts.assigned_items, 2);
  assert.equal(addEnv.counts.items_with_closeup, 1);
  assert.equal(addEnv.counts.items_with_gap, 1);
  assert.equal(addEnv.counts.recipients, 2);
  assert.equal(addEnv.counts.has_voice_message, true);
});
await check('addendum refuses a closeup source other than owner_camera', () => {
  assert.throws(
    () => buildAddendumEnvelope({
      estateId: 'x',
      owner: { participant_id: 'o1' },
      version: 1,
      recipients: [{ role: 'trustee' }],
      items: [{
        item_id: 'i1', title: 't',
        assigned_to: { name: 'a' },
        closeup_photo: { file_name: 'f.jpg', source: 'ai_generated' },
      }],
    }),
    /closeup source must be 'owner_camera'/,
  );
});
await check('addendum refuses an item with no closeup that is also not in gaps', () => {
  assert.throws(
    () => buildAddendumEnvelope({
      estateId: 'x',
      owner: { participant_id: 'o1' },
      version: 1,
      recipients: [{ role: 'trustee' }],
      items: [{ item_id: 'i1', title: 't', assigned_to: { name: 'a' } }],
      // gaps intentionally empty
    }),
    /has no closeup_photo and is not listed in gaps/,
  );
});
await check('addendum refuses to build with no recipients', () => {
  assert.throws(
    () => buildAddendumEnvelope({
      estateId: 'x',
      owner: { participant_id: 'o1' },
      version: 1,
      recipients: [],
      items: [],
    }),
    /at least one recipient/,
  );
});
await check('addendum refuses supersedes >= version', () => {
  assert.throws(
    () => buildAddendumEnvelope({
      estateId: 'x',
      owner: { participant_id: 'o1' },
      version: 2,
      supersedes: 2,
      recipients: [{ role: 'trustee' }],
      items: [],
    }),
    /supersedes must be null or a prior version/,
  );
});
await check('addendum refuses an unknown recipient role', () => {
  assert.throws(
    () => buildAddendumEnvelope({
      estateId: 'x',
      owner: { participant_id: 'o1' },
      version: 1,
      recipients: [{ role: 'family' }],
      items: [],
    }),
    /unknown recipient role/,
  );
});
await check('addendum refuses an item without an assigned_to.name', () => {
  assert.throws(
    () => buildAddendumEnvelope({
      estateId: 'x',
      owner: { participant_id: 'o1' },
      version: 1,
      recipients: [{ role: 'trustee' }],
      items: [{ item_id: 'i1', title: 't' }],
    }),
    /has no assigned_to\.name/,
  );
});

/* -------------------------------------------------------------------------- */
console.log('\n4. parseTypedEnvelope dispatch');

await check('parseTypedEnvelope accepts an inventory envelope round-trip', () => {
  const json = JSON.stringify(invEnv);
  const parsed = parseTypedEnvelope(json);
  assert.equal(parsed.envelope_type, ENVELOPE_TYPE_INVENTORY);
  assert.equal(parsed.items.length, invEnv.items.length);
});
await check('parseTypedEnvelope accepts an addendum envelope round-trip', () => {
  const parsed = parseTypedEnvelope(addEnv);
  assert.equal(parsed.envelope_type, ENVELOPE_TYPE_ADDENDUM);
  assert.equal(parsed.addendum_version, 2);
});
await check('parseTypedEnvelope rejects an unknown envelope_type', () => {
  assert.throws(
    () => parseTypedEnvelope({
      format: 'legacy-exchange',
      envelope_type: 'inventory_v9',
      envelope_version: '1.0',
    }),
    /unknown envelope_type/,
  );
});
await check('parseTypedEnvelope rejects the legacy untyped envelope with guidance', () => {
  const legacy = buildEnvelope({
    items: [], rooms: [], categories: [],
    source: { app: 'legacy-registry', app_version: '0.1.0' },
  });
  assert.throws(
    () => parseTypedEnvelope(legacy),
    /Use parseEnvelope\(\) from envelope\.js/,
  );
});
await check('parseTypedEnvelope rejects a foreign format', () => {
  assert.throws(
    () => parseTypedEnvelope({ format: 'some-other-thing', envelope_type: 'inventory', envelope_version: '1.0' }),
  );
});
await check('parseTypedEnvelope rejects a future major envelope_version', () => {
  assert.throws(
    () => parseTypedEnvelope({ format: 'legacy-exchange', envelope_type: 'inventory', envelope_version: '2.0' }),
  );
});

/* -------------------------------------------------------------------------- */
console.log('\n5. Existing legacy envelope path is unaffected');

await check('buildEnvelope still produces the legacy untyped v1 shape with no envelope_type', () => {
  const legacy = buildEnvelope({
    items: invItemsWithHeir, rooms: w.registry.rooms(w.ctx), categories: w.registry.categories(w.ctx),
    source: { app: 'legacy-registry', app_version: '0.1.0' },
  });
  assert.equal(legacy.format, 'legacy-exchange');
  assert.equal(legacy.version, '1.0');
  assert.equal(legacy.envelope_type, undefined, 'legacy envelope must NOT carry envelope_type');
  assert.ok(Array.isArray(legacy.items));
});

console.log(`\n${pass} checks passed.`);
console.log(`Artifacts: ${tmp}\n`);
