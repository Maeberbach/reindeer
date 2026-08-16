> **Superseded** — vocabulary in this document may use *PR*, *personal representative*, or *fiduciary* for what the current suite calls **trustee**, and may predate the three configurations and the heir-initiated end-trustee-mode endpoint. See [`docs/SUITE-OVERVIEW.md`](../SUITE-OVERVIEW.md) for the current model. This document is kept as history and is not being rewritten.

# FC v14 UI — Three Follow-ups Wired (2026-08-07)

Follows the Method Agreement UI landing at `c594540`. This turn ships the three UI follow-ups called out in that handoff:

1. **"Ask for an appraisal"** button on any item, any heir, any time before finalize
2. **Record of Decisions** preview + print on the PR dashboard
3. **Fiduciary page rewrite** — retires the v8 four-stage workflow in the UI

No schema, no wire format, no dependency changes. No new routes. No new auth surface. All existing tests remain green.

## What shipped

### 1. `AskForAppraisalButton` (new component)

`client/src/components/ask-for-appraisal.tsx` — a popover with an optional-reason textarea that calls `POST /api/fiduciary/items/:itemId/flag-high-value`. Identity comes from the cookie session; body carries `{ reason }` only. Idempotent — pressing it on an item already flagged just records the new reason on the audit trail.

Wired in two places:

- **Inventory page** — next to the existing "High value" nomination button. Both flows coexist because they mean different things: nomination is a two-heir confirmation during intake; "Ask for appraisal" is a single-heir escalation available any time before finalize.
- **Rank page** — next to the compact classification flag toggles on each item row, using `size="sm" variant="ghost"` so it doesn't crowd the drag/rank controls.

Toast copy is careful about state:

- First flag: "'X' has been added to the high-value list."
- Already flagged: "'X' is already on the high-value list — your reason has been added."

### 2. `RecordOfDecisionsCard` on PR dashboard

`client/src/components/admin-flow-cards.tsx` — new exported card, placed on the Session tab just under `CatalogingStatusCard`. Fetches `GET /api/fiduciary/record-of-decisions` on a 15s poll and surfaces:

- Four tabular counters: total items · awarded · appraised · pending appraisal (amber-tinted when non-zero)
- The pending-appraisal list (up to 6, then "and N more"), each showing who escalated it
- "Snapshot generated {timestamp}"
- Two buttons:
  - **Open printable view** — `window.open("/api/fiduciary/record-of-decisions/print")` in a new tab
  - **Print for trustee** — same open, then invokes `w.print()` on load so the browser Print dialog surfaces immediately

Same-origin fetch, `credentials: "include"` — the cookie session authenticates both endpoints. No `participantId` anywhere on the wire.

### 3. Fiduciary page rewrite

`client/src/pages/fiduciary.tsx` — replaced (1257 → 492 lines). The v8 `ValuationStage`, `EqualizationStage`, `ConsentStage`, `StageStepper`, `FourStageDetail`, and per-item `withParticipant()` helper are gone.

New shape:

- **Top card:** Method Agreement gate. Fetches `/api/fiduciary/method-agreements` and shows one of two states.
  - All signed → "You can finalize any high-value item below."
  - Otherwise → names the unsigned heirs and links to the Method Agreements tracker.
  - Three side buttons regardless: **Method Agreements** (in-app tracker), **Record of Decisions** (server-rendered printable in a new tab), and **Print for trustee** (new tab + auto-print).
- **Item list:** one card per high-value item.
  - Badge is one of `Finalized` · `Appraised` · `Waiting for appraisal`.
  - Shows the display value (`approvedValuation.value ?? latestValuation.value ?? item.estimatedValue`) with a small tag telling the reader whether it's an appraisal or estimate.
  - "Ask for appraisal" button (visible pre-finalize).
  - PR sees a **Finalize** button. Disabled until the Method Agreement gate is satisfied.
- **Finalize dialog:** four outcome buttons, plain-language:
  - "Assigned with equalization owed by the trustee" (`finalized_with_equalization`)
  - "All heirs agreed" (`finalized_by_consent`)
  - "Sold; proceeds go to the estate" (`finalized_by_sale`)
  - "PR override" (`finalized_by_override`)
- **Pending-appraisal note** on each pending item: "You can still finalize this item — it will be handed off marked as pending appraisal." This makes explicit v14's rule that a pending appraisal is *not* a blocker.

The v8 `blockers` array is still returned by the server but the UI never gates on it. If we ever surface it, it should be labeled "informational" — it does not reflect what `finalize()` actually enforces under v14.

### Why keep the two-heir nomination on inventory

