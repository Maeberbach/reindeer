> **Superseded** — vocabulary in this document may use *PR*, *personal representative*, or *fiduciary* for what the current suite calls **trustee**, and may predate the three configurations and the heir-initiated end-trustee-mode endpoint. See [`docs/SUITE-OVERVIEW.md`](../SUITE-OVERVIEW.md) for the current model. This document is kept as history and is not being rewritten.

# Handoff — FC honors the owner's Registry Important mark

**Date:** 2026-08-06, 6:15 PM EDT
**Repo HEAD at handoff:** `7b71554`
**Working tree:** dirty (see "Unsubmitted work" below)
**Author of handoff:** the assistant, at the end of the session that scoped the FC boundary decision.

## The one-paragraph summary

We were mid-rollout on the owner-authored **Important comment** feature (steps 1–4 committed, step 5 staged but not committed) when the user reframed the boundary rule between Registry and FairPlay. New rule: if the owner marked an item Important in Registry (`owner_high_value=true`), FairPlay imports it already flagged high value (`isHighValue=true`), exactly as if a heir had promoted it during cataloguing. The owner's comment travels too, as a new FC column `ownerImportantComment`. Spec was written, six discrete design decisions were enumerated, the user approved all six. Nothing has been committed for the FC-boundary change yet — the spec is on disk but untracked, and no code has been touched. Reconnaissance on FC's migration numbering was in progress at handoff (next migration is v13; v12 was read as a template).

## The rule, precisely

**Owner promotion == heir promotion.** The owner's Registry Important is imported into FairPlay as `isHighValue=true` on the item, and an audited row is written to `classificationChanges` attributing the flip to "Imported from Reindeer Registry — the owner marked this item Important." with `changedByParticipantId=null`. After import, the flag lives its normal FC life:

- Heirs can flip it via `PATCH /api/items/:id/flags` during unlocked phases.
- PR can revert via `POST /api/items/:id/flags/:changeId/revert`.
- The `highValueState` fiduciary flow (normal → awaiting_value_review → awaiting_equalization_decision → awaiting_consent) proceeds normally.

