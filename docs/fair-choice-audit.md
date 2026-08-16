> **Superseded** — vocabulary in this document may use *PR*, *personal representative*, or *fiduciary* for what the current suite calls **trustee**, and may predate the three configurations and the heir-initiated end-trustee-mode endpoint. See [`docs/SUITE-OVERVIEW.md`](SUITE-OVERVIEW.md) for the current model. This document is kept as history and is not being rewritten.

# FairPlay Source Audit

> **HISTORICAL DOCUMENT.** This audit was written before the v10 authentication
> rollout and the v14 Trustee Handoff rescope. Several sections below
> — particularly §1.4 ("Auth model — there isn't one") and every reference to
> per-item consent, equalization paths, or the Equalization Ledger runtime as
> the finalization gate — no longer describe the shipping code:
>
> - **Auth is real.** Magic-link email auth with 20-minute single-use tokens
>   and 30-day sliding sessions in an httpOnly signed cookie shipped in v10.
>   Every `/api/*` route is deny-by-default; identity comes from
>   `req.actor`, never from a client-supplied `participantId`. See
>   `server/auth/` and `server/auth/selftest.mts` (47 checks passing).
> - **The finalization gate is Trustee Handoff, not Equalization Ledger.**
>   The v14 rescope replaced per-item consent + equalization path selection
>   with a single up-front Method Agreement per heir; the trustee balances
>   the money externally. See
>   `docs/decisions/2026-08-06-fc-v8-trustee-handoff-rescope.md` and the
>   Trustee Handoff section of `docs/DESC-FAIR-CHOICE.md`.
> - The 21-table inventory below is now 22 (`method_agreements` added in
>   v14). `equalizationDecisions`, `consents`, and `finalizationEvents`
>   still exist and remain queryable, but the runtime no longer requires
>   them to close an item.
>
> The stack summary and item/phase state machines still describe reality.
> Use this document for historical context; trust the referenced spec and
> DESC files for current behavior.

Scope: `apps/reindeer-fair-play/` as it actually exists in the repository, checked against `docs/integration-spec.md` and the six scaffold packages in `packages/`. No source files were modified; no install or build was run. All line numbers below are from the files as read during this audit and should be re-verified if the files change.

---

## 1. What the app actually is

### 1.1 Stack (confirmed, not re-derived)
TypeScript, Express 5, Vite, React 18, wouter, TanStack Query, shadcn/Radix, Tailwind, Drizzle ORM over `better-sqlite3`, `passport-local` + `express-session` as declared dependencies, OpenAI SDK. `npm run check` and `npm run build` pass per the task brief.

### 1.2 The 21 tables, one line each

All defined in `shared/schema.ts` via `sqliteTable(...)`.

| # | Table (line) | Purpose |
|---|---|---|
| 1 | `sessions` (line 8) | The single estate/game record: name, `estateName`, `phase`, ranking-window settings, PR (Personal Representative) pointer. |
| 2 | `taxonomy` (line 112) | Enabled/custom room and category labels for one session (`kind`: `'room'\|'category'`). |
| 3 | `participants` (line 125) | Heirs and the PR: name, admin flags, contact info, `contestedLossCounter`, `autoSubmit`, `allowsPrAssist`. |
| 4 | `prTransfers` (line 150) | Audit record of PR handoffs (previous/new PR, disposition, reason). |
| 5 | `sessionStateChanges` (line 169) | Append-only log of pause/resume/archive transitions on the session. |
| 6 | `items` (line 195) | The estate item pool: name, room/category (free text), draft `status`, plus an entirely separate v8 fiduciary `highValueState`, AI fields, valuation fields. |
| 7 | `categoryChanges` (line 286) | Audit trail of category reassignment (old/new category, who, source: user/ai_auto/etc.). |
| 8 | `rankings` (line 376) | One row per participant/item/rank — the heir's ranked preference list. |
| 9 | `rankingEditsLog` (line 389) | Audit of PR-assisted or self edits to a ranking (old rank → new rank). |
| 10 | `groupings` (line 411) | Heirloom or custom multi-item bundles that move through the draft as one unit. |
| 11 | `groupingOptIns` (line 426) | Per-participant want/pass choice on a grouping. |
| 12 | `highValueNominations` (line 437) | Heir-initiated nomination that an item is high-value, pending peer confirmation. |
| 13 | `picks` (line 451) | One row per draft pick: round, participant, item, pick order, outcome (`awarded`/`lost_contest`/`pending`). |
| 14 | `duplicateGroups` (line 477) | Open/resolved marker for a detected duplicate-item group. |
| 15 | `classificationChanges` (line 488) | Audit of heirloom/high-value/sentimental flag toggles, including revert history and stripped rankings. |
| 16 | `notifications` (line 512) | Per-participant notification queue (classification changes, reconciliation reminders, etc.). |
| 17 | `itemValuations` (line 645) | v8 fiduciary: dated value entries per item with source/status, optional low/high range and attachment URL. |
| 18 | `equalizationDecisions` (line 674) | v8 fiduciary: chosen equalization path, dollar amount, and a JSON `transfers` array (cash/asset/buyout/note). |
| 19 | `consents` (line 710) | v8 fiduciary: immutable per-heir consent snapshot (item, value shown, proposed recipient, equalization amount shown, granted/declined/withdrawn/pending). |
| 20 | `finalizationEvents` (line 745) | v8 fiduciary: the closing record for an item — outcome, approved valuation, consent IDs, override flag/rationale, `dispositionRecordUrl` (line 770). |
| 21 | `highValueAuditLog` (line 781) | v8 fiduciary: append-only event stream (state before/after, value at event, actor role) — "single source of truth for a trustee reconstructing the item's history" per the code comment at lines 782-786. |

