# Slice A — demolition of the claim workflow

Date: 2026-08-09
Starting commit: 64b205f (Slice 4a+4b+4c complete)

## Why

The claim workflow (`importance_claims` + `memorandum_claims`) modeled a
household as two people negotiating every Important flag and every gift on
paper. That is not how couples actually decide who gets what. The revised
model, locked with the user this session:

- The app is not a fiduciary. Its job is to make the trustee's job easier
  and cut heir conflict — not to model estate law.
- Either partner in a couple can add items, tag them Important, and record
  where they should go. The household is trusted; the app does not police.
- Conflict resolution lives at the **memorandum layer** (Slice B). Two
  different assignments for the same item is a signal to the couple, not a
  workflow.

Slice A is demolition-only. It removes the claim workflow so Slice B can
build memorandums on a clean floor.

## What changed

### Schema

- **Migration 15** added: `drop_claim_tables`. DROPs the two claim tables
  and their indexes with `IF EXISTS`. Migration 13 (which created them) is
  left in place — a fresh install runs 13 then 15, spending a few ms to
  create-and-drop. That is safe and preserves the history-of-migrations
  invariant.
- No new columns. No wire-format change.

### Files deleted

- `packages/legacy-core-data/src/repos/importanceClaimsRepo.js`
- `packages/legacy-core-data/src/repos/memorandumClaimsRepo.js`
- `apps/reindeer-registry/server/routes/importanceClaims.js`
- `apps/reindeer-registry/server/routes/memorandumClaims.js`
- `scripts/couple-claims-test.mjs`
- `scripts/couple-claims-http-test.mjs`
- `scripts/trustee-important-test.mjs`

### Files modified

- `packages/legacy-core-data/src/migrations/index.js` — added migration 15.
- `packages/legacy-core-data/src/index.js` — removed 2 exports.
- `apps/reindeer-registry/server/index.js` — removed 2 imports, 2 repo
  instantiations, 2 route mounts, and dropped `importanceClaims` +
  `participants` from the `DeliveryService` wiring.
- `packages/legacy-print-feature/src/templates/trusteePacket.js` —
  `renderImportanceSections` now reads `items[].owner_high_value` and
  `items[].owner_important_comment` directly instead of joining against
  claim rows and participants.
- `packages/legacy-delivery/src/delivery.js` — constructor no longer
  requires `importanceClaims` or `participants`; `prepare` passes only
  `householdMode` through to the print template.
- `apps/reindeer-registry/client/app.js` — removed the `claimreview` screen
  from the dispatcher, deleted `refreshReviewBadge`, `loadClaimReview`,
  and `claimAction`; removed the "Review together" button and unlink-time
  badge refresh; rewrote linked-mode copy so it no longer says Important
  marks wait for a second yes.
- `apps/reindeer-registry/client/index.html` — removed the quiet-row
  "Review together" button and the `claimreview` screen section.
- `apps/reindeer-registry/client/styles.css` — removed `.linky-badge`,
  `.claim-*` styles and the review-together banner block.
- `scripts/household-link-http-test.mjs` — deleted sections 12, 15, 16
  (which exercised the deleted endpoints) and renumbered the remaining
  sections. Now 48 checks (was 60).

## Wire format

**Unchanged.** The claim tables were UI/API only; nothing in the
`legacy-exchange` envelope, the addendum bundle, or the inventory bundle
referenced them. Signed versions on disk from any prior slice remain
valid without migration.

## Test matrix

All green:

| Test                          | Count |
| ----------------------------- | ----- |
| content-lint                  | clean |
| roundtrip                     | 66    |
| auth                          | 33    |
| two-lane                      | 22    |
| vision                        | 32    |
| people                        | 36    |
| sign                          | 43    |
| two-outputs-envelope          | 37    |
| two-outputs-bundle            | 60    |
| household-link-http           | 48    |
| FairPlay auth selftest     | 47    |
| FairPlay fiduciary selftest| 133   |
| FairPlay import selftest   | 54    |
| FairPlay trustee selftest  | 45    |

