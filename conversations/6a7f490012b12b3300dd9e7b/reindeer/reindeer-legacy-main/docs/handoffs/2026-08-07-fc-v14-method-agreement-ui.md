> **Superseded** — vocabulary in this document may use *PR*, *personal representative*, or *fiduciary* for what the current suite calls **trustee**, and may predate the three configurations and the heir-initiated end-trustee-mode endpoint. See [`docs/SUITE-OVERVIEW.md`](../SUITE-OVERVIEW.md) for the current model. This document is kept as history and is not being rewritten.

# FairPlay v14 — Method Agreement UI (handoff)

**Date:** 2026-08-07
**Scope:** Client-only. No schema, wire-format, migration, or dependency changes.
**Precedes:** `2026-08-07-fc-v8-trustee-handoff-built.md` (backend v14).

## What shipped

The UI for the Method Agreement flow — the up-front buy-in every heir signs
before ranking opens. All three surfaces the backend exposed now have a place
in the app:

1. **`/method-agreement` (heir sign flow)** — new page. Shows the exact agreement
   text at large type, an acknowledgement checkbox, and a two-step confirm
   button ("Sign the Method Agreement" → "Yes, sign it now"). On success it
   replaces itself with a printable receipt showing the date, version, and the
   snapshotted language the heir signed.
2. **`/method-agreements` (PR tracker)** — new page. Roster of heirs with signed
   / not-signed status, a status banner (`N of M signed`), and a preview of the
   current agreement text. Read-only: the PR cannot sign for anyone else.
3. **Guided next-step for heirs** — `useGuidedSteps` now inserts a
   "Sign the Method Agreement" step between "Confirm your profile" and
   "Inventory", visible only to heirs while ranking has not yet opened. Goes
   green the moment this heir signs.
4. **NAV entries** — sidebar now includes "My agreement" (heirs) and
   "Method Agreement" (PR). Both use the `phaseAllows` gating already in place.
5. **Cataloging card gate** — the "Mark inventory complete" button on the PR's
   Administration page now shows a status row above it (`N of M signed · Waiting
   on: X, Y`) and is disabled while any heir has not signed. This prevents the
   PR from pressing the button and getting a 409 from the server; the server
   check in `mark-inventory-complete` remains the source of truth.

## Files changed

| Path | Change |
|---|---|
| `apps/reindeer-fair-play/client/src/pages/method-agreement.tsx` | New — heir sign page |
| `apps/reindeer-fair-play/client/src/pages/method-agreements.tsx` | New — PR tracker page |
| `apps/reindeer-fair-play/client/src/App.tsx` | Two new `<Route>` wires + imports |
| `apps/reindeer-fair-play/client/src/components/shell.tsx` | Two new NAV entries + `ClipboardCheck` / `Handshake` icon imports |
| `apps/reindeer-fair-play/client/src/lib/app.tsx` | `useGuidedSteps` inserts the Method Agreement step for heirs; fetches `/api/fiduciary/method-agreements` to keep `done` accurate |
| `apps/reindeer-fair-play/client/src/components/admin-flow-cards.tsx` | `CatalogingStatusCard` shows the gate status and disables the button while blocking |

## Design notes

- **Elderly-user rules honored throughout.** All buttons ≥ 44px (most 48–52),
  agreement text at `text-lg`/`text-xl` with `leading-[1.7]`, no jargon
  (never uses "fiduciary", "equalization", "override"), and signing follows the
  confirm-before-irreversible pattern.
- **Identity from the server session only.** The POST to
  `/api/fiduciary/method-agreements` sends **no body** — the server reads
  `req.actor` and refuses without a session. There is no `participantId` in the
  request from anywhere in this UI. This preserves the fix for the earlier
  impersonation hole.
- **No drift between shown text and stored text.** The client imports
  `CURRENT_METHOD_AGREEMENT_TEXT` / `CURRENT_METHOD_AGREEMENT_VERSION` from
  `@shared/schema`. The server snapshots the same constants onto each row at
  sign time via `recordMethodAgreement`. If the text is ever edited both sides
  ship the new copy together; historical rows retain their own snapshot.
- **Printable receipt.** The signed state renders a `no-print`-tagged Print
  button and an on-page receipt that a browser Print dialog will preserve —
  satisfies the "every item must be printable" project rule for the
  agreement itself.
- **PR can also sign** if the PR is also on the heir roster (i.e. is a
  PR-heir). A small amber note on the page says so.

## Test results

- `npm run check` (tsc) — clean.
- `server/auth/selftest.mts` — 47/47.
- `server/fiduciary/selftest.mts` — 51/51.
- `server/import/selftest.mts` — 38/38.
- `scripts/roundtrip-test.mjs` — 66/66.
- `npm run build` — succeeds; single ~1.1 MB client chunk (unchanged pattern).

No server code was touched. All backend gates still work exactly as they did
when `e85715d` landed.

## Follow-ups (not this task)

Still open from the backend handoff:

- **Flag-for-appraisal button** in item detail (any heir; server endpoint
  `POST /api/fiduciary/items/:itemId/flag-high-value` is live).
- **Record of Decisions viewer / print button** on the PR dashboard
  (`GET /api/fiduciary/record-of-decisions{,/print}` both live).
- **Stale UI grep**: the fiduciary page still references "consent" and
  "equalization path" flows that v14 no longer requires. The endpoints still
  return work responses but the UI screens no longer gate anything. Rewrite
  when we take the next pass at that page.
