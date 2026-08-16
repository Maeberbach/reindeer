# Reindeer Legacy — Captain-model reshape (handoff, 2026-08-08)

## Why this reshape happened

The user pushed back on an earlier same-day model. Verbatim, the correcting instructions were:

- "The trustee or trustee representative or an Heir representative may also be chosen by the heirs to run the game from the start as captain."
- "This is a tool to resolve the personal property distribution. Buy in is needed or it is all moot and discarded."
- "I'm not sure a Trustee fiduciary could compel the use of the fair choice app."
- "in the real world, the trustee was chosen by the owner of registry. They bear the ultimate responsibility to manage the trust."
- Vocabulary is two words for people — **heir** and **trustee**. **Captain** is a session role either wears. "An heir is never a trustee. A trustee is never an heir." "There is no boss. There is a referee/captain."

The earlier design carried an `end-mode` endpoint that let any heir "revoke trustee mode" as if trustee-runs-the-game were a bounded state to enter and exit. That framing was wrong on three counts. First, in the real world neither side can compel the other to use the app; heir-over-trustee unilateral revocation asserts a control the domain does not have. Second, captain is a role, not a mode — there is nothing to revoke. Third, the graceful exit the domain actually needs is a snapshot the heirs can hand to the trustee when they walk away, not a state flip inside the app.

The reshape landed the correct model.

## Target state (captain-model spec)

Full spec: [`docs/specs/2026-08-08-captain-model.md`](../specs/2026-08-08-captain-model.md).

- **Captain** = session role. `session.captainParticipantId` is the source of truth. Trustee-in-charge is derived from `captainParticipantId === trusteeParticipantId`; there is no separate `trusteeMode` flag.
- **Trustee** = real-world legal role. `role='trustee'`, `administersOnly=true`, never drafts/ranks/receives.
- **Representative** = first-class role. `role='representative'`, `administersOnly=true`, `representsParticipantId` binds to the represented participant. Can wear the captain hat.
- **Method agreement** = the mandate. v2.0 names the current captain via a `${captainName}` template. Every heir re-signs when the captain changes. Composite unique `(session_id, participant_id, captain_participant_id)` on the agreement table.
- **Snapshot export** = graceful exit. Available in every phase to any signed-in participant. Read-only, no side effects.
- **No fallback state.** The app has one operating mode; the way out is the snapshot, not a mode flip.

## What shipped (commit chain)

Working directory: `/home/user/workspace/projects/legacy-suite-XPjy0RsrSMGTV_3ok2A05g/files/`. All commits in order:

| Commit | Step | What it did |
|---|---|---|
| `e251792` | 1 | Target-state spec (270 lines) |
| `a82806a` | 2 | Removed `POST /api/session/trustee/end-mode`, its selftest, banner button, storage method |
| `6ebf456` | 3+4-a | Captain as first-class: `session.captainParticipantId` column, `denyIfNotCaptain` guard split from `denyIfNotHeirAdmin`, 11 endpoints routed to the captain guard |
| `0f99407` | 3+4-b | Banner renamed and rewritten around the captain role |
| `92b7b48` | 5 | Representative role type + `representsParticipantId` column + storage invariants |
| `6d4619a` | 6 | Method agreement names captain (v2.0); re-sign on captain change; composite unique index; snapshot text includes captain name; reactivation of prior signatures on hand-back |
| `9b49422` | 7 | `SessionSnapshot` type; `getSnapshot()` storage method; `GET /api/fiduciary/snapshot` (JSON) and `/snapshot/print` (HTML); no captain gate |
| (next) | 8+9+10+11+12 | SUITE-OVERVIEW rewrite; representative selftests; retest; patent brief withdraw F11 + add C1/C2; this handoff |

Final selftest baselines from a clean `data.db`:

| Suite | Count | Delta from pre-reshape |
|---|---|---|
| tsc | clean | — |
| auth | 47/47 | unchanged |
| fiduciary | 103/103 | +59 (from 44 → 63 → 95 → 103) |
| trustee | 45/45 | unchanged |
| import | 45/45 | unchanged |
| roundtrip | 66/66 | unchanged |

## Key files

- **Spec:** `docs/specs/2026-08-08-captain-model.md`
- **Drizzle schema:** `apps/reindeer-fair-play/shared/schema.ts` — `CURRENT_METHOD_AGREEMENT_VERSION="2.0"`, `renderMethodAgreementText(captainName)`, `captainParticipantId` column on `sessions`, composite unique index on `methodAgreements`, `representsParticipantId` column on `participants`
- **Schema init:** `apps/reindeer-fair-play/server/migrations/init.ts` — fresh-baseline pattern, no migration ladder; `captain_participant_id`, composite unique
- **Storage invariants:** `apps/reindeer-fair-play/server/storage.ts` — participant insert/patch invariants for role and `representsParticipantId` (lines ~620–660)
- **Fiduciary storage:** `apps/reindeer-fair-play/server/fiduciary/fiduciaryStorage.ts`
  - `SessionSnapshot` type at line ~107
  - `roleOf(actorId)` at line ~223 — resolves representative delegation to represented role
  - `recordMethodAgreement` at line ~986 — reads current captain, composite key, renders text
  - `allHeirsHaveMethodAgreement` at line ~1091 — filters by current captain
  - `getSnapshot` at line ~1125 — read-only, no audit rows
