# Captain model — target-state spec

**Status:** draft, awaiting user confirmation
**Author:** Perplexity Computer
**Date:** 2026-08-08
**Supersedes:** the "three configurations" framing shipped in commit `6cae093` (`docs/SUITE-OVERVIEW.md` §3)

---

## 0. Why this exists

Yesterday's checkpoint (`6cae093`) shipped two framings that turned out to be wrong:

- **`end-mode` endpoint** — any single heir could unilaterally end trustee-mode. This pretended that heirs collectively grant the trustee's authority, so heirs can rescind it. They don't and can't. The trustee's authority comes from the will or trust, not from the app.
- **Three-configurations table in `SUITE-OVERVIEW.md`** — treated "trustee inside as captain" as a distinct mode of the app. It's not. It's just a session-role assignment that the heirs happen to have made.

The correct model, from the user's own words in this session:

> The trustee or trustee representative or an Heir representative may also be chosen by the heirs to run the game from the start as captain. This would happen if no heir steps up or feels comfortable to captain it. […] This is a tool to resolve the personal property distribution. Buy in is needed or it is all moot and discarded. […] I'm not sure a Trustee fiduciary could compel the use of the fair choice app.

The app is an **opt-in cooperation surface**. The mandate is the heirs' collective consent, captured in the method agreement. The trustee's out-of-app legal authority is unchanged whether the app runs or not.

---

## 1. Model in one page

**Captain** — a session role. Whoever the heirs picked to run the sessions. Can be:
- an heir,
- the trustee (the person the owner named in the will or trust),
- a trustee's representative,
- an heir's representative.

There is exactly one captain at a time. Captain is not tied to legal role. Any participant on the roster can wear the captain hat.

**Trustee** — a real-world legal role. The person the owner named to carry out the estate. Documented on every session as `sessions.trusteeName` (already exists) plus an optional roster row with `role='trustee'` when they'll be signing in. The trustee's legal authority is not granted by the app and is not affected by anything the app does.

**Heir** — a person receiving personal property under this distribution. Roster row with `role='heir'`. Ranks, drafts, and receives.

**Representative** — a person acting on behalf of an heir or the trustee inside the app. Roster row with `role='representative'` and `representsParticipantId` pointing to the represented participant. A representative can be captain. A representative does not draft or receive items — the participant they represent does.

**Method agreement** — the mandate. Every heir signs a plain-language statement that says "we agree to distribute using this app under these rules, with [captain] running the sessions, and to abide by the result." Signed before ranking opens. Names the current captain. **Captain change after ranking opens requires every heir to re-sign a new snapshot before the game continues.**

