# Commit 4a — Memorandum-locked items travel from Registry into FairPlay (backend + data model)

**Date:** 2026-08-09
**Slice status:** commit 4a of a two-part commit 4. This slice ships the envelope, freeze mechanism, Registry export wiring, FC schema/DDL, and FC importer consumption. The UI (greyed rows + preamble note) and Registry welcome/sign/bundle-cover copy ship as commit 4b.

## What this slice does

When an owner dies and their **signed** specific-giving memorandum is delivered to the trustee, the items on that memorandum are legally spoken for by the owner's will. Those items must not appear as claimable rows in FairPlay — heirs cannot rank them, cannot bid on them, cannot be told who they were left to (the recipient is a private matter that lives on the paper the trustee holds).

Before this slice, FC had no way to know a Registry item was memorandum-locked. This slice adds a redacted per-item flag to the export bundle and teaches FC to consume it.

## User-locked design decisions

The following came from the user across this slice; they are load-bearing:

1. **Grey out, don't hide.** Heirs see the item's photo, name, room, and a caption that says "Handled as a special gift under the will." They do NOT see the recipient. (Option B.)
2. **Freeze at export.** The memorandum becomes immutable the moment its bundle is prepared for the trustee; Registry refuses to accept another signing by that owner after freeze.
3. **All other items behave as before.** Non-memorandum items in the same bundle flow through the normal recipient_hint / comment_detected / available paths.
4. **Two-estate rule.** In couple mode with two estates, each spouse's death runs FC as a separate event. On first death, the deceased's frozen memorandum still travels in every future export — item_ids + first-name grouping label only, never the recipient.
5. **Use first names for grouping.** No "Mom" or "Dad" — the deceased owner's actual first name from the participant record.
6. **Precedence.** Memorandum > recipient_hint > comment_detected. If an item is on a frozen memorandum, that wins even if a recipient_hint travelled alongside.

## What changed

### Wire format (envelope) — `packages/legacy-exchange/src/v1/envelope.js`