### 1.3 Real item lifecycle — three independent state machines, not one

1. **`items.status`** (schema.ts line 211, comment on line 210): `'available' | 'awarded' | 'in_grouping' | 'in_high_value' | 'duplicate_dismissed'`. This is the draft/pool flow.
2. **`items.highValueState`** (line 230, values at `ITEM_STATES`, lines 810-821): `normal → flagged_high_value → provisional_allocation → awaiting_value_review → awaiting_equalization_decision → awaiting_consent → ready_for_finalization → finalized | sold_liquidated | finalized_by_override`. The code comment at lines 227-230 states explicitly that this is "independent of `status` above, which is a pool/draft-flow flag."
3. **`sessions.phase`**, driven by `PHASE_ORDER` (schema.ts lines 1161-1172): `welcome → estate_name → registration → intake → ranking → groupings → draft → secondary_ranking → secondary_draft → complete`.

### 1.4 Auth model — there isn't one

`passport`, `passport-local`, and `express-session` are declared dependencies in `package.json` but are never imported or wired anywhere in `server/index.ts` or `server/routes.ts` — a search for `passport`, `session(`, and `Strategy` across the actual source returns zero matches outside `package.json`/`package-lock.json`. Real identity is a client-side React `useState` holding a `userId`, set in `client/src/lib/app.tsx` (lines 53-61), and sent as an **unauthenticated query parameter** on requests, e.g. `/api/notifications/mine?participantId=${userId}` (`app.tsx` line 334). `client/src/pages/login.tsx` is a "tap your name" screen that lists the `participants` roster fetched from `/api/participants` — there is no password and no server-side verification of identity. Any client can claim any `participantId`.

There is also no multi-tenancy/scope guard: `storage.ts`'s `getSession()` (line 554) fetches the single row from `sessions` with no id or scope argument, creating one if none exists. The whole app is single-estate, single-database — there is no per-estate isolation to violate or protect.

### 1.5 API surface, grouped by area (all in `server/routes.ts`, ~90 routes total, verified by direct grep — no auth middleware anywhere in the list)

- **Session/lifecycle**: `GET/PATCH /api/session`, `POST /api/session/reset` (239), `GET /api/state` (284), `POST /api/session/start` (294), `mark-inventory-complete` (303), `reopen-inventory` (312), `GET /api/session/cataloging-status` (321), `PATCH /api/session/settings` (326), `POST /api/session/resume-auto` (384), `lifecycle/pause` (398), `lifecycle/resume` (410), `GET lifecycle/state` (429), `welcome` (678), `estate-name` (697), `close-registration` (708), `transfer-pr` (721), `heirs-can-categorize` (1213), `bulk-analyze` (1224), `start-groupings-round` (1441), `start-draft` (1447), `next-phase` (1771).
- **Reconciliation**: `GET /api/reconciliation` (355), `POST respond` (359), `POST nudge` (374).
- **Notifications**: `GET /api/notifications/mine` (438), `POST :id/read` (457), `POST read-all` (461).
- **Item classification flags**: `PATCH /api/items/:id/flags` (468), `POST :id/flags/:changeId/revert` (497), `GET /api/classification-changes` (509), `GET /api/items/:id/classification-history` (528).
- **Taxonomy**: `GET/POST /api/taxonomy` (547/551), `PATCH/DELETE /:id` (567/577), `POST merge` (587).
- **Practice mode**: `POST /api/practice/start` (603), `GET results` (619), `GET results.csv` (627), `POST end` (666).
- **PR transfers**: `GET /api/pr-transfers` (717).
- **QA/seeding**: `POST /api/qa/seed` (774), `POST /api/qa/participants` (812) — dev-only test scaffolding routes live in production `routes.ts`.
- **Participants**: `GET/POST /api/participants` (823/851), `POST replace` (877), `PATCH/DELETE /:id` (888/941).
- **Items and AI**: `GET/POST /api/items` (957/973), `PATCH :id/category` (1009 and again 1112 — two separate handlers), `POST /api/ai/analyze-preview` (1074), `POST /api/items/:id/analyze` (1095), `POST :id/ai-high-value` (1152), `GET :id/category-history` (1176), `POST :id/discussion-resolved` (1196), `GET /api/session/categorization-status` (1205), `PATCH /api/items/:id` (1249), `PATCH :id/photo` (1287), `DELETE :id` (1307), `POST batch-intake` (1325), `POST /api/upload` (1349).
- **High value (v4 nomination flow, distinct from v8 fiduciary tables)**: `GET /api/high-value` (1372), `POST nominate` (1376), `POST :id/confirm` (1382).
- **Groupings**: `GET/POST /api/groupings` (1388/1392), `ensure-heirloom` (1408), `confirm-heirloom` (1412), `:id/add-item` (1417), `:id/opt-in` (1427), `:id/resolve` (1434).
- **Rankings**: `GET /api/rankings/all` (1542), `GET export.csv` (1576), `GET/PUT /:participantId` (1604/1666), `GET :participantId/audit` (1625), `POST audit/dismiss` (1655), `PATCH :participantId/move` (1685), `DELETE :participantId/:itemId` (1700), plus window controls: `PATCH ranking-window` (1715), `extend` (1730), `close-now` (1746), `reopen` (1756), `GET rank-completeness` (1767).
- **Draft**: `POST /api/picks/auto-suggest` (1787), `GET/POST /api/picks` (1798/1802), `POST /api/session/reveal-round` (1829).
- **Duplicates**: `GET /api/duplicates` (1841), `POST scan` (1845), `POST :id/resolve` (1850).
- **Export**: `GET /api/inventory/export.csv` (1864).

