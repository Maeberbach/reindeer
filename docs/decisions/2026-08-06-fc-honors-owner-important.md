> **Superseded** — vocabulary in this document may use *PR*, *personal representative*, or *fiduciary* for what the current suite calls **trustee**, and may predate the three configurations and the heir-initiated end-trustee-mode endpoint. See [`docs/SUITE-OVERVIEW.md`](../SUITE-OVERVIEW.md) for the current model. This document is kept as history and is not being rewritten.

# FairPlay honors the owner's Registry Important mark

Date: 2026-08-06
Status: **Approved by owner in-session, 2026-08-06 6:11 PM EDT.**
Supersedes (in part): `2026-08-06-important-flag.md` — the earlier claim
that `owner_high_value` and FairPlay's `high_value_flag` / `isHighValue`
are "kept strictly separate on import." That claim is retired here.

## The rule

**When a Registry envelope arrives at FairPlay, an item the owner marked
Important (`owner_high_value === true`) is imported into FairPlay as an
item that has already been flagged high value (`isHighValue = true`),
exactly as if a heir had promoted it during cataloguing.** The owner's mark
and the heir's promotion mechanism are treated as the same mechanism, not
two parallel systems.

From that point onward, the item lives its normal FairPlay life:

- Heirs can flip `isHighValue` off during the cataloguing / classification
  phases via the existing `PATCH /api/items/:id/flags` route, subject to
  the existing `classificationLocked(phase)` gate.
- The Personal Representative can revert any classification change via
  `POST /api/items/:id/flags/:changeId/revert`, subject to the existing
  `denyIfNotPR` gate.
- The audit trail (`classificationChanges` table) shows the flag as having
  been set by "the Registry import" (participant id `null`, `reason`
  column carries `"Imported from Reindeer Registry — the owner marked
  this item Important."`), so a heir or the PR who later looks at the item
  can see who put it in the high-value bucket and why.
- The `highValueState` fiduciary state machine (normal →
  awaiting_value_review → awaiting_equalization_decision → awaiting_consent)
  proceeds as normal — the item enters that flow because it's high value,
  regardless of who put it there.

## The owner's comment travels too

**The owner's Important comment (`owner_important_comment`) is imported
into FairPlay as `items.ownerImportantComment`.** This is provenance
and emotionally-valued content — the owner's own words about why the item
matters. The heirs dividing the estate deserve to hear it. FairPlay's
UI treats it as a first-class field alongside `inventoryStory` (the
biography) — one is "here is the item and its history," the other is
"here is what the owner wanted said about it."

This is a new column on the FairPlay side, added by a new FC migration
(FC's migration numbering, not Registry's — see below). Column contract:

- `ownerImportantComment TEXT NOT NULL DEFAULT ''`
- Additive. Existing rows read as no comment, which is exactly right for
  items imported before this rollout.
- Never rendered as a valuation. Displayed in the UI in whatever slot the
  FC team designates for owner-authored provenance content, alongside
  `inventoryStory`.

## High value ≠ money

**A core semantic shift** captured for the record: the `isHighValue` flag
under this rule no longer means "the AI's dollar estimate crossed the PR's
threshold." It means **"this item is being routed through the appraiser /
equalization / consent workflow, because either FC's valuation said so or
the owner or a heir said this matters."**

The name of the flag stays — renaming a v4 field mid-flight would break
too much. But the meaning widens, and any FC-side reports whose titles
say "high value items" may want to be reworded as "flagged items" or
"important items" in a future pass. That's a UX polish task, not a
blocker for this decision.

## What changes, precisely

### Registry side (already committed)

- `9976e66` — spec for the comment field
- `b27b204` — migration 8 + models + validator + repo
- `aabfd91` — intake router
- `7b71554` — print template (after `54ff915` fixup)

Registry writes `owner_high_value`, `owner_high_value_reason`, and
`owner_important_comment` on its own items. No further Registry-side
change is required for this decision; Registry already emits all three
fields on the envelope and CSV.

