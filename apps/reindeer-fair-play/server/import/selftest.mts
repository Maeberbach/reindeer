/**
 * Self-test for the inventory import backend.
 *
 * Builds a REAL LegacyExchange bundle the same way
 * `scripts/roundtrip-test.mjs` does (an inventory with a photo, a video, and
 * a voice recording, plus an item in a room this estate does not have), then
 * exercises `stageBundle` / `approveStaged` / `approveBatch` against this
 * app's own storage and schema.
 *
 * Run with:  npx tsx server/import/selftest.mts
 *
 * Safe to run from anywhere: ../testing/scratchEnv redirects this run to a
 * throwaway database and upload directory before storage.ts is loaded.
 */
import "../testing/scratchEnv"; // MUST be first — see that file.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";

import { SCOPE_TYPE, makeScopeCtx } from "@legacy-suite/core-api";
import { openDb, SqliteItemRepository, FsMediaStore, ScopeMediaStore, Registry, SqliteAuditLog } from "@legacy-suite/core-data";
import { writeBundle, readBundle } from "@legacy-suite/exchange";

import { db, storage } from "../storage";
import { importBatches, stagedItems, stagedMedia, itemMedia, items, rankings, picks, classificationChanges, appraisalFlags } from "@shared/schema";
import { eq } from "drizzle-orm";
import {
  stageBundle,
  confirmDetectedAssignment,
  dismissDetectedAssignment,
  listBatches,
  getBatch,
  listStaged,
  approveStaged,
  rejectStaged,
  approveBatch,
  discardBatch,
} from "./importService";