- `buildEnvelope` now accepts `lockedMemoranda` — an array of `{ owner_name, signed_at, version_number, item_ids }`.
- Each `envelope.items[i]` gets a new field `is_locked_gift: boolean` (defaults false; true when the item's id appears in any locked memorandum).
- `envelope.counts` gains `locked_by_memorandum` (item count) and `locked_memoranda` (memorandum count).
- Envelope shape is backward-compatible: older importers ignore the new fields; older exporters produce `is_locked_gift=false` for every item and no `locked_memoranda` block.

### Freeze mechanism — Registry data + delivery

- `packages/legacy-core-data/src/migrations/index.js`: migration 12 adds `frozen_at`, `frozen_by_participant_id`, `frozen_note` to `addendum_versions`.
- `packages/legacy-core-data/src/repos/addendumVersionsRepo.js`: `freezeLatest(participantId, actorId, note?, ctx)` — audit-logged (action `addendum.freeze`), idempotent (a second freeze on an already-frozen version returns the row unchanged). New `listFrozen()` returns all frozen versions with items_snapshot for export.
- `packages/legacy-delivery/src/twoOutputs.js`: `signAndWriteAddendum` refuses when `latestFor(participantId).frozen_at` is set. Error message: "This owner's memorandum has been frozen by the trustee. Registry can't accept another signing…"
- `apps/reindeer-registry/server/index.js`: new endpoint `POST /api/two-outputs/freeze { participantId, note? }`. Actor identity comes from `resolveScope()` — participantId in the body is the TARGET (whose memorandum), not an identity claim.

### Registry export wiring — `packages/legacy-exchange/src/bundle.js`

- `writeBundle` accepts optional `addendumVersions` + `people`. When both are provided, `listFrozen()` runs and per-owner name resolution runs through `people.get(participantId, ctx)`; the resulting `lockedMemoranda` array feeds `buildEnvelope`.
- Guard helper `safeOwnerName()` — a lookup failure returns `""` (FC then groups those items under "Unknown owner") rather than crashing the export.

### FairPlay — schema, DDL, importer

- `apps/reindeer-fair-play/shared/schema.ts`: `items` and `staged_items` gain `lockedByMemorandum` (boolean) and `memorandumOwnerName` (text). The existing `owner_assigned_source` union type is extended to include `'memorandum'`.
- `apps/reindeer-fair-play/server/migrations/init.ts`: DDL adds those two columns to both tables (both live and staging). Kept in sync with `drizzle-kit push` output.
- `apps/reindeer-fair-play/server/import/importService.ts`:
  - `stageBundle` indexes `envelope.locked_memoranda` into a `Map<item_id, owner_name>`, then per staged row sets `lockedByMemorandum = !!srcItem.is_locked_gift || memMap.has(srcItem.item_id)` and `memorandumOwnerName = memMap.get(srcItem.item_id) ?? ""`.
  - `approveStaged` now treats memorandum-locked as a first-class path with precedence over recipient_hint / comment_detected: on approve it forces `status='owner_assigned'`, `ownerAssignedSource='memorandum'`, `ownerAssignedName=''` (the recipient is deliberately NOT written into FC), `ownerAssignedEvidence='Handled as a special gift under the will.'`, and copies `lockedByMemorandum + memorandumOwnerName` onto the items row on both the create-new and update-existing paths. Participant lookup is skipped for the memorandum path.

## Tests

New section in `apps/reindeer-fair-play/server/import/selftest.mts` — 4 checks that exercise the whole path end-to-end:

- The memorandum-enabled envelope carries `locked_memoranda` + `is_locked_gift` + updated counts.
- `stageBundle` flags the memorandum item and copies the owner name onto the staging row; non-memorandum items in the same batch stay `lockedByMemorandum=false`.
- Approve of a memorandum-locked staged item lands in items as `owner_assigned` / `source='memorandum'` / `ownerAssignedName=''` / participant unresolved / evidence phrase matches / owner-name grouping label intact.
- A non-memorandum item in the same batch still approves through the normal path.

## Test matrix (all green)

| Suite | Before | After |
|---|---|---|
| Registry roundtrip | 66 | 66 |
| Two-outputs envelope | 37 | 37 |
| Two-outputs bundle | 40 | 40 |
| Two-lane | 22 | 22 |
| FC auth | 47 | 47 |
| FC fiduciary | 133 | 133 |
| FC import | 50 | **54** (+4) |
| FC trustee | 45 | 45 |

Sign flow test and vision test not run in this slice (server-dep / pre-existing B-002). `npm run check` (tsc) is clean.

## What's still to do (commit 4b)

1. **FC UI** — render `lockedByMemorandum` items greyed and unselectable, grouped under `memorandumOwnerName`, with a preamble note above the greyed block:

   > "A word before we begin. The list of special gifts you'll see greyed out below was captured from Registry when the memorandum was last signed. Between that day and this one, [owner name] may have signed a newer paper memorandum, added handwritten notes, or made changes their trustee is holding but Registry never saw. If something here doesn't match what the trustee has on paper, the paper is what governs. Ask the trustee. We can't plan for everything."

2. **Registry copy — three placements** ("not a legal document"):
   - Welcome/first-run screen.
   - Sign-memorandum screen (top of the ceremony).
   - Bundle-cover / trustee delivery preview.

   > "Registry is a preparation tool, not a legal document. The paper you hand your trustee or attorney is what governs. You may replace or amend this memorandum at any time — on paper, with or without this app."

3. **Freeze-flow selftest** — a short scripted test that (a) signs a memorandum via Registry, (b) exports a bundle, (c) freezes, (d) confirms a second sign attempt is rejected with the expected message, (e) confirms the frozen memorandum still travels in a subsequent export.

## Guarded lines

- Auth surface unchanged. The new freeze endpoint reads `req.body.participantId` **only as the TARGET whose memorandum is being frozen**, never as an identity claim. Actor identity remains sourced from `resolveScope()`. There is no new `x-participant-id` header, no new `?participantId=` query, no `req.body.participantId` used for authentication anywhere.
- No renames, no sweeping find-and-replace, no dependency reinstall, no wire-format break — the envelope changes are additive.

## Commit

Suggested message:

    feat(exchange+fc): memorandum-locked items travel greyed into FairPlay (backend)

    - envelope: locked_memoranda + is_locked_gift + counts
    - registry: addendum_versions.frozen_* + freezeLatest + POST /api/two-outputs/freeze
    - registry: writeBundle wires frozen memoranda into export
    - fc: schema + init.ts add lockedByMemorandum + memorandumOwnerName
    - fc importer: memorandum path takes precedence, recipient identity never crosses
    - fc import selftest: +4 checks (50 → 54)
    - patent notes: P-008 supporting claim

    UI + Registry welcome/sign/bundle-cover copy + freeze-flow test follow in commit 4b.
