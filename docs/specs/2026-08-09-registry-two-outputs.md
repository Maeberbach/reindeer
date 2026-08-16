# Registry — Two-Output Delivery Model

**Status:** Target-state spec. Awaiting code approval.
**Date:** 2026-08-09
**Related:** `registry-couple-mode.md`, `owner-voice-message.md`, `registry-closeup-photo.md`
**Patent notes:** P-004 (this doc)

## The core insight

Registry has two distinct legal outputs, not one. Conflating them is why prior attempts at "personal-property memos" fail: owners are asked to produce one thing that has to serve two different legal audiences at two different moments in time. Splitting them cleanly is the single biggest change in this spec set.

### Output 1 — Household inventory

- **What it is:** The complete list of every personal-property item in the household, with room-by-room organization, photos (wide-shot or AI-assisted are fine), descriptions, and any owner-Important comments.
- **Who it's for:** The trustee.
- **Why:** So when the estate is settled, the trustee has a definitive answer to "what personal property exists in this estate?" This prevents the classic disaster where heirs argue "the sapphire ring was in the estate" / "no it wasn't." If it's in the inventory, it's in the estate. If it's not, it's not.
- **When delivered:** At death (the trigger event defined by the trust). Not at signing time. Not to the attorney.
- **How it's stored:** Living document. Owners keep adding and revising throughout life. Only the final snapshot at death matters to the trustee.
- **In Couple mode:** One shared inventory per household. Not segregated by spouse. Both spouses add items.

### Output 2 — Specific-giving addendum

- **What it is:** Only the items the owner has assigned to a specific heir, with owner-taken close-up verification photos and any voice message from the owner.
- **Who it's for:** The wills-storage caretaker (attorney, firm, or designated custodian holding the will) AND the trustee.
- **Why:** This IS the personal-property memo the will refers to. It has legal weight. It must live in the will's file so it's found when the will is read. The trustee also needs a copy for their own distribution reference.
- **When delivered:** Every time the addendum is signed or re-signed. New version supersedes prior version. Both recipients receive every version. Signing is a legal act the owner performs deliberately, not a background sync.
- **How it's stored:** Versioned. v1 delivered at first signing. v2 supersedes v1 when the owner re-signs after an update. Old versions remain in the caretaker's file; the latest is operative.
- **In Couple mode:** Each spouse has their OWN addendum, because each has their own will. Ann's addendum → Ann's caretaker + trustee. Bob's addendum → Bob's caretaker + trustee. Same caretaker or different, doesn't matter — two separate legal instruments, two separate delivery streams.

## The distinction that matters, restated

| | Household inventory | Specific-giving addendum |
|---|---|---|
| Scope | Everything | Only items with a named heir |
| Recipients | Trustee only | Wills-storage caretaker + trustee |
| Trigger | Death | Every signing / re-signing |
| Versioned to recipients? | No — one final snapshot | Yes — every version delivered |
| Legal status | Reference document | Personal-property memo referenced by the will |
| In Couple mode | One shared per household | One per spouse |
| Photos | Wide-shot or AI-assisted OK | Owner-taken close-ups required (see `registry-closeup-photo.md`) |
| Voice message? | No — not attached to the inventory | Yes — owner's voice message travels with their addendum |

## Wet-ink signing flow (updated)

Registry's "sign and send" screen changes meaningfully with this model.

**Before (today):** Owner signs → Registry marked complete → sent to trustee.

**After (this spec):** Owner signs the ADDENDUM → sent to wills-storage caretaker + trustee immediately as vN+1 → household inventory continues to accrue silently in the background, unsigned, until death.

### On-screen copy at the signing moment (draft)

> **"This is the personal-property memo your will refers to."**
>
> This list — [N] items — will be sent to:
> - **[Attorney / caretaker name]** so it's stored with your will
> - **[Trustee name]** so they have your intent on file
>
> Version [N+1] replaces the version they received on [prior signing date].
>
> Take a moment to review. When you sign below, both recipients receive this within a few minutes.
>
> [ Review the list ] [ Sign and send ]

### On-screen copy if no attorney/caretaker is on file

