# Per-item voice memo — plan for morning approval

**Date:** 2026-08-09 (evening)
**Status:** Awaiting approval before any code

## What you asked for last night

Every item flagged Important during the room scan should have a short voice memo the owner can attach to it. The same voice memo should be reachable from the "Specific gifts by name" writer — if the owner didn't record one at capture time, they can add or change it there.

There is a separate long recording that attaches to the memorandum as a whole (general message to the family). That already exists and is not part of this plan.

## What the code already has

- **Storage is ready.** `item_photos.media_kind = 'audio'` was added in migration 12. The media store saves audio blobs against an item and hands out playback URLs. No schema change needed.
- **A voice recorder pattern exists.** The sign-flow "Say it in your own voice" button (`stmtRecord`) shows how to use `MediaRecorder` + `getUserMedia` in this app. The intake recorder would follow the same pattern.
- **What is missing:** every UI that would let an owner record, play, or replace audio *on an item*. The database is ready; the UI is not.

## Three cheap-to-expensive slices — approve one at a time

I broke this into three pieces so you can approve them independently. Each one leaves the app in a good state on its own.

### Slice V1 — writer-only voice memo (cheapest, most immediately useful)

**What the owner sees:** on the "Specific gifts by name" screen, every row that references an Important item shows a small "🎙 Voice memo" strip with buttons:

- No memo yet: **Record** button
- Memo exists: **Play** + **Re-record** buttons

The recorder is a small inline card — Start/Stop, then Save/Discard. Sixty-second cap. It saves to `item_photos.media_kind='audio'` on the item.

Not on this slice: recorder in the intake flow (you record here only), print/PDF (Slice V3), trustee bundle inclusion (Slice V2).

**Compute cost:** Roughly a third of what step 4 cost. Small.
**Files touched:** `apps/reindeer-registry/client/index.html` (add strip), `apps/reindeer-registry/client/app.js` (record/play/replace wiring, ~120 lines), `apps/reindeer-registry/client/styles.css` (~30 lines), `apps/reindeer-registry/server/routes/memorandum.js` (a `POST /api/items/:id/audio` endpoint if not already present — check first), one new test suite `scripts/memorandum-voice-http-test.mjs`.
**Risk:** low. All changes are additive; if the browser doesn't have a microphone, the UI degrades gracefully (buttons say "This device won't let us record" like the sign flow does).

### Slice V2 — trustee bundle inclusion

**What the trustee sees:** the delivery bundle already sent to the trustee's email now includes, for every Important item that has a voice memo, an audio file named after the item plus a plain-text transcript-placeholder line. The bundle manifest lists the audio file alongside photos.

Not on this slice: fancy transcript generation. The transcript slot is left blank for now (Slice V3 might use a mock transcript, or we skip transcripts entirely — your call).

**Compute cost:** Roughly a quarter of step 4. Bundle building already iterates media; adding one more media_kind is small. Tests for the bundle need one extra case.
**Files touched:** `packages/reindeer-delivery/src/bundle/index.js` (~30 lines), `packages/reindeer-delivery/src/manifest/index.js` (~15 lines), one extended test in `two-outputs-bundle-test.mjs` (~40 lines).
**Risk:** medium. The bundle contract is what the trustee actually consumes. Small changes need careful review of the manifest format so downstream FairPlay import doesn't choke.

### Slice V3 — intake-flow recorder (prompt to record at capture time)

**What the owner sees:** in the item capture Review step, if they tick "This one is important", a new offer appears below the reason chips: "Would you like to say a few words about this one? Sixty seconds is plenty." Tapping Record shows the same recorder from Slice V1. The item still saves fine whether the recording is done, skipped, or attempted-and-cancelled.

**Compute cost:** Similar to Slice V1. Reuses the recorder from V1 but adds a new step to the intake flow, plus the corresponding save path.
**Files touched:** `apps/reindeer-registry/client/index.html` (new block after Important chips), `apps/reindeer-registry/client/app.js` (~150 lines for the new step and its state handling), tests updated so intake round-trips can include audio.
**Risk:** medium. The capture step is the most heavily tested screen in the app; a mistake here can hide items or break saves.

## Cheapest useful path

If you want to spend the least compute for a real improvement, **do Slice V1 only.** The owner still gets voice memos on Important items; they add them from the writer. The trustee doesn't receive them yet, but you have working audio in the app that you can look at and decide how far to push.

If you like V1 after seeing it, do V2 next (trustee receives them), and V3 last (recorder in the room scan).

## What I promise not to do without asking

- No renames, sweeping find-and-replace, dependency reinstalls, or schema changes.
- No changes to the auth invariants (magic-link, 20-min tokens, 30-day cookies, deny-by-default over `/api`, no `req.body.participantId`).
- No new packages installed.
- No changes to the sign flow or to the long memorandum recording that already ships.

## Sitting for morning

Read this, tell me which slice(s) to build (V1 alone is fine), and I'll take it from there.
