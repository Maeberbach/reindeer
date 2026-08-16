> **Superseded** — vocabulary in this document may use *PR*, *personal representative*, or *fiduciary* for what the current suite calls **trustee**, and may predate the three configurations and the heir-initiated end-trustee-mode endpoint. See [`docs/SUITE-OVERVIEW.md`](../SUITE-OVERVIEW.md) for the current model. This document is kept as history and is not being rewritten.

# Reindeer Legacy — FairPlay v2.0 & Registry v1.0 consolidated (2026-08-07)

## Version bumps

- **`apps/reindeer-fair-play`** → `2.0.0`
- **`apps/reindeer-registry`** → `1.0.0`
- **`packages/reindeer-exchange`** stays at ReindeerExchange **wire version `1.0`** — no envelope change; only receiver behavior changed.

Neither app has shipped yet, so the whole 2026-08-06/07 sequence — trustee-handoff rescope, owner_important_comment plumbing, method agreement UI, walkthrough fixes, trustee packet rewrite, and owner-assignment / detector — is folded into these two version numbers instead of drip-migrations across "v14a…v15b" internal labels.

## What the two apps do now (consolidated surface)

### Legacy: Registry (v1.0)

Owner-facing capture and delivery app. Everything a family needs to write down what they own and hand it to a trustee.

- **Capture**: photo-gated add flow, room-by-room list, categories, owner notes, `owner_important_comment` (free text), `recipient_hint` (free text pointing at a person), quantity/condition/identifiers.
- **My people**: roster the owner names into the registry so recipient hints have people to point at.
- **Home hub**: counts of items, "Assigned to heir" tally (`Assigned to heir: N assigned, M unnamed`), room progress ("Not started" / "Part way through" / all captured).
- **Item detail**: full record, verbatim `owner_important_comment` as-typed, Important badges (with `"feeling"` / `"money"` / `"both"` reasons), edit flow.
- **Printing**: five print surfaces — by-room, single-item sheet, gifting hero, wet-ink signature page, "sign it and give it to your trustee" cover.
- **Delivery**: ReindeerExchange v1 bundle (envelope + CSV + media + verbatim comments) to hand off to FairPlay or hold for the trustee.
- **Auth**: real magic-link auth. 20-minute single-use tokens, 30-day sliding sessions in an httpOnly signed cookie, deny-by-default over `/api`.

### Reindeer: FairPlay (v2.0)

PR-facing family distribution game with fiduciary oversight and trustee handoff.

- **Import**: reads a ReindeerExchange v1 bundle from Registry. Stages every item for PR review before anything lands in the estate.
- **Owner-assignment binding** (new in v2): a Registry `recipient_hint` on an incoming item is no longer advisory. When present, it becomes an **owner assignment** on the imported item — `status = 'owner_assigned'`, holds the item out of the ranked pool entirely, and prints on the trustee packet with an `[ASSIGNED]` mark.
- **Detector** (new in v2): when `recipient_hint` is empty but `owner_important_comment` contains directive intent ("For Sarah", "meant for Michael", "belongs to Carol"), a pure-regex detector surfaces a candidate at import time. Zero LLM calls. The PR must confirm or dismiss before the batch can approve.
- **Roster**: participants, seat order, admins-only / heir accounts, PR (personal representative) role, PR transfers with full audit log.
- **Draft rounds**: rank pool, opt-in groupings, high-value nominations, contested-loss counter, auto-draft with holds and streaks, tiebreaks.
- **Method agreement UI**: heirs vote on how to handle high-value items; FairPlay honors the agreed method.
- **Fiduciary oversight**: appraisals, thresholds, classification-change audit, ranking-edits log, notifications.
- **Trustee handoff**: exportable packet with every item, its state, its recipient (or `[ASSIGNED]` for pre-owner-assigned), and the owner's own words verbatim in a cream-colored call-out row under each commented item.
- **Auth**: same magic-link contract as Registry. No impersonation via `req.body.participantId`, `x-participant-id` header, or `?participantId=`.

## ReindeerExchange v1 (unchanged wire format)

`packages/reindeer-exchange/src/v1/envelope.js` still exports `EXCHANGE_VERSION = "1.0"`. The receiver semantics changed (recipient_hint now binds), but the JSON envelope, CSV, checksum layout, and media manifest are byte-for-byte the same. Existing bundles remain readable.

## Test surface (all green at bump)

- `node scripts/roundtrip-test.mjs` → **66/66**
- `apps/reindeer-fair-play`:
  - `npx tsx server/auth/selftest.mts` → **47/47**
  - `npx tsx server/fiduciary/selftest.mts` → **51/51**
  - `npx tsx server/import/selftest.mts` → **45/45**
  - `npx tsx server/import/detectOwnerAssignment.selftest.mts` → **13/13**
  - `npm run check` → tsc clean
  - `npm run build` → clean (client bundle + `dist/index.cjs`)

Self-tests all import `../testing/scratchEnv` as their first import so ESM hoisting can't accidentally hit the real `data.db`.

## Item status enum (post-v2)

