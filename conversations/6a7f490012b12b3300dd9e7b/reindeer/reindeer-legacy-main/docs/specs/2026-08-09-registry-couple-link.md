# Registry — Linking two Solo Registries into a Couple household

**Status:** Target-state spec. Supersedes §"Migration for existing Solo
Registries" and §"Two-participant sign-in" of
`docs/specs/2026-08-09-registry-couple-mode.md`.
**Date:** 2026-08-09 (revised same day, five owner decisions folded in)
**Related:** `registry-couple-mode.md`, `registry-two-outputs.md`,
`registry-owner-voice-message.md`

## Direction from the owner (2026-08-09, in order)

> "Each user of the couple needs their own page to validate and send."
> "Two different devices. Each person needs to create their own
> memorandum. But some things they both may decide but won't take
> effect until the death of the last."

> "The entire household is owned by both. The only time differentiation
> is needed is in the memorandum of special gifting. Those items with
> specific pictures can be linked to the user that logged to them, and
> then saved for a communion between both individual individuals for
> final decision."

> "Items are essentially common property, except perhaps individually
> titled motor vehicles. So common understanding is important so the
> trustee can manage their distributions with ease. That should be
> pointed out to the users as they are specifying special items for
> gifting or flagging as important."

> "He is to obtain a uniform decision to avoid any confusion at the
> time of an individual's death."

> "Correct it is a flag. That should be resolved together by reviewing
> the item list and approving together."

**Signing gate on unresolved items (owner decision 2026-08-09):**
*"Sign anyway; the paper tells the truth."* Ann can always sign her
own memorandum; the printed page and trustee cover sheet clearly mark
which items are agreed with Bob and which are not.

## Model

**Two devices, two accounts, one household.** Each spouse
authenticates independently, sees only their own Confirm-your-choices
screen, signs their own memorandum on their own device, and delivers
to their own wills-caretaker.