No `/api/login`, `/api/logout`, or `/api/register` routes exist anywhere in this list, consistent with §1.4.

### 1.6 What the AI analyzer actually does

`server/ai/analyzer.ts` (218 lines) calls OpenAI `gpt-4o-mini` with plain text plus an **optional single base64 image**, and returns up to three category suggestions with confidence scores against the 14 fixed `STANDARD_CATEGORIES` (schema.ts lines 1402-1417: Furniture, Art & Decor, Jewelry, Silver & China, Kitchenware, Electronics, Tools, Books, Clothing, Collectibles, Musical Instruments, Sporting Goods, Documents, Miscellaneous), plus a boolean high-value suggestion. `applyAiAnalysis` in `storage.ts` (~line 2942) only auto-assigns the category when confidence is at or above `AI_CATEGORY_CONFIDENCE_THRESHOLD = 0.75` (schema.ts line 338) **and** no human has already chosen one; otherwise it is stored as a suggestion (`aiSuggestions`, JSON, up to 3) and the item stays uncategorized. There is no bounding-box detection, no batch multi-item detection per photo, and no video keyframe extraction anywhere in this file or in `storage.ts`'s AI-related methods.

---

## 2. Where the spec was wrong — be blunt

The spec's foundational assumption — plain ESM JavaScript, no build step, no TypeScript, hand-rolled SQL matching the scaffold packages — does not survive contact with the real app at all. FairPlay is TypeScript end-to-end with a Vite build and Drizzle ORM. Every schema-shaped claim in the spec that follows from that assumption is also wrong. Specific failures:

1. **Canonical `ItemRecord` shape is fictional against the real schema.** `integration-spec.md` (lines 125-148) proposes: `item_id` (ULID), `title`, `category_id` (FK), `room_id` (FK), `quantity`, `condition`, `identifiers` (json), `value_estimate_cents` (int), `value_basis` (enum), `high_value_flag` (bool), `review_state`, `print_state`, `export_state`. The real `items` table (schema.ts lines 195-281) has: `id` (int autoincrement, not a ULID), `name` (not `title`), `room` (free text, not a FK — no `rooms` table exists in FairPlay at all), `category` (nullable free text, not a FK — no `categories` table exists), no `quantity` column, no `condition` column, no `identifiers` JSON column, `aiEstimatedValue` + `estimatedValue` + `approvedValue` as `real` dollar values (not integer cents), `isHighValue` (not `high_value_flag`), `status` as described in §1.3 (not `review_state`), and **no `print_state` or `export_state` columns anywhere in the schema**. FairPlay has never had a concept of printing or exporting a single item; that is an Reindeer Registry/print-feature idea that doesn't exist on this side.

2. **Every distribution-only table name in the spec is invented.** The spec (line 161) names `heirs`, `priority_orders`, `conflict_counters`, `bids`, `equalization_ledger`, `receipts`. The real names are `participants` (not `heirs`), `sessions.priorityOrder`-style ranking state is actually the `rankings` table (a row-per-item ranked list, not a `priority_orders` table), `participants.contestedLossCounter` is a column on `participants`, not a `conflict_counters` table, `picks` (not `bids`), and the equalization/valuation subsystem is four separate tables — `itemValuations`, `equalizationDecisions`, `consents`, `finalizationEvents` — not one `equalization_ledger`. **No `receipts` table exists anywhere in the schema.**

3. **The spec's estate-scoping claim is false.** `integration-spec.md` section 4 (line 196) asserts that an "estate-scoped query guard... already prevents cross-estate leakage." As shown in §1.4, `storage.ts`'s `getSession()` (line 554) takes no scope parameter — it fetches the single global session row. There is no multi-estate concept in the real code to scope against.

