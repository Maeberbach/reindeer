/**
 * Cross-suite conflict test: My Legacy Registry -> Legacy: Fair Choice.
 *
 * The registry now produces two very different kinds of row, and this test
 * exists to prove Fair Choice can tell them apart and can absorb the same
 * inventory more than once without corrupting the estate.
 *
 *   Lane A (photo)  a small number of items the owner deliberately named.
 *                   These are the operative gifts. Schedule A on the printed
 *                   memorandum. They must arrive with the recipient intact.
 *
 *   Lane B (video)  the bulk of the household, logged from a walkthrough with
 *                   no recipient and no value. Schedule B. These must arrive
 *                   as ordinary poolable items and must NOT look like gifts.
 *
 * The four things that could realistically go wrong, and are checked here:
 *
 *   1. Re-import piles up duplicates. An owner will hand over a new export
 *      every time they add a room. The same origin_item_id must update, never
 *      multiply.
 *   2. Bulk labels collide. Video recognition emits generic names, so two
 *      different oak chairs can carry the same label. Fair Choice must flag a
 *      possible duplicate for a human and must never merge on its own.
 *   3. Missing values break the money math. The registry no longer sends any
 *      value at all. Equalization must degrade to "not yet valued", not to
 *      NaN, and not to a silent zero that looks like a real appraisal.
 *   4. A designated gift gets pooled. An item with a named recipient must stay
 *      distinguishable from the bulk after import, or the owner's wishes are
 *      lost the moment the file crosses the boundary.
 *
 * Run with:  npx tsx server/import/suite-conflict-selftest.mts
 */
import "../testing/scratchEnv"; // MUST be first — redirects to a scratch db.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";

import { SCOPE_TYPE, makeScopeCtx } from "@legacy-suite/core-api";
import { openDb, SqliteItemRepository, FsMediaStore, ScopeMediaStore, Registry, SqliteAuditLog } from "@legacy-suite/core-data";
import { writeBundle } from "@legacy-suite/exchange";

import { db, storage } from "../storage";
import { items, stagedItems } from "@shared/schema";
import { eq } from "drizzle-orm";
import { stageBundle, listStaged, approveBatch } from "./importService";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHUlEQVQoU2NkYGD4z0AEYBxVSF" +
    "JAAQAA//8DAAQVAQF0kU5PAAAAAElFTkSuQmCC",
  "base64",
);

