# Registry does not set `high_value_flag` — FairPlay does

**Date:** 2026-08-09
**Status:** in effect; captured retroactively
**Where the code is:** `packages/legacy-intake-feature/src/vision/index.js` (`screenHighValue`), `packages/legacy-intake-feature/src/vision/anthropic.js` (Anthropic provider result mapper)

## Decision

`high_value_flag` on the Registry vision output is **always `false`**, regardless of the vision model's suggested price range. The field is retained in the wire shape only because the ReindeerExchange envelope carries it; Registry itself makes no value-tier claim.

FairPlay, downstream, is responsible for tiering: it uses its own value estimate together with the PR-chosen threshold to decide whether an item enters the high-value quarantine pool (per P-002 patent notes).

## Why

- Registry is owner-driven. It documents what the owner captures; it does not assert value.
- The vision provider's price range is a **suggestion** the owner may accept, edit, or ignore. Escalating that suggestion into a boolean flag on the item itself would put Registry in the appraisal business, which it is not.
- Two apps + one field is only safe if exactly one app writes it. FairPlay owns the write; Registry owns the read (and always writes `false`).
- The vision code already documents this decision in-line — the decision doc simply captures why the test was updated to match.

## What the vision code DOES do with the range

- Preserves the low/high range on `value_suggestion` so the owner sees it in capture and can accept or ignore.
- Sets `appraisal_suggested = true` when the item text hits a cue word (e.g. "diamond", "karat", "sterling"). A bare title with no description does not fire the cue set — this is intentional; the app should not lecture the owner based on the word "Ring" alone.
- Leaves `high_value_flag` at `false`.

## What changed in this commit

`scripts/vision-test.mjs` previously asserted `high_value_flag === true` for a Ring with a $1,200–$4,000 range and no maker. That assertion has been in the test since before the current design was settled and did not match the two clearly-commented pieces of vision code above. The test now asserts the current design: `high_value_flag === false`, AND the suggested range still travels on `value_suggestion` for the owner to accept or ignore.

Bug log entry: B-002 (medium).

## If we ever want Registry to set `high_value_flag`

Change the design in one place — the mapper in `anthropic.js` and the `screenHighValue` helper in `vision/index.js` — and then update both this decision doc and FairPlay's tiering logic to avoid double-counting.