4. **The spec assumes AI vision capability FairPlay doesn't have.** `integration-spec.md` section 1 (line 46) claims FairPlay already has "AI batch photo intake with bounding boxes and padded crops, video keyframe extraction with cross-frame grouping." Per §1.6, the real analyzer takes one optional image and returns category text — no bounding boxes, no batching, no video handling. That capability exists only in the `legacy-intake-feature` scaffold package (`MockVisionProvider`/`HttpVisionProvider`, `groupAcrossFrames`), not in FairPlay.

5. **The spec's assumed audit log doesn't map either.** FairPlay does have audit trails, but they are per-concern tables (`categoryChanges`, `rankingEditsLog`, `classificationChanges`, `highValueAuditLog`, `sessionStateChanges`) rather than one unified hash-chained `audit_log` table. The hash-chained, tamper-evident single-table design (`SqliteAuditLog` in `legacy-core-data/src/audit/index.js`, with `prev_hash`/`hash` verification) exists only in the scaffold, and nothing in FairPlay can currently prove its own audit history hasn't been altered.

6. **"Extract shared packages" presupposes shared code that doesn't exist.** The spec's plan implicitly assumes FairPlay's storage layer is written in the same idiom as the scaffold (hand-rolled `better-sqlite3` SQL, plain JS validators) so that packages like `legacy-core-data`'s `SqliteItemRepository` could simply be imported by both apps. FairPlay's actual persistence layer is Drizzle ORM query-builder code (`db.select().from(items).where(...)`) with generated types — a fundamentally different runtime and type system that cannot import a plain-SQL repository class without a translation layer.

7. **The v8 fiduciary workflow is presented by the spec as an existing, callable feature.** It is not runtime-complete. `REBUILD.md` line 40 states explicitly: "Schema and migration are in and type-check clean. Storage CRUD, API routes, and UI for the fiduciary workflow (valuation ledger, equalization decisions, consent capture, finalization gate, PR override) are the next runtime tasks." Confirmed independently in this audit: a grep of `storage.ts` for `itemValuations`, `equalizationDecisions`, `finalizationEvents`, and `highValueAuditLog` returns **zero matches** — meaning these four tables exist in the schema and migration only; there is no method in `storage.ts` that reads or writes them, and no route in `routes.ts` exposes them. Any integration plan that assumes it can hand off equalization/consent data into FairPlay today has nothing live to hand it to.

---

## 3. Duplication: what the scaffold packages reinvent