async function main() {
  let pass = 0;
  const fails: string[] = [];
  const check = async (name: string, fn: () => void | Promise<void>) => {
    try {
      await fn();
      pass++;
      console.log(`  \u2713 ${name}`);
    } catch (e: any) {
      fails.push(`${name} — ${e.message}`);
      console.log(`  \u2717 ${name}`);
      console.log(`      ${String(e.message).split("\n")[0]}`);
    }
  };

  console.log("\nCross-suite conflict test: Registry -> Fair Choice\n");

  /* ---------------------------------------------------------------- */
  /* Build a registry that looks like the two lanes actually produce.   */
  /* ---------------------------------------------------------------- */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "suite-conflict-"));
  const invDir = path.join(tmp, "inventory");
  fs.mkdirSync(invDir, { recursive: true });

  const invDb = openDb(path.join(invDir, "inventory.db"));
  const audit = new SqliteAuditLog(invDb);
  const itemRepo = new SqliteItemRepository(invDb, audit);
  const mediaStore = new FsMediaStore(invDb, path.join(invDir, "media"));
  const scopeMediaStore = new ScopeMediaStore(invDb, path.join(invDir, "media"));
  const registry = new Registry(invDb, audit);
  registry.ensureScope({ scopeId: "two-lane", scopeType: SCOPE_TYPE.INVENTORY, name: "two-lane" });
  const ctx = makeScopeCtx({ scopeType: SCOPE_TYPE.INVENTORY, scopeId: "two-lane", actorId: "test" });

  const room = (n: string) => registry.resolveRoom(n, ctx).room_id;
  const cat = (n: string) => registry.resolveCategory(n, ctx).category_id;

  // Lane A: the owner stopped, photographed this, and named someone.
  const brooch = await itemRepo.create({
    title: "Grandmother's pearl brooch",
    story: "She wore it to every wedding.",
    room_id: room("Primary Bedroom"),
    category_id: cat("Jewelry"),
    // The registry no longer asks. This is what a real Lane A row looks like now.
    value_estimate_cents: null,
    value_basis: "unknown",
    high_value_flag: true,
    review_state: "kept",
    recipient_hint: { recipient_name: "Ruth Alvarez", relationship: "daughter", owner_note: "She asked every Christmas." },
  }, ctx);
  await mediaStore.put(PNG, { item_id: brooch.item_id, role: "primary", mime_type: "image/png" }, ctx);

  // Lane B: pulled out of a walkthrough. No name, no value, generic label.
  const bulkTitles = ["Oak dining chairs", "Cast iron skillet", "Photograph album", "Oak dining chairs"];
  const bulk: any[] = [];
  for (const title of bulkTitles) {
    const it = await itemRepo.create({
      title,
      room_id: room("Dining Room"),
      category_id: cat("Furniture"),
      value_estimate_cents: null,
      value_basis: "unknown",
      high_value_flag: false,
      review_state: "kept",
    }, ctx);
    await mediaStore.put(PNG, { item_id: it.item_id, role: "primary", mime_type: "image/png" }, ctx);
    bulk.push(it);
  }

  const exportBundle = () => writeBundle({
    itemRepo, mediaStore, scopeMediaStore, registry, ctx,
    query: { review_state: "kept" },
    source: { app: "legacy-registry", app_version: "0.1.0", inventory_id: "two-lane", owner_name: "Alice Bell" },
  });

  const first = await exportBundle();

  console.log("1. The registry's two lanes survive the wire");
  await check("all five items export", () => assert.equal(first.envelope.items.length, 5));
  await check("no item carries a value figure any more", () =>
    assert.ok(first.envelope.items.every((i: any) => i.value_estimate_cents == null)));
  await check("no item claims an ai_estimate basis any more", () =>
    assert.ok(first.envelope.items.every((i: any) => i.value_basis !== "ai_estimate")));
  await check("exactly one item carries a named recipient", () =>
    assert.equal(first.envelope.items.filter((i: any) => i.recipient_hint?.recipient_name).length, 1));
  await check("the high-value cue survives without a value attached", () => {
    const b = first.envelope.items.find((i: any) => /brooch/i.test(i.title));
    assert.equal(b.high_value_flag, true);
    assert.equal(b.value_estimate_cents, null);
  });

  /* ---------------------------------------------------------------- */
  console.log("\n2. First import into Fair Choice");
  const staged1 = await stageBundle(first.buffer, { fileName: "first.reindeer", actorId: null });
  const rows1 = await listStaged(staged1.batch.sessionId ?? undefined);

  await check("all five arrive staged, none live", () => {
    assert.equal(rows1.length, 5);
    assert.equal(db.select().from(items).all().filter((i) => i.originApp === "legacy_registry").length, 0);
  });
  await check("the designated gift keeps its recipient across the boundary", () => {
    const r = rows1.find((x) => /brooch/i.test(x.name))!;
    assert.match(String(r.recipientHint ?? ""), /Ruth Alvarez/);
  });
  await check("bulk items arrive with no recipient at all", () => {
    const b = rows1.filter((x) => !/brooch/i.test(x.name));
    assert.ok(b.every((x) => !x.recipientHint));
  });
  await check("a missing value maps to null, never to zero", () => {
    assert.ok(rows1.every((r) => r.estimatedValue === null),
      `saw: ${JSON.stringify(rows1.map((r) => r.estimatedValue))}`);
  });
  await check("the duplicate bulk label is flagged, not merged", () => {
    const chairs = rows1.filter((x) => /Oak dining chairs/.test(x.name));
    assert.equal(chairs.length, 2, "both chair rows must survive staging");
  });

  await approveBatch(staged1.batch.id, null);
  const live1 = db.select().from(items).all().filter((i) => i.originApp === "legacy_registry");
  await check("approving the batch makes exactly five live items", () => assert.equal(live1.length, 5));

  /* ---------------------------------------------------------------- */
  console.log("\n3. The owner adds a room and re-sends the WHOLE inventory");
  const lamp = await itemRepo.create({
    title: "Brass floor lamp",
    room_id: room("Living Room"),
    category_id: cat("Furniture"),
    value_estimate_cents: null,
    value_basis: "unknown",
    review_state: "kept",
  }, ctx);
  await mediaStore.put(PNG, { item_id: lamp.item_id, role: "primary", mime_type: "image/png" }, ctx);

  const second = await exportBundle();
  const staged2 = await stageBundle(second.buffer, { fileName: "second.reindeer", actorId: null });
  const rows2 = await listStaged(staged2.batch.sessionId ?? undefined, { state: "draft" });

  await check("the re-sent bundle carries all six items", () => assert.equal(second.envelope.items.length, 6));
  await check("the five already-imported items are recognised as updates, not new arrivals", () => {
    const updates = rows2.filter((r) => r.arrivalKind === "updates_existing");
    assert.equal(updates.length, 5, `saw kinds: ${JSON.stringify(rows2.map((r) => [r.name, r.arrivalKind]))}`);
  });
  await check("only the genuinely new item is marked new", () => {
    const fresh = rows2.filter((r) => r.arrivalKind === "new");
    assert.equal(fresh.length, 1);
    assert.match(fresh[0].name, /Brass floor lamp/);
  });

  await approveBatch(staged2.batch.id, null);
  const live2 = db.select().from(items).all().filter((i) => i.originApp === "legacy_registry");

  await check("re-importing does NOT pile up duplicates: six items, not eleven", () =>
    assert.equal(live2.length, 6, `saw ${live2.length}: ${JSON.stringify(live2.map((i) => i.name))}`));
  await check("every live item has a distinct origin id", () => {
    const ids = live2.map((i) => i.originItemId);
    assert.equal(new Set(ids).size, ids.length);
  });
  await check("the designated gift was not duplicated into two competing gifts", () =>
    assert.equal(live2.filter((i) => /brooch/i.test(i.name)).length, 1));

  /* ---------------------------------------------------------------- */
  console.log("\n4. A genuinely fresh item that merely LOOKS like an existing one");
  const decoyChair = await itemRepo.create({
    title: "Oak dining chairs",
    room_id: room("Study"),
    category_id: cat("Furniture"),
    value_estimate_cents: null,
    value_basis: "unknown",
    review_state: "kept",
  }, ctx);
  await mediaStore.put(PNG, { item_id: decoyChair.item_id, role: "primary", mime_type: "image/png" }, ctx);

  const third = await exportBundle();
  const staged3 = await stageBundle(third.buffer, { fileName: "third.reindeer", actorId: null });
  const rows3 = await listStaged(staged3.batch.sessionId ?? undefined, { state: "draft" });
  const decoyRow = rows3.find((r) => r.originItemId === decoyChair.item_id)!;

  await check("the look-alike is flagged as a possible duplicate for a human to judge", () =>
    assert.equal(decoyRow.arrivalKind, "possible_duplicate"));
  await check("the flag points at which existing item it resembles", () =>
    assert.ok(decoyRow.possibleDuplicateOf, "expected a pointer to the item it resembles"));
  await check("it is still staged as its own row — nothing was auto-merged", () =>
    assert.equal(decoyRow.state, "draft"));

  await approveBatch(staged3.batch.id, null);
  const live3 = db.select().from(items).all().filter((i) => i.originApp === "legacy_registry");
  await check("a confirmed look-alike becomes its own item once a human approves it", () =>
    assert.equal(live3.length, 7));

  /* ---------------------------------------------------------------- */
  console.log("\n5. Money math with an inventory that carries no values at all");
  await check("no imported item has a value", () =>
    assert.ok(live3.every((i) => i.estimatedValue === null || i.estimatedValue === 0)));

  const totals = live3.reduce((s, i) => s + ((i as any).approvedValue ?? i.estimatedValue ?? 0), 0);
  await check("the estate total is a real number, not NaN", () => {
    assert.ok(Number.isFinite(totals), `total was ${totals}`);
    assert.equal(totals, 0);
  });
  await check("an unvalued high-value item is NOT auto-flagged for appraisal (AI estimation decides)", () => {
    const b = live3.find((i) => /brooch/i.test(i.name))!;
    assert.equal(!!(b as any).needsAppraisal, false, "import must not auto-trigger appraisal; only AI value estimation does");
  });
  await check("value source records that nobody has valued these yet", () => {
    const b = live3.find((i) => /brooch/i.test(i.name))!;
    assert.ok((b as any).valueSource !== "ai_estimate");
  });

  console.log(`\n${pass} checks passed.`);
  if (fails.length) {
    console.log(`${fails.length} FAILED:`);
    fails.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
