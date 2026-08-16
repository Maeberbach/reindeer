> **Superseded** — vocabulary in this document may use *PR*, *personal representative*, or *fiduciary* for what the current suite calls **trustee**, and may predate the three configurations and the heir-initiated end-trustee-mode endpoint. See [`docs/SUITE-OVERVIEW.md`](../SUITE-OVERVIEW.md) for the current model. This document is kept as history and is not being rewritten.

# Handoff — FairPlay v14 Trustee Handoff rescope (built)

**Date:** 2026-08-07
**Branch state:** on top of commit `95c95a4` (the spec-approval handoff).
**Scope:** Reshaped the v8 fiduciary runtime from **Equalization Ledger**
(approve value → pick equalization path → collect per-item consent → gated
finalization) into **Trustee Handoff** (any heir can flag → PR records
appraised value → item stays in draft → finalization produces a Record of
Decisions the trustee balances externally).

Spec this implements: `docs/decisions/2026-08-06-fc-v8-trustee-handoff-rescope.md`.

---

## What shipped

### Schema (`apps/reindeer-fair-play/shared/schema.ts`)

- Added `methodAgreements` table with a unique index on
  `(sessionId, participantId)`; each row captures `agreementVersion`,
  `agreementTextSnapshot`, signature method, IP, and user agent. Immutable
  once written.
- Added `CURRENT_METHOD_AGREEMENT_VERSION = "1.0"` and
  `CURRENT_METHOD_AGREEMENT_TEXT` as code constants — version bumps stay
  git-auditable and old rows keep the text they were signed against.
- Added `"trustee_handoff"` to `FINALIZATION_OUTCOMES` and
  `"method_agreement_signed"` to `HIGH_VALUE_AUDIT_EVENTS`.
- Relaxed `finalizationEvents.approvedValuationId` to nullable and
  `approvedValue` to `notNull().default(0)` — pending-appraisal items can
  finalize without a value.

### Migration (`server/migrations/v14_trustee_handoff.ts` — new file)

- Creates `method_agreements` with matching unique index; safe on both fresh
  and existing DBs.
- Also fixed `v8_high_value_fiduciary.ts` inline so new-DB creations match
  the relaxed `finalization_events` shape (existing DBs at v8 were relaxed
  by drizzle-kit push during the build).

### Storage (`server/fiduciary/fiduciaryStorage.ts`)

Four new methods:

- `flagForAppraisal(itemId, actorId, reason)` — any authenticated
  participant may flag; sets `isHighValue=true` and transitions from
  `normal` to `flagged_high_value`; idempotent; always writes a `flagged`
  audit row.
- `recordMethodAgreement({sessionId, participantId, …})` — snapshots the
  current version + text at sign time; rejects duplicates with a 409; writes
  a session-scoped `method_agreement_signed` audit row (itemId=0).
- `listMethodAgreements(sessionId)` and
  `allHeirsHaveMethodAgreement(sessionId)` — read-side helpers.
- `generateRecordOfDecisions(sessionId)` — the trustee-facing document:
  every item, awarded-to, appraised value or pending-appraisal marker,
  escalating heir per pending item, session-level totals. Read-only, no
  audit rows, no side effects.

Rewritten `finalize()`:

- The old blocker gate (approved value + equalization path + unanimous
  consent) is gone.
- New session-scoped precondition: every non-admin heir must have a Method
  Agreement.
- `approvedValuationId` and `approvedValue` are read opportunistically; a
  pending-appraisal item finalizes with `approvedValuationId=null` and
  `approvedValue=0`, and the audit payload marks `pendingAppraisal=true`.
- `pr_override` still produces `finalized_by_override`; audit language is
  backward-compatible.

Kept intact: `addValuation`, `approveValuation`, valuation supersession,
`decide`, `requestConsents`, `respondConsent`, `finalizationStatus`,
`listHighValueItems`. The runtime no longer requires them to close an item,
but they remain callable and their data persists.

### Routes (`server/fiduciary/router.ts`)

Five new endpoints, all authenticated via the existing `req.actor` guard:

- `POST /items/:itemId/flag-high-value` — any authenticated actor; body
  optional `{ reason }`.
- `GET /method-agreements` — lists all agreements for the current session.
- `POST /method-agreements` — records the current actor's own agreement.
- `GET /record-of-decisions` — JSON structured document.
- `GET /record-of-decisions/print` — server-rendered HTML for printing.

Added `renderRecordOfDecisionsHtml(record)` helper — large-type,
elderly-friendly, plain-language print CSS, no JS required.

### Phase gate (`server/storage.ts`)

`markInventoryComplete()` now refuses to open ranking until every non-admin
heir on the roster has a Method Agreement. The check is inlined (direct
query on `method_agreements`) rather than calling
`fiduciary.allHeirsHaveMethodAgreement` to avoid a storage↔fiduciary
circular import.

### Docs

- `docs/DESC-FAIR-CHOICE.md` — appended a "Trustee Handoff model (v14,
  revised)" section covering what changed, what did not change, where the
  seam with the trustee sits, and honest limits.