```
'available'          → in the ranked pool
'awarded'            → won in a draft round
'in_grouping'        → held inside a grouping until it resolves
'in_high_value'      → routed to the high-value/fiduciary track
'duplicate_dismissed'→ resolved out of a duplicate group
'owner_assigned'     → held out of pool; assigned by owner (structured hint or confirmed detection)
```

**Invariant:** an `owner_assigned` item MUST NOT appear in `rankings` or `picks`. Enforced by `approveStaged` (never enters as `available`) and by explicit `status !== 'owner_assigned'` guards in the duplicate scanner and the results-leftovers filter. Any future query that walks items with a `status !== 'awarded'` check must add the `owner_assigned` guard too — same pattern followed for `duplicate_dismissed`.

## Detector rules (recap)

Fires only when `recipientHint === ''` AND `ownerImportantComment !== ''`. Two signal families:

- **Directive phrases:** `For {Name}`, `meant/intended for {Name}`, `give this to {Name}`, `belongs to {Name}`, `save for {Name}`, `keep for {Name}`, `leaving to {Name}`, `going to {Name}`, `goes to {Name}`. Case-insensitive. Sentence-anchored for the bare "For …" case.
- **Participant name match:** any FairPlay participant's first name appearing whole-word inside a sentence surfaces as a candidate.

Combined confidence: `both` when the same name comes from both signals in the same sentence, otherwise `directive_phrase` or `participant_name`. Stopwords never surface. Possessives tolerated. Two-token names ("Aunt Sarah") captured as one candidate. Deterministic, no external calls, fully unit-tested.

## Import review contract (server, PR-only)

- `POST /api/import/staged/:id/detection/confirm { name? }` — sets review `'confirmed'`, optionally overrides the detected name. Approve then lifts the item to `owner_assigned` with `source = 'comment_detected'`, evidence = the verbatim sentence.
- `POST /api/import/staged/:id/detection/dismiss { reason? }` — sets review `'dismissed'`. Reason is stored on the staging row for the audit trail. Approve then lands the item as `available` (goes into the ranked pool).
- `POST /api/import/batches/:id/approve` — throws 409 with a plain-language message while any row's review is still `pending`. `approveStaged` on an individual row does the same.

All three PR-only via the existing `denyIfNotPR` guard.

## Trustee packet contract

The signed record now prints:

- Every item with room, category, condition, quantity, identifiers, and the owner's `owner_important_comment` verbatim in a cream/gold call-out row directly under the item.
- Every `owner_assigned` item carries an `[ASSIGNED]` mark next to the recipient name.
- New summary cell: **Items with a written comment** count.
- Legend paragraph explaining `[ASSIGNED]`.

The owner's words print exactly as typed — verbatim, italicized, no summarization, no truncation.

## UX principles (still standing)

Large type, large targets, plain language, no jargon. Confirm before anything irreversible (send/print/finalize). Every item must be printable. `owner_important_comment` prints verbatim everywhere it appears. Registry never estimates value. FairPlay AI value is for routing (high-value nomination triage) only, never displayed as the item's price.

## What's still open (deferred, not blocking v2 release)

1. **Registry soft-nudge** at capture time: if the owner writes a name in the Important comment but leaves the recipient hint blank, prompt them to fill it in structurally.
2. **Import review UI cards**: server contract lands now; the PR-facing "Confirm / Not an assignment" tiles for the detector candidates come next.
3. **Item-detail return-to-pool action**: server-side status transition `owner_assigned → available` is audited already, but there's no button yet.
4. **Grey-out cards on ranking screens**: `results.tsx` already sections owner_assigned items separately; `rank-all.tsx` should visibly grey them if they ever leak in.
5. **`itemRepo.update()` room-state promotion** on `room_id` change — unchanged from the earlier deferred list.

## Not done, and I want your call

The user prompt suggested rolling everything into a single fresh version. I bumped the app versions but **did NOT** collapse the internal `v7a…v15` migration ladder in `apps/reindeer-fair-play/server/storage.ts` into a single init. That would delete 9 migration files, rewrite ~250 lines of storage.ts, and make any existing dev `data.db` unreadable. I want an explicit "yes, collapse the ladder" from the user before doing it — project rules say to warn before sweeping schema changes.

Same story for `apps/reindeer-fair-play/_scaffold` (dead code the project instructions call out as ignorable): I left it alone. It's a follow-up cleanup pass if the user wants it removed.

## Commands (for reference)

From the checkout root:

```
node scripts/roundtrip-test.mjs
cd apps/reindeer-fair-play
npx tsx server/auth/selftest.mts
npx tsx server/fiduciary/selftest.mts
npx tsx server/import/selftest.mts
npx tsx server/import/detectOwnerAssignment.selftest.mts
npm run check
npm run build
```

Registry (from `apps/reindeer-registry`):

```
npm run registry     # port 3210, no build step
```

FairPlay dev (from `apps/reindeer-fair-play`):

```
npm run dev          # port 5000
```

Remember: a root-level `npm install` prunes `apps/reindeer-fair-play`'s deps. Reinstall from inside that app directory afterward.