| Concern | Scaffold implementation | FairPlay implementation | Which is better, and why |
|---|---|---|---|
| **Audit log** | `legacy-core-data/src/audit/index.js` — `SqliteAuditLog`: single `audit_log` table, SHA-256 **hash-chained** (`prev_hash`/`hash` per row), with a `verify()` method that walks the chain and reports `brokenAt` if any row was altered. | Five separate audit-style tables (`categoryChanges`, `rankingEditsLog`, `classificationChanges`, `highValueAuditLog`, `sessionStateChanges`), each a plain append-intended table with **no cryptographic chaining or verification** — a direct `UPDATE` or `DELETE` against any of these tables would leave no trace. | **Scaffold's is better for tamper-evidence.** The hash chain is a real security property FairPlay's audit tables lack entirely, and this is specifically valuable for the fiduciary/high-value workflow where "was this altered after the fact" matters legally. FairPlay's is better only in that it's per-concern (e.g., `classificationChanges` carries flag-specific fields like `removedRankings`) — a generic payload-JSON row can't cleanly capture that without ad hoc shape-by-`eventType` handling, which `highValueAuditLog` already does (its own `payload` is JSON, shape depends on `eventType`, comment at schema.ts line 888 area). Recommendation: adopt the hash-chain *pattern* into FairPlay's existing tables (add `prev_hash`/`hash` columns) rather than replacing them with the scaffold's single generic table.
| **Duplicate detection** | `legacy-intake-feature/src/duplicates.js` — `SimpleDuplicateDetector`: token-overlap `titleSimilarity()` (0.72 threshold) plus exact serial-number match plus exact photo-SHA256 match; writes to `duplicate_groups`/`duplicate_members`; resolution actions `keep_new`/`keep_catalog`/`keep_both`/`delete_both`. | `storage.ts` `scanDuplicates`/`resolveDuplicate` (lines ~3538-3591) plus `duplicateGroups` table (schema.ts line 477) and `items.duplicateGroupId`. The exact matching algorithm used in `storage.ts` was not read in full character-by-character in this audit (only the two method bodies at 3538-3591 and the table shape), so the specific similarity heuristic FairPlay uses cannot be confirmed beyond what's visible in that range — **this should be verified further before committing to the comparison below.** | Both systems exist and do the same job structurally (candidate groups → resolution action). The scaffold's photo-SHA256 exact-match check (`SELECT sha256, ... GROUP BY sha256 HAVING n > 1`) is a genuinely useful, cheap, zero-false-positive signal; if FairPlay's `scanDuplicates` does not already do this (unconfirmed — flagged as an open question in §6), it is worth porting the *technique*, not the package.
| **High-value screening** | `legacy-intake-feature/src/vision/index.js` — `screenHighValue()`: a $1,000 (100000 cents) universal threshold (`HIGH_VALUE_THRESHOLD_CENTS`) plus keyword cue lists, both universal (`antique`, `signed`, `sterling`, `solid gold`, `certificate`, etc.) and category-scoped (Jewelry: `diamond`, `14k`, `platinum`; Art: `oil on canvas`, `provenance`; Coins: `pcgs`, `ngc`; Firearms: `engraved`, `commemorative`). | FairPlay has **two parallel high-value mechanisms**: (a) the v4 heir-driven flow — `highValueNominations` table (schema.ts line 437) plus `/api/high-value/nominate` and `/confirm` routes (routes.ts lines 1376, 1382), where heirs nominate and peers confirm; and (b) `isHighValue`/`aiSuggestsHighValue`/`aiHighValueReason` columns on `items` plus the entire v8 fiduciary lifecycle (`highValueState`, `ITEM_STATES`) that an item enters once flagged. | **FairPlay's is more sophisticated and further along** for its actual use case (a legal/fiduciary flagging-and-tracking workflow with peer confirmation and downstream state machine) — the scaffold's `screenHighValue()` is a single-pass keyword/threshold classifier meant for unattended intake, a different job. However, the scaffold's explicit, inspectable cue-word table is more transparent and testable than FairPlay's AI-driven `aiHighValueReason` (opaque LLM text). Recommendation: keep FairPlay's nomination + fiduciary lifecycle as the system of record; consider borrowing the scaffold's explicit keyword-cue list as a *pre-filter* feeding into the existing nomination flow, not as a replacement classifier.
| **Item model / taxonomy** | `legacy-core-api/src/schema/index.js`'s `validateItemRecord` plus FK-based `rooms`/`categories` tables in `legacy-core-data` migrations. | `items.room`/`items.category` are free text (no FK, no `rooms`/`categories` tables); the `taxonomy` table (schema.ts line 112) exists instead — one row per enabled/custom label, `kind: 'room'\|'category'`, shared across the whole session rather than a normalized per-item FK relationship. | Neither is unconditionally better. The scaffold's FK model gives referential integrity (can't delete a room in use — enforced in `registry.js`'s `deleteRoom`/`deleteCategory`) and supports rename-without-touching-every-item. FairPlay's free-text model is simpler and matches an app where labels are looser suggestions, but it means renaming a room requires updating every `items.room` string, and there's no `IN_USE` guard. If integration ever needs referential integrity here, FairPlay's `taxonomy` table would need real FK columns added to `items` — a schema migration, not a drop-in replacement.
| **Item model overall** | `legacy-core-api`'s `ItemRepository`/`validateItemRecord` (abstract classes + validators) plus `legacy-core-data`'s `SqliteItemRepository` — a single unified "item" concept used identically by both apps, with `quantity`, `condition`, `identifiers` JSON, and export/print/review state built in from the start. | FairPlay's `items` table is purpose-built for a distribution game: no `quantity`/`condition`/`identifiers`, but has `awardedToParticipantId`, `awardedInRound`, `draftPhase`, `groupingId`, `duplicateGroupId`, `provisionalRecipientId`, and the full v8 fiduciary columns. | **FairPlay's is better for FairPlay**, and the scaffold's is better for Reindeer Registry — they are solving different problems, not the same problem twice. This is the central case for §4's recommendation: there is no single "better" item model to standardize on; there is only a mapping between two purpose-fit models.
| **Photo/media storage** | `legacy-core-data/src/media/index.js` — `FsMediaStore`/`ScopeMediaStore`: filesystem-backed, SHA-256 checksummed, supports photo/video/audio with `crop_bbox`, `transcript`, `transcript_source`, `duration_ms`, and a `tally()` method for delivery sizing. | FairPlay's `items.photoUrl`/`items.thumbnailUrl` are plain text URL columns on the `items` row itself — no separate media table, no checksum, no video/audio support, no crop-bbox tracking. This audit did not find a dedicated photo-storage abstraction in FairPlay comparable to `FsMediaStore` (not read in full detail beyond the schema columns; flagged in §6). | **Scaffold's is unambiguously more capable** — checksums, multi-media-kind support, and crop metadata are all real capabilities FairPlay's single-URL-column model does not have. If any shared media pipeline is ever built, `FsMediaStore`'s design (not necessarily its exact code, given the Drizzle/plain-SQL mismatch) is the one to imitate.
| **Trustee delivery packet** | `legacy-print-feature/src/templates/trusteePacket.js` — `renderTrusteePacket()`/`renderTrusteeEmail()`: a full HTML cover packet with checksums, item table, recordings index, sign-off checklist, aimed at a trustee filing paper with estate documents. | `finalizationEvents.dispositionRecordUrl` (schema.ts line 770) — "Optional PDF export of the disposition record generated at finalization" — implies FairPlay intends to produce its own closing document per item at fiduciary finalization, but (confirmed in §2 finding 7) there is no runtime code in `storage.ts` or `routes.ts` that generates it yet. | **Not actually duplicative today** — one is a built, working feature (the trustee packet); the other is an unimplemented placeholder column. But they are aimed at overlapping jobs (a durable, printable closing record with legal/fiduciary weight) and **will collide** once `dispositionRecordUrl` generation is built. This is the single most important duplication risk to flag for the owner: two different documents — "everything that was ever inventoried, handed to a trustee" vs. "how this specific high-value item was finally disposed of, per the fiduciary override/consent trail" — are both plausible candidates for the name "the trustee packet," and if built independently and inconsistently, families will receive two different-looking official-sounding PDFs about the same estate.

