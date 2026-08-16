# Fiduciary Scope Collapse — Target-State Spec (v2)

**Date:** 2026-08-08 (revised)
**Author:** Perplexity Computer, at the direction of the project owner
**Supersedes (in part):** Prior fiduciary workflow inside Reindeer: FairPlay — the approval, equalization, consent, and finalization endpoints described in `docs/SUITE-OVERVIEW.md`.

**Revision history:**
- v1 — first target-state pass. Two-bucket ledger, remove equalization/consent/finalize.
- v2 — corrected against the code: engine already runs per-stage; escalation to high-value is single-actor (heir / owner / AI), captain can revert with the flagger's approval.

## 1. One-line statement

**Reindeer: FairPlay runs the game. The trustee runs the trust. The app never equalizes and never finalizes.** The final report is a compliance-safety ledger the trustee reads before doing their own fairness work outside the app.

## 2. Why this matters

The captain-model reshape earlier today clarified *who acts inside a session*. It did not fix a deeper miscue: **the app itself contains equalization math, consent tallies, and a finalize-lock step that belong to the trustee, not to the app.**

Real-world consequence today:

- The app can refuse to finalize a high-value item if strict-mode thresholds are breached, blocking heirs from completing their game.
- The app records "equalization decisions" (transfer plans, PR-override rationales) that the trustee has no obligation to honor.
- The app tallies "consent" from heirs on transfers — a fiduciary act the trustee's counsel will re-perform anyway.
- The word "fiduciary" is scattered across URLs, table names, and UI copy, telling users the app is doing fiduciary work when it is not.

Under the trust's own authority, none of that is the app's job. The app should:

1. Let heirs draft, rank, and take items to completion — no gate for value. The engine already runs the game per-stage (heirloom, jewelry, custom categories, general round) with a session-scoped loss counter carrying across stages. That behavior stays.
2. Let any of three actors flag an item as **high-value → out of the game, into the trustee's hands**: any heir, the owner (via Registry upstream), or the AI during intake. Single-actor, no confirmation gate. The captain can revert an honest mistake during the game, with the flagger's approval.
3. Produce a **per-stage ledger + a trustee-escalation bucket** at the end: for each stage that ran, list what each heir received and the estimated total; separately, list every item escalated to the trustee with the escalation source. Every escalated item is named so the trustee can commission appraisals.
4. Stop there.

The trustee then, outside the app: commissions appraisals, applies whatever equalization or nullification the trust requires, and finalizes inheritance under their own signature.

## 3. What stays

The following capabilities remain unchanged in the app:

- **The whole game engine.** Registration → intake → ranking → groupings → draft → secondary_ranking → secondary_draft → complete. The engine already runs the multi-stage game correctly.
- **Stages / groupings.** The `groupings` table and `StageProgress` machinery already split items into per-category rounds (heirloom, jewelry, custom stages, general round). No change.
- **The session-scoped loss counter (`contestedLossCounter`).** One integer per participant. Carries across every stage automatically. No change.
- **The captain role and the four kinds of person who can wear it.** Nothing about captaincy or session management changes.
- **The method agreement.** Every heir still re-signs a v2.0 agreement naming the current captain. Composite unique on `(session_id, participant_id, captain_participant_id)` stays.
- **Auth, magic-link sign-in, deny-by-default over `/api`.** No change.
- **Trustee take-over / hand-back.** No change.
- **Snapshot export** (graceful exit, read-only). No change.
- **The `is_high_value` flag on items.** Retained for transparency.
- **The `high_value_audit_log` table.** Retained but its role narrows to a transparency ledger: who flagged what, when, why, plus reversion history.
- **`itemValuations` table** — its semantics narrow: an heir or the captain can attach an estimated value. The app never approves, disputes, or supersedes. It just displays the most recent estimate and lists all history.
- **ReindeerExchange envelope** (`packages/reindeer-exchange`). No wire change. The envelope already carries `owner_high_value` and `owner_high_value_reason` from Registry — that carries the owner's escalation into FairPlay.

## 4. Escalation to high-value — the new rule

### 4.1 Who can escalate

**Single-actor.** Any one of the following places an item into `in_high_value` immediately, no confirmation gate:

