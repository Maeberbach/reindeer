/**
 * MemorandumRepo self-test \u2014 Slice B, step 2.
 *
 * Exercises every code path in packages/legacy-core-data/src/repos/memorandumRepo.js
 * against a real SQLite database:
 *
 *   \u2022 First-time draft (v1 empty) and first entry.
 *   \u2022 Upsert semantics: adding the same item twice updates the row.
 *   \u2022 Delete entries; refuse to delete another partner's entry.
 *   \u2022 Sign: freezes entries, records signing row, blanks the draft.
 *   \u2022 Editing after sign: openDraft() seeds vN+1 from vN.
 *   \u2022 Reprint list: listVersions() returns every version newest-first.
 *   \u2022 Conflict detection: same item, different heirs \u2192 flagged; same
 *     heir \u2192 not flagged; one partner unset \u2192 not flagged.
 *   \u2022 Solo mode: no partner id \u2192 conflict count 0 at sign.
 *   \u2022 Refuses to sign an empty draft.
 *   \u2022 Note field: preserved on upsert, trimmed, capped at 500 chars.
 *
 * Does NOT boot the HTTP server. Repo layer only.
 *
 * Run:  node scripts/memorandum-test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, MemorandumRepo, SqliteAuditLog } from '@reindeer-legacy/core-data';
import { SCOPE_TYPE, makeScopeCtx } from '@reindeer-legacy/core-api';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memorandum-test-'));
const db = openDb(path.join(tmp, 'test.db'));
const audit = new SqliteAuditLog(db);
const repo = new MemorandumRepo(db, audit);
const ctx = makeScopeCtx({ scopeType: SCOPE_TYPE.INVENTORY, scopeId: 'inventory-default' });

const ANN = 'p-ann';
const BOB = 'p-bob';
const HEIR_SARAH = 'h-sarah';
const HEIR_MIKE  = 'h-mike';
const ITEM_CHINA = 'i-china';
const ITEM_CLOCK = 'i-clock';
const ITEM_BOOKS = 'i-books';

let pass = 0;
let fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else       { fail++; console.log(`  \u2717 FAIL: ${name}`); }
};
const throws = (name, fn, code) => {
  try { fn(); fail++; console.log(`  \u2717 FAIL: ${name} \u2014 expected throw`); }
  catch (e) {
    if (code && e.status !== code) { fail++; console.log(`  \u2717 FAIL: ${name} \u2014 status ${e.status} != ${code}`); }
    else { pass++; console.log(`  \u2713 ${name}`); }
  }
};

console.log('1. First-ever memorandum: draft starts empty');
{
  const draft = repo.getDraft(ANN, ctx);
  ok('no draft exists yet', draft === null);
  const opened = repo.openDraft(ANN, ctx);
  ok('openDraft returns a v1 shell', opened.version === 1 && opened.entries.length === 0);
  ok('opened draft is not signed', opened.is_signed === false);
  // Nothing is persisted yet since there are no entries.
  ok('still no draft in the database', repo.getDraft(ANN, ctx) === null);
}

console.log('\n2. First entry creates version 1');
{
  const entry = repo.upsertEntry({ participantId: ANN, itemId: ITEM_CHINA, assignedToHeirId: HEIR_SARAH, note: 'wedding gift from Mom' }, ctx);
  ok('entry has an entry_id', typeof entry.entry_id === 'string' && entry.entry_id.length > 0);
  ok('entry is in v1', entry.version === 1);
  ok('entry heir set', entry.assigned_to_heir_id === HEIR_SARAH);
  ok('note preserved', entry.note === 'wedding gift from Mom');
  ok('entry is not signed', entry.is_signed === false);

  const draft = repo.getDraft(ANN, ctx);
  ok('draft now has 1 entry', draft && draft.entries.length === 1);
  ok('draft version is 1', draft.version === 1);
}

console.log('\n3. Upsert semantics: same item twice \u2192 updates in place');
{
  repo.upsertEntry({ participantId: ANN, itemId: ITEM_CHINA, assignedToHeirId: HEIR_MIKE, note: 'changed my mind' }, ctx);
  const draft = repo.getDraft(ANN, ctx);
  ok('still exactly 1 entry for the china', draft.entries.filter((e) => e.item_id === ITEM_CHINA).length === 1);
  ok('heir was updated', draft.entries.find((e) => e.item_id === ITEM_CHINA).assigned_to_heir_id === HEIR_MIKE);
  ok('note was updated', draft.entries.find((e) => e.item_id === ITEM_CHINA).note === 'changed my mind');
}

console.log('\n4. Note field: trimmed, empty allowed, over-long rejected');
{
  repo.upsertEntry({ participantId: ANN, itemId: ITEM_CLOCK, assignedToHeirId: HEIR_SARAH, note: '   for Sarah, it was her grandfather\\u2019s   ' }, ctx);
  const draft = repo.getDraft(ANN, ctx);
  ok('note was trimmed', draft.entries.find((e) => e.item_id === ITEM_CLOCK).note === 'for Sarah, it was her grandfather\\u2019s');

  repo.upsertEntry({ participantId: ANN, itemId: ITEM_BOOKS, assignedToHeirId: null, note: '' }, ctx);
  ok('empty note stored as empty string', repo.getDraft(ANN, ctx).entries.find((e) => e.item_id === ITEM_BOOKS).note === '');

  throws('over-long note rejected', () => repo.upsertEntry({ participantId: ANN, itemId: ITEM_BOOKS, note: 'x'.repeat(501) }, ctx), 400);
}

console.log('\n5. assigned_to_heir_id may be null (unassigned)');
{
  const draft = repo.getDraft(ANN, ctx);
  const books = draft.entries.find((e) => e.item_id === ITEM_BOOKS);
  ok('books entry exists', books != null);
  ok('books has no heir', books.assigned_to_heir_id === null);
}

console.log('\n6. Delete an entry from the draft');
{
  const draft = repo.getDraft(ANN, ctx);
  const booksEntry = draft.entries.find((e) => e.item_id === ITEM_BOOKS);
  const r = repo.deleteEntry(booksEntry.entry_id, ANN, ctx);
  ok('delete returns deleted:true', r.deleted === true);
  ok('draft now has 2 entries', repo.getDraft(ANN, ctx).entries.length === 2);
}

console.log('\n7. Delete auth: cannot delete another partner\\u2019s entry');
{
  // Give Bob an entry first.
  repo.upsertEntry({ participantId: BOB, itemId: ITEM_CHINA, assignedToHeirId: HEIR_SARAH }, ctx);
  const bobEntry = repo.getDraft(BOB, ctx).entries[0];
  throws('Ann cannot delete Bob\\u2019s entry', () => repo.deleteEntry(bobEntry.entry_id, ANN, ctx), 403);
  // Bob can still delete it himself.
  const r = repo.deleteEntry(bobEntry.entry_id, BOB, ctx);
  ok('Bob can delete his own entry', r.deleted === true);
}

console.log('\n8. Cannot sign an empty draft');
{
  // Bob just deleted his only entry, so his draft is empty.
  throws('signing an empty draft is rejected', () => repo.sign(BOB, ANN, ctx), 400);
}

console.log('\n9. Sign Ann\\u2019s v1 \u2014 freezes entries, records signing');
{
  const result = repo.sign(ANN, BOB, ctx);
  ok('sign returns a signing_id', typeof result.signing_id === 'string');
  ok('sign returns version 1', result.version === 1);
  ok('signed_at is an ISO string', /^\d{4}-\d{2}-\d{2}T/.test(result.signed_at));
  ok('conflict count is 0 (Bob has no entries)', result.conflict_count_at_sign === 0);
  ok('entry_count matches', result.entry_count === 2);

  const v1 = repo.getVersion(ANN, 1, ctx);
  ok('v1 is now signed', v1.is_signed === true);
  ok('v1 has signed_at', v1.signed_at != null);
  ok('every entry in v1 has is_signed=true', v1.entries.every((e) => e.is_signed === true));
  ok('no draft exists anymore for Ann', repo.getDraft(ANN, ctx) === null);
}

console.log('\n10. Signed entries cannot be deleted');
{
  const v1 = repo.getVersion(ANN, 1, ctx);
  const first = v1.entries[0];
  throws('deleting a signed entry is rejected', () => repo.deleteEntry(first.entry_id, ANN, ctx), 400);
}

console.log('\n11. Opening a new draft seeds vN+1 from vN');
{
  const v2 = repo.openDraft(ANN, ctx);
  ok('new draft is v2', v2.version === 2);
  ok('v2 seeded with v1 entries', v2.entries.length === 2);
  ok('v2 entries are not signed', v2.entries.every((e) => e.is_signed === false));
  ok('v2 preserved the china \u2192 Mike assignment from v1', v2.entries.find((e) => e.item_id === ITEM_CHINA).assigned_to_heir_id === HEIR_MIKE);
  ok('idempotent: calling openDraft again returns the same v2', repo.openDraft(ANN, ctx).version === 2);
}

console.log('\n12. Edit v2 without touching v1');
{
  repo.upsertEntry({ participantId: ANN, itemId: ITEM_CHINA, assignedToHeirId: HEIR_SARAH }, ctx);
  const v1 = repo.getVersion(ANN, 1, ctx);
  const v2 = repo.getDraft(ANN, ctx);
  ok('v1 china still points at Mike', v1.entries.find((e) => e.item_id === ITEM_CHINA).assigned_to_heir_id === HEIR_MIKE);
  ok('v2 china now points at Sarah', v2.entries.find((e) => e.item_id === ITEM_CHINA).assigned_to_heir_id === HEIR_SARAH);
  ok('v2 remains unsigned', v2.is_signed === false);
}

console.log('\n13. Version list (newest first)');
{
  const versions = repo.listVersions(ANN, ctx);
  ok('two versions listed', versions.length === 2);
  ok('newest first', versions[0].version === 2 && versions[1].version === 1);
  ok('v2 marked unsigned', versions[0].is_signed === false);
  ok('v1 marked signed', versions[1].is_signed === true);
  ok('v1 has conflict_count_at_sign recorded', versions[1].conflict_count_at_sign === 0);
}

console.log('\n14. Conflict detection: no conflict when only one partner has entries');
{
  const c = repo.detectConflicts(ANN, BOB, ctx);
  ok('Bob has nothing, so no conflicts', c.length === 0);
}

console.log('\n15. Conflict detection: same item, different heirs \u2192 flagged');
{
  repo.upsertEntry({ participantId: BOB, itemId: ITEM_CHINA, assignedToHeirId: HEIR_MIKE, note: 'promised to Mike years ago' }, ctx);
  const c = repo.detectConflicts(ANN, BOB, ctx);
  ok('one conflict detected', c.length === 1);
  ok('conflict names the item', c[0].item_id === ITEM_CHINA);
  ok('carries Ann\\u2019s heir', c[0].participant_a_heir_id === HEIR_SARAH);
  ok('carries Bob\\u2019s heir', c[0].participant_b_heir_id === HEIR_MIKE);
  ok('carries Bob\\u2019s note', c[0].participant_b_note === 'promised to Mike years ago');
}

console.log('\n16. Conflict detection: same heir \u2192 not a conflict');
{
  // Bob assigns the clock to the same heir Ann did.
  repo.upsertEntry({ participantId: BOB, itemId: ITEM_CLOCK, assignedToHeirId: HEIR_SARAH }, ctx);
  const c = repo.detectConflicts(ANN, BOB, ctx);
  ok('still just one conflict (the china)', c.length === 1);
  ok('conflict is still the china', c[0].item_id === ITEM_CHINA);
}

console.log('\n17. Conflict detection: one partner unassigned \u2192 not a conflict');
{
  // Bob adds an item Ann has not touched, with no heir.
  repo.upsertEntry({ participantId: BOB, itemId: 'i-quiet', assignedToHeirId: null }, ctx);
  const c = repo.detectConflicts(ANN, BOB, ctx);
  ok('still just one conflict', c.length === 1);
}

console.log('\n18. Sign v2 with a real conflict, then check the count');
{
  const result = repo.sign(ANN, BOB, ctx);
  ok('sign returns v2', result.version === 2);
  ok('conflict count at sign is 1', result.conflict_count_at_sign === 1);
  const versions = repo.listVersions(ANN, ctx);
  ok('v2 now signed', versions[0].is_signed === true);
  ok('v2 stored conflict_count_at_sign=1', versions[0].conflict_count_at_sign === 1);
}

console.log('\n19. Solo mode: no partner id \u2192 conflict count is 0');
{
  // Give Bob a fresh version and sign in solo mode.
  const soloResult = repo.sign(BOB, null, ctx);
  ok('solo sign returns a version', soloResult.version >= 1);
  ok('solo conflict count is 0', soloResult.conflict_count_at_sign === 0);
}

console.log('\n20. Snapshot integrity: entries_snapshot on the signing row matches entries');
{
  const row = db.prepare('SELECT entries_snapshot FROM memorandum_signings WHERE participant_id = ? AND version = ?').get(ANN, 1);
  const snap = JSON.parse(row.entries_snapshot);
  const v1 = repo.getVersion(ANN, 1, ctx);
  ok('snapshot length matches v1 length', snap.length === v1.entries.length);
  ok('snapshot preserved item_ids', snap.every((s) => v1.entries.some((e) => e.item_id === s.item_id)));
}

console.log(`\n${pass} checks passed${fail ? `, ${fail} FAILED` : ''}.`);
process.exit(fail ? 1 : 0);
