# Registry — Couple Mode

**Status:** Target-state spec. Awaiting code approval.
**Date:** 2026-08-09
**Related:** `registry-two-outputs.md`, `owner-voice-message.md`, `registry-closeup-photo.md`

## What Couple mode is

A single Registry session shared by two adults (typically spouses in a joint estate). Both can add and edit household inventory items together or independently to speed the process for the whole household. Each has their own specific-giving addendum tied to their own will.

## What Couple mode is NOT

- **Not required.** Solo mode remains the default and covers second marriages, single adults, and any couple who prefers to keep everything separate.
- **Not co-ownership of items.** Every item in the household inventory is just "a household item." Ownership only becomes relevant when an item is placed in one spouse's addendum — at that moment the spouse who assigns it is asserting it as theirs to give.
- **Not a merger of two wills.** Two wills stay two wills. Two addenda stay two addenda. Two voice messages, one per spouse.

## Choosing the mode

At Registry setup, the first-time owner sees:

> **"Who's making this Registry?"**
>
> [ Just me ] — solo
> [ Me and my spouse/partner ] — couple
>
> You can change this later.

**"Change this later" is intentional.** Solo → Couple is a common upgrade path (one spouse starts, later invites the other). Couple → Solo happens on death of a spouse (survivor conversion, see below) or on separation.

## Participant model

A Couple-mode Registry has exactly two adult participants, both with full editing rights over the household inventory. They are peers — neither is admin over the other. In the data model this looks like:

```
household {
  id, name, created_at, mode: 'solo' | 'couple' | 'survivor'
  participants[]: {
    id, display_name, email, role: 'owner'
    invited_at, joined_at, active
    wills_caretaker: { name, contact, delivery_method }
    trustee: { name, contact, delivery_method }  // may be shared or per-spouse
    voice_message_ref: nullable
    addendum_current_version: int
    addendum_status: 'draft' | 'signed_current' | 'signed_stale' | 'frozen'
  }
}
```

Note: `trustee` may or may not be shared between spouses depending on the trust structure. The model allows per-spouse to be safe, with a UI convenience "same as [other spouse]" toggle.

## Two-participant sign-in

Both spouses use the existing magic-link auth. Neither can act as the other (the standing anti-impersonation rule is unchanged). Shared-device scenario is common (couples often share an iPad), so:

- Registry supports fast-switch between the two participants on the same device.
- The current active participant is shown clearly at the top of every screen: "Signed in as **Ann**" with a one-tap switch to "Sign in as Bob."
- Every action (add item, edit item, assign item, record voice, sign addendum) is stamped with the participant who did it.

## What both spouses share vs. what's per-spouse

### Shared (household-level)

- **Household inventory** — one list, both edit. Rooms, items, wide-shot photos, descriptions, notes.
- **Household name** (e.g. "The Eberbach household").
- **Trustee contact** (usually — model allows per-spouse but UI defaults to shared).
- **Delivery preferences** for the inventory (which trustee, how delivered at death).

### Per-spouse

- **Addendum** — Ann's assigned items are in Ann's addendum. Bob's assigned items are in Bob's addendum. Never mixed.
- **Wills-storage caretaker** — may be the same attorney or two different ones. Enter separately.
- **Voice message** — one per spouse, optional, riding with that spouse's addendum.
- **Addendum signature** — Ann signs her own; Bob signs his own. Neither can sign the other's.
- **Update-cadence prompts** — each spouse gets their own annual review nudge, on the anniversary of THEIR last signing.

## Assigning an item to an heir in Couple mode

When a spouse taps "Assign to someone specific" on an item:

1. Registry silently records: "Ann is claiming this item as hers to give."
2. The item moves to Ann's addendum. It does NOT leave the household inventory — it stays there too, so the trustee still sees it in the inventory at death.
3. Bob cannot also assign the same item to his addendum. If Bob tries, Registry shows: "Ann has assigned this to [heir]. If this should be yours to give instead, talk with Ann and one of you can un-assign it first."
4. Close-up photo requirement fires the moment the item enters an addendum (see `registry-closeup-photo.md`).

**Un-assigning:** Either spouse can un-assign one of their own addendum items at any time. Un-assigning an item that was in a signed version does not retract the delivered version — the caretaker's file still has v1 showing "this ring was assigned to Sarah." The next signing creates vN+1 which shows the current state.

## Wet-ink signing in Couple mode

Each spouse signs their own addendum independently, at their own time. There is no "both must sign" gate. Practical example:

- Ann completes her addendum in March, signs, delivers v1 to her caretaker + the household trustee.
- Bob is still working on his in June; his addendum is in draft. That's fine.
- Ann adds an item in September, re-signs, delivers v2 to her caretaker + trustee. Bob's addendum is still draft. Still fine.
- Bob signs for the first time in November — his addendum v1 goes to his caretaker + trustee.

