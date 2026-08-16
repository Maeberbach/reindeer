> **Superseded** — vocabulary in this document may use *PR*, *personal representative*, or *fiduciary* for what the current suite calls **trustee**, and may predate the three configurations and the heir-initiated end-trustee-mode endpoint. See [`docs/SUITE-OVERVIEW.md`](../SUITE-OVERVIEW.md) for the current model. This document is kept as history and is not being rewritten.

# Working preferences — Reindeer Legacy

_Last updated: 2026-08-07 (session ending after FairPlay v14 UI follow-ups + Registry
screenshot review)_

This is not a spec. It is the working agreement I want the next agent to honor when
touching Reindeer Legacy. If any of these preferences contradict a project instruction or a
prior decision doc, the decision doc wins — this file is for the softer stuff that is
easy to lose across sessions.

---

## Vocabulary — read this first

Words shape what the user thinks the app is promising. These are the ones I keep
having to re-teach.

- **"Important"** is the owner's own word for "this one matters to me." It is not a
  valuation, not a legal claim, and not a request for an appraisal. See
  `docs/decisions/2026-08-06-important-flag.md` and `2026-08-06-important-comment.md`.
- **"Appraisal"** means a formal opinion of value from a human appraiser. It is a real
  thing that costs money and takes time. The **Registry never asks for an appraisal
  and never estimates value.** Registry documents. That is the whole product boundary.
- **"AI estimate"** and **"high-value flag"** are FairPlay concepts only, computed
  against a threshold the PR chooses. `high_value_flag` on an item is FairPlay's
  field, not the owner's. Registry stores it as `false` at creation by design (see
  `packages/legacy-intake-feature/src/server/router.js` around line 104).
- Never introduce **"Worth having appraised"** or similar copy back into Registry. That
  label was explicitly rejected because it presumes an appraiser exists and that money
  is the only reason something matters.
- Avoid **legal "safe-harbor" terminology** in any surface (spec, UI, printout, or
  code comment). The trustee handoff printout already carries the "Owner wishes only.
  Not a will, codicil, or personal property memorandum" disclaimer — that is the
  right posture. Do not add more.

## Appraisal — the important one

The user has flagged this a few times and I want it to be impossible to miss.

**Registry is not an appraisal tool. FairPlay is not an appraisal tool either.**
Neither app produces a professional opinion of value, and neither should ever be
presented to the owner or their heirs as if it does.

Where the two apps actually touch appraisal:

1. **Registry — nowhere.** No AI estimation, no threshold check, no "worth
   $X" UI. The owner may write anything they want in `owner_important_comment` and
   it prints verbatim, including the sentence "please get this appraised" if that
   is what they want said. Registry does not shape those words.

2. **FairPlay — `AskForAppraisalButton` on high-value items.** The button is a
   **request** the owner sends to the PR. The current implementation records the
   request; the appraisal itself happens off-platform (a real appraiser, real
   money, real paperwork). FairPlay's own AI estimate is used only to decide
   whether an item crosses the PR's threshold for the high-value queue; it is
   **not** shown to heirs as a valuation.

3. **Fiduciary page — Method Agreement gate + Record of Decisions.** The finalize
   flow guards against finalizing before all heirs have signed the method
   agreement. The Record of Decisions printout is what the trustee actually
   carries. Neither surface presents an AI estimate as an appraisal.

When adding, renaming, or restyling anything in the appraisal path, keep these rules:

- **Never call an AI estimate an appraisal in the UI**, in a printout, or in a
  data-testid string that a user might read in a bug report.
- **Never let AI estimates flow into the Record of Decisions printout as
  values.** Only PR-approved valuations do (`approvedValuation.value`), then
  latestValuation, then the AI estimate — in that fallback order, and the display
  must tag which basis it came from. See `apps/reindeer-fair-play/client/src/pages/fiduciary.tsx`.
- **The "Ask for appraisal" affordance is elderly-friendly by default.** After the
  v14 follow-up commit (`734f635`), the trigger, cancel, and confirm buttons all
  meet `min-h-[44px]`, and the compact icon-only form on the rank row also has
  `min-w-[44px]`. Keep it that way.
- **The comment the owner writes when they ask for an appraisal is theirs.**
  Trim it, cap it at 500 characters (per the existing validator), but do not
  paraphrase or "polish" it in the wire, the DB, or the printout.

