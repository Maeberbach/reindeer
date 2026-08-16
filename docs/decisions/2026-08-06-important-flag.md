# Owner-set "Important" flag on Registry items

**Status:** approved 2026-08-06, not yet implemented at time of writing.
**Approving thread:** session `25fca813` (2026-08-06), turns 40–43.
**Predecessor commit:** `b9fcbca` (nine visible chips + silent twenty + crossing map).

## Why this exists

Registry documents; it does not value. FairPlay already has a computed
`high_value_flag` set by its own AI estimate against the personal
representative's threshold, and the two must not be mistakable for one
another. But the owner sitting in their own hallway with a phone has a third
thing to say that neither of those captures: *this one matters to me,
right now, for reasons I may or may not want to explain.*

The flag exists to carry that mark forward on the printout and into Fair
Choice, without ever letting it read as a valuation.

## Rules the design has to satisfy

- The wording must not presume money, an appraiser, or a market. The user's
  exact phrasing from the approval:
  - checkbox label: **"This one is important"**
  - checkbox hint: **"It matters, for whatever reason."**
  - optional reason chips revealed on tick: **"It means a lot"** and
    **"It is worth money"** — either, both, or neither is valid.
- Skipping the reason chips is fine and leaves the item flagged without a
  stated reason. The ambiguity is intentional.
- The word **"Important"** appears on the printout next to the item's name.
  No dollar figure. No "high value" language. No money or appraisal wording
  anywhere on the page — even when the owner's private reason was "It is
  worth money," because this is the owner's feeling, not a valuation.
- Registry never sets FairPlay's computed `high_value_flag`. The existing
  line `body.high_value_flag = false` in the intake router stays exactly as
  it is.

## Data model

Two additive columns on `items`, both defaulted so existing inventories
upgrade untouched:

| column | type | default | values |
|---|---|---|---|
| `owner_high_value` | INTEGER | `0` | `0` or `1` |
| `owner_high_value_reason` | TEXT | `''` | `''`, `feeling`, `money`, `both` |

Migration id **7**, name `owner_important_flag`.

## Files that change

### `packages/legacy-core-data/src/migrations/index.js`
Append migration 7 adding the two columns above.

### `packages/legacy-core-data/src/repositories/itemRepository.js`
`toRow` writes `owner_high_value` as 0/1; `fromRow` reads it back as a
boolean. Both new fields participate in `INSERT` and `UPDATE`. `list()`
supports an optional `owner_high_value_only` query flag (parallel to the
existing `high_value_only`, kept distinct on purpose).

### `packages/legacy-core-api/src/models/index.js`
`makeItemRecord` defaults `owner_high_value: false` and
`owner_high_value_reason: ''`. No new enum export — the four allowed reason
values live in the schema validator.

### `packages/legacy-core-api/src/schema/index.js`
`validateItemRecord` accepts the two new fields as optional. `owner_high_value`
coerces to boolean. `owner_high_value_reason` must be one of the four allowed
strings. `ITEM_JSON_SCHEMA` gains both properties (not required).

### `packages/legacy-intake-feature/src/server/router.js`
`POST /items` and `PATCH /items/:id` accept `owner_high_value` and
`owner_high_value_reason` from the client. **The existing line
`body.high_value_flag = false` stays exactly as it is** — Registry still
never sets FairPlay's computed field.

### `packages/legacy-print-feature/src/templates/index.js`
- Remove the `HIGH VALUE` and `HV` badges (they were tied to the computed
  flag that Registry never sets, so they were always empty here).
- Remove the "high-value" count from the summary line.
- On items where `owner_high_value` is true, print the single word
  **Important** next to the item's title, in a subdued style. No dollar
  figure, no reason word (the reason stays in the data for FairPlay; it
  does not appear on paper).

### `apps/reindeer-registry/client/index.html`
On the review step of the capture flow, and on an item's own edit screen:
one checkbox `"This one is important"` with the hint
`"It matters, for whatever reason."`. Ticking it reveals two optional chips
`"It means a lot"` and `"It is worth money"` (either, both, or neither).

Also remove the "High-value only" print tile from the tiles list.

### `apps/reindeer-registry/preview/index.html`
Same tile removal in the demo copy so the preview does not offer a report
that always came out empty.

### `apps/reindeer-registry/client/app.js`
Sends both fields on save; restores them when an item is reopened; shows
the mark in the item list so the flag survives reload and is visible
without opening the item.

### `apps/reindeer-registry/client/styles.css`
Styling for the two optional chips at the same large-target size as the
existing room and category chips.

### `packages/reindeer-exchange/src/v1/envelope.js`
Carries both fields on each item. Bundle counts gain
`owner_high_value: <n>` (kept separate from the existing `high_value: <n>`
count).

### `packages/reindeer-exchange/src/v1/csv.js`
Two new columns appended **at the end**:
`owner_important` (yes/no) and `owner_important_reason`.

### `packages/reindeer-exchange/src/importer.js`
Reads both fields back and passes them to `itemRepo.create` / `.update`
unchanged. FairPlay sorts flagged items forward and can send
money-flagged ones to the appraiser first, but it never reads this as a
valuation and never sets its own computed `high_value_flag` from it.

### `scripts/roundtrip-test.mjs`
New checks:
- The flag round-trips through export → import unchanged.
- The reason round-trips through export → import unchanged.
- The printout carries the word "Important" and carries no money or
  appraisal language for a flagged item.
- The registry save still never sets `high_value_flag = true` even when
  `owner_high_value = true`.

Check count moves off its current value; the new count is reported by the
run itself.

## Explicit breakage warning

The exchange CSV gains two columns at the end. Anything that reads the CSV
**by column position rather than by header** will shift. Nothing is renamed,
nothing is removed from the wire format, and both sides ignore fields they
do not recognise, so old bundles still import and new bundles still load
into an older FairPlay.

## Rollout order (each step ends with `pplx project files submit`)

1. This decision file. *(no code)*
2. Migration 7 + models + schema + itemRepository, running self-tests.
3. Intake router accepts the two fields; `high_value_flag = false` line
   verified unchanged.
4. Print template: remove HV badges, add "Important" word.
5. Exchange envelope, CSV, importer — round-trip test updated.
6. Registry client HTML/JS/CSS + preview tile removal.
7. Final `roundtrip-test.mjs` run and FairPlay self-tests; report new
   check counts.
