> **Superseded** — vocabulary in this document may use *PR*, *personal representative*, or *fiduciary* for what the current suite calls **trustee**, and may predate the three configurations and the heir-initiated end-trustee-mode endpoint. See [`docs/SUITE-OVERVIEW.md`](../SUITE-OVERVIEW.md) for the current model. This document is kept as history and is not being rewritten.

# Reindeer Legacy v2.1 — clean build (2026-08-07)

Phase 2 of the v2 cutover. Nothing has shipped yet, so the migration ladder that carried v1..v15 was collapsed into a single `initSchema()` call. The rebuild point for the old ladder is the previous handoff (`2026-08-07-legacy-suite-v2-consolidated.md`, commit `7428457`) — this pass is the clean build on top of it.

## Versions

- `apps/reindeer-fair-play`: **2.0.0 → 2.1.0**
- `apps/reindeer-registry`: **1.0.0 → 1.1.0**
- ReindeerExchange wire version: **1.0** (unchanged — no envelope change)

## What changed

### 1. Migration ladder collapsed into one init

New file: `apps/reindeer-fair-play/server/migrations/init.ts` (~700 lines).

Exports `initSchema(sqlite: Database.Database): void`. One `sqlite.exec()` creates every table and index the app needs, with every column that v1..v15 accumulated inlined into the original `CREATE TABLE` statement. No `ALTER TABLE ADD COLUMN`, no per-version conditional backfills, no `relaxItemCategory()` table rebuild. `items.category` is nullable from the start. Every column defined in one place, in one order.

Tables created: `sessions`, `participants`, `items`, `groupings`, `grouping_opt_ins`, `high_value_nominations`, `picks`, `duplicate_groups`, `taxonomy`, `rankings`, `ranking_edits_log`, `classification_changes`, `notifications`, `pr_transfers`, `category_changes`, `session_state_changes`, `item_valuations`, `equalization_decisions`, `consents`, `finalization_events`, `high_value_audit_log`, `import_batches`, `staged_items`, `staged_media`, `item_media`, `auth_tokens`, `auth_sessions`, `auth_events`, `threshold_decisions`, `representative_credentials`, `method_agreements`.

### 2. storage.ts rewritten

`apps/reindeer-fair-play/server/storage.ts` (top of file, ~lines 88–108):

- **Removed** the 9 `runV*Migration` imports.
- **Added** `import { initSchema } from "./migrations/init";`.
- **Removed** ~286 lines: baseline `CREATE TABLE` block, `addColumn` helper, ~40 `addColumn(...)` calls for v2..v6, `category_changes` create, `relaxItemCategory()` function and call, the `UPDATE items SET category = NULL WHERE category = ''` legacy-data sweep, and 9 `runV*Migration(sqlite, addColumn)` calls.
- **Replaced** with one line: `initSchema(sqlite);`.

`DB_PATH`, `sqlite = new Database(DB_PATH)`, `journal_mode = WAL`, and `export const db = drizzle(sqlite)` are unchanged.

### 3. Migration files deleted

Removed from `apps/reindeer-fair-play/server/migrations/`:

- `v7a_lifecycle.ts`
- `v8_high_value_fiduciary.ts`
- `v9_inventory_import.ts`
- `v10_authentication.ts`
- `v11_threshold_decisions.ts`
- `v12_representative_passphrase.ts`
- `v13_owner_important_comment.ts`
- `v14_trustee_handoff.ts`
- `v15_owner_assignment.ts`

Only `init.ts` remains in that directory.

### 4. Dead code deleted

Removed `apps/reindeer-fair-play/_scaffold/` entirely (`SCAFFOLD-README.md`, `package.json`, `server/importAdapter.js`). Project instructions already flagged it as dead code that should never be wired up.

### 5. Local dev DB wiped

Deleted `apps/reindeer-fair-play/data.db` (and `-shm` / `-wal` if present). First app boot will create a fresh DB with the collapsed schema. Tests use `REINDEER_FAIR_PLAY_DB_PATH` via `scratchEnv` and are unaffected.

## Test results

From `apps/reindeer-fair-play/`:

```
npx tsx server/auth/selftest.mts                       47/47 checks passed
npx tsx server/fiduciary/selftest.mts                  51/51 checks passed
npx tsx server/import/selftest.mts                     45 checks passed
npx tsx server/import/detectOwnerAssignment.selftest.mts 13 checks passed
npm run check                                          tsc clean
npm run build                                          clean (client + server)
```

From checkout root:

```
node scripts/roundtrip-test.mjs                        66 checks passed
```

Done-state: **tsc clean + auth 47 + fiduciary 51 + import 45 + detector 13 + roundtrip 66 + build clean.**

## Rebuild point

If anyone needs the pre-collapse layout (with the full v1..v15 ladder intact), check out commit `7428457` — that is the v2.0.0 tag equivalent. This handoff is the clean-build point going forward.

## Preserved behavior

Nothing about the running app changed:

- **Auth**: magic-link login, 20-minute single-use tokens, 30-day sliding sessions in httpOnly signed cookies, deny-by-default over `/api`. No identity read from body/header/query.
- **Owner-assigned items**: `owner_assigned` still in the item-status enum, still excluded from rankings and picks, still enforced by `approveStaged` branching + duplicate scanner guard + results-leftovers filter.
- **Owner Important comment**: still prints verbatim, still carried through the ReindeerExchange envelope and CSV.
- **Method Agreement**: still required from every heir before finalization.
- **Trustee handoff**: unchanged.
- **Wire contract**: ReindeerExchange 1.0, no changes.

## What did NOT change

- No Registry code touched beyond the version bump.
- No shared-packages code touched.
- No public API changed.
- No UI touched.
- No new features, no removed features.

## Deferred (not this pass)

Carrying forward from the v2.0.0 handoff — still pending:

- Registry-side soft-nudge at capture
- Import review UI cards (server contract done)
- Item-detail return-to-pool button
- Grey-out heir cards on ranking screens
- `itemRepo.update()` room-state promotion on `room_id` change