**Owner's comment travels as provenance.** New column `ownerImportantComment TEXT NOT NULL DEFAULT ''` on FC's `items` table. Populated from `srcItem.owner_important_comment` at import. Lives alongside `inventoryStory` (biography) but is semantically distinct (owner's Important-flag reasoning).

**"High value" now widens in meaning.** No longer "the AI's dollar estimate crossed threshold" — now "this item is routed through appraiser/equalization/consent because either FC valuation said so or the owner or a heir said this matters." Flag name stays; downstream UI copy is a follow-up task.

## Six approved decisions (all confirmed by user, 2026-08-06 6:15 PM EDT)

1. **New FC column `ownerImportantComment`** (not concatenated into `inventoryStory`, not stashed in `notes`).
2. **Audit attribution:** `changedByParticipantId=null`, `reason="Imported from Reindeer Registry — the owner marked this item Important."`
3. **PR-revertable** like any other classification change — same rules as heir promotion. Not permanent.
4. **One atomic commit** — spec + FC migration + FC importService + FC self-test + Reindeer Legacy importer + roundtrip test. Splitting would leave broken intermediate state.
5. **Check FC migration numbering and session context before writing code.** In progress at handoff; findings recorded below.
6. **Step 5 of the comment rollout lands as a separate commit AFTER** the FC-boundary commit. The staged step-5 changes in the working tree wait.

## Reconnaissance done so far (safe to trust)

**FC schema (`apps/reindeer-fair-play/shared/schema.ts`):** `items` table already has `isHighValue: integer boolean notNull default false` (line 235), `inventoryStory: text notNull default ''` (line 304, "The owner's own words about the item, recorded before death"), `notes: text notNull default ''` (line 217), `originApp`/`originItemId`/`importBatchId` provenance columns already there.

**Existing FC import path (`apps/reindeer-fair-play/server/import/importService.ts`):**
- Line 386: `inventoryStory: srcItem.story ?? ""` — already reads Registry's `story` field.
- Line 393: `isHighValue: !!srcItem.high_value_flag` — this is the line to change.

**FC classification-flags system (`apps/reindeer-fair-play/server/storage.ts:3345`):** `setItemFlags` — writes to `items` column plus a `classificationChanges` row per flag flipped. Line 3384-3400 shows the exact insert shape: `sessionId`, `itemId`, `flagName`, `oldValue`, `newValue`, `changedByParticipantId`, `changedAt`, `reason`, `phase`, `isRevert`, `removedRankings`. **This is the exact insert we mirror at import time.**

**FC state machine (`apps/reindeer-fair-play/server/fiduciary/fiduciaryStorage.ts`):** `highValueState` state machine sits on top of `isHighValue`. Not our concern for this rollout — it works off `isHighValue`, so if we set that correctly at import, the flow runs.

**FC migration numbering:** Files in `apps/reindeer-fair-play/server/migrations/` are: `v7a_lifecycle.ts`, `v8_high_value_fiduciary.ts`, `v9_inventory_import.ts`, `v10_authentication.ts`, `v11_threshold_decisions.ts`, `v12_representative_passphrase.ts`. All wired via imports in `storage.ts` lines 88-93. **Next number is v13.** Convention (from reading v12): a `runV<N><Name>Migration(sqlite: Database.Database, _addColumn: AddColumn): void` function that runs SQL via `sqlite.exec(...)`.

**Reconnaissance still needed before code:**
- How the import path is triggered — inside an active session? Or before? The `classificationChanges` row needs a `sessionId`. Need to verify `importService.ts` runs inside a session context. **Grep for how `sessionId` is resolved in the import path.** Specifically look at where `importService.ts:393`'s surrounding code gets its session id from.
- Whether `phase` at import time is "cataloguing" or something earlier. The `classificationLocked(phase)` check in `setItemFlags` prevents flag changes during locked phases; if import happens before cataloguing starts, the phase-lock check may need to be bypassed or the row may need a special `phase` value.

## Unsubmitted work in the tree (be careful!)

**Untracked (from THIS turn):**
- `docs/decisions/2026-08-06-fc-honors-owner-important.md` — the approved spec, 219 lines, ready to submit as the first file in the atomic commit.

**Modified (from step 5 of the earlier Important-comment rollout, staged before the FC-boundary reframe interrupted):**
- `packages/reindeer-exchange/src/importer.js` — reads `src.owner_important_comment ?? ''`
- `packages/reindeer-exchange/src/v1/csv.js` — appends `owner_important_comment` column at end (CSV_COLUMNS + toCsv row)
- `packages/reindeer-exchange/src/v1/envelope.js` — adds `owner_important_comment` per-item field + `counts.owner_commented_important`
- `scripts/roundtrip-test.mjs` — modified 1 existing check (CSV header/positional check now expects 3-column tail: owner_important, owner_important_reason, owner_important_comment) + APPENDED 10 new checks at end of file (isolated `cmt` scope, tests auto-flag, empty comment doesn't flag, clear-on-unflag, comment-delete keeps flag, 500-char cap, trim, envelope verbatim, counts, CSV verbatim, import round-trip, print verbatim with `$` figure + leak-guard restated). Target: 65 checks (55 existing + 10 new). NOT YET RUN or verified.

**⚠️ These step-5 changes must NOT go in the FC-boundary commit.** They're a separate rollout (owner's Important comment as a legacy-value field on the Registry side + through the envelope). Two commits, in this order: (1) FC-boundary, (2) step-5 comment rollout.

## The atomic commit's exact contents (what to build)

### File 1: `docs/decisions/2026-08-06-fc-honors-owner-important.md`
Already on disk. Do not edit further; this is the approved spec.

### File 2: `apps/reindeer-fair-play/server/migrations/v13_owner_important_comment.ts`
New file. Follow v12 as a template. SQL:
```sql
ALTER TABLE items ADD COLUMN owner_important_comment TEXT NOT NULL DEFAULT '';
```
Migration function named `runV13OwnerImportantCommentMigration`.

### File 3: `apps/reindeer-fair-play/server/storage.ts`
Add import at line ~93 (after v12):
```ts
import { runV13OwnerImportantCommentMigration } from "./migrations/v13_owner_important_comment";
```
Wire into the migration runner (find where the other `runV*Migration()` calls are invoked — grep for `runV12` in storage.ts).

### File 4: `apps/reindeer-fair-play/shared/schema.ts`
Add to `items` table definition, near line 304 (near `inventoryStory`):
```ts
/** The owner's own words about why they marked this item Important, from Registry. */
ownerImportantComment: text("owner_important_comment").notNull().default(""),
```

### File 5: `apps/reindeer-fair-play/server/import/importService.ts`
Two changes:
- Line 393: `isHighValue: !!srcItem.high_value_flag` → `isHighValue: !!srcItem.high_value_flag || !!srcItem.owner_high_value`
- Add `ownerImportantComment: srcItem.owner_important_comment ?? ""` to the fields written to `items`.
- After the item insert, when `isHighValue` is true and the source was `owner_high_value` (not `high_value_flag`), insert a `classificationChanges` row (see storage.ts:3384-3400 for insert shape) with:
  - `flagName: 'isHighValue'`, `oldValue: false`, `newValue: true`
  - `changedByParticipantId: null`
  - `reason: 'Imported from Reindeer Registry — the owner marked this item Important.'`
  - `isRevert: false`
  - `sessionId: <resolved from context>` — **verify how before coding**
  - `phase: <session phase>` — **verify how before coding**

### File 6: `apps/reindeer-fair-play/server/import/selftest.mts`
Currently 35 checks. Add 2:
1. Envelope item with `owner_high_value: true` and `high_value_flag: false` lands in FC with `isHighValue: true` AND a matching `classificationChanges` row with the expected reason string and `changedByParticipantId=null`.
2. `ownerImportantComment` on FC item matches envelope's `owner_important_comment` verbatim.
Target: 37 checks.

### File 7: `packages/reindeer-exchange/src/importer.js`
Lines 88-99 currently document that owner_high_value is NOT mapped to high_value_flag. Replace with:
```js
// Owner's Registry "Important" mark seeds FairPlay's high-value flag,
// same mechanism as an heir's promotion. See
// docs/decisions/2026-08-06-fc-honors-owner-important.md.
high_value_flag: !!src.high_value_flag || !!src.owner_high_value,
```

### File 8: `scripts/roundtrip-test.mjs`
Reverse the existing negative-path assertions that verify `owner_high_value` doesn't set `high_value_flag`. New wording: "an item the owner marked Important arrives in FairPlay already flagged as high value." Also assert the classification-change row is written on import. Approximately +2 checks net.

**Path A confirmed by user 2026-08-06 6:23 PM EDT.** Procedure:
1. `git stash push -m "step-5-comment-rollout-in-progress" -- packages/reindeer-exchange/src/importer.js packages/reindeer-exchange/src/v1/csv.js packages/reindeer-exchange/src/v1/envelope.js scripts/roundtrip-test.mjs`
2. Working tree now matches HEAD `41e427b` (which is effectively the same code as `7b71554` — the intervening commit was docs-only). Roundtrip is 55 checks in this state.
3. Make the FC-boundary edits to the 8 files listed above (including reversing the 2 existing negative-path assertions in `scripts/roundtrip-test.mjs`). Expected roundtrip count after this edit: ~57.
4. Verify (see "Verification before submit" section). Submit as one commit.
5. `git stash pop` — restores the 4 step-5 modifications on top of the newly-committed roundtrip test. Different lines edited, so no conflict expected. If a conflict does appear, STOP and check with the user.
6. Now finish step 5 as its own commit (run roundtrip, expect 65 checks: 55 baseline + 2 boundary reversals now landed + 10 new comment tests staged; adjust expected count as needed once the boundary commit lands).

## Verification before submit (do not skip!)

1. `node scripts/roundtrip-test.mjs` — should report the new count (57ish, depending on path A/B). **Read the exit code before submitting. Do not assume green.**
2. `cd apps/reindeer-fair-play && npm install` (root install prunes FC's deps).
3. `npx tsx server/auth/selftest.mts` — expect 47 (unchanged).
4. `npx tsx server/fiduciary/selftest.mts` — expect 40 (unchanged).
5. `npx tsx server/import/selftest.mts` — expect 37 (35 + 2 new).
6. `npm run check` (tsc) inside `apps/reindeer-fair-play` — must be clean.
7. `npm run db:push` inside `apps/reindeer-fair-play` — apply the new migration to the local `data.db`.

If any of the above fails, DO NOT submit. Fix and re-verify. This is the workflow rule I broke in `54ff915` and had to fix in `7b71554`.

## Standing rules the next session MUST honor

1. **"Warn the user BEFORE any rename, sweeping find-and-replace, dependency reinstall, or schema/wire-format change, stating exactly what could break."** — Migration v13 IS a schema change; the user was warned in the spec, but any additional schema changes need a fresh warning.
2. **"Always confirm precisely the change in code you plan to make regards to outcomes before Ann And acting."** — Every user-facing decision goes through `ask_user_question` or an explicit written confirmation. Do not proceed on assumption.
3. **Authentication:** NEVER reintroduce `req.body.participantId`, `x-participant-id` header, or `?participantId=` for identity — impersonation hole. Use `actorOf(req)` in FC routes.
4. **Test before commit.** Run test → read exit code → THEN submit. Do not claim "N/N green" in a commit message before running.
5. **UI must stay legible and forgiving for elderly users.** Large type, large targets, plain language, confirm before anything irreversible.
6. **The Important comment is legacy content.** It carries emotional and provenance value. It must not be silently dropped.
7. **Registry never writes `high_value_flag`.** Line 104 of `packages/legacy-intake-feature/src/server/router.js` stays: `body.high_value_flag = false`. The flag is FC's domain; Registry only writes `owner_high_value`.

## What to do first when resuming

1. Read this handoff.
2. `cd /home/user/workspace/projects/legacy-suite-XPjy0RsrSMGTV_3ok2A05g/files && pplx project files sync` — refresh checkout.
3. `git status` — confirm the unsubmitted state matches what's documented above. If it differs, STOP and re-read.
4. Do the two remaining reconnaissance items: (a) how does `importService.ts` resolve `sessionId` at import time, (b) what phase is the session in during import — is `classificationLocked(phase)` true or false? These answers determine whether the classificationChanges row can be inserted directly or needs a bypass. Report to user before writing code.
5. Decide Path A vs Path B for the roundtrip test.
6. Write the code atomically across the 8 files above.
7. Run all verification steps above. Read exit codes. Do not skip.
8. `pplx project files submit -m "FairPlay honors the owner's Registry Important mark ..."` — commit message should reference the spec doc and note the migration.
9. Return to step 5 of the Important-comment rollout: run the roundtrip test with the step-5 staged changes, confirm 65 checks green, submit as a second commit.

## Key files reference (for grep-hopping in the next session)

- Spec (already written): `docs/decisions/2026-08-06-fc-honors-owner-important.md`
- Earlier spec being superseded in part: `docs/decisions/2026-08-06-important-flag.md`
- Comment rollout spec: `docs/decisions/2026-08-06-important-comment.md`
- FC schema: `apps/reindeer-fair-play/shared/schema.ts` (items table at line 207)
- FC importService: `apps/reindeer-fair-play/server/import/importService.ts` (line 393 is the change)
- FC storage / setItemFlags: `apps/reindeer-fair-play/server/storage.ts:3345`
- FC classificationChanges insert shape: `apps/reindeer-fair-play/server/storage.ts:3384-3400`
- FC fiduciaryStorage (state machine, do not edit): `apps/reindeer-fair-play/server/fiduciary/fiduciaryStorage.ts`
- FC migrations dir: `apps/reindeer-fair-play/server/migrations/`
- FC migration wiring: `apps/reindeer-fair-play/server/storage.ts:88-93`
- Registry-side importer (line 88-99 block needs rewrite): `packages/reindeer-exchange/src/importer.js`
- Registry intake router (line 104 stays untouched): `packages/legacy-intake-feature/src/server/router.js`
- Roundtrip test: `scripts/roundtrip-test.mjs`
- FC self-tests: `apps/reindeer-fair-play/server/{auth,fiduciary,import}/selftest.mts`

## One-line status

Spec on disk, six decisions approved, no code touched, step-5 changes staged and waiting behind this. Next: two grep questions on FC session/phase context, then Path A stash, then atomic commit.