`nominateHighValue` / `confirmHighValue` still lives on the inventory page because it is the *pre-ranking* mechanic that strips an item from the draft pool. `flagForAppraisal` is the *post-ranking* mechanic that keeps the item in the draft but marks it for trustee resolution. They coexist; nothing calls into the other's code path.

## Guardrails preserved

- **No `participantId` in request bodies, URLs, or headers.** Every new fetch uses `credentials: "include"` and reads identity from `req.actor` on the server. The legacy `withParticipant()` helper on the old `fiduciary.tsx` is gone with the rewrite; no new caller was added.
- **Elderly-friendly UI.** Plain language ("Waiting for appraisal", "Ask for appraisal", "All heirs agreed"), large targets, confirmation dialog before finalize. No "fiduciary" / "equalization" / "threshold" jargon in copy.
- **No sweeping renames, no dependency reinstall, no schema change.**
- **Every item still printable.** The Record of Decisions endpoint is server-rendered HTML; browsers handle print natively.

## Test baseline (all green)

- `npm run check` (tsc) — clean
- `server/auth/selftest.mts` — 47/47
- `server/fiduciary/selftest.mts` — 51/51
- `server/import/selftest.mts` — 38/38
- `scripts/roundtrip-test.mjs` — 66/66
- `npm run build` — succeeds (client + server bundles)

## Files changed

- **New**
  - `client/src/components/ask-for-appraisal.tsx` (153 lines)
  - `docs/handoffs/2026-08-07-fc-v14-three-followups.md` (this handoff)

  (Line counts reflect the final state after the touch-target follow-up landed in the same window — see the section at the bottom.)

- **Modified**
  - `client/src/pages/inventory.tsx` — import + one button under the row action group
  - `client/src/pages/rank.tsx` — import + one button next to compact FlagToggles
  - `client/src/pages/fiduciary.tsx` — full rewrite, v14-native
  - `client/src/pages/admin.tsx` — import `RecordOfDecisionsCard` and render on Session tab
  - `client/src/components/admin-flow-cards.tsx` — new `RecordOfDecisionsCard` export

## Known follow-ups (not shipped this turn)

- The old v8 four-stage backend endpoints (valuations, equalization decisions, consents) still exist and are still exposed on `/api/fiduciary/...`. The UI no longer calls them. They can be deleted in a later cleanup pass; leaving them for now to avoid churn while we watch v14 settle.
- The rank-page appraisal button uses `variant="ghost"` with `min-h-[44px]` — the row grows slightly on rank to meet the touch target. If the rank rows feel busy on mobile, consider moving the appraisal button into a per-item overflow menu (kebab).
- The "Print for trustee" button relies on `window.print()` firing after `load`. On some browsers pop-up blockers may swallow the second open even though it originated from a click; users can always fall back to "Open printable view" and use Ctrl/Cmd-P.
- The `blockers` array in `HighValueItemSummary` is now cosmetically dead in the UI. If we want to be tidy we can drop it from the wire, but the roundtrip and self-tests still exercise it, so no rush.

## Follow-up: touch-target sweep on the new controls

After an internal review flagged that the "large targets" claim didn't match reality, every button introduced in this turn was bumped to at least 44×CSS-px vertical (48 for the finalize outcome buttons, which carry the longest copy). The `Button` component's shadcn `sm`/`default` sizes resolve to `min-h-8` and `min-h-9` — not enough on their own for elderly users — so the new controls set `min-h-[44px]` explicitly and use `h-4 w-4` icons instead of `h-3.5`.

- **`AskForAppraisalButton`** — trigger, cancel, and confirm all `min-h-[44px]`. The compact form adds `min-w-[44px]` so the icon-only pill still meets the touch spec.
- **Fiduciary page top card** — Method Agreements, Record of Decisions, and Print for trustee all `min-h-[44px]`.
- **Fiduciary per-item Finalize button** — `min-h-[44px]`.
- **Finalize dialog outcome buttons** — `min-h-[48px]` to give the longer plain-language copy vertical breathing room; the Cancel affordance is `min-h-[44px]`.
- **`RecordOfDecisionsCard` on PR dashboard** — Open printable view and Print for trustee both `min-h-[44px]`.

What we deliberately did **not** touch:

- The pre-existing two-heir nomination flow ("High value" / "Confirm") on the inventory row and the classification `FlagToggles` — those predate this deliverable. They are candidates for a separate elderly-friendliness sweep across the older pages.
- The rank page's drag-handle and per-row rank input — the appraisal button on rank rows now honors `min-h-[44px]` (rows will grow slightly, which was already a documented trade-off).

Tests re-ran green after the follow-up: tsc clean, auth 47/47, fiduciary 51/51, import 38/38, roundtrip 66/66, `npm run build` succeeds.
