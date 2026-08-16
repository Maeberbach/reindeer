# Couple Mode — Slice 1: schema + claim repos + isolated test

**Date:** 9 Aug 2026
**Status:** shipped
**Spec:** [`docs/specs/2026-08-09-registry-couple-link.md`](../specs/2026-08-09-registry-couple-link.md)

## What this slice adds

The load-bearing layer for Couple Mode: the database schema, the two
claim-state repositories, and an isolated test suite that exercises both
state machines against a fresh SQLite database. **No UI. No routes. No
sign-flow changes. No merge / link plumbing.** Solo mode is unchanged.

### Migration 13 — `couple_and_claims`

Purely additive. Rerunning existing tests against a database that has
been migrated through 12 is safe because every new column has a default
and every new table is empty.

- `scopes`
    - `household_mode TEXT NOT NULL DEFAULT 'solo'` — `solo | couple | survivor`
    - `linked_household_id TEXT` — set once when two solo scopes merge
    - `linked_at TEXT` — timestamp of the merge
    - `linked_by_participant_id TEXT` — who initiated the link
- `scope_people`
    - `role TEXT NOT NULL DEFAULT 'heir'` — `owner | heir | named_recipient | trustee`
    - `household_role TEXT` — `primary | partner` when the person is an owner
    - `email TEXT NOT NULL DEFAULT ''` — needed for the invite flow later
    - `account_status TEXT NOT NULL DEFAULT 'active'` — `active | invited | declined | deceased`
- `items`
    - `is_titled_property INTEGER NOT NULL DEFAULT 0` — separates cars,
      boats, LLC shares, etc. under a distinct heading on the printed
      trustee report; does not change addendum behavior.
- New tables:
    - `memorandum_claims` — state machine `proposed → agreed | contested | withdrawn`
    - `importance_claims` — state machine `proposed → agreed | declined | withdrawn`
- Two indices per table for the hot lookup paths (per-item and per-owner).

### `MemorandumClaimsRepo` (new)

Located at `packages/legacy-core-data/src/repos/memorandumClaimsRepo.js`.
Modeled on `WillsCaretakersRepo` — same constructor shape
`(db, audit = null)`, same "throw with `.status`" error style, same
`shape(row)` helper.

Public methods:

- `list(ctx)` — every claim in the household, newest first. Powers the
  Review-together tray.
- `listForItem(itemId, ctx)` — the parallel-claim view; both spouses
  can hold their own claim on the same shared item.
- `addendumPreview(finalOwnerParticipantId, ctx)` — the claims eligible
  for one spouse's addendum print, including `proposed` and `contested`
  claims so the printed page can annotate them. Excludes `withdrawn`.
- `get(claimId, ctx)`
- `create({ itemId, taggedByParticipantId, proposedHeirId, finalOwnerParticipantId?, finalHeirId? }, ctx)`
- `agree(claimId, { agreedByParticipantId }, ctx)` — self-agree rejected.
- `contest(claimId, { contestedByParticipantId, reason }, ctx)` — self-contest rejected.
- `withdraw(claimId, { withdrawnByParticipantId }, ctx)` — only the
  tagger can withdraw their own claim.
- `createPreLinkAgreed({ itemId, taggedByParticipantId, heirId, agreedAt }, ctx)`
  — the merge helper for pre-link `assigned_to_heir_id` values. Mints
  the claim directly in `'agreed'` status with a `'system'` agreer so
  intents already on that spouse's signed memorandum before the household
  existed retain their standing.

### `ImportanceClaimsRepo` (new)

Located at `packages/legacy-core-data/src/repos/importanceClaimsRepo.js`.
Same shape. Public methods:

- `list(ctx)`, `listForItem(itemId, ctx)`, `get(claimId, ctx)`.
- `summary(ctx)` — `{ agreed, proposed }` counts for the trustee cover
  sheet.
- `propose({ itemId, proposedByParticipantId, reason?, mode? }, ctx)` —
  when `mode === 'solo'` the claim enters `'agreed'` immediately (the
  single owner is both proposer and reviewer, preserving pre-couple
  behavior). When `mode === 'couple'` it enters `'proposed'`.
- `agree(claimId, { agreedByParticipantId }, ctx)` — self-agree rejected.
- `decline(claimId, { declinedByParticipantId, reason }, ctx)` —
  self-decline rejected.
- `withdraw(claimId, { withdrawnByParticipantId }, ctx)` — either owner
  may retract a household-level flag; unlike memorandum claims, Important
  is annotation on shared property, not per-spouse intent.

Both repos re-exported from `packages/legacy-core-data/src/index.js`.
Constants `MEMORANDUM_CLAIM_STATUSES` and `IMPORTANCE_CLAIM_STATUSES`
exported for enum introspection.

## Test coverage

New: `scripts/couple-claims-test.mjs` — pure DB layer, no HTTP server,
patterned on `two-outputs-bundle-test.mjs`.

**49 checks, all green:**

1. Migration 13 lands every declared column and table (11 checks)
2. Solo mode is unchanged — auto-agree, defaults hold (4 checks)
3. Memorandum happy path — Ann tags, Bob agrees (8 checks)
4. Memorandum contested path — reason recorded, still on preview (4 checks)
5. Memorandum authorization guards — no self-agree, no self-contest,
   only tagger can withdraw (5 checks)
6. Parallel claims — two spouses, same item, independent memoranda (3 checks)
7. Pre-link agreed conversion — merge helper produces `'agreed'` +
   `'system'` (3 checks)
8. Importance couple-mode review-together (4 checks)
9. Importance declined path with reason (3 checks)
10. Importance authorization guards — no self-agree, no self-decline (2 checks)
11. Enum constants are complete (2 checks)

## Regression check

The existing full test matrix still passes:

- `content-lint` — clean, no banned role vocabulary
- `roundtrip-test` — 66 checks
- `two-outputs-envelope-test` — 37 checks
- `two-outputs-bundle-test` — 60 checks
- `two-lane-test` — 22 checks
- `vision-test` — 32 checks

The two HTTP integration tests (`people-test`, `sign-test`) exhibit
pre-existing test-isolation failures against the persistent `data.db`
(stale signed record; heir names already on the roster). These are not
regressions from this slice — the failures pre-date any Couple-Mode
code, and Slice 1 does not touch any HTTP routes.

## What did NOT change

- No changes to routes.
- No changes to the sign flow or `AddendumVersionsRepo`.
- No changes to the printed memorandum or trustee cover sheet.
- No changes to the client UI. Solo owners see nothing new.
- `owner_high_value` / `owner_important_comment` on items are untouched
  and remain the current source of truth for Important in Solo mode.
- `assigned_to_heir_id` on items is untouched and remains the current
  source of truth for memorandum intent in Solo mode.

## What is next (Slice 2 preview, not yet built)

Slice 2 turns the claims tables on for the routes:

- Server sends `household_mode` in `/api/scope-summary` so the client
  knows whether to render solo or couple flows.
- New routes: `POST /api/memorandum-claims`,
  `POST /api/memorandum-claims/:id/agree | contest | withdraw`,
  and the same trio for `/api/importance-claims`.
- Every route derives `participantId` from the session cookie — never
  from the request body.
- The addendum preview and printed memorandum start reading from
  `memorandumClaimsRepo.addendumPreview()` when the scope is in couple
  mode, falling back to `assigned_to_heir_id` in solo mode.

Slice 3 is the invite flow and the household-link handshake. Slice 4
is the review-together tray UI. Slice 5 is the printed page + trustee
report changes. Each will get its own handoff.