**The household inventory is joint.** Every item, every photo, every
heir, every caretaker belongs to both spouses equally. The only
per-spouse concept in the inventory itself is a **claim** on an item
— either a memorandum tag ("I want this to go to Sarah under my
will") or an Important flag ("this one matters, trustee please
notice").

**Claims exist to produce a uniform decision.** The whole point of
the couple-mode plumbing is to make sure that at the time of one
spouse's death, the surviving spouse and the trustee are looking at
the same story. The app does not adjudicate — it documents.

**Titled property is the one real exception.** Cars, boats, a share
of an LLC — anything with its own title document — is handled by
whoever holds the title, not by a memorandum. Registry lists such
items under a distinct heading on the trustee cover sheet.

## Data model

### Household record (`scopes` table)

Extend the existing table:

```
scopes {
  ...existing...
  household_mode:            'solo' | 'couple' | 'survivor'    -- default 'solo'
  linked_household_id:       nullable text                     -- self-ref, see below
  linked_at:                 nullable timestamp
  linked_by_participant_id:  nullable text                     -- who accepted the link
}
```

### Participants (`scope_people` table)

Add:

```
scope_people {
  ...existing...
  role:                'owner' | 'heir' | 'named_recipient' | 'trustee'
                       -- migration: role='owner' on the pre-existing solo participant,
                       -- role='heir' on the rest
  household_role:      'primary' | 'partner' | null
                       -- non-null only for role='owner' in couple mode
  email:               nullable text (login identity)
  account_status:      'active' | 'invited' | 'declined' | 'deceased'
}
```

At most two `role='owner'` rows per scope. Enforced at write time by
the participants repo (plain error message: "This household already
has two owners.").

### Items

Items have **no owner column**. The household inventory is joint.
Items gain exactly one nullable boolean for the titled-property
exception:

```
items {
  ...existing...
  is_titled_property:  integer NOT NULL DEFAULT 0
}
```

Solo mode migration: default 0, no back-fill logic needed.

### Memorandum claims

```
memorandum_claims {
  claim_id                       -- ulid
  scope_id                       -- household
  item_id                        -- the shared item this claim covers
  tagged_by_participant_id       -- Ann or Bob
  tagged_at
  proposed_heir_id
  final_owner_participant_id     -- whose memorandum this lands on; defaults to tagged_by
  final_heir_id                  -- defaults to proposed_heir_id
  status                         -- 'proposed' | 'agreed' | 'contested' | 'withdrawn'
  agreed_by_participant_id
  agreed_at
  contested_by_participant_id
  contested_reason
  contested_at
  created_at, updated_at
}
```

State machine:

- `proposed` — tagging spouse has made the intent. Immediately eligible
  for the tagging spouse's addendum preview; annotated *"awaiting
  review with {spouse}."*
- `agreed` — the other spouse has said yes. Prints clean on the
  memorandum.
- `contested` — the other spouse said no, with a one-line reason.
  Still eligible for the tagging spouse's addendum preview but annotated
  with the objection reason on the printed page.
- `withdrawn` — tagging spouse pulled it. Excluded from every preview
  and every printed page.

### Importance claims

Importance is a claim too, resolved by review-together, not by a
solo toggle:

```
importance_claims {
  claim_id
  scope_id
  item_id
  proposed_by_participant_id     -- Ann or Bob
  proposed_reason                -- optional short text
  status                         -- 'proposed' | 'agreed' | 'declined' | 'withdrawn'
  agreed_by_participant_id
  agreed_at
  declined_by_participant_id
  declined_reason
  declined_at
  created_at, updated_at
}
```

In Solo mode, importance claims auto-agree at insert time (the single
owner is on both sides of the review). This preserves the existing
Solo Important badge behavior with no code changes above the repo
layer.

### Version snapshots

`addendum_versions.items_snapshot` already stores each item in a
signed version. Each snapshot entry gains:

```
{
  ...existing item fields...
  memorandum_claim_status_at_sign:  'proposed' | 'agreed' | 'contested'
  contested_reason_at_sign:         string or null
  importance_status_at_sign:        'proposed' | 'agreed' | null
}
```

This is what lets the printed page and trustee cover sheet tell the
truth about what was joint and what wasn't at the moment Ann signed.
A later objection from Bob cannot rewrite an already-signed version.

## Setup and linking (two Solo Registries → one household)

### Phase 1 — Each spouse builds a Solo Registry

Both Ann and Bob sign in fresh with magic links on their own devices.
Each builds their Registry the current Solo way: rooms, items, heirs,
trustee, wills-caretaker, memorandum. Nothing new.

### Phase 2 — One initiates linking

Settings → **"Link this Registry with my spouse or partner."** Ann
enters Bob's email. Bob receives an in-app notice on his next sign-in:

> **Ann Ellis wants to link her Registry with yours.**
>
> If you accept:
>
> - Ann's household inventory and yours become one shared list. Both
>   of you can add and edit items in the shared list.
> - Ann's memorandum stays Ann's. Yours stays yours. Signatures never
>   cross.
> - Signed versions you both already have on file are preserved.
> - The link cannot be undone. Separation would mean starting over.
>
> [ Not now ] [ Accept and link with Ann ]

Both actions logged in `audit_log` with `event='household_linked'`.

### Phase 3 — The merge (server-side, atomic)

Single transaction:

1. Initiator's `scopes` row survives. Other row is archived.
2. On the surviving row: `household_mode='couple'`, `linked_at=now`,
   `linked_by_participant_id=<accepter>`.
3. Rewrite `scope_id` on every relation of the non-surviving scope:
   `scope_people`, `rooms`, `items`, `wills_caretakers`, `trustees`,
   `heirs`, `scope_media`, `addendum_versions`, `deliveries`,
   `duplicate_groups`, `intake_queue`, `audit_log`.
4. Deduplicate `heirs`, `wills_caretakers`, and `trustees` by
   `(lowercase(name), email if set)`. When a duplicate collapses, any
   FK pointing at the losing row is rewritten to the winner.
5. **Do NOT deduplicate items.** Wedding china entered by both stays
   as two rows; the duplicates module surfaces the pair as a
   suggestion for the couple to resolve by hand.
6. **Pre-link memorandum intent becomes agreed claims.** For every
   item in either scope with `assigned_to_heir_id` set before the
   link, insert a `memorandum_claims` row with `tagged_by=<that
   spouse>`, `final_owner=<that spouse>`, `status='agreed'`,
   `agreed_at=<link timestamp>`. That intent was already on that
   spouse's own signed memorandum; it carries standing.
7. **Pre-link Important flags become agreed importance claims** with
   the same treatment.
8. `addendum_versions` preserved untouched. Ann's v1, v2, v3 keep her
   `owner_participant_id`. Bob's v1 keeps his.
9. Insert `archived_scopes` row for the non-surviving id.

Atomic: commits fully or rolls back. Half-linked state impossible.

### Phase 4 — After the link

- Both home screens show a header: **"Ellis household · Ann and Bob."**
- Each spouse sees only their own memorandum on their own Confirm
  screen.
- Household inventory is shared; the main list does not attribute who
  added which item (the inventory is joint, so attribution belongs in
  audit view only, not in the main UI).
- Each spouse's wills-caretaker list stays separate. Shared attorney
  = each spouse adds them to their own list.

## Communion — the "Review together" flow

**Home screen tile.** In Couple and Survivor mode, both spouses see:

> **Review together · N**

where N = count of items with any `status='proposed'` claim
(memorandum or importance). Zero → hide the tile.

Tapping opens the Review together screen. Each row shows:

- Item photo and name.
- What's proposed:
  - *"Ann proposed: this should go to Sarah on my memorandum."*
  - *"Ann proposed: mark this Important — 'engagement ring, generations.'"*
  - Both, if applicable.
- Buttons:
  - **Agree** (per proposal)
  - **Change** (opens Redirect / edit — for memorandum tags) or
    **Decline with reason** (for importance flags)
- Optional one-line "why" from either spouse, saved on the claim.

Either spouse can open the screen. Either can tap Agree. Memorandum
tags and importance flags resolve independently — you can agree the
item matters without agreeing it goes to Sarah.

**Redirect flow for memorandum tags.** Bob taps Change on Ann's tag
(Wedding china → Sarah on Ann's memorandum). He proposes: *"I want
this on my memorandum instead."* A new claim is inserted with
`tagged_by=Bob, final_owner=Bob, status='proposed'`. Ann sees Bob's
proposal in her tray. If she agrees, Bob's goes agreed and Ann's
original goes withdrawn. If she declines, both claims stand as-is
(Ann's on hers, Bob's proposal is withdrawn).

**Same item on both memoranda.** Either spouse can tap **Add this to
my memorandum too** on item detail. Creates a parallel claim on the
same `item_id`. Both can settle to agreed. Item appears on both
memoranda. Whichever spouse dies first, the item flows under that
will; at second death, the survivor's memorandum carries the
(redundant, and fine) intent.

## Communion nudges — where the app says it out loud

Owner direction 2026-08-09: the app must remind the couple that
items are shared and the trustee's job gets easier when both spouses
know what's been tagged. Two moments each carry one plain line.

**On "Assign to somebody" (Couple mode only), under the assign
controls:**

> You and {SpouseFirstName} both own this. Assigning it to {HeirName}
> puts it on your memorandum. {SpouseFirstName} will see it in Review
> together. Trustees have an easier time when you both agree on the
> list.

**On the Important toggle (Couple mode only):**

> You and {SpouseFirstName} both own this. Flagging it as Important is
> a message to your trustee: this one matters. {SpouseFirstName} will
> see it in Review together. Trustees have an easier time when you
> both agree it matters.

Neither nudge is a modal. Neither blocks. Sized like existing help
copy.

## Signing with unresolved claims

Owner decision 2026-08-09: **sign anyway; the paper tells the truth.**

**Confirm-your-choices screen, above the phrase input:**

```
Your list has 8 items.
  ✓ 5 agreed with Bob
  ⋯ 2 waiting for Bob's review
  ⚠ 1 Bob disagreed with

You can still confirm today. Items Bob hasn't reviewed will be
marked that way on the paper so your trustee knows to check with
him. We recommend reviewing together first if you can.
```

Ann can proceed regardless. The Confirm button is never disabled by
the state of joint review.

**On the printed memorandum page:**

- Agreed items print clean.
- Proposed items print with a small annotation next to the line:
  *"(Not yet reviewed with Bob.)"*
- Contested items print with a small annotation:
  *"(Bob disagreed: '{reason}'.)"*

**On the trustee cover sheet, in the household summary block:**

```
Ann Ellis — Memorandum v3 signed 2026-08-09
  12 items total
  10 agreed with Bob
  1 not yet reviewed with Bob
  1 Bob disagreed with (see item detail)

Bob Ellis — Memorandum v2 signed 2026-07-22
  8 items total
  8 agreed with Ann

Titled property (verify with the wills and titles): 2 items
Important items (agreed by household): 4
Important items (proposed, not yet reviewed): 1
```

Trustee sees the sensitive spots in one glance.

## Titled property

Item detail, both modes:

> ☐ This has its own title document (car, boat, share of an LLC).
>
> *Titled property is handled by whoever holds the title, not by this
> memorandum. Your attorney will match it up. Registry lists it here
> so your trustee sees the picture and the story.*

- Checkbox writes `items.is_titled_property = 1`.
- Titled items **may** still carry a memorandum claim (some owners
  want the intent on record even though the title carries the day).
  The assign controls remain available with an inline hint:
  *"Because this is titled property, your attorney will check the
  title first. Your memorandum records what you wished."*
- On the trustee cover sheet and printed report, titled items appear
  under **Titled property (verify with the wills and titles).** They
  are excluded from any household-inventory count and from any Fair
  Choice pool that might run against remaining chattels.
- Registry does not auto-detect. User ticks or doesn't tick.

## Prior signed versions across the link

Signed versions that predate the link stay valid — they are that
spouse's authenticated intent as of that date. Caretakers who hold
pre-link versions still hold valid memoranda.

Post-link, Ann can sign v3 which supersedes her v2 the normal way.
The version chain is per-owner-participant and does not care about
the merge.

## First-death (survivor) conversion — unchanged

Per `registry-couple-mode.md`. Deceased spouse's memorandum freezes
at its latest signed version. Their voice message is released. Their
wills-caretaker gets the frozen bundle. Household mode becomes
`survivor`. Surviving spouse's memorandum continues.

**One addition:** on entering survivor mode, all outstanding
`status='proposed'` claims where the deceased spouse was the
tagger auto-agree (surviving spouse can no longer review with them,
and the intent is already signed into the deceased's frozen memorandum
if it made it that far). Claims where the survivor was the tagger and
the deceased spouse never agreed auto-transition to `agreed` with
`agreed_by=<system>, agreed_at=<death timestamp>` and a note in the
audit log: *"survivor-conversion auto-agreement."*

## Second-death conversion — unchanged

Per `registry-couple-mode.md`. Household inventory delivered to the
trustee; surviving spouse's memorandum delivered to their caretaker;
Registry becomes read-only for the household.

## What is NOT in this spec (fences)

- **No simultaneous-death clause in the app.** Registry documents
  wishes; the attorney handles the will clause. Trustee cover sheet
  includes: *"Registry does not record any simultaneous-death
  presumption. Consult the wills for that."*
- **No 3+ owners.** Exactly two per couple household.
- **No unlink.** Once linked, always linked, until survivor
  conversion. Separation = new Solo Registry.
- **No cross-signing.** No spouse ever authenticates, drafts, edits,
  or signs on behalf of the other. The existing deny-by-default over
  `/api` covers this at the routing layer.
- **No shared voice message.** Each spouse records their own or
  doesn't.
- **No blocking on unresolved claims.** The Confirm button is never
  disabled by joint-review state. Owner decision 2026-08-09.

## Test surface (planned)

- Roundtrip test grows a couple-household case: two owners, one
  shared item with two agreed claims (Ann→Sarah, Bob→Sarah), each
  spouse's addendum preview shows the item. One titled item with a
  claim on Ann's side asserts it appears under "Titled property" on
  the trustee cover sheet and on Ann's memorandum with the
  title-check hint. One importance claim resolved to `agreed`, one
  still `proposed` at sign time — asserts the signed version snapshot
  captures both states.
- New self-test: `scripts/couple-link-test.mjs` — merge transaction,
  heir/caretaker/trustee dedup, no item dedup, pre-link
  `assigned_to_heir_id` → agreed claim conversion, pre-link Important
  flag → agreed importance claim conversion, preservation of pre-link
  signed versions, atomic rollback on simulated failure mid-merge.
- New self-test: `scripts/couple-claims-test.mjs` — memorandum-claim
  state machine (proposed → agreed, proposed → contested, proposed →
  withdrawn, redirect flow), importance-claim state machine,
  addendum-preview inclusion of proposed and contested claims with
  correct annotations, guarantee that objecting to a claim on an
  already-signed version does not rewrite the signed version.
- New self-test: `scripts/couple-signing-test.mjs` — signing with all
  agreed produces a clean printed page; signing with mixed statuses
  produces annotated lines; trustee cover sheet counts match the
  claims table at the signing timestamp.
- Auth test grows: Ann's session cannot create a claim with
  `tagged_by=Bob`, cannot GET Bob's addendum preview, cannot agree
  to her own claims on Bob's behalf, cannot set
  `is_titled_property` on an item outside her household. Bob's
  session mirrors.

## Open questions for the code phase

1. **Review together tile placement.** Instinct: home screen, sibling
   of "My items" and "My people," visible only when N > 0.
2. **Bob already signed in on a different Registry when Ann invites
   him.** Instinct: he signs out of the other one; the link cannot
   proceed until his primary account is the one being linked.
3. **Both spouses accidentally use the same email.** Instinct: reject
   at Phase 2 with "This email is already the initiator. Please have
   your spouse use a different email address."
4. **Titled-property title-holder name field?** Instinct: no. The
   title document itself carries that. Adding a name on the item
   duplicates data that is not Registry's job to hold.
5. **Should the Confirm-your-choices summary ("5 agreed, 2 waiting,
   1 disagreed") also render when everything is agreed?** Instinct:
   yes, as a single line — *"Your list has 8 items. All 8 are agreed
   with Bob. ✓"* Reinforces the good outcome.
