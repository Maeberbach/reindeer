# Slice B — step 4 verification (2026-08-09)

## What this pass did

Loaded the new "Special gifts by name" screen in a real browser against a
seeded server and found four small UI bugs. Fixed all four, re-checked in
the browser, and re-ran the whole registry test matrix — everything green.

## Bugs found and fixed

1. **Conflict banner did not fire.** The seeder had invited a partner but
   never confirmed the household into couple mode. `POST
   /api/household-link/confirm` is the flip. The app itself is fine; only
   the seeder needed to know about it. (`scripts/seed-memo-browser.mjs`
   now calls confirm after Bob signs in.)
2. **"Past signed versions" link showed even with zero signed versions.**
   `.linky` has `display:block` which beat the `hidden` attribute.
   `renderMemo` now also sets `style.display = 'none'` when the button
   should be hidden. Same treatment applied to the "Remove this promise"
   link on the entry form, which had the same visibility problem when
   adding (not editing) a promise.
3. **"Remove this promise" showed on the Add form.** Same `.linky` /
   `hidden` interaction. Now hidden with both attribute and inline style.
4. **Heir chip did not visually highlight the selected person while
   editing.** The renderer emitted `class="chip active"` but the CSS
   styles selection through `aria-pressed="true"`. Renderer now emits
   `aria-pressed` instead.

## Verified visually

Six screenshots (mobile viewport, 420×900, DPR 2):

- 01 home
- 02 writer with gold conflict banner + Sort out tag
- 03 empty entry form (no Remove button)
- 04 filled entry form (Sarah chip highlighted in accent color)
- 05 writer after save
- 06 edit form (heir chip highlighted, Remove button present)

## Verified with tests (all green)

- roundtrip 66 · memorandum unit 64 · memorandum-http 68
- people-http 36 · sign-http 43 · household-link-http 48
- two-lane 22 · two-outputs-envelope 37 · two-outputs-bundle 60
- vision 32 · content-lint clean · auth 33

## Still not built (as agreed — separate conversation)

- Step 5: conflict banner on Review + item detail + Home tile
- Step 6: sign flow with modified confirm + versioning
- Step 7: PDF template with Not-agreed markers
- Step 8: full test matrix — done as part of this pass, no new failures
- Step 9: handoff + submit — done as part of this pass

## Files touched in this pass

- `apps/reindeer-registry/client/app.js` (four small changes, ~10 lines)
- `scripts/seed-memo-browser.mjs` (new helper for future browser checks)
- `HANDOFF_SLICE_B_STEP4_VERIFY.md` (this file)
