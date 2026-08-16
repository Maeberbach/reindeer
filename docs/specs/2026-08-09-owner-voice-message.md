# Registry — Owner Voice Message + Transcript

**Status:** Target-state spec. Awaiting code approval.
**Date:** 2026-08-09
**Related:** `registry-two-outputs.md`, `registry-couple-mode.md`
**Patent notes:** P-003 (this doc)

## What this is

An optional, in-the-owner's-own-voice message from the owner to the family, recorded through Registry, saved with a companion transcript, and delivered with the owner's specific-giving addendum to the wills-storage caretaker + trustee. On the owner's death (or the appropriate trust trigger), heirs can hear it as part of the estate handoff.

**The point is the voice.** A grandmother's voice, decades from now, is not replaceable. The transcript exists to serve accessibility, long-term durability, and heirs who prefer to read — but the audio is the primary artifact.

## The prompt (owner-approved wording)

At the appropriate moment in the Registry flow (see "When it's offered" below), the owner sees:

> **"Would you like to leave a personal message for your family to hear later?"**
>
> It doesn't need to be perfect. There are no wrong words. Just share your thoughts and love.
>
> [ Record a message ] [ Not right now ] [ No, thank you ]

**"Not right now" vs. "No, thank you":** "Not right now" defers — the prompt returns in a few sessions. "No, thank you" tells Registry the owner has decided and stops offering it. Both are respectful of the emotional weight; the owner is never nagged after they've declined.

## Second screen — right before recording starts

> **"Take your time."**
>
> You can re-record as many times as you want before you save. Nothing is sent to anyone until you sign your addendum.
>
> When you're ready, tap the microphone. Tap it again to stop.
>
> [ 🎙️ Ready to record ]

## Recording flow

- **Live waveform** during recording so the owner sees their voice is being captured.
- **Duration counter** — visible from second one. When approaching the soft target (5 min), gentle color change; approaching the hard cap (15 min), the counter turns amber.
- **At 15:00 exact,** recording stops automatically with: "That's about 15 minutes — a good length for a message. If you'd like to record more, save this one first and add a second recording later."
- **Playback** immediately available after stopping.
- **Re-record** replaces the current draft. Multiple takes are common — the owner isn't "spending" recordings.
- **Save** is the deliberate step that commits this take as the current voice message for this owner.

## Length limits (approved)

| Boundary | Value | Rationale |
|---|---|---|
| Soft target | 3–5 minutes | What people actually record when the prompt is "share your thoughts and love." Longer and they trail off. |
| Hard cap | 15 minutes | Room for owners who have more to say (e.g. a paragraph for each grandchild) without turning it into an audiobook. |
| File-size cap | 10 MB | Well above any 15-minute Opus recording (~3.6 MB), catches accidental wrong-file uploads, keeps envelopes reasonable. |

## Format (approved)

**Opus at 32 kbps, voice-tuned.** Rationale:

- Sounds better at 32 kbps than MP3 does at 96 kbps for voice.
- Universal browser support (Chrome, Safari, Firefox, mobile).
- Small files that email-attach cleanly and travel well through ReindeerExchange.
- What YouTube, WhatsApp, and Zoom use for voice.

Approximate file sizes:

| Duration | File size |
|---|---:|
| 3 min | ~720 KB |
| 5 min | ~1.2 MB |
| 10 min | ~2.4 MB |
| 15 min (cap) | ~3.6 MB |

**Not chosen and why:**

- **Not MP3** — larger for equivalent quality, worse voice reproduction at low bit rates.
- **Not raw WAV** — 15-minute WAV is ~150 MB, breaks project-files 100-MiB submit cap, hostile to delivery.
- **Not AAC** — comparable to Opus but with patent/licensing friction Opus doesn't have.

## Transcript

Generated automatically at save time. Owner gets one edit pass:

> **"Here's what we heard you say."**
>
> Please read through and fix anything obvious — especially names, places, and words the transcription got wrong. Your voice is what matters; the text is here for people who prefer to read.
>
> [text of transcript, editable inline]
>
> [ Looks right — save it ] [ Save without editing ]

**One edit pass, then locked** (approved default). Rationale: keeps the transcript tied to the recording. If the owner re-records, they get a fresh transcript and a fresh edit pass. If they only want to edit the transcript later, they're actually changing what the family reads without changing what they said — that's confusing. Re-record if you want to change something.

## Playback locations (approved)

- **On the owner's own addendum print-out / digital view** — a small "🎙️ [Name] left a message ([duration])" element with a play button in digital form or a QR code in printed form.
- **In FairPlay, on the welcome screen** shown to heirs when the estate flows through — before the draft, before anything else, a "There's a message from [Owner]" screen with playback.
- **In FairPlay, on the Record of Decisions cover page** — a mention that a voice message accompanied the addendum, with a link/QR.
- **Not** on individual item pages, not embedded in the draft flow, not auto-played anywhere. The message is offered; the heir chooses when to listen.