---

## 4. Realistic integration path

**"Extract shared packages" is not viable as stated**, for a reason more fundamental than a big rewrite: the two apps' *item models solve different problems* (§3, item model row), and FairPlay's runtime is Drizzle-typed TypeScript while all six scaffold packages are hand-written SQL in plain ESM JavaScript (confirmed by direct inspection of `legacy-core-data/src/db/index.js`, `repositories/itemRepository.js`, etc. — every query is a literal `.prepare(...)` string against column names like `item_id`, `title`, `high_value_flag` that do not exist in FairPlay's real schema, per §2 finding 1). Sharing "the item repository" would require either:
- rewriting FairPlay's persistence in plain SQL to match the scaffold (a rewrite of a working, type-checked app, for no functional gain), or
- rewriting the scaffold packages in Drizzle against FairPlay's schema (at which point they are no longer shared with Reindeer Registry, since Reindeer Registry' own schema — per the scaffold's `migrations/index.js` — has its own different `items` table shape, e.g. `title`/`quantity`/`condition`/`identifiers` columns FairPlay doesn't have).

Either path produces a shared *package* that is only shared in name, because the two schemas underneath it are shaped for different jobs. This is not a syntax problem (JS vs. TS) that a build step would fix — it's a genuine data-model divergence.

**Concrete proof this isn't hypothetical**: the scaffold already contains a real, in-repo attempt at exactly this integration, and it's wrong. `apps/reindeer-fair-play/_scaffold/server/importAdapter.js` (already in the repo, not authored during this audit) writes hand-rolled SQL against `intake_queue` (a table that does not exist in FairPlay's real schema at all — it exists only in `legacy-core-data`'s migration for the *other* app), `items.item_id` (real column: `items.id`), `items.title` (real: `items.name`), `items.high_value_flag` (real: `items.isHighValue`), and `items.review_state` (no such column exists in FairPlay). This file cannot run against the real database as written. It is the clearest available evidence that spec-driven code generated against the assumed shared model breaks immediately on contact with the real schema.

**Recommendation: adopt the envelope + adapter path, not shared packages.**