1. **Any heir** — via the game UI, during any stage. No value or estimate is required; heirs are not experts and act on a hunch.
2. **The owner** — via Registry upstream. When an item arrives from Registry with `owner_high_value = true`, the importer records an escalation with source `"owner"` and the reason from `owner_high_value_reason`, and sets the item's status to `"in_high_value"` at import time.
3. **The AI** — during intake (`server/ai/analyzer.ts`). See §4.3.

Once escalated, the item's status flips to `"in_high_value"` and the draft excludes it from every stage's available pool. It does not return to the game unless a captain reverts it — see §4.4.

### 4.2 Schema change to `high_value_nominations`

Currently the table encodes a two-heir vote (`nominatedBy`, `confirmations` JSON array, `status` in `{pending, approved}`). The two-vote gate is deleted.

**New shape** (one row per escalation):

- `id` — primary key.
- `session_id` — FK.
- `item_id` — FK.
- `escalated_by_source` — `"heir" | "owner" | "ai"`.
- `escalated_by_participant_id` — nullable; heir's participant_id when source is `"heir"`; null when `"owner"` (upstream, not a session participant) or `"ai"`.
- `reason` — nullable text. For owner: the `owner_high_value_reason` from the envelope. For AI: which trigger fired (see §4.3). For heir: optional free text.
- `escalated_at` — timestamp.
- `reverted_at`, `reverted_by_captain_id` — nullable; populated only when the captain reverts per §4.4.

Deleted columns: `confirmations`, `status`.

### 4.3 AI auto-flag trigger

`server/ai/analyzer.ts` currently outputs `aiEstimatedValue` and `isHeirloomCandidate`. It gains one more output field: **`highValueAutoFlag`** — a struct `{ triggered: boolean, reason: "category" | "value" | "both" | null, threshold: number | null }`.

**Trigger rule** (both category and value):

- Category ∈ {`Jewelry`, `Fine Art`, `Collectibles`, `Precious Metals`, `Vehicles`} → `triggered: true, reason: "category"`.
- OR `aiEstimatedValue >= high_value_threshold` → `triggered: true, reason: "value"`.
- Both conditions can fire together → `reason: "both"`.

**Threshold** — family-configurable, stored on `sessions.high_value_threshold_usd`. **Default: $1,000.** The setting is visible to every heir. The captain can change it.

When the AI's `highValueAutoFlag.triggered` is true, intake creates a `high_value_nominations` row with source `"ai"`, `reason` describing which trigger fired (e.g. `"ai:category:Jewelry"` or `"ai:value:>=1000"`), and sets the item's status to `"in_high_value"`.

### 4.4 Reversion — captain acts

The captain can revert an `in_high_value` item back into the game pool during the game (i.e. before the RoD is generated at completion). One action, no confirmation gate.

**Exception: owner escalations are permanent.** When the escalation source is `"owner"`, the item cannot be reverted in-app. The owner is deceased; their selection stands. The trust handles it outside the app. The revert action returns 403 for owner-source items.

Heir-source and AI-source items can be reverted by the captain with one action. On reversion, the item's status goes back to `"available"` and it returns to the stage it belongs to. The `high_value_nominations` row is updated with `reverted_at` and `reverted_by_captain_id`. One row is written to `high_value_audit_log` with event type `reverted` naming the captain, the item, and the previous escalation source.

Once the RoD is generated (end of game), reversion is closed.

## 5. What comes out

### 5.1 Endpoints (server)

Remove these routes from `server/fiduciary/router.ts`:

| Route | Rationale |
| --- | --- |
| `POST /api/fiduciary/items/:itemId/valuations/:id/approve` | Approval is a trustee act. |
| `POST /api/fiduciary/items/:itemId/valuations/:id/dispute` | Same. |
| `POST /api/fiduciary/items/:itemId/equalization` | Equalization is trustee work. |
| `PATCH /api/fiduciary/items/:itemId/equalization/:id` | Same. |
| `GET /api/fiduciary/items/:itemId/equalization` | Same. |
| `POST /api/fiduciary/items/:itemId/consents` | Consent tallies are trustee work. |
| `GET /api/fiduciary/items/:itemId/consents` | Same. |
| `POST /api/fiduciary/consents/:id/respond` | Same. |
| `GET /api/fiduciary/items/:itemId/finalization` | Finalization is trustee work. |
| `POST /api/fiduciary/items/:itemId/finalize` | Same. |
| `GET /api/fiduciary/thresholds` | The equalization thresholds are gone. |
| `PATCH /api/fiduciary/thresholds` | Same. |

New routes for the reshaped escalation model:

| Route | Purpose |
| --- | --- |
| `POST /api/fiduciary/items/:itemId/escalate-high-value` | Any signed-in heir escalates. Body: `{ reason?: string }`. No value or estimate is required — heirs act on a hunch. Source is `"heir"`, participant is the caller. |
| `POST /api/fiduciary/items/:itemId/revert-high-value` | Captain-only. Reverts an `in_high_value` item back to the game pool. One action. |

Retained routes:

| Route | Purpose |
| --- | --- |
| `GET /api/fiduciary/items` | List of items surfacing high-value flag status, escalation source, and latest estimate. Read-only. |
| `GET /api/fiduciary/items/:itemId/valuations` | Full estimate history (read-only). |
| `POST /api/fiduciary/items/:itemId/valuations` | Attach a new estimate. No approval workflow. |
| `GET /api/fiduciary/method-agreements` | Method-agreement ledger. |
| `POST /api/fiduciary/method-agreements` | Sign the method agreement. |
| `GET /api/fiduciary/record-of-decisions` | The final ledger. Reshaped — see §6. |
| `GET /api/fiduciary/record-of-decisions/print` | Print view. Reshaped. |
| `GET /api/fiduciary/snapshot` | Graceful exit. Unchanged. |
| `GET /api/fiduciary/snapshot/print` | Print snapshot. Unchanged. |

Deleted from the retained list (was in v1 of this spec): the plain `POST /api/fiduciary/items/:itemId/flag-high-value`. Escalation now goes through `escalate-high-value` (with source semantics baked in) instead of a naked flag.

### 5.2 Storage

Remove from `server/fiduciary/fiduciaryStorage.ts`:

- `approveValuation`, `disputeValuation`, `latestValuation` / `approvedValuation` distinction. Collapse to a single `latestValuation`.
- `decide` (equalization proposal), `setDecisionState`, `listDecisions`, `latestDecision`.
- `requestConsents`, `respondConsent`, `listConsents`.
- `finalizationStatus`, `finalize`.
- `targetEqualShare`, threshold-breach math, `strictMode` blockers array.
- `listHighValueItems` — keep, but simplify to return `{ item, latestValuation, escalation }` only.

Update `server/storage.ts`:

- `nominateHighValue` — becomes `escalateHighValue(itemId, source, participantId?, reason?)`. One call. Flips `items.status` to `"in_high_value"` immediately.
- `confirmHighValue` — **deleted**. Two-vote gate is gone.
- New: `revertHighValue(itemId, captainId)` — one call. Flips `items.status` back to `"available"`, stamps the nomination row's `reverted_at` and `reverted_by_captain_id`, writes an audit row.

Remove from `shared/schema.ts` and matching DDL in `server/migrations/init.ts`:

- `equalization_decisions` table (whole).
- `consents` table (whole).
- `finalization_events` table (whole).
- `threshold_decisions` table (whole).
- `equalizationPath`, `equalizationAmount`, `equalizationStrictMode`, `equalizationPercentThreshold`, `equalizationDollarThreshold`, `equalizationThresholdMode` columns on `sessions`.
- `equalization_path`, `finalized_at`, `finalization_event_id` columns on `items` (if present).
- `valueStatus` column on `items`.
- `approvedValue` column on `items` — collapsed into `estimatedValue`.
- Item state values `awaiting_value_review`, `awaiting_equalization_decision`, `awaiting_consent`, `finalized`, `finalized_by_override`. Retained item state values: the existing draft states plus `in_high_value` (unchanged).

Update `shared/schema.ts`:

- `high_value_nominations` — rewritten per §4.2. Drop `confirmations` and `status` columns; add `escalated_by_source`, `reason`, `reverted_at`, `reverted_by_captain_id`, `reversion_approved_by`.
- `sessions` — add `high_value_threshold_usd INTEGER NOT NULL DEFAULT 1000`.

Retained tables:

- `item_valuations` — estimates only.
- `high_value_audit_log` — transparency ledger. Event types retained: `flagged`, `valuation_added`, `unflagged`, plus new `reversion_proposed`, `reversion_approved`, `reversion_declined`, `reverted`. Deleted event types: `valuation_approved`, `valuation_disputed`, `valuation_superseded`, `equalization_proposed`, `equalization_accepted`, `equalization_rescinded`, `consent_requested`, `consent_granted`, `consent_declined`, `consent_withdrawn`, `finalization_locked`.