> **"You don't have someone listed to hold your will."**
>
> Without a wills-storage caretaker, this addendum may not end up attached to your will when it's read. That's the problem this app is meant to solve.
>
> You can:
> - **[ Add your attorney's contact now ]** (recommended)
> - **[ Add a family member to hold this copy ]** — someone you trust to give it to the executor
> - **[ Sign without one ]** — a copy is kept in the estate file, but it may not be found or honored
>
> If you sign without one, the print-out and the trustee's copy will both show "No wills-storage caretaker on file."

## Update cadence

**Annual gentle prompt.** On the anniversary of the last signing:

> "It's been a year since you last updated [Addendum name]. Would you like to review it? Things change — new items, changed minds, new grandchildren. A five-minute review keeps this current with your wishes."
>
> [ Review now ] [ Remind me in a month ] [ It's still accurate — mark reviewed ]

The third option ("still accurate — mark reviewed") is important: it lets the owner affirm the current version without going through the signing flow again. That affirmation is recorded and shown on the addendum print-out ("Reviewed and re-affirmed on [date], no changes"). It does NOT create a new version delivered to the caretaker — it's a lightweight annual heartbeat.

If the owner changes anything during a review, that becomes a new signing event → new version → new delivery.

## ReindeerExchange envelope shapes

Two new envelope types. Both live in the existing `legacy-exchange` package.

### `legacy-exchange://inventory` (v1)

```json
{
  "envelope_type": "inventory",
  "envelope_version": "1.0",
  "estate_id": "...",
  "trigger": "death|manual_test",
  "generated_at": "2026-08-09T13:00:00Z",
  "recipient": {
    "role": "trustee",
    "name": "...",
    "delivery_method": "email|download|signed_link"
  },
  "items": [
    {
      "id": "...",
      "name": "Wedding china set",
      "room": "Dining room",
      "description": "...",
      "photos": [ { "role": "wide|closeup", "url": "...", "checksum": "..." } ],
      "owner_important": { "flagged": true, "reason": "feeling|both", "comment": "..." },
      "assigned_to_heir_id": null,   // null in inventory; assignment is in the addendum
      "voice_note_ref": null          // no per-item audio; whole-estate message rides in addendum
    }
  ],
  "counts": { "total_items": 0, "rooms": 0, "assigned": 0 }
}
```

### `legacy-exchange://addendum` (v1)

```json
{
  "envelope_type": "addendum",
  "envelope_version": "1.0",
  "estate_id": "...",
  "owner": {
    "participant_id": "...",
    "name": "Ann Eberbach",
    "signed_at": "2026-08-09T13:04:00Z",
    "signature_evidence": { "wet_ink_hash": "...", "device": "..." }
  },
  "addendum_version": 2,
  "supersedes_version": 1,
  "supersedes_delivered_at": "2025-03-11T15:00:00Z",
  "recipients": [
    { "role": "wills_caretaker", "name": "Smith & Jones LLP", "contact": "...", "delivered_at": "..." },
    { "role": "trustee", "name": "Trustee Tanya", "contact": "...", "delivered_at": "..." }
  ],
  "voice_message": {
    "audio_ref": "...",             // Opus, ≤10MB, see owner-voice-message spec
    "transcript": "...",
    "duration_seconds": 240,
    "recorded_at": "...",
    "checksum": "..."
  },
  "items": [
    {
      "id": "...",
      "name": "Grandmother's sapphire ring",
      "assigned_to": { "name": "Sarah Eberbach", "relationship": "daughter", "heir_id": "..." },
      "owner_words": "This was my grandmother's engagement ring...",
      "closeup_photo": {
        "url": "...",
        "checksum": "...",
        "captured_at": "...",
        "source": "owner_camera",   // enforced: not AI-generated, not wide-crop
        "gap_reason": null
      }
    }
  ],
  "gaps": [
    // items assigned to heir but WITHOUT closeup — surfaced to legal recipients for visibility
    { "item_id": "...", "reason": "closeup_photo_missing" }
  ]
}
```

Gaps do NOT block signing (per the "don't let perfection block completion" call). They ARE surfaced to the legal recipients on both the on-screen delivery view and the print-out: "[N] items in this addendum do not have close-up verification photos."

## Delivery mechanics

Both envelope types travel over the existing ReindeerExchange delivery layer (`packages/reindeer-delivery`). Three delivery methods, owner-selectable per recipient:

1. **Direct email** to the recipient with the envelope as an attachment (JSON + PDF summary + audio file if addendum).
2. **Signed download link** — recipient gets a link they click; download is logged.
3. **Print + mail** — Registry generates a print-ready packet with a QR code linking to the digital envelope. For owners whose attorney doesn't do email.

Delivery events (sent, received, downloaded) are recorded in the Registry's own audit trail so the owner can see "Attorney received v2 on [date]."

## What changes in Registry today

Not exhaustive — this is a spec, not a diff — but the shape of the code work:

- **Item model:** add `assigned_to_heir_id`, `closeup_photo_ref` (nullable), `owner_words` (existing Important comment repurposed as the addendum text for assigned items).
- **Owner model:** add `wills_caretaker` contact (name, firm, email, delivery method preference) and `trustee` contact.
- **Signing flow:** new "Sign the addendum and send it" screen. Distinct from the existing "finish inventory" flow. Both may exist in Couple mode where inventory continues while the addendum ships.
- **Delivery layer:** two new envelope generators. Existing `packages/reindeer-delivery` should handle them without new transport code.
- **Audit trail:** track versions, deliveries, review affirmations.
- **Print output:** two distinct printable documents — inventory (long, room-by-room) and addendum (short, per-item with close-ups).

## Migration for existing Registry data

Every existing Registry item enters the inventory. Items with an assigned heir enter the addendum too, but WITHOUT close-up verification unless one already exists. The first time the owner opens Registry after this feature ships, they get a one-time prompt:

> "We've split your Registry into two parts: the full inventory (for your trustee) and the addendum for items you've assigned to specific people (for your attorney and your trustee).
>
> [N] of your assigned items are missing close-up photos. Would you like to add them now? You can also do it later, room by room."

## What is NOT in this spec (scoping fences)

- **No per-item voice recording** in v1. Whole-estate voice message per owner, riding with the addendum, only.
- **No auto-detection of "the owner assigned this to someone" from text.** Assignment is an explicit owner action.
- **No changes to FairPlay's data model** required by this spec. FairPlay already reads ReindeerExchange envelopes. It gets an addendum envelope at death for named items and can be extended later to consume the inventory envelope directly if useful.

## Open questions for the code phase

Not blocking spec approval; recording for when we get there:

1. Does the wills-storage caretaker need their own account, or is the delivery link enough? My instinct: link is enough for v1. Accounts add friction attorneys won't want.
2. If the caretaker delivery bounces (bad email), how does the owner find out? My instinct: Registry surfaces the failure on the next open, with a one-tap re-send.
3. Do we need a "revoke a delivered version" mechanism? My instinct: no. Superseding via a new version is cleaner. Old versions in the caretaker's file are historical, not operative.