### Exchange envelope (already committed)

- Envelope carries `owner_high_value`, `owner_high_value_reason`, and
  `owner_important_comment`. No wire-format change required.

### Reindeer Legacy exchange importer (NOT changing after all)

On closer read, `packages/reindeer-exchange/src/importer.js` is a
**Registry-to-Registry** reader, not a Registry-to-FC reader. Its
`high_value_flag: !!src.high_value_flag` line correctly transfers Registry's
own flag; owner promotion crosses at the FC boundary via
`apps/reindeer-fair-play/server/import/importService.ts`, not here.

The misleading comment above that line ("Kept strictly separate ... we do
NOT set this from src.owner_high_value ... a Registry owner ticking
important must never look to FairPlay like a valuation") is now
correct for Registry-to-Registry but wrong about FC — FairPlay DOES
now honor the owner's mark. Comment is updated to say so.

### FairPlay side (this decision)

Two changes, both on the FC side:

1. **New FC migration.** Adds `owner_important_comment TEXT NOT NULL
   DEFAULT ''` to `items`. Additive, mirrors the Registry column. FC's
   own migration numbering; needs an `npm run db:push` after the
   migration file lands.

2. **`server/import/importService.ts`** — in the item-create path (around
   line 393, `isHighValue: !!srcItem.high_value_flag`):

   - Replace with `isHighValue: !!srcItem.high_value_flag || !!srcItem.owner_high_value`.
   - Add `ownerImportantComment: srcItem.owner_important_comment ?? ""` to
     the fields written to `items`.
   - When `owner_high_value` OR `high_value_flag` promotes the item (i.e.
     `isHighValue` is being set to true at import), write a
     `classificationChanges` row attributing the flip:
     - `flagName: 'isHighValue'`
     - `oldValue: false`
     - `newValue: true`
     - `changedByParticipantId: null` (owner is not an FC participant)
     - `reason: 'Imported from Reindeer Registry — the owner marked this item Important.'`
     - `isRevert: false`
     - `phase`: whatever the session phase is at import time
     - `sessionId`: the current session

   That last row is what makes the audit trail honest — a heir who sees
   the item in the high-value bucket can look at the classification change
   log and see exactly why.

### Tests

- **Reindeer Legacy roundtrip test** at `scripts/roundtrip-test.mjs`: the
  existing pair of checks that assert Registry's `owner_high_value` does
  NOT promote FC's `high_value_flag` on import are reversed. New wording:
  "an item the owner marked Important arrives in FairPlay already
  flagged as high value" and "the corresponding classification-change
  row attributes the flip to the Registry import." Approximately +2
  checks net; some of the existing negative-path assertions become
  positive-path.

- **FairPlay import self-test** at
  `apps/reindeer-fair-play/server/import/selftest.mts`: add a check
  that an incoming envelope item with `owner_high_value: true` and
  `high_value_flag: false` lands in FC with `isHighValue: true` and a
  matching `classificationChanges` row. Add a second check that the
  `ownerImportantComment` field is populated verbatim from the envelope.
  Current count is 35; expected to move to 37.

- **FairPlay fiduciary self-test** (currently 40): unchanged expected
  count, because we're not changing the fiduciary state machine itself.
  Run to prove no regression.

- **FairPlay auth self-test** (currently 47): unchanged expected
  count. Run for regression.

## What does NOT change

- Registry still never writes `high_value_flag`. Line 104 of the intake
  router stays. Registry's writes still only touch `owner_high_value`,
  `owner_high_value_reason`, `owner_important_comment`.
- The two DB columns on the Registry side stay separate. Only the
  IMPORT step unifies them into FC's `isHighValue`.
- FC's existing heir-promotion path (`PATCH /api/items/:id/flags`) is
  untouched. Heirs still promote and demote in the same way.
- FC's `revertClassificationChange` path is untouched. The PR can still
  revert any change, including the one written on import — that's
  desirable, because it means the PR has the final word.
- No FC-side wire format changes; no envelope version bump.

## Implementation notes (added during code)

- **The classificationChanges audit row is written only on the new-item
  insert path in `approveStaged`, not the update path.** Reasoning: re-imports
  can arrive against items that a heir or PR has already flagged and un-flagged;
  writing a fresh "the owner marked this Important" row on every re-import
  would spam the audit log and fight downstream decisions. The pre-existing
  update path overwrites `isHighValue` from staged — which is not ideal but
  is the pre-existing behavior and is out of scope here.
- **The audit row is written in `approveStaged`, not `stageBundle`.** Reason:
  the flip from `false` to `true` on the real `items` row happens at approve
  time, not stage time. Staging is preview; approval is commitment. The
  `assertRoundNotLocked` gate at the top of `approveStaged` already prevents
  approval during locked phases, so the audit row is never written in a
  phase where classification changes would be forbidden.
- **`ownerImportantComment` is a new column on BOTH `items` and
  `staged_items`.** The spec was silent on this split. The staged column is
  needed so PR review can see the owner's comment before approval, and so
  the value survives the stage → approve transition without a lossy hop.

## Consequences (kept in the record so future me can find them)

1. **The Registry-import classification row is revertable.** If the PR
   reverts the import row via `POST /api/items/:id/flags/:changeId/revert`,
   the item drops out of the high-value bucket entirely — same as any
   heir promotion. That is by design under the rule "treat owner
   promotion the same as heir promotion." An owner who wanted their
   mark permanent will need a legal instrument, not a software rule.

2. **The `isHighValue` flag now widens in meaning.** "High value" now
   covers both dollar-value promotions and owner-emotional promotions.
   Downstream FC reports and UI copy may benefit from a language pass in
   a follow-up, but nothing blocks on it here.

3. **`highValueState` fiduciary flow catches owner-emotional items.**
   An owner-flagged $30 skillet will enter the `awaiting_value_review`
   state along with a $30,000 painting. The PR / appraiser will see the
   skillet in the queue and can move it back to `normal` if the
   emotional flag doesn't warrant appraisal-and-consent handling. This
   is fine — it's the PR's judgment call, and the audit trail explains
   the item's presence.

4. **The `ownerImportantComment` field is display-only for now.** FC's
   UI needs a small placement (item detail page, alongside
   `inventoryStory`). That UI work is a separate task from this
   decision; the data lands and is available regardless.

## Rollout order (as landed)

The FC-boundary work and the step-5 owner-comment rollout landed together
as a single atomic commit, because FC's `stageBundle` reads
`owner_important_comment` from the envelope — which meant the envelope
writer had to ship in the same commit or the FC self-test would fail on
an empty comment field. Attempting a split showed exactly this.

One combined commit therefore covers:

1. Spec update (this file), audit-attribution decisions, and the
   Registry-to-Registry importer comment fix.
2. FC migration v13 adding `owner_important_comment` on `items` and
   `staged_items`.
3. FC schema + storage wiring for the new column.
4. FC `importService.stageBundle` reading `owner_high_value` and
   `owner_important_comment` off `ExchangeItem`; `approveStaged`
   writing an audited `classificationChanges` row on the new-item
   insert path when `isHighValue` flips from `false` to `true`
   because of the owner's mark.
5. FC import self-test additions verifying the promotion, the
   comment survives, and the audit row is written with null-participant
   attribution.
6. Exchange envelope / CSV writers emitting `owner_important_comment`
   (step 5 of the Important-comment rollout).
7. Core-data `itemRepository.update` clear-on-unflag intent detection:
   when the caller explicitly sets `owner_high_value: false`, clear the
   comment before validation so auto-flag doesn't re-assert.
8. Print template renders `<div class="important-comment">` in the
   list-layout report as well as on item sheets.
9. Roundtrip test's 11 new comment assertions.

Verified green before submit: roundtrip 66/66, FC auth 47/47, FC
fiduciary 40/40, FC import 38/38, `tsc` clean, `db:push` applied.