Open question — surfaced today, not resolved: the Registry item detail screen
does not currently render `owner_important_comment` inline. The comment is
captured, and it prints on the item sheet and in the by-room report, but the
owner cannot see it on their own device after saving without going to the print
view. If the next design pass touches Registry detail, consider surfacing that
comment on the detail screen too — matching the way FairPlay surfaces the
same field on the fiduciary item card. Not urgent, but a real gap.

## UI — elderly-friendly is a hard rule

The project instructions say "large type, large targets, plain language, no jargon,
confirm before anything irreversible." I want that treated as a hard rule, not a soft
guideline. In practice:

- **Every interactive control I add should meet `min-h-[44px]`.** shadcn's default
  sizes (`sm` = 32px, `default` = 36px, `lg` = 40px) do not hit that on their own.
  Explicitly set `min-h-[44px]` in `className`. Icon-only compact buttons also need
  `min-w-[44px]`. Long copy (finalize dialog outcomes) can go to `min-h-[48px]` for
  breathing room.
- **Icons in buttons should be `h-4 w-4`, not `h-3.5`.** The v14 follow-up bumped
  every new control; the older `h-3.5` icons predate the touch-target sweep.
- **Plain language, no jargon.** "Finalize" is fine. "Method Agreements" is fine.
  "Escrow arbitration workflow" would not be. When I catch myself writing UI copy
  that would need a glossary, I rewrite it.
- **Confirm before anything irreversible.** Delete, finalize, submit, send to
  trustee — every one of these gets a dialog with an explicit outcome click, not a
  default confirm button.
- **Every item must be printable.** If I add a field, the print template needs to
  render it too. If I add a screen, there should be a printable equivalent for the
  same information.

## Testing and self-tests

Before I say "done":

- `npm run check` (tsc) — clean.
- `npx tsx server/auth/selftest.mts` — 47/47.
- `npx tsx server/fiduciary/selftest.mts` — 51/51.
- `npx tsx server/import/selftest.mts` — 38/38.
- `node scripts/roundtrip-test.mjs` — 66/66.
- `npm run build` — succeeds.

Self-tests **must import `../testing/scratchEnv` as their FIRST import.** ESM
hoisting will silently point them at the real `data.db` otherwise. If I add a new
self-test, that line goes at the top before I write anything else.

## Handoff conventions

- One handoff per meaningful commit or window of work. Filename pattern
  `docs/handoffs/YYYY-MM-DD-<short-slug>.md`.
- Include what changed, why, what was tested, what was deliberately left alone,
  and any drift I noticed but did not fix.
- If I correct an earlier handoff's numbers (line counts, button counts, feature
  claims), say so plainly. Do not silently rewrite the earlier document.
- Do not overstate a preserved guardrail. If touch targets are not yet 44px, the
  handoff says "still 36px, follow-up needed" — it does not say "large targets
  preserved."
- Share the handoff with `share_file` using a stable `name` so versions chain.

## What I do not want you to do without asking

Restating project rules here so they are unmissable:

- **No rename, sweeping find-and-replace, dependency reinstall, or
  schema/wire-format change** without warning me first with the exact blast
  radius.
- **Never reintroduce identity read from `req.body.participantId`, an
  `x-participant-id` header, or `?participantId=`.** That was a live
  impersonation hole. Auth is cookie sessions only.
- **Do not touch `apps/reindeer-fair-play/_scaffold`** — dead code.
- **`npm install` at the repo root prunes `apps/reindeer-fair-play`'s deps.** If
  a root install has to happen, reinstall inside the app afterwards, and warn me
  first.

## Style — how I like the conversation to go

- Terse, not chatty. Skip the pep-talk and the "great question" preamble.
- Show diffs and paths. When I ask for a change, I usually want to see the
  before/after or at least the edited region.
- Do not claim tests pass. Run them and quote the count. If a self-test count
  drifts (say 51 becomes 52), tell me — don't paper over it.
- When I say "proceed with all," act on the specific list from my previous
  message. Do not expand scope.
- When I ask for screenshots, seed representative data first (a mix of flagged
  and unflagged items, at least one item with an `owner_important_comment`, at
  least two rooms). Do not hand me screenshots of an empty app.

## Language and locale

- English only in UI copy for now. If we ever add a second language, the
  wording rules above apply per-language, and I want to see the translations
  before they ship.
- Dates in the UI: locale default. The user is in America/New_York; do not
  hard-code an offset.

---

_If you are reading this and any of these preferences no longer match how the user
is talking about the app, ask before you enforce them. Preferences drift; this file
is a snapshot, not a contract._
