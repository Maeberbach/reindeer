# Owner → heir → trustee alignment — handoff

**Date:** 2026-08-08
**Scope:** Both apps (FairPlay + Registry) and shared packages
**Baseline:** commit `88c4022` ("FC v14 three follow-ups")

## What changed and why

The suite had drifted between three overlapping role words — *personal representative*, *fiduciary*, *PR* — for one job: **trustee**. It also carried two behavior gaps that made the "three configurations" model less than fully honest:

1. `transfer-pr` still offered `new_outside_pr` mode, which duplicated Configuration 2 and let the captain role leak to a non-heir without going through the trustee path.
2. Once the trustee was invited and took over the game (Configuration 2), only the trustee themselves could hand it back — heirs could not end trustee mode. That made "the trustee is a service the family invited" untrue in practice.

This handoff records the full alignment pass. Historical documents are kept and now carry a Superseded banner. Nothing in the wire format or database schema changed.

## The vocabulary, locked

- **Owner** — the person whose belongings the app is helping distribute.
- **Heir** — a person who may receive items. Drafts, ranks, bids, receives. An heir is never a trustee.
- **Trustee** — the fiduciary named by the trust or will. Never drafts, never ranks, never receives. May be listed for the record only, or invited into the app to referee (Configuration 2). A trustee is never an heir.
- **Captain** — the session role that runs a phase. Either an heir or the trustee wears it in a given moment.

No other role words appear in user-visible copy. Route paths, DB columns, and JSDoc still contain the legacy words where changing them would break the wire format.

## The three configurations, locked

| # | Captain | Trustee inside app | Trustee documented outside |
|---|---|---|---|
| 1 | An heir | No | Yes (or not present) |
| 2 | The trustee | Yes, referees the game | Yes (this is the trustee) |
| 3 | An heir | No | No trustee at all |

Configuration 2 is now genuinely reversible: any heir may end trustee mode.

## Behavior changes

### 1. `new_outside_pr` mode removed from `transfer-pr`

- Endpoint: `POST /api/session/transfer-pr`
- Old accepted modes: `to_existing_heir`, `new_outside_pr`
- New: `to_existing_heir` only.
- Old callers get **400** with a schema-refusal message.
- Outside oversight now goes through the trustee endpoints only (`/api/session/trustee/invite`, `/api/session/mode/trustee/take-over`).

### 2. Heir-initiated end-trustee-mode

- New endpoint: `POST /api/session/trustee/end-mode`
- Actor: any signed-in **heir** (including the heir-admin). Not the trustee themselves.
- Trustee still hands captaincy back via the existing `/api/session/trustee/hand-back` route.
- Wire: sets `session.trusteeMode = false`, clears `session.trusteeParticipantId`. The trustee row remains in the roster (a heavy `remove trustee` action is a separate future step and is out of scope here).
- New TrusteeBanner control on the client: heirs see **"End trustee mode"**; the trustee sees **"Hand back"**.

### 3. Copy purge across both apps

Every user-visible surface uses **trustee** (never "personal representative", "fiduciary", or a bare "PR"). One controlled exception: the disclosure line that reads "The app calls them the trustee — your legal documents may say personal representative." This line exists to bridge the vocabulary for a lay reader and is allow-listed in `scripts/content-lint.mjs`.

Files touched (representative, not exhaustive):

- `apps/reindeer-fair-play/client/src/**` — page titles, banners, form labels, attestation options.
- `apps/reindeer-fair-play/server/routes.ts` and `server/storage.ts` — human-readable messages.
- `apps/reindeer-fair-play/server/audit/auditTrail.ts` — the printable audit trail PDF.
- `apps/reindeer-registry/client/**` and `apps/reindeer-registry/preview/**`.
- `packages/legacy-print-feature/src/templates/**` — printable owner-facing artifacts.
- `docs/SUITE-OVERVIEW.md`, `docs/DESC-FAIR-CHOICE.md`, `docs/DESC-REGISTRY.md`, `docs/TWO-LISTS.md`, `docs/PROBATE-CLASSES.md`, `docs/ROADMAP.md`, `README.md`.

### 4. Historical docs — Superseded banners

Every file under `docs/handoffs/` and `docs/decisions/` that used the old vocabulary now has a first-line **Superseded** banner pointing to `docs/SUITE-OVERVIEW.md`. `docs/fair-choice-audit.md` gets the same banner. The banner is idempotent: rerunning `add_superseded_banner.py` will not add a second one.

The audit inventory in `docs/fair-choice-audit.md` deliberately references the code names (migrations like `v8_high_value_fiduciary.ts`, tables like `highValueAuditLog`) and is kept as a technical registry with the banner on top.

## New and touched files

**New tests / scripts**

- `scripts/content-lint.mjs` — visible-copy lint for the banned role words. Skips route paths, testids, import paths, and JSDoc. Allow-lists the bridging disclosure. Runs clean today.

**Changed self-tests**

- `apps/reindeer-fair-play/server/trustee/selftest.mts` — extended from 44 → **56** checks. New sections:
  - Section 6: `transfer-pr` refuses `new_outside_pr` (400).
  - Section 7: `end-mode` works for any heir, refuses the trustee themself (403), refuses when off (409), refuses anonymous (401), and heir-admin can end mode too.

**Existing self-tests** — untouched but re-run to confirm no regressions.

## Test results

All from a clean `data.db*`:

| Suite | Result |
|---|---|
| `npm run check` (tsc) | clean |
| `npm run build` | clean |
| `server/auth/selftest.mts` | 47/47 |
| `server/fiduciary/selftest.mts` | 53/53 |
| `server/import/selftest.mts` | 45/45 |
| `server/import/detectOwnerAssignment.selftest.mts` | 13/13 |
| `server/trustee/selftest.mts` | **56/56** (was 44) |
| `scripts/roundtrip-test.mjs` | 66/66 |
| `scripts/content-lint.mjs` | clean |

Total selftest checks across the suite: **214** for FC + roundtrip.

## What did **not** change (deliberate)

- Wire values in the database: `role: "pr"`, endpoint paths `/api/fiduciary/*`, migration filenames like `v8_high_value_fiduciary.ts`, and DB tables like `highValueAuditLog`. Changing these would be a schema/wire-format change and would break back-compat with any exchange envelope already on disk.
- Attestation option **values** remain `executor` / `personal_representative` for legal integrity; only the **labels** shown to the user changed.
- Historical handoffs and decisions are kept as history with a banner. History was not rewritten.

## Re-run recipe

```bash
cd apps/reindeer-fair-play
npm run check
npm run build
rm -f data.db* && npx tsx server/auth/selftest.mts
rm -f data.db* && npx tsx server/fiduciary/selftest.mts
rm -f data.db* && npx tsx server/import/selftest.mts
rm -f data.db* && npx tsx server/import/detectOwnerAssignment.selftest.mts
rm -f data.db* && npx tsx server/trustee/selftest.mts

cd ../..
node scripts/roundtrip-test.mjs
node scripts/content-lint.mjs
```

Expected: tsc clean, build clean, 47 / 53 / 45 / 13 / 56 / 66 checks, `content-lint: clean`.

## Follow-ups (not done here)

- Remove the trustee **row** from the roster (not just clear trustee-mode) when an heir ends trustee mode. Today the row remains and lets the trustee be re-invited without re-collecting their email; treat that as a small future decision.
- Migrate wire values `role: "pr"` and `/api/fiduciary/*` to their trustee names as a separate, warned schema/wire-format change.
- Registry side does not yet know about Configuration 2. The `recipient_hint` remains non-binding and the Registry itself has no trustee-mode. That is by design for now.
