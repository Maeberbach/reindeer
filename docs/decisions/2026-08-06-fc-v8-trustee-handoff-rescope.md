> **Superseded** — vocabulary in this document may use *PR*, *personal representative*, or *fiduciary* for what the current suite calls **trustee**, and may predate the three configurations and the heir-initiated end-trustee-mode endpoint. See [`docs/SUITE-OVERVIEW.md`](../SUITE-OVERVIEW.md) for the current model. This document is kept as history and is not being rewritten.

# FairPlay v8 — Trustee Handoff Rescope (spec)

**Date:** 2026-08-06
**Baseline:** commit `95c95a4` on top of `eeebf99`. Clean tree.
**Owner vision (all binding):**
1. **Fair, not Equal.** No dollar equalization inside FairPlay.
2. **Trustee handles the money externally** using other estate assets (cash, real property, brokerage, retirement).
3. **High-value items STAY in the FairPlay ranked draft** and are assigned by it like every other item; the only "high-value" difference is that an appraised value is recorded on the item.
4. **No aggregate personal-property threshold.** Any heir can escalate any item to appraisal at any point before final signing.
5. **Finalization can complete with pending appraisals.** Those items appear on the trustee's Record of Decisions marked "pending appraisal" with the escalating heir named. Trustee resolves downstream.

## The delta in one sentence

The v8 fiduciary runtime is wired for an **Equalization Ledger** model (approve value → pick equalization path → collect consent → gated finalization). We are reshaping it into a **Trustee Handoff** model (any heir can flag → PR records appraised value → item stays in draft → finalization produces a Record of Decisions the trustee balances externally).

## Executive summary of changes

| Area | Change |
|---|---|
| Schema | Add `method_agreements` table (v14). No columns added or dropped elsewhere. |
| Storage | Add 4 methods (`flagForAppraisal`, `recordMethodAgreement`, `listMethodAgreements`, `generateRecordOfDecisions`). Change `finalize()` blocker semantics so pending appraisals do NOT block. Leave `decide()`, `requestConsents()`, `respondConsent()` in place but no route calls them from the UI going forward. |
| Router | Add 5 endpoints under `/api/fiduciary`: flag-high-value, method-agreements (POST + GET), record-of-decisions (JSON + print). Leave the equalization / consents / thresholds / finalize routes mounted but deprecated (marked in code, not removed). |
| Phase gate | `storage.markInventoryComplete()` (intake → ranking) refuses if any non-admin heir lacks a Method Agreement row. |
| Self-tests | Rewrite the 40-check suite. Delete the equalization+consent+threshold happy path and its refusal counterparts. Add coverage for flag-for-appraisal, method-agreement phase gate, pending-appraisal Record of Decisions. Target ~55 checks. |
| Docs | Update `docs/fair-choice-audit.md` — replace the "runtime not wired" claim with the corrected picture. Add a brief `docs/DESC-FAIR-CHOICE.md` addition describing the Trustee Handoff model. |

**No renames. No sweeping find-and-replace. No dependency install.** The one wire-format change is the new `method_agreements` table plus the new endpoints — everything else keeps its existing shape.

---

## Warnings — what could break (per project standing rule)

Before touching code, calling out every risk:

