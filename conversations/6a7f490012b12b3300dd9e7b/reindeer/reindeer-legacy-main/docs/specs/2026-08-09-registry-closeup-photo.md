# Registry — Close-Up Photo Requirement for Assigned Items

**Status:** Target-state spec. Awaiting code approval.
**Date:** 2026-08-09
**Related:** `registry-two-outputs.md`, `registry-couple-mode.md`
**Patent notes:** P-005 (this doc)

## Why this matters

The specific-giving addendum is a legal instrument. When a will says "the gold ring I leave to my daughter Sarah," the estate has a problem if there are three gold rings. Ambiguity in personal-property memos is the source of a huge share of family estate disputes — often more painful than the money.

Registry's job is to eliminate that ambiguity by attaching a specific, owner-verified visual to every item that's been assigned to a specific heir. That visual has to satisfy three requirements:

1. **Show the specific item** — close enough that no other item in the household could be plausibly confused for it.
2. **Be captured by the owner** — not AI-generated, not cropped from a group shot, not pulled from a wide-room inventory image.
3. **Be captured at (or near) the moment of assignment** — so it's the owner's deliberate act of "yes, THIS one goes to Sarah."

## The rule

**Every item in a specific-giving addendum must have exactly one designated close-up photo, taken by the owner, at the time of (or after) assignment to an heir.**

## What counts as a close-up

Close-up is defined by owner intent and technical properties, not by pixel dimensions alone:

- **Owner-captured.** Coming from the device's camera at capture-moment, or uploaded from the owner's photo library. Explicitly NOT: AI-generated (e.g. from a text prompt), synthesized (e.g. from a wide shot via a "zoom" model), copied from the wide-shot inventory photo of the same room.
- **Framed on the item.** The item is the primary subject. There isn't half a room behind it. The intent is visual identification of THIS specific object.
- **Reasonable resolution.** Minimum 1024×1024 or equivalent. Modern phone cameras far exceed this. This floor exists to reject deliberately obfuscated uploads.
- **EXIF preserved when possible.** Timestamp, device, orientation. Not required (some owners strip EXIF for privacy, and that's fine) but preserved by default.

The app enforces the owner-captured property by:

- **Only accepting close-ups through two paths:** (a) the in-app camera, invoked at the moment of assignment, or (b) an explicit "Upload a photo from your gallery" button. NOT through the AI-photo tools that Registry uses elsewhere.
- **Tagging the source** in the item record: `source: 'in_app_camera' | 'owner_gallery'`. Any other source is refused for addendum use.
- **Refusing to promote a wide-shot inventory photo** to close-up status, even if the owner tries.

## When the app enforces it

Two enforcement points, chosen to catch the owner at the moment their intent is fresh.

### Enforcement point 1: At assignment

The moment the owner taps "Assign this to someone specific" on an item, the assignment flow includes a close-up step:

> **"Take a close-up of [item name]"**
>
> Since [heir name] will receive this, we want no doubt about which one you meant. Please take a fresh close-up photo, or pick one from your gallery that clearly shows THIS specific item.
>
> [ Take a photo ] [ Choose from gallery ] [ Skip for now ]

**"Skip for now" is allowed** — this is the "don't let perfection block completion" call. But the item is flagged: `closeup_status: 'missing'`.

### Enforcement point 2: End of room

When the owner finishes a room (taps "Done with this room"), Registry blocks the completion if any assigned item in that room lacks a close-up:

> **"Before you finish this room:"**
>
> You've marked [N] items in this room to go to someone specific:
> - [Item 1] → [Heir]
> - [Item 2] → [Heir]
>
> These still need close-up photos so there's no confusion later. Please add them now — it takes about ten seconds each.
>
> [ Take photos now ] [ Leave them for later ]

**"Leave them for later" is still allowed** — but the flag stays. Nagging comes back at signing time.

### Enforcement point 3: At signing

The signing screen shows any addendum items still missing close-ups:

> **"Before you sign:"**
>
> [N] items in this addendum don't have close-up photos:
> - [Item 1] → [Heir]
> - [Item 2] → [Heir]
>
> You can still sign — the addendum will be delivered with a note showing which items are missing close-ups. But we strongly recommend adding them first.
>
> [ Add close-ups now ] [ Sign anyway ]

If the owner signs anyway, the delivered envelope includes those items in the `gaps` array (see `registry-two-outputs.md`). Both the wills-storage caretaker and the trustee see: "[N] items in this addendum do not have close-up verification photos."

## On the printed / delivered addendum

- **Every assigned item shows its close-up as the primary photo** on the addendum page. Wide-room shot is secondary or omitted entirely.
- **Items with no close-up** show a placeholder: a bordered box containing "No close-up photo provided" and a small icon. Not blank — the absence is visible.
- **A summary line at the top of each addendum** shows: "[N] items. [M] with verified close-ups. [K] missing close-up verification."
- **The trustee's view of the household inventory** does NOT enforce the close-up rule — wide shots are fine there. Close-ups only matter for the legal addendum.

## What the app does NOT try to do

- **Does not verify authenticity of the photo.** An owner who takes a close-up of the wrong item has fooled the system. That's a limitation we accept — the app can only verify that the owner deliberately captured a photo through the intended path, not that the photo is of the "right" thing. Owner intent is what the app captures.
- **Does not use AI to identify or classify the item.** The close-up is legal evidence of intent, not input to a machine-vision pipeline. What the app records is the owner's visual selection, not an AI opinion about it.
- **Does not require multiple angles.** One deliberately-taken close-up per item. More angles are welcome (owner can add), but one is enough.
- **Does not require a background reference** (business card for scale, etc.). Nice for jewelry, but adding this requirement kills adoption.

## Migration for items assigned before this feature ships

Existing addendum items without close-ups are grandfathered: they appear in the addendum with the wide-room photo they have, tagged `closeup_status: 'missing', gap_reason: 'pre_feature_migration'`. The signing screen prompts the owner to add close-ups the next time they engage with those items. Not blocked — surfaced.

## Data model

Additions to the Item record:

```
{
  ... existing fields ...
  assigned_to_heir_id: string | null,
  closeup_photo_ref: string | null,       // storage key for the close-up
  closeup_source: 'in_app_camera' | 'owner_gallery' | null,
  closeup_captured_at: timestamp | null,
  closeup_status: 'not_required' | 'missing' | 'present',
  closeup_gap_reason: 'user_deferred' | 'pre_feature_migration' | null
}
```

`closeup_status = 'not_required'` when `assigned_to_heir_id` is null. Any assignment flips it to `'missing'` or `'present'` depending on what happens next.

## What is NOT in this spec (scoping fences)

- **No per-item audio.** The whole-estate voice message covers the "in the owner's words" need at the addendum level. Item-level uses the existing typed Important-reason field.
- **No 360° / video capture.** Just still photos. Video complicates storage, delivery, and print rendering. Revisit if owners ask for it.
- **No AI-assisted close-up guidance** in v1 ("try again — the item isn't centered"). Would improve quality but adds ML complexity and a failure mode where the app rejects a fine photo.

## Open questions for the code phase

1. Should the close-up requirement apply to the deliberately-vague case where an owner writes "any one of my rings — Sarah's choice"? My instinct: no. If no specific item is designated, no close-up is needed. That gift is handled at the addendum-page level as a written direction, not a per-item entry.
2. Should the app allow the SAME close-up photo to serve for two items (a matched pair of candlesticks, for example)? My instinct: yes, with an explicit "this photo covers items A and B" affordance. Common case.
3. Should the close-up preserve GPS EXIF? My instinct: no — strip GPS by default for privacy, keep timestamp and device.