### 5.3 UI

Remove from `client/src/pages/fiduciary.tsx`:

- Approve / dispute buttons on valuations.
- Equalization decision UI (whole panel).
- Consent request UI (whole panel).
- Finalize button + blocker list.
- Threshold settings panel.

Retained + reshaped in `client/src/pages/fiduciary.tsx`:

- List of items with escalation status (source badge: heir / owner / AI), latest estimate.
- Attach-estimate form (no approval).
- Escalate-to-high-value button (heir action).
- Revert button (captain action) — one click, no modal.

`client/src/components/admin-flow-cards.tsx` cards for equalization/consents/finalize are removed. The card for "escalate for trustee's appraisal" stays and its copy updates.

`client/src/components/ask-for-appraisal.tsx` — copy changes: it says the escalation places the item on the trustee's ledger, and that the trustee handles appraisal outside the app. No promise the app will coordinate anything.

### 5.4 Selftest

`server/fiduciary/selftest.mts` (currently 103 checks across 8 sections) collapses. Target: **approximately 45 checks across 6 sections**:

1. Method Agreement gate (unchanged, ~15 checks).
2. Escalation to high-value — three sources, single-actor, no confirmation gate (~10 checks).
3. Reversion — captain reverts, one action, audit row written (~5 checks).
4. Estimate lifecycle — attach only (~3 checks).
5. Record of Decisions per-stage + escalation bucket (~5 checks).
6. Snapshot export (unchanged, ~2 checks).

Checks about equalization, consents, finalize, thresholds, strict mode, PR override, and pending-appraisal blockers are **deleted**, not rewritten. The invariants they encoded are no longer invariants of the app.

## 6. The Record of Decisions — new shape

This is the deliverable to the trustee. Everything else in the app exists to feed this.

### 6.1 Structure

Per session:

- Session metadata (name, estate name, generated timestamp, high-value threshold in effect for the session).
- Captain history — every captain who ever held the seat, with method-agreement rows tying every heir's signature to each captain era.
- **Per-stage sections** — one per stage that ran (heirloom, jewelry, any custom family stages, general round). Each stage section contains:
  - Every heir, with the items assigned to them in that stage, each with room, category, and latest estimate. Subtotal at the bottom of each heir's list.
  - Stage-total subtotal.
- **"Escalated to the trustee" section** — one section at the end, listing every item currently `in_high_value`, with:
  - Item name, room, category, latest estimate (or `"n/a"` if none recorded).
  - Escalation source (heir name / "Owner, via Registry" / "AI, category:X" or "AI, value:$Y").
  - Original recipient hint if any.
  - Reversion history if the item was ever reverted (never happens on the final RoD, since a reverted item is back in the game pool; kept for the transparency ledger).
  - Section total (sum of latest estimates; `"n/a"` items excluded from the sum with a note).
- **Bucket totals** printed separately, never summed together. Per-stage totals and the escalation-bucket total are shown side by side but not combined.
- Items with no recipient — surfaced as an "unassigned" section.
- **Closing note to the trustee**, printed on every RoD:

  > *Reindeer: FairPlay runs the game the heirs agreed to. It does not equalize, appraise, or finalize inheritance. The values above are pre-appraisal estimates the heirs, the original owner, or the AI recorded. Appraise every item in the "Escalated to the trustee" section before applying the trust's equalization rules. The session-scoped loss counter has already been used inside the game to keep contested picks fair; the trustee decides what, if any, further balancing to apply.*

### 6.2 What the RoD does NOT contain

- No "equalization path" per item.
- No "consent tally" per item.
- No "finalized" / "not finalized" status per item.
- No "canFinalize" or "blockers" fields.
- No `threshold_breach` warnings.

### 6.3 Print view

The `/record-of-decisions/print` HTML view is rewritten to match the new structure. One page per heir per stage where volume allows; otherwise a per-heir-per-stage subsection with a hard page break. Escalated-to-trustee section on its own page(s). The trustee reads it top to bottom and can sign each stage's page and the escalation page.

### 6.4 Estimates on the print — the `"n/a"` rule

Items with no recorded estimate print `"n/a"` for their value. The RoD **never refuses to print** because of missing estimates. The trustee is capable of noticing "n/a" and dealing with it.

## 7. What the reshape does NOT touch