1. **New `method_agreements` table + v14 migration.** `npm run db:push` will run against the dev DB. Safe (additive). Production data is unaffected because there is no production yet.
2. **Ranking-phase transition gains a precondition.** Any existing session that has already progressed past intake is unaffected (the gate only runs on the intake → ranking transition itself). Any session sitting in `intake` will need every heir to sign the Method Agreement before it can advance. **This is the intended behavior** — the Method Agreement is the up-front buy-in — but it does mean an in-progress test session in `intake` would need agreements recorded before it can advance.
3. **`finalize()` behavior change.** Under the new model, a high-value item with no approved valuation and no equalization path can finalize (as long as it has a Method Agreement on file for the session's heirs and is marked "pending appraisal"). The old 40-check self-test asserts the opposite. Anyone reading the old test will get confused if we don't rewrite it — hence the rewrite in step 4.
4. **Dashboard read model shape changes slightly.** `HighValueItemSummary.blockers` becomes shorter and less scary (no more threshold-breach language). Any UI code depending on the exact old blocker strings will stop rendering those strings. I'll grep for consumers before editing.
5. **The deprecated equalization + consent routes remain accessible over the wire.** Anyone still calling them will get the same behavior they got before. I am not removing them tonight; a future release can. **If you'd rather I delete them tonight, say so** — it's cleaner but a larger diff.

---

## Files touched (file-and-line specifics)

### 1. `apps/reindeer-fair-play/shared/schema.ts` — add methodAgreements table (~30 lines added)

Insert **after `finalizationEvents` block, before `highValueAuditLog` block** (around line 780):

```typescript
/* ------------------------------------------------------------------ */
/* methodAgreements — each heir's up-front buy-in to FairPlay's    */
/* method (v14, Trustee Handoff)                                       */
/* ------------------------------------------------------------------ */
/**
 * One row per heir per session. Records the heir's agreement, before
 * ranking opens, that the family will divide personal property using Fair
 * Choice's ranked-draft method — knowing that dollar totals inside Fair
 * Choice do not need to be equal because the trustee balances the
 * financial side externally using other estate assets (cash, real
 * property, brokerage, retirement). Immutable once written.
 */
export const methodAgreements = sqliteTable("method_agreements", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: integer("session_id").notNull(),
  participantId: integer("participant_id").notNull(),
  agreedAt: integer("agreed_at").notNull(),
  agreementVersion: text("agreement_version").notNull().default("1.0"),
  agreementTextSnapshot: text("agreement_text_snapshot").notNull(),
  signatureMethod: text("signature_method").notNull().default("magic_link"),
  magicLinkTokenId: integer("magic_link_token_id"),
  clientIp: text("client_ip"),
  clientUserAgent: text("client_user_agent"),
}, (t) => ({
  uniqPerParticipant: uniqueIndex("method_agreements_session_participant_uniq")
    .on(t.sessionId, t.participantId),
}));
export type MethodAgreement = typeof methodAgreements.$inferSelect;
export type InsertMethodAgreement = typeof methodAgreements.$inferInsert;
```

Also add a corresponding zod insert schema and constant `CURRENT_METHOD_AGREEMENT_VERSION = "1.0"` alongside — following the pattern used for the other tables.

### 2. `apps/reindeer-fair-play/server/fiduciary/fiduciaryStorage.ts` — 4 new methods, 1 changed (~120 lines added, ~10 changed)

**New method `flagForAppraisal(itemId, actorId, reason)`** (~30 lines). Any authenticated participant can call. Sets `items.isHighValue = true` and (if `highValueState === "normal"`) `highValueState = "flagged_high_value"`. Writes one `highValueAuditLog` row. Item stays in the ranked-draft pool. Idempotent — flagging an already-flagged item is a no-op that still writes an audit row noting the reason.

**New method `recordMethodAgreement({ sessionId, participantId, ... })`** (~30 lines). Inserts one row. Throws `FiduciaryError` on duplicate (unique constraint catches this — translated to a 409). Snapshots the current agreement text so future edits to the boilerplate can't retroactively change what an heir signed.

**New method `listMethodAgreements(sessionId)`** (~10 lines).

**New method `generateRecordOfDecisions(sessionId)`** (~40 lines). Returns:
```typescript
{
  session: { id, name, estateName, finalizedAt },
  pr: { id, name },
  heirs: [{ id, name, methodAgreedAt }],
  items: [
    {
      id, name, room, category,
      awardedToParticipantId: number | null, // provisional/final recipient
      awardedToName: string | null,
      isHighValue: boolean,
      appraisedValue: number | null,          // items.approvedValue if approved
      valueSource: string | null,             // items.valueSource
      valuationDate: number | null,
      pendingAppraisal: boolean,              // isHighValue && no approved value
      escalatingParticipantId: number | null, // resolved from first highValueAuditLog
                                              //   row with eventType 'valuation_added'
                                              //   or the flag_for_appraisal event
      escalatingParticipantName: string | null,
    },
  ],
  totals: {
    itemCount: number,
    appraisedCount: number,
    pendingAppraisalCount: number,
    totalAppraisedValue: number, // sum of appraisedValue where set
  },
}
```

**Changed method `finalize()`** (~10 lines changed). Currently refuses when `finalizationStatus().canFinalize === false`. Under the new model, we still call `finalizationStatus` (it becomes a soft-warn read model), but we do NOT block on it — the only hard requirement is that a Method Agreement exists for every non-admin heir on the session. Add that check. Continue to write a `finalizationEvents` row. Continue to write the audit row. The `outcome` value shifts to a new enum member `"trustee_handoff"` — see schema change below.

**Add one `FINALIZATION_OUTCOMES` value.** `shared/schema.ts` line 924-929: append `"trustee_handoff"`. This is additive to the enum; no existing outcome removed.

**Deprecation comments.** Add JSDoc `@deprecated` on `decide()`, `setDecisionState()`, `listConsents()`, `requestConsents()`, `respondConsent()`, `finalizationStatus()`, `targetEqualShare()` explaining they belong to the pre-rescope Equalization Ledger model and remain only for backward-compat.

### 3. `apps/reindeer-fair-play/server/fiduciary/router.ts` — 5 new endpoints (~80 lines added)

Add after the `/thresholds` block, before `return router`:

```typescript
/* ---------- flag-for-appraisal (any authenticated heir) ---------- */
router.post("/items/:itemId/flag-high-value", async (req, res) => {
  try {
    const itemId = parseItemId(req);
    const actor = req.actor;
    if (!actor) return res.status(401).json({ message: "Not signed in." });
    const body = z.object({ reason: z.string().optional() }).parse(req.body ?? {});
    const item = await fiduciary.flagForAppraisal(itemId, actor.id, body.reason ?? "");
    res.json(item);
  } catch (e) { fail(res, e); }
});

/* ---------- method agreements (up-front buy-in) ---------- */
router.get("/method-agreements", async (_req, res) => {
  try {
    const session = await storage.getSession();
    res.json(await fiduciary.listMethodAgreements(session.id));
  } catch (e) { fail(res, e); }
});

router.post("/method-agreements", async (req, res) => {
  try {
    const actor = req.actor;
    if (!actor) return res.status(401).json({ message: "Not signed in." });
    const session = await storage.getSession();
    const agreement = await fiduciary.recordMethodAgreement({
      sessionId: session.id,
      participantId: actor.id,
      clientIp: req.ip ?? null,
      clientUserAgent: req.header("user-agent") ?? null,
    });
    res.json(agreement);
  } catch (e) { fail(res, e); }
});

/* ---------- record of decisions (trustee handoff) ---------- */
router.get("/record-of-decisions", async (_req, res) => {
  try {
    const session = await storage.getSession();
    res.json(await fiduciary.generateRecordOfDecisions(session.id));
  } catch (e) { fail(res, e); }
});

router.get("/record-of-decisions/print", async (_req, res) => {
  try {
    const session = await storage.getSession();
    const record = await fiduciary.generateRecordOfDecisions(session.id);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderRecordOfDecisionsHtml(record));
  } catch (e) { fail(res, e); }
});
```

Plus a small `renderRecordOfDecisionsHtml()` helper (~40 lines) inside the file — a plain server-side string template producing a print-ready HTML document. Large type, plain language, one item per line with award recipient and appraised value if any.

### 4. `apps/reindeer-fair-play/server/storage.ts` — phase-gate check (~15 lines changed in `markInventoryComplete`)

Currently `markInventoryComplete()` (line ~1105) refuses only if `phase !== "intake"`. Add: before returning, load `methodAgreements` for the session and the non-admin roster, and refuse if any heir lacks an agreement — with a plain-language message ("Every heir must sign the Method Agreement before ranking can open.").

### 5. `apps/reindeer-fair-play/server/fiduciary/selftest.mts` — rewrite (~250 lines new; ~200 lines removed)

New test plan (target ~55 checks):

**Section A — Method Agreement gate (new, ~10 checks)**
- record one heir's agreement
- record a second heir's agreement
- duplicate agreement for the same heir throws 409
- `listMethodAgreements(sessionId)` returns both rows
- unique index enforced (already covered by duplicate throw)
- `markInventoryComplete` throws when no agreements
- `markInventoryComplete` throws with one heir missing
- `markInventoryComplete` succeeds when all heirs have signed
- agreement text snapshot captured
- agreement snapshot immutable across future reads

**Section B — Flag for appraisal (new, ~8 checks)**
- any heir (not just PR) can flag an item
- flagging sets `isHighValue = true`
- flagging sets `highValueState = "flagged_high_value"` (from normal)
- flagging an already-flagged item is idempotent
- flagging writes one `highValueAuditLog` row per call with `eventType = "high_value_flagged"` (new event type — see below)
- flagged item **remains in the ranked-draft pool** (assert via `items.status` isn't changed to whatever "held out" would look like)

**Section C — Valuation lifecycle (kept, minor tweaks, ~10 checks)**
- add valuation → row created with correct value + status
- add valuation moves item to `awaiting_value_review`
- `item.estimatedValue` set from valuation
- approve valuation marks the row approved
- `item.approvedValue` set on approval
- `item.valueStatus` becomes `approved`
- `item.valuationDate` set
- second valuation superseded first
- `item.approvedValue` updates to latest approval
- dispute valuation flips `item.valueStatus` back to `disputed`

**Section D — Record of Decisions (new, ~12 checks)**
- generate with zero items → empty items array, correct totals
- generate with a mix of appraised, unappraised-normal, and pending-appraisal high-value items
- appraised item shows `appraisedValue` and `valueSource`
- pending-appraisal item shows `pendingAppraisal: true` and `escalatingParticipantName` populated
- unappraised normal item shows `appraisedValue: null` and `pendingAppraisal: false`
- totals count correctly
- totals sum `totalAppraisedValue` correctly
- printable HTML endpoint returns 200 with `Content-Type: text/html`
- printable HTML contains estate name and heir names
- printable HTML lists every item

**Section E — Finalization under Trustee Handoff semantics (new, ~10 checks)**
- item with no valuation, no path, no consents CAN finalize as `trustee_handoff` (opposite of old behavior — this is the whole point)
- but only if all heirs have signed the Method Agreement (session-scoped precondition)
- without Method Agreements → throws
- with Method Agreements → succeeds, writes `finalizationEvents` row with `outcome = "trustee_handoff"`
- `item.highValueState` becomes `finalized`
- `item.finalizedAt` set
- audit row written with `eventType = "finalization_locked"`
- pending-appraisal item appears in RoD after finalization, still marked pending
- finalization does not require a `provisionalRecipientId` (draft may not have run yet in tests)
- second finalization on the same item still succeeds idempotently (writes another finalizationEvents row — matches existing schema behavior)

**Section F — Audit trail (new, ~5 checks)**
- flag-for-appraisal writes one audit row
- add valuation writes one audit row
- record method agreement writes one audit row (need to add this — currently unaudited)
- generate RoD is read-only (writes zero audit rows)
- audit log ordering matches action order

New audit event types (add to schema): `"high_value_flagged"`, `"method_agreement_signed"`, `"trustee_handoff_generated"` (only if we decide to audit the generation itself; probably not).

### 6. `docs/fair-choice-audit.md` — replace stale content

Replace the file with a short "This audit is superseded by the Trustee Handoff rescope (see `docs/decisions/2026-08-06-fc-v8-trustee-handoff-rescope.md`)" note plus a table of what changed. Keep the file (don't delete) so any external links or references still resolve.

### 7. `docs/DESC-FAIR-CHOICE.md` — small addition

Add a section titled "Trustee Handoff model (v8, revised)" with 2 paragraphs of prose describing the model in plain language. Reference the spec above.

### 8. `scripts/roundtrip-test.mjs` — verify baseline still 66

Read carefully first; if it touches fiduciary tables, adjust. Expected: it doesn't (roundtrip is registry ↔ FC import boundary; fiduciary is FC-internal). No change expected, but I'll grep to confirm.

---

## What is NOT changing

Explicitly to prevent misunderstanding:

- **Ranked-draft engine** — unchanged. Heirs, contested-loss counter, snake order, secondary rounds all keep their existing behavior. High-value items participate in it exactly like everything else.
- **Auth** — unchanged. Magic-link tokens, sliding sessions, `req.actor`. No `req.body.participantId` reads reintroduced.
- **Registry app** — unchanged. This work is scoped to `apps/reindeer-fair-play/`.
- **`shared/schema.ts` item state machine** — no new states, no removed states. `ITEM_STATES` and `NON_FINAL_ITEM_STATES` / `FINAL_ITEM_STATES` unchanged.
- **`equalizationDecisions`, `consents`, `finalizationEvents` tables** — unchanged. Left in place with all columns. `finalizationEvents` gets one new possible `outcome` value (`"trustee_handoff"`).
- **`highValueAuditLog`** — unchanged shape, three new event-type strings accepted.
- **Threshold columns on `sessions`** — unchanged. The threshold routes remain accessible for backward-compat but no new UI drives them.

---

## Execution order (once approved)

1. Add `methodAgreements` table + `CURRENT_METHOD_AGREEMENT_VERSION` constant to `shared/schema.ts`. Add `"trustee_handoff"` to `FINALIZATION_OUTCOMES`. Add 3 new audit event types.
2. `npm run db:push` (from `apps/reindeer-fair-play/`).
3. Add the 4 new storage methods to `fiduciaryStorage.ts`. Update `finalize()` semantics. Add `@deprecated` JSDoc to old methods.
4. Add 5 new endpoints to `router.ts` and the `renderRecordOfDecisionsHtml` helper.
5. Update `markInventoryComplete()` in `storage.ts`.
6. Rewrite `selftest.mts` to the new plan.
7. Run all four test suites: roundtrip 66, auth 47, fiduciary target ~55, import 38.
8. `npm run check` (tsc).
9. Update `docs/fair-choice-audit.md` and `docs/DESC-FAIR-CHOICE.md`.
10. Atomic commit.

Rough time estimate: **2–3 hours** of focused work. The delta is genuinely narrower than "build the runtime from zero" would have been.

---

## Two mechanical decisions I made for you (flag if you disagree)

1. **Method Agreement text lives in a constant, not the database.** `CURRENT_METHOD_AGREEMENT_VERSION = "1.0"` plus a `CURRENT_METHOD_AGREEMENT_TEXT` string constant in `shared/agreementText.ts`. Snapshotted onto each `methodAgreements` row at signing time so future edits don't retroactively change what heirs signed. **Alternative**: store the text in a database row. I chose the constant because it makes version bumps a code change (auditable in git), which matches the app's existing pattern for other bounded strings.

2. **The Record of Decisions endpoint is generative, not stored.** Every call re-computes the RoD from live data. **Alternative**: persist a snapshot at finalization time (like `finalizationEvents` does per item). I chose generative because there is no session-wide "finalize" event today (finalization is per-item), and adding one is out of scope. If you'd prefer a snapshot, I'd need to add a session-wide finalize action first.

---

## Ready to build

Approve or modify. If approved, I'll execute steps 1–10 in one session, one atomic commit, all tests green before submit.