**Snapshot export** — a printable "state as of now" available from any phase, to any signed-in participant. Not a decision, not a finalization. Just the data. Titled "Snapshot as of [timestamp]." Contents: inventory, rankings (whatever's been collected), method agreement text and signatures, high-value flags, audit log. This is the graceful exit when cooperation collapses: the trustee gets the snapshot and proceeds by their own methods, outside the app.

That's the whole model. One captain, one method agreement that names the captain, one snapshot button for the "we're stopping" case.

---

## 2. What each participant sees

**Happy path — heir captain, everyone cooperating:**
The heirs sign the method agreement (which names one of them as captain). They rank, draft, finalize. The trustee's name appears on the printed Record of Decisions as the legally responsible party; the trustee does not sign into the app.

**Heir-picks-trustee-as-captain path:**
At setup, on the captain-picker screen, the heirs choose "the trustee will run this." The trustee gets a magic-link invite. The method agreement names the trustee as captain. Every heir signs. Session runs normally. The trustee holds the captain hat all the way to finalization; heirs still rank and receive.

**Representative-as-captain path:**
Same as above except the captain is a representative. The represented party (an heir or the trustee) exists on the roster too. The representative signs into the app; the represented party does not need to.

**Captain-change mid-session (rare):**
Any heir with `isAdmin=true` — currently one heir — proposes a captain transfer. Every heir must sign the new method-agreement snapshot naming the new captain before the game unpauses. This is deliberately heavy: it protects buy-in. If any heir refuses to re-sign, the game does not continue, and the snapshot-export path is the way out.

**Cooperation collapse:**
The heirs stop using the app. Any signed-in participant hits "Print snapshot." The snapshot is generated. The trustee receives it. The trustee handles distribution by whatever means they would have used without the app. The app does not declare anything. It doesn't need to.

---

## 3. State model — what changes in the schema

### Sessions table

| Column                     | Change                                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trusteeMode` (boolean)    | **Remove.** No longer a distinct mode.                                                                                                                                                            |
| `trusteeParticipantId`     | **Keep**, but repurpose comment: this is just "the participant row for the trustee, if the trustee is on the roster." Not tied to captain.                                                        |
| `captainParticipantId` NEW | Nullable int. The participant currently running the session. NULL until the method agreement is signed. Every action gated on captaincy checks this field, not `isAdmin` or `role`.               |
| `trusteeName`              | **Keep as-is.** The name goes on printed artifacts regardless of whether the trustee is on the roster.                                                                                            |

### Participants table

| Column                     | Change                                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `role`                     | **Extend enum:** `'heir'` \| `'trustee'` \| `'representative'`.                                                                                                                                    |
| `representsParticipantId` NEW | Nullable int. NULL for heir and trustee rows. NOT NULL for representative rows, points at the represented participant.                                                                          |
| `administersOnly`          | **Keep.** True for trustee and representative rows; they don't draft, rank, or receive.                                                                                                           |

### Method agreements table

| Column                     | Change                                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `captainParticipantIdSnapshot` NEW | The captain named in this signature. When any heir re-signs after a captain change, they sign a new agreement row with the new captain baked in.                                          |
| `captainNameSnapshot` NEW  | Text copy of the captain's name at sign time. Kept even if the participant row is later deleted.                                                                                                  |

### prTransfers table

**Rename to `captainTransfers`.** The current table already logs previous/new/reason/name. Adjust column names — `previousCaptainParticipantId`, `newCaptainParticipantId`, `previousCaptainName`, `newCaptainName`. **This is a schema/wire-format change per project instructions — warn the user before shipping (already warned in-thread).**

Rationale: "PR" was old vocabulary and the table logs a role transfer, which is now a captain transfer. Keeping the old name would leave the codebase with `prTransfers.previousCaptainParticipantId`, which reads worse than renaming.

### Migrations

- `v20_captain_participant_id.ts` — add `sessions.captain_participant_id`, seed to `sessions.trustee_participant_id` where `trustee_mode=1`, else to the row that had `isAdmin=1` at method-agreement time (best-effort backfill; NULL if unknowable).
- `v21_drop_trustee_mode.ts` — drop `sessions.trustee_mode`. Data is preserved because everything is now captured in `captain_participant_id`.
- `v22_participant_role_and_represents.ts` — extend `participants.role` check-constraint, add `represents_participant_id`.
- `v23_method_agreement_captain_snapshot.ts` — add `captain_participant_id_snapshot`, `captain_name_snapshot`. Backfill existing rows with the session's captain at signing time (best-effort).
- `v24_rename_pr_transfers_to_captain_transfers.ts` — rename table and columns.

---

## 4. API changes

### Endpoints removed

| Endpoint                                    | Why                                                                                                             |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `POST /api/session/trustee/end-mode`        | Wrong model. Heirs don't rescind the trustee. Deleted with its storage method and its four selftest sections.  |

### Endpoints reshaped

| Old                                          | New                                             | Behavior                                                                                                                                                                            |
| -------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/session/trustee/take-over`        | `POST /api/session/captain/take-hat` (see below) | Merged into transfer flow.                                                                                                                                                          |
| `POST /api/session/trustee/hand-back`        | `POST /api/session/captain/transfer`             | Hand-back is just a transfer to whichever heir the trustee names.                                                                                                                   |
| `POST /api/session/trustee/invite`           | `POST /api/session/trustee/seat`                 | Seat the trustee at setup as a documented roster row. Not tied to captaincy. Optionally with an email so they can sign in.                                                          |
| `POST /api/session/transfer-pr`              | `POST /api/session/captain/transfer`             | Same body shape but takes `toParticipantId` — any roster participant. Renamed to remove PR vocabulary.                                                                              |

### New endpoints

| Endpoint                                              | Auth                                | Behavior                                                                                                                                                                                                                                     |
| ----------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/session/captain/pick-initial`              | `isAdmin=true` (heir-admin)         | Called once at setup, before method agreement. Sets `captainParticipantId`. `toParticipantId` may be any roster participant.                                                                                                                 |
| `POST /api/session/captain/transfer`                  | Current captain OR heir-admin       | Pauses the session, sets `captainParticipantId` to new value, marks all method-agreement rows for this session as `supersededByCaptainChange=true`, and re-issues signing links. Game resumes only when every heir re-signs the new snapshot. |
| `POST /api/session/representative/add`                | `isAdmin=true`                      | Creates a representative row for a given heir or trustee. Body: `name`, `email`, `representsParticipantId`.                                                                                                                                  |
| `GET /api/session/snapshot`                           | Any signed-in participant           | Returns JSON: inventory, rankings, method agreements with signatures, audit log, roster, high-value flags, current captain, current phase. Read-only. Available in every phase.                                                              |
| `POST /api/session/snapshot/print`                    | Any signed-in participant           | Renders a PDF of the snapshot. Titled "Snapshot as of [timestamp]." Not a Record of Decisions.                                                                                                                                               |

### Endpoints untouched

Everything else. Auth, item CRUD, ranking, draft, high-value, appraisals, finalization, imports. None of it changes.

---

## 5. UI changes

### Removed

- **Trustee-banner "End trustee mode" button** — deleted with the endpoint.
- **`SUITE-OVERVIEW.md` "three configurations" table** — replaced with "one model, three tracks it can take."

### Reshaped

- **Trustee banner → captain banner.** Shows "[Captain name] is running this session" always, in muted style. Not framed as an exception state. Includes a "Transfer captain" affordance if the viewer is heir-admin or captain.
- **Method-agreement signing screen** — adds one plain sentence: "The captain for this session is [Name] ([role])." That's it. No extra ceremony.

### New

- **Captain-picker screen at setup.** Between roster-close and method-agreement signing. Three options laid out in plain English: "One of us will run it," "The trustee will run it," "Someone we agree on outside the family." Choosing the second or third seats the trustee/representative if not already seated.
- **Snapshot button.** In the header of every session screen, subtle. Copy: "Print a snapshot." One tap.

### Copy at the front door (welcome screen)

One paragraph, appearing once, first-time only:

> This app is one way to divide personal property. It works when everyone agrees to use it and to accept the result. If that agreement is there, the app will do the rest. If it isn't, the app steps aside and the trustee handles the estate the way trustees have always handled it. Either way, the trustee is the person the will or trust named to carry this out.

No lecture. No repeated warnings. One statement, then get out of the way.

---

## 6. Self-tests

### Removed

- The four sections in `server/fiduciary/selftest.mts` that assert `end-mode` behavior. Sections 6 and 7 as added in `6cae093`.

### Added

New sections in `server/fiduciary/selftest.mts`:

1. **Captain is first-class.** After setup + `pick-initial`, `sessions.captainParticipantId` is set; every guarded endpoint that used to check `denyIfNotPR` now checks captain (or is renamed).
2. **Captain change requires re-sign.** After `captain/transfer`, all method-agreement rows are marked superseded and the ranking phase is paused. Every heir must sign a new row before ranking resumes.
3. **Representative can be captain.** Add representative for an heir; set captain to representative; every captain-only endpoint works; representative does not appear in draft or ranking math.
4. **Trustee-as-captain works end to end.** Seat trustee, set captain to trustee, run through ranking, draft, finalize. Trustee never receives items.
5. **Snapshot available in every phase.** Loop through every valid phase, hit `/api/session/snapshot`, assert 200 + non-empty payload.
6. **Any heir can flag high-value.** Preserved from yesterday's work. Still true.
7. **Trustee is never an heir.** Preserved from yesterday's work. Extended: representative is never an heir either.

Target count: **~58** in `fiduciary/selftest.mts` (down from 53 by removing end-mode's 4-5 checks, up by adding the captain + representative + snapshot checks). Auth (47), import (45), detectOwnerAssignment (13), roundtrip (66), content-lint (clean) — untouched by this reshape.

---

## 7. Patent brief consequences

**Withdrawn:** F11 ("heir-revocable in-app fiduciary mode") — the behavior it described is being removed as a wrong model.

**Replacing F11 with two smaller dependent claims:**

1. **Captain-mandate re-sign on transfer.** The method agreement names the operating party. A change in that operating party requires every counterparty to sign a new snapshot before the process continues. Novel over the 38 fetched records: nothing recites a signed multi-party mandate that names its operator and voids on operator change.

2. **Representative as first-class distinguishable roster role.** A participant may be seated who acts on behalf of another, may be selected as the operating party, and does not enter the distribution math. Distinct from proxy voting (which does enter math). Not recited in any fetched record.

Both are dependent claims under the two-application-architecture independent claim from §0.5 of the Aug 7 brief.

**Independent claim shape unchanged.** Two-application architecture, owner-flagged sentiment items suppressed on paper, cross-app envelope with attribution, signed versioned method-agreement gate, finalization-with-pending-appraisals. Still the recommended shape.

---

## 8. Migration and rollout order

One commit, this session. Order inside the commit:

1. Schema migrations (v20 → v24).
2. Storage layer changes — new methods, renamed methods, deleted methods.
3. Routes — remove `end-mode`, rename `transfer-pr` and `trustee/*`, add captain and snapshot endpoints, replace `denyIfNotPR` with **two** helpers:
   - `denyIfNotHeirAdmin` — for setup-phase actions before there is a captain (roster edits before method agreement, captain-pick-initial, proposing a captain transfer). Body of the current `denyIfNotPR` unchanged.
   - `denyIfNotCaptain` — for in-game actions (advance phase, resolve conflicts, close registration, etc.). Checks `actor.id === session.captainParticipantId`.
   Every one of the ~30 current `denyIfNotPR` call sites is inspected and routed to whichever helper matches its lifecycle. Most in-game actions become captain-gated; roster/setup actions stay admin-gated. This is not a mechanical find-and-replace.
4. Client — captain-picker screen, banner rewording, snapshot button, welcome copy.
5. Docs — rewrite `SUITE-OVERVIEW.md` §3, add this spec, mark yesterday's handoff as partially superseded.
6. Self-tests — remove end-mode sections, add the new ones.
7. Retest: tsc, build, auth, fiduciary, import, detectOwnerAssignment, trustee (which is now the captain test), roundtrip, content-lint.
8. Patent brief update — replace F11 section with captain-mandate + representative sections.

---

## 9. Explicit warnings (project-instruction compliance)

The user's project instructions require warning before any rename, sweeping find-and-replace, dependency reinstall, or schema/wire-format change. This spec does all four of the first and one of the last:

- **Rename:** `prTransfers` → `captainTransfers`, plus method rename `denyIfNotPR` → `denyIfNotCaptain`, plus endpoint renames listed in §4. Client callers to `/api/session/transfer-pr` will 404 until they hit the new path. Both apps' client code must be updated in the same commit.
- **Sweeping find-and-replace:** the string "PR" as an app concept still lives in a handful of comments and error messages; those get cleaned. `denyIfNotPR` has ~30 call sites in `routes.ts`.
- **Dependency reinstall:** none required.
- **Schema/wire-format change:** yes — the migrations in §3 add and drop columns and rename a table. Existing databases will run the migrations on next startup. Existing signed method-agreement rows will be backfilled with the current captain, which for pre-reshape sessions is a best-effort guess; a comment on the migration documents this.

**What could break, explicitly:**
- Any client still calling `/api/session/trustee/end-mode` will 404. That endpoint shipped yesterday; nothing external depends on it yet.
- Any client calling `/api/session/transfer-pr` will 404. The FairPlay client is the only caller; it moves to `/api/session/captain/transfer` in the same commit.
- The `trusteeMode` column is dropped. Anything reading it directly (there is nothing outside the app's own storage layer) would break.
- Method-agreement rows written before this reshape will show a backfilled captain-name snapshot rather than a truly signed one. The migration comments this and self-test 2 does not rely on those pre-reshape rows.

---

## 10. Open questions

None blocking. The user has already answered:
- Delete `end-mode`? **Yes.**
- Seat trustee at setup? **Yes** (implicit from "the trustee was chosen by the owner").
- Representative as first-class role? **Yes** (from "trustee representative or heir representative").
- Fallback declared endpoint? **No** — snapshot-anywhere is the honest replacement.
- What to do with commit `6cae093`? **Option A — land the reshape on top, don't revert.**

---

## 11. Success criteria

- All self-tests green with new counts.
- `SUITE-OVERVIEW.md` §3 replaced with the captain model.
- No mention of "trustee mode" or "end trustee mode" in user-visible copy or public APIs.
- Snapshot endpoint returns 200 in every valid phase.
- Method-agreement signing screen shows the captain name.
- Captain-picker screen present at setup.
- Patent brief update reflects F11 withdrawal + two new dependent claims.
- Handoff doc written and shared.

---

## 12. What this spec does not do

- Does not touch the intake/registry app's own state model. Registry continues to say "trustee" for the person the owner is naming; that's still correct.
- Does not touch equalization math, appraisal flow, or the finalize step.
- Does not change auth. Magic links, single-use tokens, deny-by-default over /api, httpOnly cookies — all preserved. Adding a `denyIfNotCaptain` helper reuses the same actor-lookup path.
- Does not introduce a court-order or external-verification seating path. If a family has the kind of dispute that would need that, they are outside the app's scope and should be using their trustee's real-world authority, not the app.
