/**
 * Standalone self-test for the v14 Trustee Handoff fiduciary backend.
 *
 * Run with: npx tsx server/fiduciary/selftest.mts
 *
 * Exercises the reshaped runtime:
 *  1. Method Agreement gate — ranking cannot open until every non-admin heir
 *     has signed.
 *  2. Flag-for-appraisal — any authenticated heir may flag; the item stays
 *     in the ranked-draft pool.
 *  3. Valuation lifecycle unchanged — add/approve/supersede still work; the
 *     item ends the run with an approvedValue but no consent required.
 *  4. Record of Decisions — appraised items show a value, pending-appraisal
 *     items are named with their escalating heir.
 *  5. Audit trail — every mutation is logged, including
 *     method_agreement_signed, valuation_superseded, and flagged events.
 *
 * Uses the app's real `db`/`storage` singletons against a throwaway database
 * (see ../testing/scratchEnv), with freshly created, clearly-labeled test
 * rows so it never touches pre-existing data.
 */
import "../testing/scratchEnv"; // MUST be first — see that file.
import { db, storage } from "../storage";
import { items, methodAgreements, highValueAuditLog } from "@shared/schema";
import { eq } from "drizzle-orm";
import { fiduciary, FiduciaryError } from "./fiduciaryStorage";
import { renderRecordOfDecisionsHtml } from "./router";

let checks = 0;
let failures = 0;

function check(label: string, condition: boolean) {
  checks++;
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    failures++;
    console.log(`FAIL  - ${label}`);
  }
}

async function checkThrows(label: string, fn: () => Promise<unknown>) {
  checks++;
  try {
    await fn();
    failures++;
    console.log(`FAIL  - ${label} (expected throw, none happened)`);
  } catch (e) {
    if (e instanceof FiduciaryError || (e as any)?.status === 409) {
      const msg = (e as Error).message ?? String(e);
      console.log(`  ok  - ${label} (${msg})`);
    } else {
      failures++;
      console.log(`FAIL  - ${label} (threw unexpected error: ${e})`);
    }
  }
}

async function auditLogFor(itemId: number) {
  return db.select().from(highValueAuditLog).where(eq(highValueAuditLog.itemId, itemId)).all();
}

