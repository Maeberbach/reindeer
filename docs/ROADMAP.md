# Reindeer Legacy — open items

## Deferred by owner decision

### Automatic photo recognition — OFF, keep on the list
Status: built and working, deliberately not switched on.

- `vision_mode` reports `mock` because no `REINDEER_VISION_KEY` is set.
- The real provider is implemented at `packages/legacy-intake-feature/src/vision/anthropic.js`.
- The client tells the truth while it is off: "Automatic recognition is not switched on yet…
  Nothing has been guessed for you."
- To switch on: request the owner's Anthropic key via `pplx-tool request_credential`
  (host `api.anthropic.com`, `HeaderCred`, header `x-api-key`), then set `REINDEER_VISION_KEY`.
- Hard rule that must survive going live: vision may record a maker only when it can
  genuinely read it in the photograph, never infer one from style, and it must **never**
  set `value_estimate_cents`. Values on an estate record are the owner's alone.

Owner note (2026-08-05): "photo recognition can stay off for now but keep this in the to do list."

## In design

### Probate significance classes
See `docs/PROBATE-CLASSES.md` once approved. Core requirement from the owner:

> The Key is listing the items that are most important and assigning to an heir IF THERE IS
> A SPECIFIC HEIR IN MIND. IF NOT THEN DO NOT ASSIGN A NAME.

Design consequence: a blank recipient is ambiguous, so "deliberately not named" must be an
affirmative, recorded choice distinct from "not answered yet".

Value balancing between heirs is the trustee's determination and sits outside both apps.
FairPlay flags items for appraisal and hands them to the trustee on the Record of
Decisions; the trustee resolves value questions against other estate assets in their
usual workflow. The app may flag but must never conclude — the in-app equalization
ledger, per-item consent flow, and finalization gate were retired in commits 6 and 7.