Each spouse sees on their home screen: "Your addendum: signed, up to date" or "Your addendum: 3 changes since you last signed — [ Review and re-sign ]".

## Survivor conversion — first death

When one spouse dies, the household enters **survivor mode**. Model changes:

- `mode` transitions `couple → survivor`.
- Deceased spouse's participant is marked `active: false`, `deceased_at: <date>`.
- **Deceased spouse's addendum is frozen.** No further edits. The final signed version is what travels to their caretaker (as the definitive memo the will references) and to the trustee.
- **Deceased spouse's voice message is frozen** and released to the trustee as part of the deceased's addendum delivery. It is never edited, never re-recorded, never replaced. Even the surviving spouse cannot alter it.
- **Household inventory continues.** The survivor keeps adding, editing, revising. This is important — a widow reorganizing the house should not be blocked from updating what exists.
- **Survivor's own addendum continues.** They may re-sign as their intent evolves.

### Who triggers survivor conversion

Not automatic. The surviving spouse (or an executor with owner-transferred credentials) marks the deceased spouse deceased. This is a deliberate action with a confirm-screen:

> **"You're marking [Name] as passed away."**
>
> This will:
> - Freeze [Name]'s addendum at its most recently signed version
> - Release [Name]'s addendum and voice message to their attorney and to the trustee
> - Move this Registry into survivor mode
>
> This can't be undone. If you're not ready, tap Cancel.
>
> [ Cancel ] [ I understand — mark [Name] as passed away ]

Timing note: some families want this to happen immediately at death (attorney can start their part right away); others wait weeks. The app supports either. If the trigger has not been pulled but the trustee needs the addendum urgently, the executor can trigger it explicitly. See `registry-two-outputs.md` for delivery mechanics.

## Survivor conversion — second death

The surviving spouse's death triggers the household's final handoff:

- Household inventory is delivered to the trustee.
- Survivor's own addendum (final signed version) is delivered to their caretaker + trustee.
- Both voice messages are now in the trustee's hands.
- Registry becomes read-only for the household. An executor account can access it for wind-down but not edit.

## The joint-property question, resolved

Earlier drafts of this design tried to tag every household item as Ann's / Bob's / joint. That's abandoned:

- Household inventory is unified. Joint items don't need a tag — they're just in the inventory.
- Ownership of a specific item only becomes an assertion when a spouse assigns it in their addendum. At that moment, they're claiming it as theirs to give. If the other spouse objects, the app tells them to work it out and un-assign.
- Items never assigned to anyone stay in the household inventory and become part of the pool distributed via FairPlay at second death (or per whatever process the trust specifies).

This matches how couples actually work: they don't sit down and label every ladle "Ann's" or "Bob's." They only care about ownership when it matters — and it matters when someone wants to give a specific thing to a specific person.

## Migration for existing Solo Registries

Solo → Couple upgrade path:

1. Solo owner taps Settings → "Invite my spouse/partner."
2. Enters spouse's email.
3. Spouse gets a magic link. On first sign-in, sees: "You've been added as a co-owner of [Ann]'s Registry. You can now add your own items, assign things for your own addendum, and record your own voice message. Ann's existing items and her addendum stay hers."
4. Existing items keep Ann as their "added by."
5. Existing assigned items stay in Ann's addendum. Bob starts fresh.

Downgrade (Couple → Solo) is not supported in v1. Separation and death both flow through survivor mode instead. If a real "we separated" case comes up, the answer is: create a new Registry.

## What is NOT in this spec (scoping fences)

- **No more than two participants.** Registry is not a general multi-user tool. Households have two adults; other cases (multi-generational households, blended families where a parent and adult child are both estate participants) use two separate Solo Registries.
- **No shared voice message.** Each spouse records their own or doesn't.
- **No merge of two Solo Registries into one Couple Registry.** Complexity not worth v1. Couples who both started Solo can pick one to be the household base and manually re-enter or don't bother.

## Open questions for the code phase

1. Should the household inventory distinguish "added by Ann" vs "added by Bob" on-screen? My instinct: yes, quietly, in item detail — helpful when reviewing months later. Not a primary sort or filter.
2. When Ann assigns an item to her addendum, should Bob receive a notification? My instinct: no by default, but a "notify my spouse when I assign items" preference is reasonable.
3. Update-cadence prompts firing to the wrong spouse on a shared device — how to route them? My instinct: prompt shows to whoever opens the app first that day; if they're not the right spouse, one-tap "Not me — remind [other spouse]" defers it.