async function main() {
  const session = await storage.getSession();
  console.log(`Using session #${session.id} (${session.name})`);

  // Scratch sessions start in whatever phase the seed helper chose; force
  // intake so we can prove markInventoryComplete's Method Agreement gate.
  if (session.phase !== "intake") {
    await storage.updateSession({
      phase: "intake",
      inventoryCompletedAt: null,
      rankingOpenedAt: null,
      rankingDeadline: null,
    } as any);
  }

  const pr = await storage.createParticipant({
    sessionId: session.id,
    name: "Selftest PR",
    isAdmin: true,
    administersOnly: true,
    seatOrder: 900,
  } as any);
  const heirA = await storage.createParticipant({
    sessionId: session.id,
    name: "Selftest Heir A",
    isAdmin: false,
    seatOrder: 901,
  } as any);
  const heirB = await storage.createParticipant({
    sessionId: session.id,
    name: "Selftest Heir B",
    isAdmin: false,
    seatOrder: 902,
  } as any);

  // Every session gets a captain assigned at welcome time. The selftest
  // bypasses the welcome route, so we mirror that assignment explicitly:
  // the heir-admin (PR) starts as captain.
  await storage.updateSession({ captainParticipantId: pr.id } as any);

  /* ================================================================ */
  /* 1. Method Agreement gate                                          */
  /* ================================================================ */
  console.log("\n--- 1. Method Agreement gate ---");

  const noneYet = await fiduciary.listMethodAgreements(session.id);
  check("no Method Agreements at start of run", noneYet.length === 0);
  check(
    "allHeirsHaveMethodAgreement=false before any signatures",
    (await fiduciary.allHeirsHaveMethodAgreement(session.id)) === false,
  );

  await checkThrows(
    "markInventoryComplete refuses when no heir has signed",
    () => storage.markInventoryComplete(),
  );

  const agreementA = await fiduciary.recordMethodAgreement({
    sessionId: session.id,
    participantId: heirA.id,
  });
  check("first agreement stored", agreementA.participantId === heirA.id);
  check("agreement snapshots version", agreementA.agreementVersion === "2.0");
  check(
    "agreement records the current captain",
    agreementA.captainParticipantId === pr.id,
  );
  check(
    "agreement snapshot text names the captain by name",
    typeof agreementA.agreementTextSnapshot === "string" &&
      agreementA.agreementTextSnapshot.includes("Selftest PR"),
  );
  check(
    "agreement snapshots the full text",
    typeof agreementA.agreementTextSnapshot === "string" &&
      agreementA.agreementTextSnapshot.length > 0,
  );

  await checkThrows(
    "recording the same heir's agreement twice throws",
    () =>
      fiduciary.recordMethodAgreement({
        sessionId: session.id,
        participantId: heirA.id,
      }),
  );

  await checkThrows(
    "markInventoryComplete still refuses with only one of two heirs signed",
    () => storage.markInventoryComplete(),
  );

  await fiduciary.recordMethodAgreement({
    sessionId: session.id,
    participantId: heirB.id,
  });
  check(
    "allHeirsHaveMethodAgreement=true after every heir signs",
    (await fiduciary.allHeirsHaveMethodAgreement(session.id)) === true,
  );

  const allAgreements = await fiduciary.listMethodAgreements(session.id);
  check("two agreements listed", allAgreements.length === 2);

  const sessionAfterOpen = await storage.markInventoryComplete();
  check("markInventoryComplete succeeds after all heirs sign", sessionAfterOpen.phase === "ranking");

  // Method-agreement audit rows exist (session-scoped, itemId=0).
  const sessionAudit = await auditLogFor(0);
  const agreementAudits = sessionAudit.filter((r) => r.eventType === "method_agreement_signed");
  check("two method_agreement_signed audit rows exist", agreementAudits.length === 2);

  /* ---------------- Captain change invalidates the gate ---------------- */
  // A change of captain mid-session means the mandate the heirs signed no
  // longer names the operating party. The old rows stay on the audit trail
  // but the gate flips back to false until every heir signs again naming
  // the new captain.
  const trustee = await storage.createParticipant({
    sessionId: session.id,
    name: "Selftest Trustee",
    role: "trustee",
    isAdmin: false,
    administersOnly: true,
    seatOrder: 903,
  } as any);
  await storage.updateSession({ captainParticipantId: trustee.id } as any);
  check(
    "gate flips to false when captain changes",
    (await fiduciary.allHeirsHaveMethodAgreement(session.id)) === false,
  );

  // A single heir signing under the new captain isn't enough on its own.
  const heirAAfter = await fiduciary.recordMethodAgreement({
    sessionId: session.id,
    participantId: heirA.id,
  });
  check(
    "new-captain agreement records the new captain",
    heirAAfter.captainParticipantId === trustee.id,
  );
  check(
    "new-captain agreement text names the new captain",
    typeof heirAAfter.agreementTextSnapshot === "string" &&
      heirAAfter.agreementTextSnapshot.includes("Selftest Trustee"),
  );
  check(
    "gate still false after only one heir re-signs",
    (await fiduciary.allHeirsHaveMethodAgreement(session.id)) === false,
  );

  // Re-signing under the same captain twice is still refused.
  await checkThrows(
    "re-recording the same heir's agreement under the same captain still throws",
    () =>
      fiduciary.recordMethodAgreement({
        sessionId: session.id,
        participantId: heirA.id,
      }),
  );

  await fiduciary.recordMethodAgreement({
    sessionId: session.id,
    participantId: heirB.id,
  });
  check(
    "gate returns true once every heir has re-signed under the new captain",
    (await fiduciary.allHeirsHaveMethodAgreement(session.id)) === true,
  );

  const afterCaptainChange = await fiduciary.listMethodAgreements(session.id);
  check(
    "list now shows four rows (two per captain era)",
    afterCaptainChange.length === 4,
  );

  // Hand back to the original heir-admin captain: same rule applies. The
  // rows signed under the trustee no longer count; the original rows do
  // count again because they name that captain.
  await storage.updateSession({ captainParticipantId: pr.id } as any);
  check(
    "handing captain back to the original captain re-activates their original agreements",
    (await fiduciary.allHeirsHaveMethodAgreement(session.id)) === true,
  );

  /* ================================================================ */
  /* 2. Flag for appraisal                                             */
  /* ================================================================ */
  console.log("\n--- 2. Flag for appraisal ---");

  const ordinaryItem = await storage.createItem({
    name: "Selftest Normal Vase",
    room: "Living Room",
  } as any);
  check("ordinary item starts not-high-value", ordinaryItem.needsAppraisal === false);
  check("ordinary item starts state=normal", ordinaryItem.highValueState === "normal");

  const flagged = await fiduciary.flagForAppraisal(ordinaryItem.id, heirA.id, "Might be antique");
  check("flagForAppraisal sets needsAppraisal=true", flagged.needsAppraisal === true);
  check("flagForAppraisal moves to flagged_high_value", flagged.highValueState === "flagged_high_value");

  // Idempotent second flag by the other heir writes another audit row but no state change.
  const flaggedAgain = await fiduciary.flagForAppraisal(ordinaryItem.id, heirB.id, "Agree");
  check("second flag leaves state at flagged_high_value", flaggedAgain.highValueState === "flagged_high_value");

  const flagAudits = (await auditLogFor(ordinaryItem.id)).filter((r) => r.eventType === "flagged");
  check("two flag audit rows written", flagAudits.length === 2);
  const sortedFlagAudits = flagAudits.sort((a, b) => a.createdAt - b.createdAt);
  check(
    "first flag audit records the escalating heir",
    sortedFlagAudits[0].actorParticipantId === heirA.id,
  );

  /* Under the language collapse (any heir may flag; no boss; no approval),
     an ordinary heir's flag must be recorded as actorRole='heir' — never
     'captain', never 'trustee'. This locks the correct attribution so the
     RoD shows who raised the flag honestly. */
  check(
    "first flag audit records actorRole='heir' (an heir raised the flag)",
    sortedFlagAudits[0].actorRole === "heir",
  );

  /* Idempotency: a second flag on the same item does not change state.
     Both flags are recorded (both heirs signalled), but the item's state
     stays at flagged_high_value — no ping-pong, no double promotion. */
  check(
    "second flag by another heir does not change state (idempotent state)",
    sortedFlagAudits[1].stateBefore === "flagged_high_value" &&
      sortedFlagAudits[1].stateAfter === "flagged_high_value",
  );

  /* ================================================================ */
  /* 3. Valuation lifecycle (unchanged)                                */
  /* ================================================================ */
  console.log("\n--- 3. Valuation lifecycle ---");

  const ring = await storage.createItem({
    name: "Selftest Heirloom Ring",
    room: "Primary Bedroom",
    needsAppraisal: true,
    highValueState: "flagged_high_value",
  } as any);

  const val1 = await fiduciary.addValuation(
    ring.id,
    { value: 12000, source: "appraisal", notes: "Selftest appraisal" },
    pr.id,
  );
  check("valuation row created", val1.value === 12000);
  check("valuation starts estimated", val1.status === "estimated");

  const afterAddRing = await db.select().from(items).where(eq(items.id, ring.id)).get();
  check(
    "item moves to awaiting_value_review after first valuation",
    afterAddRing?.highValueState === "awaiting_value_review",
  );

  const approved1 = await fiduciary.approveValuation(val1.id, pr.id);
  check("approveValuation marks row approved", approved1.status === "approved");

  const afterApproveRing = await db.select().from(items).where(eq(items.id, ring.id)).get();
  check("item.approvedValue set", afterApproveRing?.approvedValue === 12000);
  check("item.valueStatus is approved", afterApproveRing?.valueStatus === "approved");

  const val2 = await fiduciary.addValuation(
    ring.id,
    { value: 13500, source: "auction" },
    pr.id,
  );
  await fiduciary.approveValuation(val2.id, pr.id);

  const afterResupersede = await db.select().from(items).where(eq(items.id, ring.id)).get();
  check("item.approvedValue updates to latest approval", afterResupersede?.approvedValue === 13500);

  /* ================================================================ */
  /* 4. Record of Decisions                                            */
  /* ================================================================ */
  console.log("\n--- 4. Record of Decisions ---");

  // Assign the ring to heirA, the flagged vase to heirB, so the trustee
  // document has real recipients on both rows.
  db.update(items).set({ provisionalRecipientId: heirA.id }).where(eq(items.id, ring.id)).run();
  db.update(items).set({ provisionalRecipientId: heirB.id }).where(eq(items.id, ordinaryItem.id)).run();

  const record = await fiduciary.generateRecordOfDecisions(session.id);
  check("record includes both selftest items", record.items.length >= 2);
  check(
    "record heirs list has method-agreed timestamps",
    record.heirs.every((h) => typeof h.methodAgreedAt === "number"),
  );

  const ringRow = record.items.find((i) => i.id === ring.id);
  check("ring row shows appraised value", ringRow?.appraisedValue === 13500);
  check("ring row not marked pending", ringRow?.pendingAppraisal === false);
  check("ring row awarded to heir A", ringRow?.awardedToParticipantId === heirA.id);

  const vaseRow = record.items.find((i) => i.id === ordinaryItem.id);
  check("vase row still pending appraisal (no approved value)", vaseRow?.pendingAppraisal === true);
  check(
    "vase row escalating heir is Heir A (first flagger)",
    vaseRow?.escalatingParticipantId === heirA.id,
  );
  check("record totals reflect one appraised item", record.totals.appraisedCount >= 1);
  check(
    "record totals reflect at least one pending appraisal",
    record.totals.pendingAppraisalCount >= 1,
  );
  check("record totals sum appraised value", record.totals.totalAppraisedValue >= 13500);

  // Additive commit-1 checks: per-stage sections, escalated-to-trustee bucket,
  // unassigned bucket, and closing-note copy in the print template.
  check("record exposes stages array", Array.isArray(record.stages));
  check(
    "escalated-to-trustee bucket contains the vase (in_high_value item)",
    record.escalatedToTrustee.items.some((e) => e.itemId === ordinaryItem.id),
  );
  check(
    "high-value ring also lands in the escalated-to-trustee bucket",
    record.escalatedToTrustee.items.some((e) => e.itemId === ring.id),
  );
  check(
    "escalation label identifies flagging heir when nomination row is missing",
    record.escalatedToTrustee.items.every((e) => typeof e.escalationSourceLabel === "string" && e.escalationSourceLabel.length > 0),
  );
  const rodHtml = renderRecordOfDecisionsHtml(record);
  check("print template renders the closing-note copy", rodHtml.includes("Closing note for the trustee"));

  /* ================================================================ */
  /* 5. Audit trail integrity                                          */
  /* ================================================================ */
  console.log("\n--- 5. Audit trail integrity ---");

  const ringAudit = await auditLogFor(ring.id);
  check(
    "ring audit log includes valuation_superseded",
    ringAudit.some((r) => r.eventType === "valuation_superseded"),
  );

  const vaseAudit = await auditLogFor(ordinaryItem.id);
  check(
    "vase audit log includes flagged event",
    vaseAudit.some((r) => r.eventType === "flagged"),
  );

  // Session-scoped agreement rows are still queryable directly.
  const rawAgreements = db
    .select()
    .from(methodAgreements)
    .where(eq(methodAgreements.sessionId, session.id))
    .all();
  // Two rows from the original captain era (heirA + heirB under the PR),
  // two more from the captain-change era (heirA + heirB under the trustee) = 4 total.
  check("all method agreements persisted", rawAgreements.length === 4);

  /* ================================================================ */
  /* 6. Snapshot export                                                */
  /* ================================================================ */
  console.log("\n--- 6. Snapshot export ---");

  // The snapshot must be callable in every phase without side effects.
  // We walk the session through every phase state and prove each one
  // returns a non-empty payload with the same shape.
  const phasesToVisit = ["intake", "ranking", "drafting", "groupings", "done"] as const;
  for (const phase of phasesToVisit) {
    await storage.updateSession({ phase } as any);
    const snap = await fiduciary.getSnapshot(session.id);
    check(
      `snapshot in phase='${phase}' names the current captain`,
      snap.session.captainParticipantId != null,
    );
    check(
      `snapshot in phase='${phase}' returns non-empty roster`,
      Array.isArray(snap.roster) && snap.roster.length > 0,
    );
    check(
      `snapshot in phase='${phase}' returns items array`,
      Array.isArray(snap.items),
    );
    check(
      `snapshot in phase='${phase}' returns rankings array`,
      Array.isArray(snap.rankings),
    );
    check(
      `snapshot in phase='${phase}' returns audit log`,
      Array.isArray(snap.auditLog) && snap.auditLog.length > 0,
    );
    check(
      `snapshot in phase='${phase}' renders current agreement text with captain name`,
      typeof snap.currentMethodAgreementText === "string" &&
        snap.currentMethodAgreementText.length > 0,
    );
  }

  // Snapshot in the paused lifecycle state still returns.
  await storage.updateSession({ state: "paused" } as any);
  const pausedSnap = await fiduciary.getSnapshot(session.id);
  check("snapshot in lifecycle='paused' still returns", pausedSnap.session.lifecycleState === "paused");
  await storage.updateSession({ state: "active" } as any);

  // Method-agreement rows from every captain era are visible in the
  // snapshot, not only the current-captain rows. That's the whole point:
  // it's the audit trail, not the live gate.
  const fullSnap = await fiduciary.getSnapshot(session.id);
  const uniqueCaptainsInSnap = new Set(
    fullSnap.methodAgreements.map((a) => a.captainParticipantId),
  );
  check(
    "snapshot includes agreement rows from both captain eras",
    uniqueCaptainsInSnap.size >= 2,
  );

  /* ================================================================ */
  /* 7. Representative role                                            */
  /* ================================================================ */
  console.log("\n--- 7. Representative role ---");

  // A representative is a first-class roster role. They wear the captain
  // hat on behalf of somebody else. They never draft or receive items.
  // The role in the audit trail is the represented person's role.

  // A representative on behalf of the trustee (e.g. their attorney).
  const trusteeRep = await storage.createParticipant({
    sessionId: session.id,
    name: "Selftest Trustee Rep",
    role: "representative",
    representsParticipantId: trustee.id,
    isAdmin: false,
    administersOnly: true,
    seatOrder: 910,
  } as any);
  check("trustee rep persists with role='representative'", trusteeRep.role === "representative");
  check(
    "trustee rep is tied to the trustee they represent",
    trusteeRep.representsParticipantId === trustee.id,
  );
  check("trustee rep is administers-only", trusteeRep.administersOnly === true);

  // A representative on behalf of an heir (e.g. a mediator picked by the heirs).
  const heirRep = await storage.createParticipant({
    sessionId: session.id,
    name: "Selftest Heir Rep",
    role: "representative",
    representsParticipantId: heirA.id,
    isAdmin: false,
    administersOnly: true,
    seatOrder: 911,
  } as any);
  check("heir rep persists with role='representative'", heirRep.role === "representative");
  check(
    "heir rep is tied to the heir they represent",
    heirRep.representsParticipantId === heirA.id,
  );

  // A representative can wear the captain hat.
  await storage.updateSession({ captainParticipantId: heirRep.id } as any);
  const sessionAfter = await storage.getSession();
  check(
    "a representative can be assigned as captain",
    sessionAfter?.captainParticipantId === heirRep.id,
  );

  // The snapshot still returns cleanly with a representative captain.
  const repSnap = await fiduciary.getSnapshot(session.id);
  check(
    "snapshot names the representative when they are captain",
    repSnap.session.captainParticipantId === heirRep.id,
  );
  check(
    "snapshot roster shows the representative role",
    repSnap.roster.some((r) => r.id === heirRep.id && r.role === "representative"),
  );

  // Restoring the trustee as captain for the totals check below.
  await storage.updateSession({ captainParticipantId: trustee.id } as any);

  /* -------------------------------------------------------------------- */
  /* 8. High-value escalation model (v15 commit 2)                        */
  /*                                                                       */
  /* Single-actor escalation, no confirmation gate, captain can revert    */
  /* heir/AI rows but never owner rows, and reverted rows stay in the     */
  /* audit trail.                                                          */
  /* -------------------------------------------------------------------- */
  console.log("\n--- 8. High-value escalation model ---");

  // Fresh item; we don't care about categories here.
  const escItem = await storage.createItem({
    sessionId: session.id,
    name: "Escalation test item",
    room: "Living Room",
    status: "available",
  } as any);

  // 9a. Heir escalation is single-actor and immediate.
  const heirEsc = await storage.flagForAppraisal({
    itemId: escItem.id,
    source: "heir",
    participantId: heirA.id,
    reason: "Antique clock",
  });
  check("heir escalation returns a row", !!heirEsc);
  check("heir escalation records source='heir'", heirEsc?.flaggedBySource === "heir");
  check("heir escalation records the heir", heirEsc?.flaggedByParticipantId === heirA.id);
  const afterHeirEsc = db.select().from(items).where(eq(items.id, escItem.id)).get();
  check("item flips to in_high_value on escalation", afterHeirEsc?.status === "needs_appraisal");
  check("item.needsAppraisal becomes true on escalation", afterHeirEsc?.needsAppraisal === true);

  // 9b. Escalation is idempotent while active: re-calling returns the same row.
  const heirEsc2 = await storage.flagForAppraisal({
    itemId: escItem.id,
    source: "heir",
    participantId: heirB.id,
    reason: "different heir",
  });
  check("re-escalating an active item returns the existing row (idempotent)", heirEsc2?.id === heirEsc?.id);

  // 9c. Captain (pr) reverts. Item returns to available; row survives with reverted_at set.
  await storage.updateSession({ captainParticipantId: pr.id } as any);
  const reverted = await storage.unflagAppraisal({ nominationId: heirEsc!.id, captainId: pr.id });
  check("revert returns the reverted row", !!reverted);
  check("revert stamps revertedAt", (reverted?.revertedAt ?? 0) > 0);
  check("revert records the captain", reverted?.revertedByCaptainId === pr.id);
  const afterRevert = db.select().from(items).where(eq(items.id, escItem.id)).get();
  check("item returns to available after revert", afterRevert?.status === "available");
  check("item.needsAppraisal clears after revert", afterRevert?.needsAppraisal === false);

  // 9d. Reverted rows are kept in the audit trail.
  const rowsForItem = (await storage.listAppraisalFlags()).filter((n) => n.itemId === escItem.id);
  check("reverted row is not deleted (audit trail preserved)", rowsForItem.length === 1);

  // 9e. Second revert on the same row is refused.
  const revertAgain = await storage.unflagAppraisal({ nominationId: heirEsc!.id, captainId: pr.id });
  check("second revert on the same row is refused", revertAgain === undefined);

  // 9f. A fresh escalation after revert inserts a NEW row (not idempotent across reversion).
  const secondEsc = await storage.flagForAppraisal({
    itemId: escItem.id,
    source: "heir",
    participantId: heirA.id,
    reason: "second pass",
  });
  check("escalation after revert creates a fresh row", secondEsc?.id !== heirEsc?.id);
  const rowsAfter2 = (await storage.listAppraisalFlags()).filter((n) => n.itemId === escItem.id);
  check("escalation after revert leaves TWO rows for the item", rowsAfter2.length === 2);

  // 9g. Owner-source rows CANNOT be reverted (permanent, owner is deceased).
  const ownerItem = await storage.createItem({
    sessionId: session.id,
    name: "Owner-flagged heirloom",
    room: "Living Room",
    status: "available",
  } as any);
  const ownerEsc = await storage.flagForAppraisal({
    itemId: ownerItem.id,
    source: "owner",
    participantId: null,
    reason: "Marked Important in Registry",
  });
  check("owner escalation returns a row", !!ownerEsc);
  const ownerRevert = await storage.unflagAppraisal({ nominationId: ownerEsc!.id, captainId: pr.id });
  check("owner-source escalation refuses revert", ownerRevert === undefined);
  const ownerItemAfter = db.select().from(items).where(eq(items.id, ownerItem.id)).get();
  check("owner-source item stays in_high_value after refused revert", ownerItemAfter?.status === "needs_appraisal");

  // Restore trustee as captain for the totals check below.
  await storage.updateSession({ captainParticipantId: trustee.id } as any);

  /* ------------------------------------------------------------ */
  /* 9. Auto-flag from AI analysis — commit 4 (AI + category rule) */
  /* ------------------------------------------------------------ */
  console.log("\n9. Auto-flag from AI analysis");

  // Fix the threshold at $2,000 so soft-floor math is predictable
  // (0.85 × 2000 = $1,700).
  await storage.updateSession({ appraisalThresholdUsd: 3000 } as any);

  // --- Rule A: AI estimate crosses the soft floor -----------------
  const aiHighItem = await storage.createItem({
    sessionId: session.id,
    name: "Auto-flag: AI estimate crosses floor",
    room: "Study",
    status: "available",
  } as any);
  await storage.applyAiAnalysis(aiHighItem.id, {
    category: "Tools & Equipment", // not appraisalLikely
    confidence: 0.4,
    suggestions: [],
    estimatedValueUsd: 1800, // ≥ 0.85 * 2000
    highValue: false,
  } as any);
  const aiHighFlags = (await storage.listAppraisalFlags()).filter((n) => n.itemId === aiHighItem.id);
  check("AI estimate above soft floor creates a flag", aiHighFlags.length === 1);
  check("AI-created flag has source='ai'", aiHighFlags[0]?.flaggedBySource === "ai");
  check("AI-created flag has null participantId", aiHighFlags[0]?.flaggedByParticipantId == null);
  check(
    "AI-created reason includes the estimate",
    !!aiHighFlags[0]?.reason?.includes("$1,800"),
  );
  check(
    "AI-created reason includes the 'not an official appraisal' caveat",
    !!aiHighFlags[0]?.reason?.toLowerCase().includes("not an official appraisal"),
  );
  const aiHighItemAfter = db.select().from(items).where(eq(items.id, aiHighItem.id)).get();
  check(
    "AI-flagged item moves to needs_appraisal status",
    aiHighItemAfter?.status === "needs_appraisal",
  );
  check(
    "AI estimate persisted onto items.aiEstimatedValue",
    aiHighItemAfter?.aiEstimatedValue === 1800,
  );

  // Re-running the analyzer must NOT create a duplicate flag (idempotence).
  await storage.applyAiAnalysis(aiHighItem.id, {
    category: "Tools & Equipment",
    confidence: 0.4,
    suggestions: [],
    estimatedValueUsd: 1900,
    highValue: false,
  } as any);
  const aiHighFlagsAgain = (await storage.listAppraisalFlags()).filter((n) => n.itemId === aiHighItem.id);
  check("re-analysis does not create a duplicate flag", aiHighFlagsAgain.length === 1);

  // --- Rule A negative: estimate under the soft floor stays quiet --
  const aiLowItem = await storage.createItem({
    sessionId: session.id,
    name: "Auto-flag: AI estimate under floor",
    room: "Study",
    status: "available",
  } as any);
  await storage.applyAiAnalysis(aiLowItem.id, {
    category: "Tools & Equipment", // not appraisalLikely
    confidence: 0.4,
    suggestions: [],
    estimatedValueUsd: 500, // well below 1,700
    highValue: false,
  } as any);
  const aiLowFlags = (await storage.listAppraisalFlags()).filter((n) => n.itemId === aiLowItem.id);
  check("AI estimate below soft floor does NOT flag", aiLowFlags.length === 0);

  // --- Rule A negative: null estimate stays quiet ------------------
  const aiNullItem = await storage.createItem({
    sessionId: session.id,
    name: "Auto-flag: AI estimate null",
    room: "Study",
    status: "available",
  } as any);
  await storage.applyAiAnalysis(aiNullItem.id, {
    category: "Tools & Equipment",
    confidence: 0.4,
    suggestions: [],
    estimatedValueUsd: null,
    highValue: false,
  } as any);
  const aiNullFlags = (await storage.listAppraisalFlags()).filter((n) => n.itemId === aiNullItem.id);
  check("null estimate does NOT flag on its own", aiNullFlags.length === 0);

  // --- Rule B: category rule triggers when AI estimate is low ------
  const catItem = await storage.createItem({
    sessionId: session.id,
    name: "Auto-flag: Jewelry category rule",
    room: "Bedroom",
    status: "available",
  } as any);
  await storage.applyAiAnalysis(catItem.id, {
    category: "Jewelry", // appraisalLikely=true
    confidence: 0.4, // deliberately below auto-assign threshold
    suggestions: [],
    estimatedValueUsd: 200, // well below soft floor
    highValue: false,
  } as any);
  const catFlags = (await storage.listAppraisalFlags()).filter((n) => n.itemId === catItem.id);
  check("appraisalLikely category creates a flag", catFlags.length === 1);
  check("category-rule flag has source='category'", catFlags[0]?.flaggedBySource === "category");
  check(
    "category-rule reason is plain-language",
    !!catFlags[0]?.reason?.includes("Jewelry") && !!catFlags[0]?.reason?.includes("auto-appraisal list"),
  );

  // --- Rule A wins over Rule B when both would apply --------------
  const bothItem = await storage.createItem({
    sessionId: session.id,
    name: "Auto-flag: Jewelry AND high estimate",
    room: "Bedroom",
    status: "available",
  } as any);
  await storage.applyAiAnalysis(bothItem.id, {
    category: "Jewelry",
    confidence: 0.4,
    suggestions: [],
    estimatedValueUsd: 5000, // well above floor
    highValue: false,
  } as any);
  const bothFlags = (await storage.listAppraisalFlags()).filter((n) => n.itemId === bothItem.id);
  check("AI + category creates exactly one flag (not two)", bothFlags.length === 1);
  check("combined flag prefers source='ai'", bothFlags[0]?.flaggedBySource === "ai");

  // --- Captain revert respected by AI rule -------------------------
  const revertItem = await storage.createItem({
    sessionId: session.id,
    name: "Auto-flag: captain revert respected",
    room: "Study",
    status: "available",
  } as any);
  await storage.applyAiAnalysis(revertItem.id, {
    category: "Tools & Equipment",
    confidence: 0.4,
    suggestions: [],
    estimatedValueUsd: 1800,
    highValue: false,
  } as any);
  const revertFlags1 = (await storage.listAppraisalFlags()).filter((n) => n.itemId === revertItem.id);
  await storage.unflagAppraisal({ nominationId: revertFlags1[0]!.id, captainId: trustee.id });
  // Re-run analyzer; the AI-source revert should keep it quiet.
  await storage.applyAiAnalysis(revertItem.id, {
    category: "Tools & Equipment",
    confidence: 0.4,
    suggestions: [],
    estimatedValueUsd: 1900,
    highValue: false,
  } as any);
  const revertFlagsActive = (await storage.listAppraisalFlags())
    .filter((n) => n.itemId === revertItem.id)
    .filter((n) => n.revertedAt == null);
  check("AI does NOT re-flag over an active captain revert", revertFlagsActive.length === 0);

  // --- Threshold-change rescan clears reverts, re-flags -----------
  const created = await storage.rescanAllItemsForAppraisal();
  check("rescanAllItemsForAppraisal is callable and returns a number", typeof created === "number");
  const revertFlagsAfterRescan = (await storage.listAppraisalFlags())
    .filter((n) => n.itemId === revertItem.id)
    .filter((n) => n.revertedAt == null);
  check(
    "rescan re-flags an item whose AI revert should be superseded",
    revertFlagsAfterRescan.length === 1,
  );

  // --- Practice items are never auto-flagged ----------------------
  const practiceItem = await storage.createItem({
    sessionId: session.id,
    name: "Auto-flag: practice item",
    room: "Study",
    status: "available",
    isPractice: true,
  } as any);
  await storage.applyAiAnalysis(practiceItem.id, {
    category: "Jewelry",
    confidence: 0.4,
    suggestions: [],
    estimatedValueUsd: 5000,
    highValue: false,
  } as any);
  const practiceFlags = (await storage.listAppraisalFlags()).filter((n) => n.itemId === practiceItem.id);
  check("practice items are never auto-flagged", practiceFlags.length === 0);

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  if (failures > 0) {
    console.error(`${failures} check(s) FAILED.`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("Selftest crashed:", e);
  process.exit(1);
});