household-link-http went from 60 → 48 (12 checks were the deleted
claim-endpoint sections). Roundtrip, envelope, bundle, and all Fair
Choice self-tests are unchanged in count and content.

## Slice B — locked specification

Slice B builds per-partner memorandums. This is where the couple's
"who gets what" is recorded on paper and where the conflict notice lives.

### Data model (proposed, to be confirmed at Slice B kickoff)

- New table `memorandum_entries` (per-partner rows) with columns for
  `scope_id`, `participant_id` (which partner wrote it), `item_id`,
  `assigned_to_heir_id`, `note`, `created_at`. One row per
  (participant × item). Signing freezes the set for that partner.

### Conflict detection

Same `item_id` appears on both partners' `memorandum_entries` with
different `assigned_to_heir_id`. Detection runs live in the UI and on
the server at sign time.

### Notice — where it appears

Three surfaces, all showing the same list:

1. **Memorandum review screen (primary surface)** — full-width gold
   banner listing every conflicting item, shown before the Print and
   Sign buttons. Copy names the partner and the item and asks them to
   talk it over.
2. **Item detail screen** — inline gold call-out on any item that is in
   conflict, visible to both partners.
3. **Home tile** — small quiet-row entry: "X items to sort out with
   [partner]" when count > 0.

### Signing behavior — soft block, not hard block

- Print and Sign stay **enabled** with unresolved conflicts. The app is
  not the boss.
- A confirm dialog fires on Sign when conflicts exist: "You have N items
  your partner has also promised, to different people. Sign anyway?" —
  with "Go back and fix" as the primary action and "Sign anyway" as the
  secondary.
- The signed memorandum PDF carries a visible "Not agreed with partner"
  note next to each conflicting item on the paper itself. The reader
  can see the flag without opening the app.
- The couple can still sign if one partner has died or is unavailable —
  a hard block would trap the survivor. The trustee resolves what the
  couple could not.

### Copy tone (draft, refine at build time)

> "You and Ann have both promised the Wedding china, to different
> people. The app is not the boss — you can still print and sign. But
> please talk it over and update your list so your trustee and your
> family are not left to sort it out. Fixing it now is much kinder
> than fixing it later."

### Trustee cover sheet (Slice C)

The cover sheet lists every conflicting item in its own section:
"Items where the couple's two memorandums disagree." The trustee reads
the will and picks the recipient under its authority — the app just
surfaces the mismatch.

### What Slice B does NOT do

- No new item-level column for household-intended heir. The couple's
  wish is `items.assigned_to_heir_id` for shared items and the
  per-partner memorandum rows for personal ones. Conflict lives in the
  memorandum layer.
- No enforcement, no locking, no automatic resolution. The app never
  picks a winner.

## Follow-ups (not this slice)

- **Slice B:** memorandum_entries table, per-partner memorandum
  writer, conflict detection, three notice surfaces, soft-block sign
  confirm, per-item PDF flag.
- **Slice C:** trustee cover sheet — surface both memorandums + the
  conflict list.
- **Slice D:** UI polish — the linked-mode copy still mentions
  "one-person view" language that pre-dates the trust-the-household
  model; sweep and simplify.

## Notes for the next agent

- Migration 13 remains in `migrations/index.js` even though it creates
  tables that migration 15 immediately drops. Do not delete migration
  13 — the migrations table records which numbered migrations have run,
  and removing 13 would confuse existing installs.
- The `household_mode` field still exists on scope and is still used to
  show/hide couple-only UI. That is correct — Slice B needs it.
- The `packages/legacy-delivery/src/delivery.js` constructor no longer
  requires `importanceClaims` or `participants`. If Slice C reintroduces
  the participants dep to render both partners' names on the trustee
  cover, that is fine — just pass it explicitly again.