- **Fiduciary router:** `apps/reindeer-fair-play/server/fiduciary/router.ts`
  - `GET /snapshot` + `GET /snapshot/print` at line ~459
  - `renderSnapshotHtml` at line ~706 — printable HTML, large elderly-friendly type
- **Routes:** `apps/reindeer-fair-play/server/routes.ts` — `denyIfNotHeirAdmin` at line ~200 (setup, isAdmin), `denyIfNotCaptain` at line ~220 (in-game, captainParticipantId)
- **Banner:** `apps/reindeer-fair-play/client/src/components/captain-banner.tsx`
- **Method agreement UI:** `apps/reindeer-fair-play/client/src/pages/method-agreement.tsx` (heir signing), `method-agreements.tsx` (captain tracker)
- **Fiduciary selftest:** `apps/reindeer-fair-play/server/fiduciary/selftest.mts` — 103 checks across 8 sections
- **Overview:** `docs/SUITE-OVERVIEW.md` — rewritten around "Who can be captain" (four kinds of person: heir, trustee, trustee's representative, heir's representative), the method agreement, the graceful-exit snapshot
- **Patent brief update:** `docs/handoffs/2026-08-08-patent-brief-captain-model.md` — withdraws F11, proposes C1 (captain-mandate re-sign) and C2 (representative role)

## Deferred wire renames — landed in the follow-up commit

These three items were flagged as deliberate deferrals in the first pass of the reshape. They landed as one bounded wire-rename commit right after (see the same session):

- **`denyIfNotPR` → `denyIfNotCaptain`** (fiduciary router + import router). Guard was moved from `server/routes.ts` into `server/auth/sharedGuards.ts` so there is exactly one implementation shared by all three routers. The old `denyIfNotPR` (isAdmin-gated) is gone — the middleware-level `requireAdmin` at `server/auth/middleware.ts` still exists for the setup-phase heir-admin gate, but nothing in the fiduciary or import routers uses it. The in-game endpoints (valuation approve, equalization, consents, finalization, thresholds patch, import batch approve) are now captain-gated, which matches the reshape spec.
- **`actorRole: "pr"` → `actorRole: "captain"`** on audit rows. `fiduciaryStorage.roleOf()` return type changed from `"pr" | "heir" | "trustee"` to `"captain" | "heir" | "trustee"`; the null-actor branch now returns `"captain"`. The `audit_log.actor_role` column values that historically read `"pr"` now read `"captain"`. No consumer was reading `actorRole === "pr"`, so nothing broke. Fresh-baseline `data.db` per the project pattern.
- **`session.trusteeMode` boolean retired.** Column dropped from `shared/schema.ts` and `server/migrations/init.ts`. `trusteeTakeOver` and `trusteeHandBack` now derive trustee-in-charge from `session.captainParticipantId === session.trusteeParticipantId`. `client/src/components/trustee-handoff-card.tsx` derives the same way. Trustee selftest rewritten to assert against `captainParticipantId`. This removes a class of drift where a boolean and a foreign key could disagree.

**Client `"pr"` strings deliberately left alone.** `client/src/components/shell.tsx` and `client/src/components/admin-flow-cards.tsx` use `"pr"` as an audience key (`"all" | "pr" | "heir"`) and as a collaborator DOM key fallback (`c.participantId ?? "pr"`). Those are not the wire enum and are not part of this rename.

**Baselines after the commit:** tsc clean · auth 47/47 · fiduciary 103/103 · trustee 45/45 · import 45/45 · roundtrip 66/66.

## What the reshape did not touch

- AI photo pipeline
- Offline sync
- Ranked draft algorithm
- Finalization-with-pending-appraisals path
- Cross-app envelope (ReindeerExchange v1)
- Registry's Important flag and print pipeline
- Trustee's high-value handling flow

## For the next session

The reshape is done. Pending items for whoever picks this up:

1. **`/api/fiduciary/*` endpoint path rename.** Still deliberately deferred — a URL rename is a wire-visible change and the setup gate/route-level guard change is not required for the reshape itself.
2. **Counsel review of the patent brief update.** Withdrawing F11 and proposing C1/C2 is a specification and dependent-claim change; it should go to counsel before any provisional is drafted.
3. **UI polish on the representative role.** The role now exists on the roster with `representsParticipantId`, but the setup UI has not been walked to prove a heir's admin can actually pick a representative through the screens end-to-end. The invariants and the storage are covered; the UI walkthrough is not.

Nothing in the target-state spec is left unimplemented.
