> **Superseded** — vocabulary in this document may use *PR*, *personal representative*, or *fiduciary* for what the current suite calls **trustee**, and may predate the three configurations and the heir-initiated end-trustee-mode endpoint. See [`docs/SUITE-OVERVIEW.md`](../SUITE-OVERVIEW.md) for the current model. This document is kept as history and is not being rewritten.

# Two-perspective positioning — docs + FC welcome copy (2026-08-07)

Reworded the four positioning docs and the FairPlay welcome screen to make
the two-perspective story explicit and non-optional in the introductions:

- **While the owner is alive**, the estate is theirs. The software serves
  *their* desires — Registry is the owner's app, and the only judgement it
  asks for is which specific person, if any, a specific object was meant for.
- **After the owner is gone**, the estate belongs to the heirs, and its
  distribution is presided over by a **fiduciary** — trustee, personal
  representative, or executor named by the will or trust. FairPlay is the
  fiduciary-run app the heirs use to divide the property that was not
  specifically directed.

The prior language implied this in places but never opened with it. This pass
puts the frame at the top of every reader's first encounter with the suite.

## Files changed

### `README.md`

Added a "Two perspectives, one estate" paragraph immediately under the H1, and
rewrote the two app-table rows so the owner-vs-fiduciary roles are stated
plainly rather than described as generic estate tools.

### `docs/SUITE-OVERVIEW.md`

- New section **"Two perspectives, one estate"** between the opening paragraph
  and the app comparison. Names the owner as the sole authority while alive
  and the fiduciary + heirs as the parties after.
- Comparison table now has a **"Whose desires it serves"** row (owner's /
  heirs', within the trust or will).
- Kept the "Two failures the suite is built to prevent" language but retitled
  and re-anchored the section so it reads as consequence, not as the top-level
  frame.
- FairPlay section subtitle changed from *"Where Registry documents, Fair
  Choice divides"* to *"…divides — with the fiduciary running the room."*
- Intro paragraph now names PR / trustee / executor by their canonical role
  ("whoever the will or trust names as fiduciary for this estate") and ends
  with the fiduciary confirming the outcome.
- "The handoff" section retitled **"The handoff — owner's record to
  fiduciary's process"** and rewritten to state that the seam between the two
  apps is the seam between the two perspectives.

### `docs/DESC-REGISTRY.md`

Added **"Whose app this is"** above the existing Purpose section, stating in
one paragraph that Registry is the owner's app, used while the owner is alive,
and pointing forward to FairPlay + fiduciary for the fairness process on
whatever the owner did not specifically direct.

### `docs/DESC-FAIR-CHOICE.md`

- Fixed the stray copy error at the top ("Sold separately from Reindeer: FairPlay
  Choice" → "…from Reindeer: Registry") — this was already correct on disk;
  no functional change beyond confirming.
- Added **"Whose app this is"** above Purpose: FairPlay is the heirs' app,
  administered by the fiduciary named by the will or trust.
- Expanded the Purpose one-liner to include the fiduciary as the party legally
  responsible for calling the distribution fair, and reworked the paragraph
  after it so the phrase "with a fiduciary presiding because the trust or will
  names them, not the software" appears in the intro rather than only in v14
  and v8 sections downstream.

### `apps/reindeer-fair-play/client/src/pages/welcome.tsx` (copy only)

Previously:

> You are setting up a private record for dividing the tangible property of
> an estate. Start by telling us who you are.

Now:

> FairPlay is used *after* the owner is gone, when the family and the
> fiduciary — the trustee, personal representative, or executor named in the
> will or trust — need to divide the tangible property that was not
> specifically directed. The owner's wishes, where they were recorded, are
> honored as instructions; everything else is settled here, by a process
> every heir agrees to before knowing who gets what.
>
> Start by telling us who you are. If the will or trust names you as
> fiduciary, that is the role you are stepping into here. You can hand it to
> someone else later.

The two role-picker options were also rewritten to drop the "PR" acronym in
favor of the plain word "fiduciary":

- "I am PR only (I administer, I do not draft)" → "I am the fiduciary only —
  I administer the process, I am not receiving items"
- "I am PR and an heir (I administer and I also draft)" → "I am the fiduciary
  and also an heir — I administer and I also receive items"

No prop names, `data-testid`s, API endpoints, mutations, routing, or state
keys changed — the on-wire values (`pr_only`, `pr_and_heir`) and the
`administersOnly` boolean remain the same. This is a text-only revision on
one page.

## What was intentionally not changed

- **No terminology sweep across the app.** The internal engineering terms
  `pr_only`, `administersOnly`, PR badges elsewhere in the UI, and code
  comments are unchanged. The user-facing word on the welcome page reads
  "fiduciary"; the code continues to call the role PR. This keeps the diff
  scoped to introductions and copy without any rename, per the standing rule.
- **No behavior change.** The state machine, auth flow, ranking process,
  Method Agreement, Trustee Handoff, and Record of Decisions are all
  unchanged.
- **`docs/TWO-LISTS.md` was not touched.** It already carries the two-
  perspective framing almost verbatim ("designated gifts satisfy the owner …
  contested favourites satisfy the heir … under a process, with a fiduciary
  supervising"). It reads correctly as-is.

## Verification

From `apps/reindeer-fair-play/`:

```
npm run check                        tsc clean
npm run build                        clean (client + server)
```

From checkout root:

```
node scripts/roundtrip-test.mjs      66 checks passed
```

Copy-only change to one React page; server, schema, wire format, and self-test
surfaces (auth 47, fiduciary 51, import 45, detector 13) are untouched.

## Versions

Unchanged from the v2.1 clean build:

- `apps/reindeer-fair-play`: 2.1.0
- `apps/reindeer-registry`: 1.1.0
- ReindeerExchange wire version: 1.0