## Delivery form (approved)

Two files, both delivered:

- **`voice_message.opus`** — the audio. Playable in any modern browser or player.
- **`voice_message_transcript.txt`** — the transcript, plain text, UTF-8. Also included in the addendum PDF for print-out readability.

Rationale for separate files (not embedded in a single PDF with a link): audio embedded in PDF has poor player support and is a rendering headache. Two files, clearly named, with a companion "How to play this message" one-pager if the trustee wants to hand it off.

## Re-record policy (approved)

**Owner can re-record until the addendum is signed and sent as its current version.** Re-recording replaces the current voice message. After signing, the audio in that delivered version is frozen — the caretaker + trustee have it and it is the message of record for that addendum version.

If the owner later re-records and re-signs, a new version of the addendum goes out with the new audio. Prior versions in the caretaker's file still have the prior audio. Historical layers, in order.

**On death**, the current signed voice message is frozen for the trustee — and per Couple mode, no other party (including a surviving spouse) can ever edit or replace a deceased person's voice message.

## Couple mode (approved)

- **Each spouse has their own optional voice message.** One belongs to Ann and rides with Ann's addendum; one belongs to Bob and rides with Bob's addendum.
- **No shared / joint voice message.** If a couple wants a "message from both of us," they each record their own; heirs can hear both.
- **The prompt is offered to each spouse independently** — declining doesn't influence what the other spouse sees.
- **On first spouse's death**, the deceased's voice message is frozen and released to the trustee. Surviving spouse continues their own message flow (may re-record, may re-sign) untouched. Surviving spouse CANNOT edit or replace the deceased's message.

## Data model

Additions to the participant / owner record:

```
{
  ... existing fields ...
  voice_message: {
    audio_ref: string,              // storage key for the .opus file
    audio_checksum: string,         // SHA-256, for tamper detection
    transcript: string,             // owner-edited text
    duration_seconds: int,
    recorded_at: timestamp,
    saved_at: timestamp,
    replaced_prior_ref: string | null,  // audit trail of takes
    status: 'draft' | 'saved' | 'signed_current' | 'frozen',
    prompt_shown_count: int,        // gentle re-prompt tracking
    prompt_declined_permanently: boolean
  } | null
}
```

`null` = never offered or "No thank you" hasn't been captured yet.
`prompt_declined_permanently: true` = owner said "No, thank you" — never prompt again.

## When it's offered

**Not on first opening.** Registry needs the owner to have some sense of the app before this heavier prompt is appropriate.

**First offer:** After the owner has added their first 10 items OR has assigned their first item to an heir, whichever comes first. That's usually the moment they've engaged with what Registry is FOR.

**Re-offer cadence** (if "Not right now" but not "No thank you"): next offer at 30 days, then 90 days, then annually thereafter. Silent unless the owner has done meaningful further work in the app.

## Delivery in the ReindeerExchange addendum envelope

The `addendum` envelope (defined in `registry-two-outputs.md`) carries the voice message inline:

```json
{
  "voice_message": {
    "audio_ref": "...",
    "transcript": "...",
    "duration_seconds": 240,
    "recorded_at": "...",
    "checksum": "..."
  }
}
```

At delivery time the actual audio file is included as a delivery attachment alongside the addendum JSON and PDF.

## Migration for existing Registries

No migration needed — new feature, opt-in. Owners who never engage with the prompt simply have `voice_message: null` in their record. No behavior change for anyone who doesn't want it.

## What is NOT in this spec (scoping fences)

- **No per-item audio.** One whole-estate voice message per owner, addendum-level. Item-level intent uses the typed Important-reason field.
- **No multiple messages per owner.** One current message at a time. Re-recording replaces. Multi-message ("message to Sarah, message to David") is deliberately out — too much complexity, invites uneven treatment of heirs.
- **No video.** Voice only. Video adds storage, delivery, and rendering weight for questionable added value in a legal-adjacent document. Revisit if owners ask.
- **No AI generation of the audio, transcript, or content.** Everything comes from the owner directly. This is a legal / personal artifact and must be authentic.
- **No auto-translation of the transcript.** The transcript is in whatever language the owner spoke. Translations are a downstream concern for heirs who need them.

## Open questions for the code phase

1. Which speech-to-text service for the transcript? Options: on-device (Whisper.cpp bundled or via the browser's SpeechRecognition), cloud (OpenAI Whisper API, AssemblyAI). On-device preserves privacy but bundles a heavy dependency. Cloud is easier but sends the owner's voice to a third party. My instinct: browser SpeechRecognition first (free, private), with a note that quality varies by browser; cloud fallback offered explicitly if the owner is unhappy with the transcript.
2. Where does the audio file live? Options: same object store as Registry photos; separate audio store. My instinct: same store — one less integration.
3. Compression happens where? Options: browser (MediaRecorder → Opus natively in Chrome/Firefox, needs polyfill in older Safari); server. My instinct: browser where supported, server as fallback.