The one artifact that genuinely is shared, and should stay shared, is the **ReindeerExchange v1 bundle format** — the `.legacy` zip containing `manifest.json`, `items.json` (the envelope built by `legacy-exchange/src/v1/envelope.js`), `items.csv`, `media/`, `transcripts.txt`, and `checksums.txt`. This format is a plain, versioned, app-agnostic JSON contract (`format: "legacy-exchange"`, `version: "1.0"`, checked by `parseEnvelope()`'s major-version guard) — it does not care what database or ORM either side uses. That's exactly the right shape for a boundary between a plain-JS app and a Drizzle/TypeScript app.

What FairPlay needs, instead of importing scaffold packages, is a **TypeScript import adapter written against the real Drizzle schema** — a small module that:
1. Reads a `.legacy` bundle (can reuse `legacy-exchange`'s `readBundle`/`unzipSync` logic almost as-is, since ZIP/JSON parsing has no schema dependency),
2. Maps each envelope item field to the real `items` row shape per the table in §5 below,
3. Writes into `items` via Drizzle (`db.insert(items).values(...)`), not raw SQL,
4. Lands everything as `status: 'available'` items with an explicit "imported, needs review" marker — FairPlay has no `intake_queue` table, so this adapter needs its own minimal landing mechanism (see §5's flagged gaps) rather than assuming one exists.

This is strictly less work than making shared packages import-compatible with two incompatible schemas, and it fails safely: a broken adapter breaks bundle import, not the whole app's persistence layer.

---

## 5. ReindeerExchange v1 envelope → real FairPlay column mapping

Envelope shape per `legacy-exchange/src/v1/envelope.js`'s `buildEnvelope()`. Each `items[]` entry has: `item_id, title, category_id, category_name, room_id, room_name, description, story, quantity, condition, identifiers, value_estimate_cents, value_basis, high_value_flag, ai_confidence, created_at, updated_at, photos[], recordings[], recipient_hint`.

| Envelope field | Real FairPlay column | Notes |
|---|---|---|
| `item_id` | *(none — no home)* | FairPlay's `items.id` is an autoincrement integer primary key (schema.ts line 196); it cannot accept an externally-generated ULID string as its own id. An adapter would need to store the envelope's `item_id` in a new column (e.g. `originItemId`) for idempotent re-import matching — **this column does not currently exist on FairPlay's `items` table.** |
| `title` | `items.name` (line 197) | Direct rename mapping. |
| `category_id` / `category_name` | `items.category` (line 202, free text) | No FK on either side once mapped. Use `category_name`, not `category_id` (FairPlay has no `categories` table for the id to resolve against). If the name doesn't exist in `taxonomy` (line 112), it needs to be created there first or the item lands "Uncategorized." |
| `room_id` / `room_name` | `items.room` (line 199, free text, `.notNull().default("")`) | Same pattern as category: use `room_name`; FairPlay has no `rooms` table. |
| `description` | *(no home)* | FairPlay's `items.notes` (line 203) is the closest analog but is a general free-text field also used for other purposes; it isn't a dedicated description column, so a straight map would need to decide whether `description` and `story` (below) both collapse into `notes`, which is lossy. |
| `story` | *(no home)* | Same issue as `description` — no dedicated column exists; would collapse into `notes` alongside `description`, losing the distinction Reindeer Registry makes between "what it is" and "the story behind it." |
| `quantity` | *(no home — required-on-envelope-side field with no target)* | FairPlay's `items` table has no quantity concept at all; every item is implicitly qty 1. A multi-quantity envelope item (e.g. "6 dining chairs" from `groupAcrossFrames`) has no single-row target. |
| `condition` | *(no home)* | No condition column exists anywhere in FairPlay's schema. |
| `identifiers` (JSON: brand/model/serial) | *(no home)* | No JSON identifiers column on `items`. Closest fallback is folding a formatted string into `notes`, again lossy and not queryable (FairPlay can't do "find the item with this serial number" the way the scaffold's duplicate detector does). |
| `value_estimate_cents` | `items.aiEstimatedValue` or `items.estimatedValue` (lines 204, 236) | **Unit mismatch, not just a name mismatch**: envelope value is integer cents; FairPlay's columns are `real` dollar amounts. Needs `/100` conversion, and a decision about which of the two dollar columns (`aiEstimatedValue` vs. `estimatedValue`) an imported value belongs in — they mean different things (the former is AI-only; `estimatedValue` per its comment at line 236 feeds "drafting and provisional allocation"). |
| `value_basis` | `items.estimateSource` (line 206, values `'ai'\|'manual'\|null`) or `items.valueSource` (line 240, wider enum) | Two candidate columns with different enums; envelope's `value_basis` string (defined by the scaffold, not enumerated in what was read) would need explicit mapping to whichever is chosen. |
| `high_value_flag` | `items.isHighValue` (line 223) | Direct boolean mapping — this is the cleanest field in the table. But note it does **not** map into the v8 `highValueState` lifecycle (line 230) — an imported high-value item would be flagged but would not automatically enter `flagged_high_value` state, since (per §2 finding 7) there is no runtime code that transitions `highValueState` at all yet. |
| `ai_confidence` | `items.aiCategoryConfidence` (line 273) | Plausible direct map, but FairPlay's field name implies it is specifically *category* confidence, not general item-detection confidence — semantics may not match. |
| `created_at` / `updated_at` | *(no home — `items` has no timestamp columns)* | FairPlay's `items` table, as read, has no `createdAt`/`updatedAt` columns at all. These envelope fields have nowhere to go without a schema migration. |
| `photos[]` (`role`, `file`, `crop_bbox`, `sha256`, `source_frame_index`) | `items.photoUrl` / `items.thumbnailUrl` (lines 208-209) | FairPlay supports exactly one photo URL and one thumbnail per item, as plain text columns — not a table. An envelope item with multiple photos has no way to preserve more than one (and none of `crop_bbox`, `sha256`, `role`, `source_frame_index` have any target at all). This is a major fidelity loss on import. |
| `recordings[]` (video/audio) | *(no home)* | FairPlay has no media table and no video/audio support anywhere found in the schema. All recordings are silently dropped on import unless a new table is added. |
| `recipient_hint` (`recipient_name`, `relationship`, `alternate_name`, `owner_note`, `is_binding: false`) | *(no home — and no equivalent concept)* | This is the field the space's own instructions call out: the inventory app's `recipient_hint` is explicitly non-binding and must **never** become a ranking or draft-pool entry automatically. FairPlay has no "hint" column; its closest concepts are `rankings` (an heir's own ranked list) and `highValueNominations`/consent flow — both real, actionable game state, not passive hints. There is no safe direct column mapping; per `legacy-exchange/src/importer.js`'s own design (rule 4, "recipient_hint is a suggestion. It never becomes an heir preference without an explicit administrator action"), this field should land as a **suggestion surfaced to the PR for manual action**, not written into any existing FairPlay column. |

**Required FairPlay columns the envelope cannot fill** (fields the real schema needs that have no envelope source): `items.sessionId` (every item requires one — the envelope has no session/estate concept), `items.status` (must be set explicitly by the adapter, e.g. `'available'`), and everything under the v8 fiduciary lifecycle (`highValueState`, `valueStatus`, etc.) — none of which the envelope format has any way to populate, nor should it, since those are FairPlay-only fiduciary concepts.

**Net assessment**: of the ~20 envelope item fields, only 3 (`title`, `high_value_flag`, and loosely `category_name`/`room_name`) map cleanly to existing FairPlay columns. `quantity`, `condition`, `identifiers`, multi-photo, and all recordings have no target at all without new columns/tables. This is strong material confirmation for §4's recommendation: the adapter's job is mostly deciding what to *drop or fold*, not a mechanical field-for-field copy — which is exactly the kind of judgment call a shared "generic item repository" package cannot make for both apps, because the right answer depends on FairPlay-specific business rules (e.g., where multiplicity or condition data would even be used downstream).

---

## 6. Risks and open questions for the owner

1. **The auth model is not a placeholder to wire up later — it is currently exploitable as designed.** Any user of the deployed app can set `participantId` to any other heir's ID in a query string and act as them (view their notifications, submit picks framed as their choice) with no server-side check. If this app is ever used for a real estate division with money/heirloom stakes, this needs to be treated as a pre-launch blocker, not a backlog item.

2. **The v8 fiduciary workflow (valuation, equalization, consent, finalization) is schema-only.** Four tables and their audit log exist and type-check, but there is zero runtime code (`storage.ts` has no methods touching them, `routes.ts` exposes no endpoints for them). Anyone assuming "FairPlay already handles the legally sensitive high-value disposition process" — including, plausibly, the integration spec's authors — is wrong today. This should be resolved (built or explicitly deprioritized) before any real fiduciary process depends on it.

3. **Two documents are heading for a naming/purpose collision**: the working `renderTrusteePacket()` in `legacy-print-feature` and the not-yet-built `dispositionRecordUrl` PDF implied by `finalizationEvents` (schema.ts line 770). If both are eventually built independently, families may receive two different "official" closing documents about the same estate. Worth deciding now which one is canonical, or how they nest.

4. **Duplicate-detection algorithm in FairPlay was not fully read.** This audit read `scanDuplicates`/`resolveDuplicate` signatures and the surrounding ~50 lines (storage.ts 3538-3591) but not the full similarity logic, so the claim in §3 that the scaffold's photo-SHA256 exact-match check might be a novel capability is **unconfirmed** — it's possible FairPlay already does this and it simply wasn't in the range read. This should be checked directly before deciding what (if anything) to port.

5. **No dedicated media/photo storage abstraction was found in FairPlay** beyond the two plain URL columns (`photoUrl`, `thumbnailUrl`) on `items`. If FairPlay's actual upload handling (`/api/upload`, routes.ts line 1349, and `/api/items/:id/photo`, line 1287) does more than write a URL into those two columns — e.g., if there's server-side file storage this audit didn't trace — that would change the §3 assessment of the media-storage duplication row. Worth a follow-up read of the upload handler specifically.

6. **`origin_item_id`/idempotent-reimport tracking has no home in FairPlay**, per §5. Without adding a column, re-importing an updated Reindeer Registry bundle cannot be distinguished from importing it fresh, meaning every re-import would create duplicate items rather than updating existing ones — the opposite of the behavior `legacy-exchange/src/importer.js` was explicitly designed to guarantee (rule 5: "Re-importing the same item_id updates instead of duplicating"). This guarantee currently cannot be honored on the FairPlay side without a schema change.

7. **The `_scaffold/server/importAdapter.js` file already in the repo is broken against the real schema** (§4) and should not be used or extended as-is; if anyone picks it up assuming it's close to working, they'll hit `items.item_id`/`title`/`high_value_flag`/`review_state` not existing within the first query.

---

## Sources

All findings above are drawn directly from the source files in this repository checkout:
- `apps/reindeer-fair-play/shared/schema.ts`
- `apps/reindeer-fair-play/server/storage.ts`
- `apps/reindeer-fair-play/server/routes.ts`
- `apps/reindeer-fair-play/server/ai/analyzer.ts`
- `apps/reindeer-fair-play/server/migrations/v7a_lifecycle.ts`, `v8_high_value_fiduciary.ts`
- `apps/reindeer-fair-play/REBUILD.md`
- `apps/reindeer-fair-play/server/index.ts`
- `apps/reindeer-fair-play/_scaffold/SCAFFOLD-README.md`, `_scaffold/server/importAdapter.js`, `_scaffold/package.json`
- `apps/reindeer-fair-play/package.json`
- `apps/reindeer-fair-play/client/src/pages/inventory.tsx`, `admin.tsx`, `rank.tsx`, `login.tsx`
- `apps/reindeer-fair-play/client/src/lib/app.tsx`
- `docs/integration-spec.md`
- `packages/legacy-core-api/src/errors.js`, `index.js`, `models/index.js`, `ports/index.js`, `schema/index.js`
- `packages/legacy-core-data/src/index.js`, `registry.js`, `db/index.js`, `audit/index.js`, `media/index.js`, `migrations/index.js`, `repositories/itemRepository.js`
- `packages/legacy-intake-feature/src/index.js`, `duplicates.js`, `vision/index.js`, `server/router.js`
- `packages/legacy-print-feature/src/index.js`, `templates/index.js`, `templates/trusteePacket.js`
- `packages/reindeer-exchange/src/index.js`, `bundle.js`, `zip.js`, `importer.js`, `v1/envelope.js`, `v1/csv.js`
- `packages/reindeer-delivery/src/index.js`, `delivery.js`, `mailer.js`, `router.js`, `trustees.js`

No external sources were used; this is a pure code-reading audit as instructed. No source file was modified, and no `npm install` or build was run.
