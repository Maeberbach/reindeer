> **Superseded** — vocabulary in this document may use *PR*, *personal representative*, or *fiduciary* for what the current suite calls **trustee**, and may predate the three configurations and the heir-initiated end-trustee-mode endpoint. See [`docs/SUITE-OVERVIEW.md`](../SUITE-OVERVIEW.md) for the current model. This document is kept as history and is not being rewritten.

# Trustee report + owner pre-assignment — built (2026-08-07)

## What shipped

Two matching gaps closed in one pass:

1. **The trustee packet was silent about owner comments and owner assignments.** It listed items and stated wishes, but a comment like "always meant for Sarah" printed nowhere on the signature record.
2. **FairPlay threw owner-assigned items into the ranked pool anyway.** The Registry envelope's `recipient_hint` was staged as advisory text and then ignored. Comments that expressed the same intent in free text ("For Sarah") were invisible to the system.

Both are fixed. Owner-assigned items now leave the ranked pool entirely, print on the trustee packet with an `[ASSIGNED]` mark, and the owner's own words print verbatim below the row for the trustee to weigh.

## Behavior changes

- **New item status: `owner_assigned`.** Items land there at approve time when the Registry envelope carried a structured recipient hint OR the PR confirmed a detector candidate during import review.
- **The ranked draft is smaller.** Owner-assigned items are held out of the pool. Heirs never rank them, and the results page shows them under a new "Already assigned by the owner" section — separate from Final Leftovers.
- **Import review has a new gate.** When the detector fires on the Important comment, batch approval is blocked until the PR confirms or dismisses the candidate. Individual approval throws the same error.
- **Trustee packet prints the owner's words verbatim.** Any item with `owner_important_comment` now shows a cream-colored "IN THE OWNER'S OWN WORDS" row under the item, and owner-assigned items carry an `[ASSIGNED]` mark next to the recipient name.

## Files changed

Backend:

- `apps/reindeer-fair-play/server/migrations/v15_owner_assignment.ts` — new. Adds 4 owner-assignment columns to `items`, 5 detection columns to `staged_items`.
- `apps/reindeer-fair-play/server/storage.ts` — wire v15 into the migration chain; add `status !== "owner_assigned"` guard to the duplicate scanner.
- `apps/reindeer-fair-play/shared/schema.ts` — declare the new columns; update comments on `recipientHint` and the item-status enum.
- `apps/reindeer-fair-play/server/import/detectOwnerAssignment.ts` — new. Pure regex+participant-lookup detector.
- `apps/reindeer-fair-play/server/import/importService.ts` — call detector at stage time; branch approve to owner_assigned; add confirm/dismiss service functions; add batch-approval gate.
- `apps/reindeer-fair-play/server/import/router.ts` — POST `/api/import/staged/:id/detection/confirm` and `/dismiss` (PR-only).

Frontend:

- `apps/reindeer-fair-play/client/src/pages/results.tsx` — split owner-assigned items out of "Final leftovers" into their own "Already assigned by the owner" section.

Shared print template:

- `packages/legacy-print-feature/src/templates/trusteePacket.js` — verbatim comment row per item; `[ASSIGNED]` mark; new "Items with a written comment" summary count; legend paragraph explaining `[ASSIGNED]`.

Tests:

- `apps/reindeer-fair-play/server/import/detectOwnerAssignment.selftest.mts` — new. 13 unit checks on detector rules.
- `apps/reindeer-fair-play/server/import/selftest.mts` — updated 2 existing checks to the new binding-assignment behavior; added 7 new checks for the review pipeline.

## Test counts

- roundtrip: **66/66** (unchanged)
- auth self-test: **47/47** (unchanged)
- fiduciary self-test: **51/51** (unchanged)
- import self-test: **45/45** (was 38 → +7)
- detector unit self-test: **13/13** (new)
- FC `tsc`: clean
- FC `npm run build`: clean

Run:

```
node scripts/roundtrip-test.mjs
cd apps/reindeer-fair-play
npx tsx server/auth/selftest.mts
npx tsx server/fiduciary/selftest.mts
npx tsx server/import/detectOwnerAssignment.selftest.mts
npx tsx server/import/selftest.mts
npm run check
npm run build
```

## Detector rules (in one place)

Fires only when `recipientHint === ''` AND `ownerImportantComment !== ''`. Two signal families, combined per-name:

- **Directive phrases:** `For {Name}`, `meant/intended for {Name}`, `give this to {Name}`, `belongs to {Name}`, `save for {Name}`, `keep for {Name}`, `leaving to {Name}`, `going to {Name}`, `goes to {Name}`. Case-insensitive. Sentence-anchored for the bare "For" case.
- **Participant name match:** any FairPlay participant's first name appearing whole-word inside a sentence surfaces as a candidate.

Confidence is `both` when the same name comes from both signals in the same sentence, otherwise `directive_phrase` or `participant_name`. Stopwords ("the", "family", "children", etc.) never surface as names. Possessives (`Sarah's` → `Sarah`) tolerated. Two-token names ("Aunt Sarah") captured as one candidate.

Zero external calls. No LLM. Deterministic and unit-tested.

## Review UX contract (server side)

For every staged row with detection:

- `POST /api/import/staged/:id/detection/confirm { name? }` → sets `detected_owner_assignment_review = 'confirmed'`, optionally overriding the detected name. Next approve lifts the item to `owner_assigned` with `source = 'comment_detected'`, evidence = the verbatim sentence.
- `POST /api/import/staged/:id/detection/dismiss { reason? }` → sets review to `'dismissed'`; the item approves normally as `available`. The reason is stored on the staging row for the audit trail.
- `POST /api/import/batches/:id/approve` throws 409 with a plain-language message while any row's review is `pending`.

All three endpoints are PR-only via the existing `denyIfNotPR` guard.

## What's still open (deferred, spec called them out)

1. **Registry soft-nudge:** if the owner writes a name in the Important comment but leaves the recipient hint blank, prompt them at capture time to fill it in structurally. Follow-up in Registry, not this pass.
2. **Import UI review card:** the server contract lands now; the actual "Confirm / Not an assignment" tiles in the PR's review screen come next.
3. **Item-detail return-to-pool action:** the server can already flip `owner_assigned → available` via a status update (audited), but there's no button yet. Follow-up sub-pass.
4. **Grey-out unavailable cards for heirs:** `results.tsx` and `rank-all.tsx` now show `owner_assigned` items in their own section, but the ranking screens should also visibly grey them if they leak in (they shouldn't, given the pool queries above; visual belt-and-suspenders).
5. **`itemRepo.update()` room-state promotion on `room_id` change** — still open from earlier work, unchanged.

## Migration safety

Additive columns only. Existing rows default cleanly:

- `items.owner_assigned_* = ''` / `NULL`
- `staged_items.detected_owner_assignment_* = ''`

Old-to-new upgrade is clean. **New-to-old restore FAILS** because the migration only runs forward. If you need to restore a pre-v15 build, do it from a v14 snapshot.

## The invariant we protect

An `owner_assigned` item MUST NOT appear in `rankings` or `picks`. Two mechanisms enforce this today:

1. `approveStaged` sets `status = 'owner_assigned'` directly, so it never enters the pool as `available`.
2. The duplicate scanner and results-leftovers filter explicitly exclude `owner_assigned` from their candidate lists.

If a future query iterates over items with a `status !== 'awarded'` check, it will silently include owner_assigned. Add `&& status !== 'owner_assigned'` at every such site. This is the same pattern followed for `duplicate_dismissed`.