- `docs/fair-choice-audit.md` — prepended a HISTORICAL DOCUMENT banner
  flagging the stale "no auth model" and Equalization-Ledger paragraphs;
  routes readers to the spec and DESC for current behavior.

### Tests

- Rewrote `server/fiduciary/selftest.mts` from 40 checks (Equalization
  Ledger) to **51 checks** across six sections: Method Agreement gate,
  flag for appraisal, valuation lifecycle, Record of Decisions,
  finalization under Trustee Handoff, audit-trail integrity. Also forces
  the scratch session's `phase` back to `intake` so the phase gate's
  Method-Agreement check is genuinely tested.

**Final test tally, all green:**

| Suite | Before | After |
|---|---|---|
| `npm run check` (tsc) | clean | clean |
| `server/auth/selftest.mts` | 47 | 47 |
| `server/fiduciary/selftest.mts` | 40 | **51** |
| `server/import/selftest.mts` | 38 | 38 |
| `scripts/roundtrip-test.mjs` | 66 | 66 |

---

## Deviations from the spec (surfaced during build)

1. **`finalization_events.approvedValuationId` and `approvedValue` had to
   be relaxed.** The spec did not call this out explicitly — the runtime
   needs to write a finalization event for a pending-appraisal item with no
   valuation on file. Relaxed both columns (nullable and defaulted-zero
   respectively). The corresponding DDL in `v8_high_value_fiduciary.ts` was
   fixed inline so fresh DBs match; existing DBs were relaxed by the
   drizzle-kit push run during the build. No data lost, no reads broken.
2. **Session-scoped audit rows use `itemId=0`.** The `high_value_audit_log`
   schema requires an `itemId`. `method_agreement_signed` events are
   session-scoped (no item involved), so they are written against `itemId=0`
   to keep the append-only log unified without polluting per-item logs. The
   spec left this unspecified.
3. **Deprecated routes are still mounted.** As approved by the owner during
   spec review, `decide`, `requestConsents`, `respondConsent`, and the
   equalization-threshold PATCH endpoint remain wire-accessible for
   backward compatibility. A follow-up commit can remove them without
   affecting current sessions.

---

## What remains

1. **UI work.** The backend is fully wired but no client screens exist for:
   - Method Agreement sign flow (per-heir, before intake closes).
   - Flag-for-appraisal button in item detail (any heir).
   - Record of Decisions viewer / print button on the PR dashboard.
   The dashboard's blockers list may show stale strings for sessions that
   were mid-flight when this landed; a UI grep of "consent", "equalization
   path", and "approve value" is worth a pass.
2. **Deprecated route cleanup.** Follow-up commit: remove
   `POST /items/:id/decide`, `POST /items/:id/consents/*`,
   `POST /items/:id/threshold-breach*`, and `PATCH /thresholds` once UI
   stops calling them. Storage methods stay `@deprecated` but callable
   until then.
3. **FairPlay vs FairSplit positioning comparison.** Deferred deliverable
   from earlier in the session. Research already saved to
   `/home/user/.pplx/search/pplx_sdk_2026-08-07T00-43-46.764177Z_7983997d.json`
   and `.../00-50-05.113608Z_58ea79e1.json`. Owner-endorsed positioning
   lines: "Fair, not Equal — because families aren't calculators" and
   "Your estate attorney handles the money. We handle what's in the house."
4. **Legal review of the Method Agreement text.** The current copy in
   `CURRENT_METHOD_AGREEMENT_TEXT` is plain-language stand-in wording.
   Owner may want an attorney to bless it before rollout; version bumping
   is easy — increment the constant, no schema change, old rows keep their
   snapshot.

---

## Standing rules for the next session

- **Warn the user BEFORE any rename, sweeping find-and-replace, dependency
  reinstall, or schema/wire-format change.**
- **Never reintroduce identity from `req.body.participantId`, an
  `x-participant-id` header, or `?participantId=`.** Auth stays real.
- **UI must stay legible and forgiving for elderly users** — large type,
  large targets, plain language, no jargon, confirm before anything
  irreversible.
- **Every item must be printable.** Record of Decisions has its own
  print-only CSS; keep new views on the same standard.
- **Self-tests MUST import `../testing/scratchEnv` as their FIRST import.**
  ESM hoisting means anything else touches real data.
- **Root-level `npm install` prunes `apps/reindeer-fair-play` deps** —
  reinstall inside the app directory afterwards.
- **FairPlay, not Equal Choice.** No dollar equalization inside FC. The
  trustee balances the money.

---

## Commands to reproduce the green state

```bash
# From the repo root
cd apps/reindeer-fair-play
npm run check                                    # tsc, clean
npx tsx server/auth/selftest.mts                 # 47/47
npx tsx server/fiduciary/selftest.mts            # 51/51
npx tsx server/import/selftest.mts               # 38/38
cd -
node scripts/roundtrip-test.mjs                  # 66/66
```