- Registry (`apps/reindeer-registry`) — no change.
- ReindeerExchange v1 contract (`packages/reindeer-exchange`) — no wire change. The envelope already carries `owner_high_value` and `owner_high_value_reason`; the importer starts honoring it at import time.
- The AI photo pipeline itself — the analyzer gains one new output field, but the pipeline shape is unchanged.
- Offline sync, ranked draft algorithm, engine, stages, session-scoped loss counter.
- Auth, sign-in, session cookies, deny-by-default gate.
- Captain model reshape (finished earlier today).
- Roundtrip test — it exercises the Registry → FairPlay envelope, which does not depend on the fiduciary machinery.

## 8. Migration approach

Fresh-baseline `data.db` per the project's `init.ts` pattern. Historical audit rows of the removed event types are dropped on rebuild (clean slate). No migration ladder is written — this is consistent with how the captain-model reshape was landed.

## 9. Patent-brief implications

The patent brief updated earlier today (`docs/handoffs/2026-08-08-patent-brief-captain-model.md`) needs a matching update in a separate task:

- **Withdraw** any equalization-related claims (the whole "equalization threshold with strict-mode blockers and PR override" line of claiming — that machinery is being removed from the product).
- **Keep** F1–F10 (heir-run game mechanics), C1 (captain-mandate re-sign), C2 (representative role) — none of those depend on equalization.
- **Add**, if the brief goes forward: two possible new claim lines, both worth counsel review.
  1. The **per-stage ledger + escalation-bucket compliance-safety report** as the distinctive output of an heir-run division system that deliberately does not equalize.
  2. The **three-source single-actor escalation model** (heir / owner / AI) with captain reversion, in an heir-run division system.

This spec does **not** update the patent brief. That is a separate task after this reshape lands.

## 10. Commit chain

1. **Commit 1 — RoD reshape (additive first).** Extend `generateRecordOfDecisions` to expose the per-stage + escalation-bucket structure. Rewrite the print template. Add the closing-note copy. Keep every removed endpoint in place. Bring up new checks in the selftest (~5) alongside the existing 103.
2. **Commit 2 — Escalation model rewrite.** Rename `nominateHighValue` → `escalateHighValue`; delete `confirmHighValue`; add `revertHighValue`. Rewrite `high_value_nominations` schema (columns changed). Add `sessions.high_value_threshold_usd`. Rebuild `data.db`. Add ~15 selftest checks for the new model.
3. **Commit 3 — AI auto-flag.** Add `highValueAutoFlag` output to `server/ai/analyzer.ts`. Wire the intake pipeline to honor it (items land as `in_high_value` when triggered). Add ~5 selftest checks.
4. **Commit 4 — Registry-owner escalation.** Update the importer in `packages/reindeer-exchange` and FairPlay's ingestion side to honor `owner_high_value` at import time, writing a `high_value_nominations` row with source `"owner"` and the reason. Add ~5 selftest checks and a roundtrip check.
5. **Commit 5 — Remove equalization/consent/finalize endpoints and their storage methods.** Drop the corresponding UI panels and cards. Trim the selftest (delete the ~60 checks that exercised removed machinery). Rebuild `data.db`.
6. **Commit 6 — Drop schema tables and columns.** `equalization_decisions`, `consents`, `finalization_events`, `threshold_decisions`, thresholds columns on sessions, `valueStatus`/`approvedValue` on items, dead item states. Rebuild `data.db`.
7. **Commit 7 — Update `docs/SUITE-OVERVIEW.md` and reshape handoff.** Documentation only.

Each commit runs the full test suite (auth 47, fiduciary reshaping toward ~45, trustee 45, import 45, roundtrip 66) and reports the count.

## 11. Success criteria

The reshape is done when:

- Escalation to high-value works from all three sources (heir, owner via Registry, AI at intake), single-actor, no confirmation gate.
- Captain reverts an item with one action; the reversion is logged in `high_value_audit_log`.
- The RoD prints a per-stage ledger plus a distinct escalation-to-trustee section, with the closing note, and no equalization / consent / finalization language anywhere in the app.
- Every removed endpoint returns 404.
- `grep -r "equalization\|consent\|finaliz" server client shared` returns matches only in code comments and archived documentation, not in live control flow or UI copy.
- `data.db` on a fresh boot has no `equalization_decisions`, `consents`, `finalization_events`, or `threshold_decisions` tables.
- The selftest suite is smaller and every remaining check corresponds to something the app actually still does.
- The captain-model reshape and every other prior invariant still holds.