async function main() {

  let pass = 0;
  const check = async (name: string, fn: () => void | Promise<void>) => {
    await fn();
    pass++;
    console.log(`  \u2713 ${name}`);
  };

  /* ------------------------------------------------------------------ */
  /* 1. Build a real inventory + a real .reindeer bundle                    */
  /* ------------------------------------------------------------------ */
  console.log("\nInventory import backend self-test\n");
  console.log("1. Building a real LegacyExchange bundle from a fixture inventory");

  const tmp = fs.mkdtempSync(path.join((await import("node:os")).default.tmpdir(), "fair-choice-import-selftest-"));
  const invDir = path.join(tmp, "inventory");
  fs.mkdirSync(invDir, { recursive: true });

  const invDb = openDb(path.join(invDir, "inventory.db"));
  const invAudit = new SqliteAuditLog(invDb);
  const invItemRepo = new SqliteItemRepository(invDb, invAudit);
  const invMediaStore = new FsMediaStore(invDb, path.join(invDir, "media"));
  const invScopeMediaStore = new ScopeMediaStore(invDb, path.join(invDir, "media"));
  const invRegistry = new Registry(invDb, invAudit);
  invRegistry.ensureScope({ scopeId: "inv-selftest", scopeType: SCOPE_TYPE.INVENTORY, name: "inv-selftest" });
  const invCtx = makeScopeCtx({ scopeType: SCOPE_TYPE.INVENTORY, scopeId: "inv-selftest", actorId: "test" });

  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHUlEQVQoU2NkYGD4z0AEYBxVSF" +
      "JAAQAA//8DAAQVAQF0kU5PAAAAAElFTkSuQmCC",
    "base64",
  );
  const AUDIO = crypto.randomBytes(64 * 1024);
  const VIDEO = crypto.randomBytes(256 * 1024);
  const WALKTHROUGH = crypto.randomBytes(128 * 1024);

  const watch = await invItemRepo.create(
    {
      title: "Grandfather's Hamilton pocket watch",
      story: "He carried it on the railroad for thirty-one years.",
      room_id: invRegistry.resolveRoom("Primary Bedroom", invCtx).room_id,
      category_id: invRegistry.resolveCategory("Jewelry", invCtx).category_id,
      identifiers: { brand: "Hamilton", serial: "992B" },
      value_estimate_cents: 45000,
      value_basis: "ai_estimate",
      high_value_flag: true,
      ai_confidence: 0.82,
      review_state: "kept",
      recipient_hint: {
        recipient_name: "Susan",
        relationship: "daughter",
        owner_note: "She asked about it every Christmas.",
      },
    },
    invCtx,
  );
  await invMediaStore.put(PNG, { item_id: watch.item_id, role: "primary", mime_type: "image/png" }, invCtx);
  await invMediaStore.put(
    AUDIO,
    {
      item_id: watch.item_id,
      mime_type: "audio/webm",
      media_kind: "audio",
      role: "item_story",
      duration_ms: 47000,
      label: "Why this matters",
      transcript: "This is the watch my father carried on the railroad. He wound it every Sunday night.",
    },
    invCtx,
  );
  await invMediaStore.put(
    VIDEO,
    {
      item_id: watch.item_id,
      mime_type: "video/mp4",
      media_kind: "video",
      role: "item_walkaround",
      duration_ms: 12000,
      label: "All sides, including the engraving",
    },
    invCtx,
  );
  await invScopeMediaStore.put(
    WALKTHROUGH,
    { media_kind: "video", mime_type: "video/mp4", title: "Walkthrough of the whole house", duration_ms: 90000, transcript: "Starting at the front door." },
    invCtx,
  );

  const skillet = await invItemRepo.create(
    {
      title: "Cast iron skillet",
      room_id: invRegistry.resolveRoom("Kitchen", invCtx).room_id,
      category_id: invRegistry.resolveCategory("Tools", invCtx).category_id,
      value_estimate_cents: 4500,
      review_state: "kept",
      // The owner marked this Important in Registry (emotional value, not
      // dollar value) and wrote a comment. Fair Choice should honor the
      // Important mark as an needsAppraisal promotion at approve time, with an
      // audited classification-change row. The comment travels through as
      // legacy content. See docs/decisions/2026-08-06-fc-honors-owner-important.md.
      owner_high_value: true,
      owner_important_comment: "Grandma made a hundred meals in this. Keep it in the family.",
    } as any,
    invCtx,
  );
  await invMediaStore.put(PNG, { item_id: skillet.item_id, role: "primary", mime_type: "image/png" }, invCtx);

  // An item in a room this estate will not recognize.
  const boatMotor = await invItemRepo.create(
    {
      title: "Outboard motor",
      room_id: invRegistry.resolveRoom("Boat House", invCtx).room_id,
      category_id: invRegistry.resolveCategory("Tools", invCtx).category_id,
      value_estimate_cents: 180000,
      high_value_flag: true,
      review_state: "kept",
    },
    invCtx,
  );

  const { buffer, envelope } = await writeBundle({
    itemRepo: invItemRepo,
    mediaStore: invMediaStore,
    scopeMediaStore: invScopeMediaStore,
    registry: invRegistry,
    ctx: invCtx,
    query: { review_state: "kept" },
    source: { app: "legacy-registry", app_version: "0.1.0", inventory_id: "inv-selftest", owner_name: "Test Owner" },
  });

  await check("the fixture bundle is a readable zip with checksums that verify", () => {
    const { problems, manifest } = readBundle(buffer);
    assert.deepEqual(problems, []);
    assert.ok(manifest?.batch_id);
  });
  await check("the fixture bundle carries 3 items with photo/video/audio", () => {
    assert.equal(envelope.items.length, 3);
    assert.equal(envelope.counts.videos, 2); // 1 item walkaround + 1 scope video
    assert.equal(envelope.counts.audio, 1);
    assert.equal(envelope.counts.scope_media, 1);
  });

  /* ------------------------------------------------------------------ */
  /* 2. Stage the bundle into Legacy: Fair Choice                         */
  /* ------------------------------------------------------------------ */
  console.log("\n2. Staging the bundle (nothing may enter the live pool yet)");

  const session = await storage.getSession();

  await check("no items row exists before staging", () => {
    const before = db.select().from(items).all();
    assert.equal(before.filter((i) => i.originApp === "legacy_registry").length, 0);
  });

  const staged1 = await stageBundle(buffer, { fileName: "handoff.reindeer", actorId: null });

  await check("staging creates one import_batches row", () => {
    const row = db.select().from(importBatches).where(eq(importBatches.id, staged1.batch.id)).get();
    assert.ok(row);
    assert.equal(row!.itemCount, 3);
    assert.equal(row!.state, "staged");
  });

  await check("staging creates one staged_items draft row per bundle item", () => {
    assert.equal(staged1.stagedItems.length, 3);
    assert.ok(staged1.stagedItems.every((s) => s.state === "draft"));
  });

  await check("no items row exists after staging either — only staging changed", () => {
    const after = db.select().from(items).all();
    assert.equal(after.filter((i) => i.originApp === "legacy_registry").length, 0);
  });

  await check("media files land on disk under uploads/imports/<batchId>/...", () => {
    const media = db.select().from(stagedMedia).all();
    assert.ok(media.length >= 5); // 2 photos + 2 recordings + 1 scope video
    for (const m of media) {
      assert.match(m.url, new RegExp(`^/uploads/imports/${staged1.batch.batchId}/`));
      const uploadDir = process.env.FAIR_CHOICE_UPLOAD_DIR ?? path.resolve("uploads");
      const onDisk = path.join(uploadDir, m.url.replace(/^\/uploads\//, ""));
      assert.ok(fs.existsSync(onDisk), `expected media file to exist at ${onDisk}`);
    }
  });

  await check("unmatched rooms are reported, never invented", () => {
    assert.deepEqual(staged1.unmatchedRooms, ["Boat House"]);
    const taxonomyRooms = new Set((db.select().from(items).all()).map((i) => i.room));
    // The room truly was not silently created as a taxonomy/room entry.
    assert.ok(!taxonomyRooms.has("Boat House"));
  });

  await check("known rooms/categories are recognized and not reported as unmatched", () => {
    assert.ok(!staged1.unmatchedRooms.includes("Primary Bedroom"));
    assert.ok(!staged1.unmatchedRooms.includes("Kitchen"));
  });

  await check("arrivalKind is 'new' for a first-time import", () => {
    assert.ok(staged1.stagedItems.every((s) => s.arrivalKind === "new"));
  });

  await check("recipient hint is staged as advisory text, not applied anywhere", () => {
    const watchStaged = staged1.stagedItems.find((s) => s.name.includes("Hamilton"));
    assert.equal(watchStaged?.recipientHint, "Susan");
    // Nothing in rankings or picks exists yet at all.
    assert.equal(db.select().from(rankings).all().length, 0);
    assert.equal(db.select().from(picks).all().length, 0);
  });

  /* ------------------------------------------------------------------ */
  /* 3. Approve into the live pool                                        */
  /* ------------------------------------------------------------------ */
  console.log("\n3. Approving staged items");

  const watchStaged1 = staged1.stagedItems.find((s) => s.name.includes("Hamilton"))!;
  const approved1 = await approveStaged(watchStaged1.id, null);

  await check("approval creates a real items row", () => {
    assert.ok(approved1.item.id);
    assert.equal(approved1.item.name, "Grandfather's Hamilton pocket watch");
    assert.equal(approved1.item.originItemId, watch.item_id);
    assert.equal(approved1.item.room, "Primary Bedroom");
    // Watch carries a structured recipient_hint from Reindeer Wishes, so it
    // lifts straight into the owner_assigned bucket at approve time.
    // This is the behavior change from v15: recipient_hint used to be
    // advisory-only and the item would sit in `available` for the draft.
    assert.equal(approved1.item.status, "owner_assigned");
  });

  await check("approval copies staged_media into item_media", () => {
    const media = db.select().from(itemMedia).where(eq(itemMedia.itemId, approved1.item.id)).all();
    assert.ok(media.length >= 3); // photo + audio + video
    assert.ok(media.some((m) => m.kind === "photo"));
    assert.ok(media.some((m) => m.kind === "audio" && /wound it every Sunday/.test(m.transcript)));
    assert.ok(media.some((m) => m.kind === "video"));
  });

  await check("the item's photoUrl/thumbnailUrl are set from the primary photo", () => {
    assert.ok(approved1.item.photoUrl);
    assert.equal(approved1.item.photoUrl, approved1.item.thumbnailUrl);
  });

  await check("recipient hint reaches the item as both advisory text and a binding owner assignment", () => {
    assert.equal(approved1.item.recipientHint, "Susan");
    // v15: the hint also drives owner_assigned bookkeeping.
    assert.equal(approved1.item.ownerAssignedName, "Susan");
    assert.equal(approved1.item.ownerAssignedSource, "recipient_hint");
    // Susan is not a participant in this test fixture, so the resolver
    // does not populate a participant id. That is fine — the item is
    // still locked out of the draft pool by status='owner_assigned' and
    // the PR can bind Susan later from the item detail screen.
    assert.equal(approved1.item.ownerAssignedParticipantId, null);
  });

  await check("owner-assigned items are still absent from rankings and picks", () => {
    const allRankings = db.select().from(rankings).all();
    const allPicks = db.select().from(picks).all();
    assert.equal(allRankings.length, 0);
    assert.equal(allPicks.length, 0);
    // Also confirm no ranking/pick table has ever referenced this item's id
    // in a way that encodes the hint as a rank or award. status='owner_assigned'
    // is what keeps it out of the ranked draft going forward.
    assert.ok(!allRankings.some((r) => r.itemId === approved1.item.id));
    assert.ok(!allPicks.some((p) => p.itemId === approved1.item.id));
  });

  const batchApproval = await approveBatch(staged1.batch.id, null);

  await check("approveBatch applies every remaining draft row", () => {
    const okResults = batchApproval.results.filter((r) => r.ok);
    assert.equal(okResults.length, 2); // skillet + boat motor (watch already approved individually)
    assert.equal(batchApproval.batch.state, "applied");
  });

  await check("boat motor item lands with its unmatched room stored verbatim", () => {
    const motor = db.select().from(items).where(eq(items.originItemId, boatMotor.item_id)).get();
    assert.ok(motor);
    assert.equal(motor!.room, "Boat House");
  });

  /* ---------- v13: owner's Registry Important promotes to needsAppraisal ---------- */
  await check("the skillet arrives in Fair Choice already flagged high value (owner marked it Important in Registry)", () => {
    const s = db.select().from(items).where(eq(items.originItemId, skillet.item_id)).get();
    assert.ok(s, "skillet should be present in items after approveBatch");
    assert.equal(s!.needsAppraisal, true, "owner_high_value in Registry must promote needsAppraisal on the FC side");
  });

  await check("the owner's Important comment travels through as ownerImportantComment on the FC item", () => {
    const s = db.select().from(items).where(eq(items.originItemId, skillet.item_id)).get();
    assert.equal(
      s!.ownerImportantComment,
      "Grandma made a hundred meals in this. Keep it in the family.",
      "the owner's own words must not be silently dropped at the FC boundary",
    );
  });

  await check("a classification-change row records the flip with null-participant attribution and a plain-English reason", () => {
    const s = db.select().from(items).where(eq(items.originItemId, skillet.item_id)).get();
    const changes = db
      .select()
      .from(classificationChanges)
      .where(eq(classificationChanges.itemId, s!.id))
      .all();
    const importFlip = changes.find(
      (c) => c.flagName === "needsAppraisal" && c.newValue === true && c.oldValue === false,
    );
    assert.ok(importFlip, "expected a classificationChanges row for the import-time promotion");
    assert.equal(importFlip!.changedByParticipantId, null, "owner is not a participant — attribution stays null");
    assert.equal(
      importFlip!.reason,
      "Imported from Reindeer Wishes — the owner marked this item Important.",
      "the audit trail must say why the flag was set",
    );
    assert.equal(importFlip!.isRevert, false, "the import row is a normal set, not a revert");
  });

  /* v15 commit 5: the same import also creates an owner-source appraisal_flags
   * row so the trustee's queue, the RoD escalation section, and the captain
   * review screen see the owner's Important mark as a real flag. Up to now the
   * items.needsAppraisal bit was flipped but no appraisal_flags row existed,
   * so those surfaces could not attribute the flag to the owner. */
  await check("the skillet has an appraisal_flags row with source='owner' so the trustee queue sees it", () => {
    const s = db.select().from(items).where(eq(items.originItemId, skillet.item_id)).get();
    const flags = db.select().from(appraisalFlags).where(eq(appraisalFlags.itemId, s!.id)).all();
    const ownerFlags = flags.filter((f) => f.flaggedBySource === "owner" && f.revertedAt == null);
    assert.equal(ownerFlags.length, 1, "expected exactly one active owner-source appraisal_flags row");
  });

  await check("the owner-source appraisal_flags row carries null participantId (the owner is not a participant)", () => {
    const s = db.select().from(items).where(eq(items.originItemId, skillet.item_id)).get();
    const flags = db.select().from(appraisalFlags).where(eq(appraisalFlags.itemId, s!.id)).all();
    const ownerFlag = flags.find((f) => f.flaggedBySource === "owner");
    assert.equal(ownerFlag!.flaggedByParticipantId, null, "owner-source rows must not be attributed to an heir");
  });

  await check("the owner-source appraisal_flags row's reason quotes the owner's comment verbatim", () => {
    const s = db.select().from(items).where(eq(items.originItemId, skillet.item_id)).get();
    const flags = db.select().from(appraisalFlags).where(eq(appraisalFlags.itemId, s!.id)).all();
    const ownerFlag = flags.find((f) => f.flaggedBySource === "owner");
    assert.equal(
      ownerFlag!.reason,
      'The owner marked this Important in Registry — "Grandma made a hundred meals in this. Keep it in the family."',
      "the flag's reason must show the owner's own words to the trustee and the captain",
    );
  });

  await check("the captain cannot unflag an owner-source appraisal_flags row (permanent per project rule)", async () => {
    const s = db.select().from(items).where(eq(items.originItemId, skillet.item_id)).get();
    const flags = db.select().from(appraisalFlags).where(eq(appraisalFlags.itemId, s!.id)).all();
    const ownerFlag = flags.find((f) => f.flaggedBySource === "owner");
    const attempted = await storage.unflagAppraisal({ nominationId: ownerFlag!.id, captainId: 999 });
    assert.equal(attempted, undefined, "unflagAppraisal must return undefined for owner-source rows");
    const stillActive = db.select().from(appraisalFlags).where(eq(appraisalFlags.id, ownerFlag!.id)).get();
    assert.equal(stillActive!.revertedAt, null, "owner-source rows stay active even after a revert attempt");
  });

  /* ------------------------------------------------------------------ */
  /* 4. Re-import: supersede, don't duplicate                             */
  /* ------------------------------------------------------------------ */
  console.log("\n4. Re-importing the same bundle");

  const staged2 = await stageBundle(buffer, { fileName: "handoff-again.reindeer", actorId: null });

  await check("re-import creates a fresh batch and fresh staged rows", () => {
    assert.notEqual(staged2.batch.id, staged1.batch.id);
    assert.equal(staged2.stagedItems.length, 3);
  });

  await check("re-import marks staged rows as 'updates_existing', not 'new'", () => {
    assert.ok(staged2.stagedItems.every((s) => s.arrivalKind === "updates_existing"));
  });

  await check("re-import does NOT create a second copy of the earlier staged rows (superseded, not duplicated)", () => {
    // The original batch's staged rows, if still 'draft', would have been
    // superseded. All three from batch 1 were already approved, so this also
    // confirms superseding only touches rows still in 'draft' state.
    const batch1Rows = db.select().from(stagedItems).where(eq(stagedItems.importBatchRowId, staged1.batch.id)).all();
    assert.ok(batch1Rows.every((r) => r.state === "approved"));
  });

  const totalItemsBeforeSecondApproval = db.select().from(items).all().length;
  const secondBatchApproval = await approveBatch(staged2.batch.id, null);

  await check("re-import approval UPDATES existing items instead of duplicating", () => {
    const totalAfter = db.select().from(items).all().length;
    assert.equal(totalAfter, totalItemsBeforeSecondApproval);
    assert.ok(secondBatchApproval.results.every((r) => r.ok && (r as any).wasUpdate === true));
  });

  await check("re-import does not duplicate media on the same item", () => {
    const media = db.select().from(itemMedia).where(eq(itemMedia.itemId, approved1.item.id)).all();
    const byKind: Record<string, number> = {};
    for (const m of media) byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
    assert.equal(byKind.photo, 1);
    assert.equal(byKind.audio, 1);
    assert.equal(byKind.video, 1);
  });

  /* v15 commit 5: re-importing the same owner-Important item must NOT create
   * a second appraisal_flags row. flagForAppraisal is idempotent for the
   * active row, so a passive re-sync passes through cleanly. */
  await check("re-import does not create a second owner-source appraisal_flags row for the same item", () => {
    const s = db.select().from(items).where(eq(items.originItemId, skillet.item_id)).get();
    const flags = db.select().from(appraisalFlags).where(eq(appraisalFlags.itemId, s!.id)).all();
    const ownerFlags = flags.filter((f) => f.flaggedBySource === "owner");
    assert.equal(ownerFlags.length, 1, "one owner-source row before and after re-import — no duplicates");
  });

  /* ------------------------------------------------------------------ */
  /* 5. Round lock                                                        */
  /* ------------------------------------------------------------------ */
  console.log("\n5. Round lock behavior");

  await storage.updateSession({ phase: "draft" });

  const staged3 = await stageBundle(buffer, { fileName: "handoff-during-round.reindeer", actorId: null });

  await check("staging still SUCCEEDS while a round is locked", () => {
    assert.equal(staged3.stagedItems.length, 3);
    assert.equal(staged3.arrivedDuringLockedRound, true);
  });

  await check("the batch row records arrivedDuringLockedRound", () => {
    const row = db.select().from(importBatches).where(eq(importBatches.id, staged3.batch.id)).get();
    assert.equal(row!.arrivedDuringLockedRound, true);
  });

  await check("approveStaged REFUSES with a plain-language message during a locked round", async () => {
    const oneDraft = staged3.stagedItems[0];
    await assert.rejects(
      () => approveStaged(oneDraft.id, null),
      (e: any) => /round/i.test(e.message) && /finish/i.test(e.message),
    );
  });

  await check("approveBatch also REFUSES during a locked round", async () => {
    await assert.rejects(() => approveBatch(staged3.batch.id, null), (e: any) => /round/i.test(e.message));
  });

  await check("nothing from the locked-round batch was applied", () => {
    const rows = db.select().from(stagedItems).where(eq(stagedItems.importBatchRowId, staged3.batch.id)).all();
    assert.ok(rows.every((r) => r.state === "draft"));
  });

  await storage.updateSession({ phase: "intake" });

  await check("after the round unlocks, approval succeeds normally", async () => {
    const oneDraft = staged3.stagedItems[0];
    const result = await approveStaged(oneDraft.id, null);
    assert.ok(result.item.id);
  });

  /* ------------------------------------------------------------------ */
  /* 6. Rejection + discard + who/when                                    */
  /* ------------------------------------------------------------------ */
  console.log("\n6. Rejection, discard, and audit trail");

  await check("rejectStaged marks a row rejected with actor and time recorded", async () => {
    const remaining = (await listStaged(session.id, { state: "draft" }))[0];
    assert.ok(remaining, "expected at least one draft left to reject");
    const rejected = await rejectStaged(remaining.id, null, "Not part of this estate.");
    assert.equal(rejected.state, "rejected");
    assert.ok(rejected.reviewedAt);
    assert.equal(rejected.reviewNote, "Not part of this estate.");
  });

  await check("every staged row records who imported it and when", () => {
    const anyStaged = db.select().from(stagedItems).all()[0];
    assert.ok(anyStaged.createdAt > 0);
    const batch = db.select().from(importBatches).where(eq(importBatches.id, anyStaged.importBatchRowId)).get();
    assert.ok(batch!.importedAt > 0);
  });

  const staged4 = await stageBundle(buffer, { fileName: "handoff-to-discard.reindeer", actorId: null });
  const discarded = await discardBatch(staged4.batch.id, null);

  await check("discardBatch marks the batch discarded and rejects its drafts", () => {
    assert.equal(discarded.state, "discarded");
    const rows = db.select().from(stagedItems).where(eq(stagedItems.importBatchRowId, staged4.batch.id)).all();
    assert.ok(rows.every((r) => r.state === "rejected"));
  });

  /* ------------------------------------------------------------------ */
  /* 7. Listing helpers                                                    */
  /* ------------------------------------------------------------------ */
  console.log("\n7. Listing helpers");

  await check("listBatches returns every batch for the session, newest first", async () => {
    const all = await listBatches(session.id);
    assert.ok(all.length >= 4);
    assert.ok(all[0].importedAt >= all[all.length - 1].importedAt);
  });

  await check("getBatch returns the batch with its staged items and media", async () => {
    const detail = await getBatch(staged1.batch.id);
    assert.ok(detail);
    assert.equal(detail!.batch.id, staged1.batch.id);
    assert.equal(detail!.items.length, 3);
    assert.ok(detail!.media.length > 0);
  });

  await check("checksum failures are surfaced, never silently dropped", () => {
    // Tamper with a copy of the bundle's checksums file to prove a mismatch is reported.
    const tampered = Buffer.from(buffer);
    // Flip a byte well inside the zip's file data region (not the header) —
    // any resulting checksum mismatch or read problem must be captured.
    const idx = Math.floor(tampered.length / 2);
    tampered[idx] = tampered[idx] ^ 0xff;
    let problemsSeen: string[] = [];
    try {
      const r = readBundle(tampered);
      problemsSeen = r.problems;
    } catch {
      // A sufficiently mangled zip may fail to parse outright — acceptable,
      // since stageBundle() converts that into a reported/thrown problem too.
      problemsSeen = ["(bundle failed to parse)"];
    }
    assert.ok(problemsSeen.length > 0, "expected the tampered bundle to report at least one problem");
  });

  /* ------------------------------------------------------------------ */
  /* 6. Owner-assignment detection review                                */
  /* ------------------------------------------------------------------ */
  //
  // The full detector is unit-tested in
  // detectOwnerAssignment.selftest.mts. Here we drive the *pipeline* it
  // feeds into: pending-review gate, confirm → owner_assigned, dismiss →
  // available, and the batch-approval gate.
  //
  // Rather than build a whole second inventory and bundle just to seed a
  // detection candidate, we insert a synthetic staged_items row that
  // looks like one that would have been produced by stageBundle with a
  // comment carrying "For Sarah" and no structured hint. The behavior we
  // care about at this layer is the post-detection review pipeline.

  console.log("\n6. Owner-assignment detection review pipeline");

  const { participants: fcParticipants } = await import("@shared/schema");
  const sessionRow = await storage.getSession();

  // We need a participant named Sarah for the participant-id resolver to
  // find a match. The seeded roster doesn't have her by default in this
  // test's session, so add her. Only the columns declared on the
  // `participants` table are set; everything else defaults.
  const sarah = db
    .insert(fcParticipants)
    .values({
      sessionId: sessionRow.id,
      name: "Sarah",
    })
    .returning()
    .get();

  // Fresh import batch to hang the synthetic staged rows off. Column names
  // and defaults come straight from shared/schema.ts — only what the table
  // actually declares is set.
  const detectionBatch = db
    .insert(importBatches)
    .values({
      sessionId: sessionRow.id,
      batchId: `selftest-detection-${crypto.randomUUID()}`,
      bundleSha256: crypto.randomBytes(32).toString("hex"),
      sourceApp: "legacy_registry",
      ownerName: "Test Owner",
      itemCount: 3,
      state: "staged",
      importedAt: Date.now(),
      arrivedDuringLockedRound: false,
      importedByParticipantId: null,
      fileName: "detection.reindeer",
    })
    .returning()
    .get();

  // Helper: insert one synthetic staged row with detector output already
  // populated. We do NOT run the detector here; that is covered by its
  // own self-test. This exercises the pipeline the detector feeds into.
  const makeStagedDetectionRow = (opts: {
    name: string;
    comment: string;
    quote: string;
    detectedName: string;
    review: "pending" | "confirmed" | "dismissed" | "";
    hint?: string;
  }) => {
    return db
      .insert(stagedItems)
      .values({
        sessionId: sessionRow.id,
        importBatchRowId: detectionBatch.id,
        batchId: detectionBatch.batchId,
        originItemId: `origin-${opts.name}-${crypto.randomUUID()}`,
        name: opts.name,
        room: "Study",
        category: null,
        notes: "",
        inventoryStory: "",
        ownerImportantComment: opts.comment,
        quantity: 1,
        conditionNote: "",
        identifiers: "{}",
        estimatedValue: null,
        valueSource: null,
        needsAppraisal: false,
        isSentimental: false,
        recipientHint: opts.hint ?? "",
        recipientHintNote: "",
        detectedOwnerAssignmentName: opts.detectedName,
        detectedOwnerAssignmentQuote: opts.quote,
        detectedOwnerAssignmentConfidence: opts.detectedName ? "both" : "",
        detectedOwnerAssignmentReview: opts.review,
        detectedOwnerAssignmentReviewReason: "",
        photoCount: 0,
        videoCount: 0,
        audioCount: 0,
        state: "draft",
        appliedItemId: null,
        supersedesStagedId: null,
        arrivalKind: "new",
        possibleDuplicateOf: null,
        mappingNotes: "[]",
        reviewNote: "",
        createdAt: Date.now(),
        reviewedAt: null,
        reviewedByParticipantId: null,
      })
      .returning()
      .get();
  };

  const rowPending = makeStagedDetectionRow({
    name: "Grandmother's brooch",
    comment: "For Sarah. She admired it every visit.",
    quote: "For Sarah.",
    detectedName: "Sarah",
    review: "pending",
  });

  const rowDismissTarget = makeStagedDetectionRow({
    name: "Rolling pin",
    comment: "Grandma made a hundred meals with this. Keep it for the family.",
    quote: "Grandma made a hundred meals with this.",
    // Detector wouldn't fire on this in practice; here we simulate a
    // detection that the PR is going to dismiss.
    detectedName: "Grandma",
    review: "pending",
  });

  const rowClean = makeStagedDetectionRow({
    name: "Kettlebells",
    comment: "",
    quote: "",
    detectedName: "",
    review: "",
  });

  await check(
    "approveStaged refuses a row whose detection is still pending",
    async () => {
      let threw: Error | null = null;
      try {
        await approveStaged(rowPending.id, null);
      } catch (e: any) {
        threw = e;
      }
      assert.ok(threw, "expected approveStaged to throw for pending review");
      assert.match(threw!.message, /confirm or dismiss/i);
    },
  );

  await check(
    "approveBatch refuses the whole batch while any row is pending",
    async () => {
      let threw: Error | null = null;
      try {
        await approveBatch(detectionBatch.id, null);
      } catch (e: any) {
        threw = e;
      }
      assert.ok(threw, "expected approveBatch to throw");
      assert.match(threw!.message, /owner-assignment review/i);
    },
  );

  const confirmed = await confirmDetectedAssignment(rowPending.id, null, {});

  await check("confirmDetectedAssignment moves review to 'confirmed'", () => {
    assert.equal(confirmed.detectedOwnerAssignmentReview, "confirmed");
    assert.equal(confirmed.detectedOwnerAssignmentName, "Sarah");
  });

  const approvedConfirmed = await approveStaged(rowPending.id, null);

  await check(
    "approve after confirm: item lands as owner_assigned with source='comment_detected'",
    () => {
      assert.equal(approvedConfirmed.item.status, "owner_assigned");
      assert.equal(approvedConfirmed.item.ownerAssignedName, "Sarah");
      assert.equal(approvedConfirmed.item.ownerAssignedSource, "comment_detected");
      assert.match(approvedConfirmed.item.ownerAssignedEvidence, /For Sarah/);
      assert.equal(approvedConfirmed.item.ownerAssignedParticipantId, sarah.id);
    },
  );

  const dismissed = await dismissDetectedAssignment(rowDismissTarget.id, null, {
    reason: "Name-drop only; not really meant for anyone specific.",
  });

  await check("dismissDetectedAssignment moves review to 'dismissed' with reason recorded", () => {
    assert.equal(dismissed.detectedOwnerAssignmentReview, "dismissed");
    assert.match(dismissed.detectedOwnerAssignmentReviewReason, /name-drop/i);
  });

  const approvedDismissed = await approveStaged(rowDismissTarget.id, null);

  await check(
    "approve after dismiss: item lands as available (goes into the ranked pool)",
    () => {
      assert.equal(approvedDismissed.item.status, "available");
      assert.equal(approvedDismissed.item.ownerAssignedName, "");
      assert.equal(approvedDismissed.item.ownerAssignedSource, "");
    },
  );

  const approvedClean = await approveStaged(rowClean.id, null);

  await check(
    "item with no detection at all still approves normally as available",
    () => {
      assert.equal(approvedClean.item.status, "available");
    },
  );

  /* ------------------------------------------------------------------ */
  /* 5. Memorandum-locked items (commit 4)                                */
  /* ------------------------------------------------------------------ */
  //
  // A frozen memorandum travelling with the export bundle marks specific
  // inventory items as \u201chandled as a special gift under the will.\u201d
  // Downstream Fair Choice must:
  //   (a) stage them with lockedByMemorandum = true;
  //   (b) on approval, land them as status='owner_assigned', source='memorandum',
  //       ownerAssignedName='' (recipient identity stays out of FC);
  //   (c) preserve the deceased owner's name for grouping in the UI.
  console.log("\n5. Memorandum-locked items travel greyed into Fair Choice");

  // Build a small memorandum-enabled bundle. We pass mock addendumVersions
  // and people stubs to writeBundle so we don't need to spin up the full
  // Registry stack for this test.
  const memItemId = boatMotor.item_id; // one of the fixture items
  // Commit 4 added two optional params to writeBundle (`addendumVersions`
  // and `people`). The JS package has no .d.ts, so TypeScript infers the
  // parameter type from the source and doesn’t widen it for these two
  // params. Casting the args object to `any` here keeps the test
  // faithful to the real runtime signature without changing production
  // code paths.
  const memBundle = await (writeBundle as any)({
    itemRepo: invItemRepo,
    mediaStore: invMediaStore,
    scopeMediaStore: invScopeMediaStore,
    registry: invRegistry,
    ctx: invCtx,
    query: { review_state: "kept" },
    source: { app: "legacy-registry", app_version: "0.1.0", inventory_id: "inv-selftest", owner_name: "Test Owner" },
    addendumVersions: {
      listFrozen: () => [
        {
          version_id: "mem-1",
          owner_participant_id: "p-mary",
          version_number: 3,
          signed_at: "2026-08-01T00:00:00Z",
          frozen_at: "2026-08-05T00:00:00Z",
          items_snapshot: [{ id: memItemId, name: "Outboard motor" }],
        },
      ],
    },
    people: {
      get: (id: string) => (id === "p-mary" ? { name: "Mary" } : null),
    },
  });

  await check("the memorandum-enabled envelope carries locked_memoranda + is_locked_gift", () => {
    const env: any = memBundle.envelope;
    assert.equal(env.locked_memoranda?.length, 1);
    assert.equal(env.locked_memoranda[0].owner_name, "Mary");
    assert.deepEqual(env.locked_memoranda[0].item_ids, [memItemId]);
    const locked = env.items.find((it: any) => it.item_id === memItemId);
    assert.equal(locked.is_locked_gift, true);
    const notLocked = env.items.find((it: any) => it.item_id !== memItemId);
    assert.equal(notLocked.is_locked_gift, false);
    assert.equal(env.counts.locked_by_memorandum, 1);
    assert.equal(env.counts.locked_memoranda, 1);
  });

  // Stage the memorandum-enabled bundle into a fresh session so nothing
  // interferes with the previous section's items.
  await storage.resetSession();
  const staged5 = await stageBundle(memBundle.buffer, {
    fileName: "memorandum-locked.reindeer",
    actorId: null,
  });

  const stagedLocked = staged5.stagedItems.find((s) => s.originItemId === memItemId)!;
  const stagedNotLocked = staged5.stagedItems.find((s) => s.originItemId !== memItemId)!;

  await check("stageBundle flags the memorandum item and carries the owner name", () => {
    assert.equal(stagedLocked.lockedByMemorandum, true);
    assert.equal(stagedLocked.memorandumOwnerName, "Mary");
    assert.equal(stagedNotLocked.lockedByMemorandum, false);
    assert.equal(stagedNotLocked.memorandumOwnerName, "");
  });

  const approvedLocked = await approveStaged(stagedLocked.id, null);

  await check(
    "approve of a memorandum-locked staged item lands as owner_assigned with source='memorandum'",
    () => {
      assert.equal(approvedLocked.item.status, "owner_assigned");
      assert.equal(approvedLocked.item.ownerAssignedSource, "memorandum");
      // Critical privacy check: no recipient name written to FC.
      assert.equal(approvedLocked.item.ownerAssignedName, "");
      assert.equal(approvedLocked.item.ownerAssignedParticipantId, null);
      // The deceased owner\u2019s name IS present, for grouping only.
      assert.equal(approvedLocked.item.memorandumOwnerName, "Mary");
      assert.equal(approvedLocked.item.lockedByMemorandum, true);
      // Evidence carries the neutral phrase, never a recipient.
      assert.match(approvedLocked.item.ownerAssignedEvidence, /special gift under the will/i);
    },
  );

  const approvedNotLocked = await approveStaged(stagedNotLocked.id, null);

  await check(
    "a non-memorandum item in the same batch still approves normally",
    () => {
      // Items in this fixture with no recipient hint and no detection go
      // into the pool as available.
      assert.notEqual(approvedNotLocked.item.ownerAssignedSource, "memorandum");
      assert.equal(approvedNotLocked.item.lockedByMemorandum, false);
      assert.equal(approvedNotLocked.item.memorandumOwnerName, "");
    },
  );

  console.log(`\n${pass} checks passed.\n`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
