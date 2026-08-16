# Commit 4b — memorandum-locked UI + copy + guard-rail selftest — handoff

**Date:** 2026-08-09
**Commit context:** builds on commit 4a (`bc52468`)
**Scope in one line:** the memorandum-locked flow that shipped in 4a as backend + wire format now has (a) a greyed FC UI grouped by owner, (b) the user's approved "preparation tool, not a legal document" copy at the three Registry places that see the owner or the trustee, and (c) an end-to-end selftest that walks sign → export → freeze → refused second sign → still travels in export.

## What changed

### FairPlay — greyed rows on the results page

`apps/reindeer-fair-play/client/src/pages/results.tsx`

The single "Already assigned by the owner" section is now split into two:

1. **`Handled as special gifts under {ownerName}'s will`** — one section per deceased owner (grouped by `memorandumOwnerName`, which the exporter fills from the participant record). Cards are visually disabled (`opacity-70`, `border-dashed`, `bg-muted/40`, `cursor-not-allowed`, `aria-disabled="true"`) and carry a fixed caption: *Handled as a special gift under the will.* Recipient identity is NEVER rendered here — that lives on the paper the trustee holds.

2. **Already assigned by the owner** — the pre-4 recipient-hint / comment-detection cases keep the existing card treatment with `To: {ownerAssignedName}` visible. Unchanged behaviour for the non-memorandum path.

Preamble note (verbatim from the commit 4 decision, per section per deceased owner): "A word before we begin. The list of special gifts you'll see below was captured from Registry when the memorandum was last signed. Between that day and this one, {ownerName} may have signed a newer paper memorandum, added handwritten notes, or made changes their trustee is holding but Registry never saw. If something here doesn't match what the trustee has on paper, the paper is what governs. Ask the trustee. We can't plan for everything."

The greying is visual only — the ranking pool already excludes `status === 'owner_assigned'` (rank.tsx:416). Nothing about pool eligibility changed.

### Registry — "preparation tool, not a legal document" copy at three points

`apps/reindeer-registry/client/index.html`

- **Welcome screen** (line 65). The old "You are not signing anything" note now leads with the three-point statement (preparation tool / paper governs / replace or amend on paper at any time) before the existing "nothing leaves this app" reassurance.
- **Sign screen** (line 818). Removed the previous "Once signed, it becomes a legal document" line, which directly contradicted the user's commit 4 copy directive. Replaced with the same three-point statement plus the versioning note.

`packages/legacy-exchange/src/two-outputs-bundle.js`

- **Bundle cover.** Every `.inventory` and `.addendum` zip now carries a `README.txt` at the top of the archive containing the same three-point statement, phrased for the trustee/attorney opening the bundle. The `README.txt` is included in `checksums.txt` so tamper-detection covers it. Manifest.files lists it. Backward-compatible — old readers see one extra file they can ignore.

### Registry — freeze-flow selftest

`scripts/two-outputs-bundle-test.mjs` grew a new **Section 6 — Freeze flow — memorandum lifecycle across owner death**:

1. Owner signs v1.
2. Pre-death export carries zero locked memoranda (`counts.locked_memoranda === 0`).
3. Trustee calls `freezeLatest`. Idempotent (calling twice returns the same `frozen_at`).
4. Second sign after freeze is refused with the exact message the user approved: `/memorandum has been frozen/i` AND `/paper the trustee holds is what governs/i`.
5. No ghost v2 gets written despite the refusal — `addendum_versions.list` still returns one row.
6. Post-death export carries the frozen memorandum: `locked_memoranda[0].owner_name === 'Mark Freeze'`, `item_ids === [watch.item_id]`, per-item `is_locked_gift === true`, `counts.locked_by_memorandum === 1`.
7. The written `.legacy` zip re-reads without checksum problems.

Plus two new checks in Section 2 and Section 3 asserting `README.txt` is in both bundle types and carries the three lines.

Result: `two-outputs-bundle-test.mjs` went from 40 → **55 checks**, all passing.

### Also fixed here

- **B-002** (medium, vision high-value promotion): the test asserted a design that never shipped. Registry deliberately always sets `high_value_flag: false` — FairPlay does the tiering (see `vision/anthropic.js:259`, `vision/index.js:41`, and the P-002 patent note on quarantine being FC's responsibility). Test rewritten to assert the actual design; decision captured at `docs/decisions/2026-08-09-registry-does-not-set-high-value-flag.md`. Vision now 31 → 32 checks (the rewrite kept the range-still-travels assertion and split it).
- **B-001** (low, project instructions): the four in-instructions test counts were stale after 4a's additions. Fixed with `pplx project edit` — instructions now reference roundtrip 66, fiduciary 133, import 54, trustee 45 (auth 47 was already right). No code change.
- **TSC hole in FC**: `server/import/selftest.mts` calls `writeBundle` with the two new-in-4a optional params (`addendumVersions`, `people`). The exchange package ships no `.d.ts`, so `tsc` inferred a narrower parameter shape and rejected the extra fields. Cast the args object to `any` in the selftest (only in the test — production paths still get JSDoc types). `npm run check` now clean.

## Runtime check matrix — all green

| Suite | Count | Status |
|---|---|---|
| roundtrip-test | 66 | ✓ |
| two-outputs-envelope-test | 37 | ✓ |
| two-outputs-bundle-test | 55 (was 40; +15 from freeze section + README checks) | ✓ |
| two-lane-test | 22 | ✓ |
| vision-test | 32 (was 31; +1 from B-002 rewrite splitting one check into two, minus one obsolete) | ✓ |
| content-lint | clean | ✓ |
| FC auth selftest | 47 | ✓ |
| FC fiduciary selftest | 133 | ✓ |
| FC import selftest | 54 | ✓ |
| FC trustee selftest | 45 | ✓ |
| FC `npm run check` (tsc) | clean | ✓ |
| FC `npm run build` | ✓ built | ✓ |

## Two things I did NOT touch

- **`inventory.tsx` (FC admin/PR list).** The greyed cards live on the results page (where heirs actually see them). The PR-facing inventory grid still shows every item without a memorandum badge. Noted as follow-up if the PR wants to see the flag at a glance in that view — no user request yet.
- **A parallel greyed treatment during `rank.tsx` / `rank-all.tsx`.** Those pages already filter to `status === 'available'`, so heirs never see memorandum-locked items in the ranking pool at all. The greying only matters where the awards ledger is shown — that's results.

## Files touched

- `apps/reindeer-fair-play/client/src/pages/results.tsx` — split section, add preamble + greyed cards
- `apps/reindeer-fair-play/server/import/selftest.mts` — cast writeBundle args to `any`
- `apps/reindeer-registry/client/index.html` — welcome + sign copy
- `packages/legacy-exchange/src/two-outputs-bundle.js` — README.txt in both bundles
- `scripts/two-outputs-bundle-test.mjs` — freeze flow section + README checks
- `scripts/vision-test.mjs` — B-002 rewrite
- `docs/bug-log.md` — B-001 + B-002 marked fixed
- `docs/decisions/2026-08-09-registry-does-not-set-high-value-flag.md` — new

## Not in scope for 4b (paused as requested)

- Bulk-assign path
- Remove-button work
- inventory.tsx memorandum badge

Awaiting user approval before proceeding.
