> **Superseded** — vocabulary in this document may use *PR*, *personal representative*, or *fiduciary* for what the current suite calls **trustee**, and may predate the three configurations and the heir-initiated end-trustee-mode endpoint. See [`docs/SUITE-OVERVIEW.md`](../SUITE-OVERVIEW.md) for the current model. This document is kept as history and is not being rewritten.

# Owner-authored comment and end-of-room review

**Date:** 2026-08-06 (Thursday, EDT)
**Predecessor:** `621323a` (Registry Important-flag rollout, complete)
**Approved by owner:** yes, in the conversation that produced this file.
**Supersedes / extends:** builds on the Important-flag design at
`docs/decisions/2026-08-06-important-flag.md`. Adds an owner-authored comment
field and two new prompts. Does not change the Important flag or the reason
enum already in place.

---

## Owner statement

Direct quotes from the conversation, kept for future me:

> The owner should be prompted to look again about the room. Ask "is there
> anything particular that you want to highlight as perhaps having special
> personal meaning or value? If yes flag as such with comment and if so
> assign to heir if you have strong feelings about it. Otherwise move to next
> room."

> The comment is important to keep for legacy value.

> If there is a comment it should be flagged. There was a reason to comment.
> Flagging in these cases should be automatically done.

> Owners always have the choice to add information even if financial. All
> high value will be appraised in fair choice if used. The registry app can
> stand alone.

> Prior to printing and submission a review of items should be offered but
> not demanded for specification and editing and provenance.

## The two-list model this rests on

`docs/TWO-LISTS.md` sets the frame. Registry captures two lists in one
inventory:

- **Assigned items** — the owner picked a specific person. These become
  Schedule A of the memorandum, the operative instruction to the trustee.
- **Everything else** — no recipient, and the item goes into the FairPlay
  pool for the heirs and the fiduciary to handle at settlement time.

There are no other buckets. "Deliberately not named" and "not yet decided"
collapse into "not assigned." This spec does not add a `naming_state` field.
It does not touch the `recipient_hint` field. Assignment is expressed today
by whether `recipient_hint.recipient_name` is set, and that remains the only
mechanism.

What this spec adds is an authoring surface — a way for the owner to leave a
note on any item that matters — and two prompts that surface the authoring
surface at natural moments.

## The three signals on an item

An item can carry, independently:

1. **A recipient** (`recipient_hint.recipient_name`). Names a specific heir.
   Existing field. Unchanged by this spec.
2. **The Important flag** (`owner_high_value` + `owner_high_value_reason`).
   Existing fields. Unchanged by this spec.
3. **The comment** (`owner_important_comment`). **New field.** Owner's own
   words about the item.

Any combination of the three is valid: recipient with no flag, flag with no
recipient, comment with no recipient, all three, none.

## The one invariant this spec adds

The comment and the Important flag are asymmetrically coupled:

- **Writing a comment turns the flag on automatically.** The owner does not
  have to tick a separate box. Non-whitespace text in the comment field ⇒
  `owner_high_value = true`.
- **Deleting a comment does not turn the flag off.** A comment that was
  written and then removed still leaves the flag on. The owner explicitly
  unflags to unflag.
- **Unflagging clears the comment.** Turning `owner_high_value` from true to
  false forces `owner_important_comment = ''` and
  `owner_high_value_reason = ''`. "Not flagged" means "nothing to say."

Server-side coercion enforces this in `validateItemRecord`, so a bad client
cannot create the impossible states `flag=false ∧ comment≠''` or
`flag=false ∧ reason≠''`.

## Schema — migration 8

One additive column on `items`:

```
ALTER TABLE items
  ADD COLUMN owner_important_comment TEXT NOT NULL DEFAULT '';
```

- Nothing renamed. Nothing dropped. No new index.
- Existing rows default to empty string.
- Length cap: **500 characters** (trimmed). Trimmed length beyond the cap is
  rejected with a 400 in the intake router. 500 is enough for a real
  paragraph and short enough to fit on a print sheet without crowding.

