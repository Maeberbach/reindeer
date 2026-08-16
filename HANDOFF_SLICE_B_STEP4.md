# Slice B — step 4 saved untested (2026-08-09 evening)

Saving mid-step 4 so the work is not lost. Nothing in this commit has
been opened in a browser. The test suite has not been re-run since the
client code was added. **Verify before trusting.**

## What is done (steps 1–3, tested green earlier this session)

- **Step 1** — migration 16 added the two new tables
  `memorandum_entries` and `memorandum_signings`.
- **Step 2** — `MemorandumRepo` at
  `packages/legacy-core-data/src/repos/memorandumRepo.js`. Self-test at
  `scripts/memorandum-test.mjs` passed 64/64 when last run.
- **Step 3** — HTTP router at
  `apps/reindeer-registry/server/routes/memorandum.js`, mounted from
  `apps/reindeer-registry/server/index.js`. HTTP integration test at
  `scripts/memorandum-http-test.mjs` passed 68/68 when last run.

## What is done in step 4 but NOT verified

- Home tile "Special gifts by name" now opens `data-screen="memo"`
  instead of the old `gifts` screen. Old screen still exists in the
  file, just unreachable from Home.
- New screens added to `apps/reindeer-registry/client/index.html`:
  `data-screen="memo"` (the writer) and `data-screen="memoentry"` (add
  or edit one promise).
- Styles for the new screens appended to
  `apps/reindeer-registry/client/styles.css` — banners, entry rows,
  item picker, heir chips.
- Client code appended to `apps/reindeer-registry/client/app.js` — the
  `loadMemo` / `renderMemo` / `renderMemoConflicts` /
  `openMemoEntry` / `saveMemoEntry` / `removeMemoEntry` block.
- `go()` router in `app.js` now recognises `memo` and `memoentry`.

## Known open questions before finishing step 4

1. Client has never been rendered in a browser. First thing next
   session: start the registry on port 3210 and click through as a
   real user.
2. Test matrix has not been re-run since step 3. Nothing in step 4
   touches the server, so the server tests should still be green,
   but confirm before moving on.
3. `#memoSignBtn` and `#memoVersionsBtn` currently route to the OLD
   giftsign / giftversions screens as placeholders. That is on
   purpose — step 6 replaces the sign flow, step 7 replaces the PDF.
   Do not treat these placeholders as final.
4. Conflict banner has never seen real cross-partner data in a
   browser. The logic is exercised by the HTTP self-test but the
   visual has not been eyeballed.

## Steps still to do

5. Conflict banner on item detail and Home tile counter.
6. Sign flow with the modified-confirm dialog and version bump.
7. Per-partner memorandum PDF with "Not agreed with partner" markers.
8. Full test matrix sweep (all suites).
9. Handoff doc + submit.

## User instructions still in force

- Ask before touching schema or wire formats.
- No code before approval on non-trivial changes.
- Elderly-forgiving UI, plain language throughout.
- Auth invariants (magic links only, no participantId from body /
  header / query) are non-negotiable.
- Locked copy: post-signing-edit banner, conflict banner, version-
  bump message are user-written and not to be paraphrased.

## Cost-conscious note

The user asked to bank progress and stop for the night rather than
verify. Next session's cheapest path forward is:
  1. Open the registry in a browser and click through the new screen.
  2. Fix whatever is broken.
  3. Only then decide whether to keep going with steps 5–9.