## Print output — the rule changes here

**Old rule (Important-flag spec):** the printed sheet shows the word
"Important" and never any dollar figures, appraisal words, or the reason
value.

**New rule (this spec, per owner direction):** the printed sheet shows the
word "Important" whenever `owner_high_value` is true, and shows the comment
verbatim as the owner wrote it. If the owner writes "$400 at estate sale
1998," that phrase prints. Registry does not shape the owner's own
authorship.

- The word "Important" and the comment print in the same subdued italic
  style already used for "Important" (`.important` / `.important-mark` CSS
  classes stay; a new `.important-comment` class is added).
- The reason enum (`'feeling'`, `'money'`, `'both'`) still never prints. It
  stays a private classifier used only for reporting counts.
- The guarding comment in the print template that today says "no money or
  appraisal wording on Registry printouts" is rewritten to say the new rule:
  the owner authors what appears in the comment; Registry prints it as
  written; FairPlay does its own appraisal work separately if the owner
  chooses to use FairPlay.

## Exchange envelope, CSV, importer

- **Envelope:** each item carries `owner_important_comment` at the top
  level. Counts include `owner_flagged_with_comment` alongside the existing
  `owner_flagged_important`.
- **CSV:** one new column appended at the end: `owner_important_comment`.
  Position-readers of earlier columns are unaffected; header-readers pick
  the new column up automatically. This is a wire-format change and is
  called out in the step 5 warning.
- **Importer:** round-trips the comment. A stale export without the column
  imports as `''`. The auto-flag invariant is applied on import too — a
  comment on an unflagged import row flips the flag on.

## Registry client UI

Four surfaces change. Three are new screens; one is a rework of the
existing Save step.

### 1. Photo-lane Save step (rework of existing screen)

The Important checkbox and its two reason chips stay as they are today. A
new comment field is added below them, always visible, quiet label:

> A note to leave with this item, if you want one.

Behavior:

- The comment field is a `<textarea>` capped at 500 characters. A small
  live counter reads "N of 500."
- Typing non-whitespace ticks the Important checkbox automatically and
  reveals the reason chips (same reveal path as before).
- Unticking the Important checkbox clears the comment field and resets the
  reason chips.

The Save step framing shifts to acknowledge that a deliberate photograph is
already a signal, without demanding an answer:

> You took this photograph on purpose. Was there a reason?

Save-with-name and Save-without-name remain the only two paths off this
screen. Neither is required to touch the comment or flag.

### 2. End-of-room prompt (new screen)

Appears twice — once at the end of the photo lane's last save in a room,
once at the end of a walkthrough review for a room. One screen, two big
buttons:

> **Before you move on to the next room, look again.**
>
> Is there anything in this room that has special personal meaning or value
> — to you, or that you think will matter to someone?
>
> [ Yes, let me flag something ] &nbsp; [ No, move to the next room ]

- **No** goes straight to the next room. Nothing on any item changes.
- **Yes** goes to the room-review screen.

The end-of-room prompt appears after **every** room, even one-item rooms. It
appears again if the owner comes back to that room later — the prompt is not
a one-time event. It is a nudge, not a checkpoint.

### 3. Room-review screen (new screen)

A list of every item in the current room, large tap targets, one row per
item. Each row shows the photo, the title, the current recipient (if any),
and the current Important state. Tapping a row opens an inline sheet with:

- Important checkbox + reason chips (same control as the Save step).
- Comment field (same control as the Save step).
- Recipient field, prefilled if a recipient was set during capture.

Saves are per-row and immediate (PATCH `/api/items/:id`). A row that gets no
edit is left alone.

A "Done with this room" button at the bottom moves to the next room in the
capture flow, or back to the home screen if there is no next room.

### 4. Pre-print review (new screen)

Offered from every print / export tile in the print center. An interstitial
screen appears:

> **Look over your list before you print.**
>
> You can skip this and print now, or step through your inventory to check
> or edit each item.
>
> [ Skip and print ] &nbsp; [ Review my list ]

- **Skip and print** proceeds to the printout as it does today.
- **Review my list** shows every item in the inventory in the same row
  format as the room-review screen, with the same inline edit sheet. When
  the owner is done, they hit "Print now" at the bottom.

This screen is a wrapper. It reuses the row and sheet from step 3.

### What does NOT change in the client

- Bulk `/intake/commit` still cannot set a recipient, cannot set the flag,
  cannot set the comment. All three land on unflagged, unnamed, empty.
- The walkthrough / video lane stays exactly as it is. The only difference
  is the end-of-room prompt appearing after the walkthrough review
  finishes.
- The item list view is unchanged. No filter chips.

## FairPlay

Out of scope for this spec. The exchange envelope carries the new field, so
whenever FairPlay is next updated to read the new envelope version it
will see the comment. No FairPlay code lands in this rollout.

## Explicit non-changes

- `body.high_value_flag = false` at
  `packages/legacy-intake-feature/src/server/router.js:104` — untouched.
- `req.body.participantId` / `x-participant-id` / `?participantId=` — still
  banned, no reintroduction.
- `high_value_flag` remains FairPlay's computed field. Registry never
  sets it, this spec does not touch it.
- No new participant identity paths. All new client endpoints are the
  existing authenticated routes.
- The `recipient_hint` field is unchanged. Assignment continues to be
  expressed by whether `recipient_hint.recipient_name` is set.
- The Important-flag reason enum stays four values (`''`, `'feeling'`,
  `'money'`, `'both'`). This spec does not add a fifth.

## Roundtrip test additions

Ten new checks added to `scripts/roundtrip-test.mjs` on top of the current
55:

1. POST an item with a comment; GET it back; comment survives.
2. POSTing a comment on an unflagged payload flips the flag on (server-side
   coercion).
3. PATCHing `owner_high_value: false` on a flagged item with a comment
   clears the comment.
4. Bulk `/intake/commit` items land with empty comment.
5. Comment prints on paper verbatim, character-for-character.
6. Comment prints even when reason is `'money'` (proves reason still
   doesn't affect print output).
7. Envelope carries the comment per item.
8. Envelope `counts.owner_flagged_with_comment` is separate from
   `counts.owner_flagged_important`.
9. CSV appends `owner_important_comment` at the end.
10. Importer round-trips a comment and applies the auto-flag invariant on
    import.

Target after step 5: **65 checks passed**.

## Steps and submits

Every step ends with `pplx project files submit -m "<msg>"`. Order:

1. **Spec** — this file. Commit before any code.
2. **Migration 8 + models + validator + repository.** The auto-flag
   invariant lives in `validateItemRecord`. The clear-on-unflag invariant
   lives in the validator too.
3. **Intake router.** POST and PATCH accept `owner_important_comment`;
   coercion applied server-side; `/intake/commit` defaults to `''`.
4. **Print template.** Comment prints under the title on flagged items;
   the guarding comment in the template is rewritten to the new rule.
5. **Exchange envelope + CSV + importer.** Envelope carries the field,
   CSV appends the column at the end, importer round-trips.
   **Wire-format warning at this step.**
6. **Client UI.** Split into three sub-commits for reviewability:
   6a. Save-step comment field + auto-flag wiring.
   6b. End-of-room prompt + room-review screen (new session-state:
       "current room in progress").
   6c. Pre-print review interstitial + row/sheet reuse.
7. **Tests + fresh Registry screenshots.** Roundtrip test at 65; the three
   FairPlay self-tests still at 47 / 40 / 35 (no FairPlay code
   changed).

## The one design point I want to state plainly

The comment is legacy content. It travels. It prints. Whatever the owner
writes appears on the page and in the export, verbatim. Registry does not
edit the owner. If the owner writes a dollar figure, a dollar figure
prints. This is a deliberate reversal of the old print-side rule, and it is
what the owner explicitly asked for.
