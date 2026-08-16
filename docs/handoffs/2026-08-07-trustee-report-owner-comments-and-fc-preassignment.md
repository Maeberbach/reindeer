> **Superseded** — vocabulary in this document may use *PR*, *personal representative*, or *fiduciary* for what the current suite calls **trustee**, and may predate the three configurations and the heir-initiated end-trustee-mode endpoint. See [`docs/SUITE-OVERVIEW.md`](../SUITE-OVERVIEW.md) for the current model. This document is kept as history and is not being rewritten.

# Owner comments in the trustee report + pre-assigned items in FairPlay

**Date:** 2026-08-07 (revised — expanded to capture owner intent expressed in comments, not only structured hints)
**Status:** Spec / plan. No code changes in this pass.
**Motivating example:** An owner writes on the ring: *"For Sarah. It has always been meant for her. Please do not appraise it — I do not want the number to matter."*

That sentence is the whole point of the app. It must travel with the paper the
trustee reads, and it must keep the ring out of the family bidding pool. Right
now, half of that is missing.

**Guiding principle for this handoff:** the owner's *intent* is what we
honor, not the app's structured metadata. If the owner clearly named an heir
anywhere — in the recipient hint, in the important comment, in the story
field, on the print sheet — we must surface that so the trustee and Fair
Choice can act on it. The app must forgive user error, not punish it by
quietly dropping the intent.

## What currently happens (verified against 42e6fe7)

### Owner-facing paper — comment already prints
`packages/legacy-print-feature/src/templates/index.js` at line 94 renders
`owner_important_comment` verbatim in an "Important" callout on every per-item
sheet and in the room / category / full-book / by-recipient print surfaces.
Nothing to change here.

### Trustee packet — comment is missing
`packages/legacy-print-feature/src/templates/trusteePacket.js` renders the
signable summary the trustee files with the estate documents. The items table
has six columns:

```
# | Item | Room | Media | Stated wish | Est. value
```

There is no column, callout, or footnote for `owner_important_comment`. The
trustee's cover document does not know what the owner said in her own words —
it only knows the "Stated wish" name.

**Blast radius of adding it:** the trustee packet is body HTML rendered on
demand by the delivery service; no schema change, no envelope change. It reads
from the same item rows the memorandum template does, and those rows already
carry `owner_important_comment`. Purely a template edit.

### FairPlay — recipient hint is stored, ignored
`apps/reindeer-fair-play/server/import/importService.ts` at approve time
(around line 731) creates every imported item with `status: "available"`,
including items where `recipientHint` is a non-empty name. The stored hint is
copied through to `items.recipient_hint` on the FC side as advisory text and
otherwise has no effect on eligibility. There is no code path that reads a
hint and:

- keeps the item out of ranking / bidding
- greys it out for heirs
- assigns it to a specific participant
- surfaces "already assigned by owner" anywhere in the UI

Item schema statuses today: `'available' | 'awarded' | 'in_grouping' |
'in_high_value' | 'duplicate_dismissed'`. Nothing encodes "the owner already
decided this one."

## What we want

Three changes. The first two are unchanged from the earlier draft; the third
is the new one motivated by "the owner may not have used the field correctly":
detect owner intent in free-text and surface it for review.

### 1) Trustee packet renders owner comments verbatim

The trustee needs the sentence, not just the name. In the printed packet, any
item with a non-empty `owner_important_comment` shows the comment beneath the
row, styled as a call-out, printed verbatim (no paraphrase, no truncation, no
value figures stripped or added).

**Layout suggestion** (inside `trusteePacket.js`, in the items table map):

```html
<tr>
  <td class="num">${n + 1}</td>
  <td><strong>${esc(i.title)}</strong>${serialBits}</td>
  <td>${esc(i.room?.name ?? '')}</td>
  <td>${esc(bits || '—')}</td>
  <td>${esc(i.recipient_hint?.recipient_name ?? '—')}</td>
  <td class="num">${money(i.value_estimate_cents)}</td>
</tr>
${i.owner_important_comment ? `<tr class="owner-comment-row">
  <td></td>
  <td colspan="5">
    <div class="owner-comment">
      <strong>In the owner's own words</strong>
      <div>${esc(i.owner_important_comment)}</div>
    </div>
  </td>
</tr>` : ''}
```

Plus a new count in the summary block:

> **N items carry a written comment from the owner.** These are printed
> verbatim next to each item below. Please read each one before assigning
> or distributing that item.

The count belongs beside the existing "Items with a stated wish" figure so a
trustee scanning the cover page sees at a glance whether the owner said
something they need to read.

### 2) FairPlay honors owner assignments

When Registry says *"For Sarah,"* Sarah is a name — not a participant. Fair
Choice has an integer participant table and can't match a free-text hint to a
participant row automatically. So the design has to bridge that gap without
guessing.

**Model change (v14 migration):**

Extend the item `status` enum:

```
'available' | 'awarded' | 'in_grouping' | 'in_high_value'
  | 'duplicate_dismissed'
  | 'owner_assigned'      -- NEW: kept out of every pool, greyed in every heir view
```

Add two nullable columns to `items` (no changes to `staged_items`; the resolution
happens at approval time or later by the PR):

- `owner_assigned_name TEXT` — the free-text name from the recipient hint
  ("Sarah"). Never inferred, only copied from `recipient_hint`.
- `owner_assigned_participant_id INTEGER NULL` — the FK, populated by the PR
  when they confirm which participant this name refers to. Nullable because
  the owner-stated name may not correspond to a FairPlay participant at all
  (a grandchild not in the game, a friend, a charity).

**Import behavior:**

At `approveStaged` time, if the item has *any* owner-stated assignment signal
— structured hint OR detected intent in the comment (see §3) that the PR
has confirmed during review — create the item with:

```ts
status: "owner_assigned",
ownerAssignedName: <hint name OR PR-confirmed detected name>,
ownerAssignedSource: <'recipient_hint' | 'comment_detected' | 'pr_manual'>,
ownerAssignedEvidence: <verbatim quote from the source that carried the intent>,
ownerAssignedParticipantId: null,   // PR resolves later; may stay null
```

The extra columns matter because when the PR (or a future auditor) looks at
an owner-assigned item, they must be able to see *why* FairPlay thinks the
owner assigned it. "Because the structured recipient hint said Sarah" and
"because the important comment said 'For Sarah' and the PR confirmed that at
review" are both valid, but they are not the same evidence, and the auditor
has to be able to tell them apart.

Every eligibility query that currently reads `WHERE status = 'available'` gains
an implicit filter — items with status `owner_assigned` never appear in
ranking, drafting, bidding, or grouping. The item's row still exists so it
prints, audits, exports, and is visible in the master list.

**UI behavior in the item list / picker views:**

Items with status `owner_assigned` render greyed out, with the badge
**"Already assigned"**, and no interaction affordance — no rank, no bid,
no group. A small subtitle shows *"To: {ownerAssignedName}"* so heirs see
who the owner named. Clicking opens a read-only detail card with the full
owner comment.

**PR-only affordances:**

The PR sees three additional controls on an owner-assigned item:

- **Confirm participant** — a dropdown of the game's participants, or "Not a
  participant (external)". Chosen value writes `ownerAssignedParticipantId`
  (or leaves it null when external). Audited.
- **Return to pool** — moves the item back to `available` with a required
  reason ("owner-named recipient declined", "family agreement", etc.). Audited.
- **Award to named person** — only enabled once `ownerAssignedParticipantId`
  is set (or once the PR explicitly picks a substitute). Moves the item to
  `awarded` with the participant ID recorded normally.

Heirs never see any of the PR-only affordances. The greyed row and the
"Already assigned" label are the only surfaces they see.

**Why status, not a boolean flag:**

Reusing `status` keeps every existing eligibility query correct with no
additional joins or where-clauses to update. A new boolean like
`isOwnerAssigned` would require every pool query in the codebase to add
`AND isOwnerAssigned = 0`. A status transition is the same shape as the
existing `awarded` / `in_high_value` mechanics and slots into the audit log
exactly like they do.

**Why not just set `awarded` at import time:**

`awarded` implies a completed transaction inside the game — a participant
chose it, or the PR assigned it, and it now has an `awardedToParticipantId`.
An owner-stated wish is a *pre-game* fact: it never entered the pool, no
participant selected it, and the recipient may or may not turn out to be a
participant at all. Conflating the two would corrupt reporting and audit.

### 3) Detect owner-stated assignment in the important comment

**The core insight from the user's feedback:** the recipient_hint field is one
way to express intent, not the only way. Owners routinely write assignments
directly into the comment box ("For Sarah," "Give this to Michael," "Meant
for my sister Carol"). If FairPlay only reads the structured hint, those
items land in the bidding pool despite the owner's clearly-stated wish. That
is the exact failure mode this handoff exists to prevent.

**Signal detection — not automatic assignment.** We are not trying to build a
name-extraction AI that makes irreversible decisions. We are trying to catch
the cases the structured field missed, surface them to the PR at import
review, and let the PR confirm or dismiss.

**Where to detect:** at `stageBundle` time in
`apps/reindeer-fair-play/server/import/importService.ts`, run a lightweight
detector on each staged item that has `ownerImportantComment` set. Only run
it when the structured `recipientHint` is empty — the structured hint is the
canonical answer whenever the owner filled it in, so a detected signal that
agrees with the hint is noise and a detected signal that disagrees is the
PR's problem to arbitrate, not ours to guess.

**Detector rules (starting point — deliberately conservative):**

A staged item earns a `pending_owner_assignment_review` flag when its
comment matches at least one of:

- **"For {Name}"** at the start of a sentence or the whole comment. Name is a
  capitalized word or two-word phrase that isn't a stop-word (For / The / My /
  This / It / etc.).
- **"Meant for {Name}"** / **"Intended for {Name}"** / **"Going to {Name}"** /
  **"Give this to {Name}"** / **"Belongs to {Name}"** / **"Save for {Name}"** /
  **"For my {relation} {Name}"** where relation is a small closed set
  (daughter, son, sister, brother, mother, father, niece, nephew, grandson,
  granddaughter, cousin, wife, husband, friend).
- The comment mentions a name that also appears in the estate's participant
  list (case-insensitive, first-name match). This is the strongest signal
  because it grounds against the known family; a comment that says "Sarah"
  when Sarah is a participant is almost certainly an assignment.

Matching is case-insensitive, tolerant of possessives ("Sarah's"),
and records the extracted name plus the sentence that carried it. Multiple
matches in one comment surface all of them so the PR can pick the right one.

**Explicit non-goals:** the detector does not run any language model, does not
call out to any external service, does not need training data. It is a small
deterministic regex + participant-name lookup, so its behavior is auditable
and its false-positive rate is bounded by the PR's review step. If the
regexes miss a phrasing, the PR still sees the comment (it prints on the
review screen) and can flag it manually. **The detector's job is to catch
obvious cases, not exhaustive ones.**

**Staging schema addition (part of the v14 migration):**

```
staged_items.detected_owner_assignment_name TEXT NULL
staged_items.detected_owner_assignment_quote TEXT NULL   -- verbatim sentence
staged_items.detected_owner_assignment_confidence TEXT
   -- 'participant_name' | 'directive_phrase' | 'both'
```

**Review UX in the import batch screen:**

Every staged row with a detected signal shows a review card:

> **Possible owner assignment.** The owner wrote *"For Sarah"* and Sarah is a
> participant in this game.
>
> [ Confirm — mark as assigned to Sarah ]  [ Not an assignment — keep in pool ]
> [ Someone else — pick from list ]

The PR must act on every detected signal before the batch can be approved.
That forcing function is the whole point — we detect for the human, we do not
decide for them. "Not an assignment" is a first-class outcome (many comments
mention names for reasons other than assignment, e.g. "Sarah picked this out
with me at the estate sale").

When the PR confirms:
- The chosen name is written to `ownerAssignedName` on approval.
- `ownerAssignedSource` is set to `'comment_detected'`.
- `ownerAssignedEvidence` is set to the detected verbatim sentence, so an
  auditor can later see the exact words that led to this classification.
- The item is created with `status: 'owner_assigned'` exactly as if the hint
  had been used.

When the PR dismisses:
- No `status` change. The item lands as `available` as before.
- The dismissal is audited with the detected sentence and the PR's optional
  reason, so a family member who later asks "why didn't the app catch
  'For Sarah'?" gets a real answer from the audit log.

**Edge cases handled deliberately:**

- **Multiple names in one comment** ("For Sarah, but if she doesn't want it,
  give it to Michael"): surface both. The PR picks the primary. The
  alternate can be recorded in the `owner_note` field of the recipient hint
  the PR effectively creates.
- **Ambiguous name shared with a non-participant** ("For Aunt Sarah" when
  Sarah is a participant, and Aunt Sarah is a different person): the PR sees
  the full sentence and picks. We do not silently pick the participant.
- **Directive without a name** ("Keep this in the family," "Do not sell"):
  this is not an assignment. The detector never fires on these because
  neither the directive phrases nor the participant lookup produce a name
  candidate. The comment still prints in the trustee packet.
- **Comment written in a language the detector does not cover:** the
  detector produces no signal. The comment still prints in the trustee
  packet, and the PR can manually mark the item owner-assigned via the
  "Someone else" path. Non-English support is a fast-follow, not a
  blocker — the fallback is safe (item stays available; PR can still
  intervene).
- **Owner used the recipient_hint AND wrote an assignment-shaped
  comment:** detector is suppressed (see "only run when structured hint
  is empty" above). Both surfaces still record the comment; only one
  drives the `ownerAssignedName`.

**Registry side — do we detect there?**

Probably yes, but as a *soft prompt*, not a status change. If an owner writes
"For Sarah" on an item with no recipient hint, the Registry app can show a
friendly one-time nudge:

> It looks like you're saying this item is for Sarah. Want to add her as the
> intended recipient? [ Add Sarah ]  [ Not now ]

This converts detected intent into structured intent at the point of
authorship, which is by far the best time. Registry never *changes* the item
automatically — the owner chooses. If they choose "Not now," the comment
still prints on the trustee packet, and FairPlay still detects it on
import. Belt and suspenders. This is a Registry follow-up and does not block
the FC-side work.

### 4) What the trustee packet shows about pre-assigned items

The trustee packet's items table should mark owner-assigned items so the
trustee sees the same greyed distinction the heirs see:

```
# | Item | Room | Media | Stated wish | Est. value
7   Mother's engagement ring   Primary Bedroom   1 photo   Sarah [ASSIGNED]   —
    In the owner's own words: For Sarah. It has always been meant for her.
    Please do not appraise it — I do not want the number to matter.
```

The `[ASSIGNED]` mark is redundant with the `owner_important_comment`
call-out for the trustee, but it makes the count of pre-assigned items
scannable in the table without reading every comment. A small legend under
the table:

> Items marked **[ASSIGNED]** carry an owner-stated wish and are kept out
> of the family selection process. If any of these need to be reopened, the
> personal representative can return them to the pool inside FairPlay.

**Items whose assignment came from a comment** (not from a structured hint)
get the same `[ASSIGNED]` mark. The trustee packet does not distinguish
source in the visible mark — from the trustee's point of view, the owner
said it either way. The audit log preserves the source so a curious auditor
can see whether a given assignment came from the structured hint, from a
detected comment, or from a manual PR entry.

**Items with an owner comment but no assignment** still print the comment
verbatim in the call-out row. The comment is worth reading even when it is
not an assignment ("Grandma made a hundred meals in this pan" is not an
assignment, but the trustee should know it before disposing of the pan).

## Scope of work

### Trustee packet edit (small)

- `packages/legacy-print-feature/src/templates/trusteePacket.js`
  - New row per item with `owner_important_comment`
  - `[ASSIGNED]` mark next to "Stated wish" when set
  - Summary counter for "items with a comment"
  - Legend under the table
- CSS block for `.owner-comment-row` / `.owner-comment`
- Roundtrip: add a check that a rendered packet contains the exact comment
  string when set on the source item.

### FairPlay pre-assignment (larger, five sub-passes)

1. **v14 migration**
   - Add to `items`:
     - `owner_assigned_name TEXT NULL`
     - `owner_assigned_participant_id INTEGER NULL`
     - `owner_assigned_source TEXT NULL` — `'recipient_hint' | 'comment_detected' | 'pr_manual'`
     - `owner_assigned_evidence TEXT NULL` — verbatim quote of the words that established the assignment
   - Add to `staged_items`:
     - `detected_owner_assignment_name TEXT NULL`
     - `detected_owner_assignment_quote TEXT NULL`
     - `detected_owner_assignment_confidence TEXT NULL`
     - `detected_owner_assignment_review TEXT NULL` — `'pending' | 'confirmed' | 'dismissed'`
     - `detected_owner_assignment_review_reason TEXT NULL`
   - No change to the `status` column type; the new `'owner_assigned'` value is a string.
   - Back-fill: no back-fill for existing rows. Existing games are not
     retroactively reclassified — this is a forward-only rule.
2. **Detector + staging**
   - New module `server/import/detectOwnerAssignment.ts`. Pure function,
     deterministic, no external calls. Input: comment string + participant
     name list. Output: 0..N candidate `{name, quote, confidence}`.
   - Called from `stageBundle` for each item where
     `staged.recipientHint === ''` and `staged.ownerImportantComment !== ''`.
   - Writes results into the `detected_*` columns.
3. **Import review + approve behavior**
   - Review screen surfaces detected candidates as a required decision per
     staged item. Batch cannot be approved with pending detections.
   - `approveStaged` sets `status: 'owner_assigned'` and populates
     `ownerAssignedName`, `ownerAssignedSource`, `ownerAssignedEvidence`
     when either the structured hint is present or the PR confirmed a
     detected candidate.
   - Review-time override: the PR can also *dismiss* a structured hint
     (some estates will have hints on items that were already given inter
     vivos and should not have been in the envelope). Same shape as
     dismissing a detected candidate; source recorded as
     `'recipient_hint'` in the audit even when dismissed.
4. **Query hygiene**
   - Every pool / eligibility SELECT that checks `status = 'available'` stays
     correct by construction, but we still add explicit expectations to the
     self-tests so a future addition to the enum doesn't silently leak
     `owner_assigned` items into the pool.
   - Import self-test (`server/import/selftest.mts`) grows checks:
     - Item with `recipient_hint.recipient_name = "Sarah"` and empty comment
       → `status = 'owner_assigned'`, `ownerAssignedSource = 'recipient_hint'`.
     - Item with empty hint and comment `"For Sarah."` where Sarah is a
       participant → staged with a detected candidate → PR confirms →
       `status = 'owner_assigned'`, `ownerAssignedSource = 'comment_detected'`,
       `ownerAssignedEvidence` contains the sentence.
     - Item with empty hint and comment `"For Sarah."` where Sarah is a
       participant → PR dismisses → `status = 'available'`, audit records
       dismissal + detected sentence.
     - Item with empty hint and comment `"Grandma made a hundred meals in
       this pan."` → no detection → no review step required → lands
       `available`.
5. **UI**
   - Heir list: greyed row, "Already assigned" badge, To: name subtitle,
     read-only detail on click.
   - PR list: three controls (Confirm participant / Return to pool /
     Award to named person). Every action audited.
   - Import review: detected-candidate card with Confirm / Dismiss /
     Someone-else actions (see §3).
   - Handoff drawer count: "N items already assigned by the owner. Read
     each one before finalizing."

### Estimated test counts after work lands

- Roundtrip: 66 → 68 (comment appears in trustee packet HTML;
  owner-assigned item survives envelope roundtrip).
- FC import self-test: 38 → 45 (five new checks around detection,
  confirmation, dismissal, no-op, and the structured-hint path continuing to
  work).
- FC auth: unchanged (47).
- FC fiduciary: unchanged (51).
- New detector unit test file: ~10 checks on the pure detection function
  itself (For / Meant for / Give this to / participant match / possessive /
  multiple names / no-match / directive without a name / non-Latin script
  fallback / capitalization tolerance).

### Warnings before starting

Per the project rule, before touching this:

- **Schema change:** v14 adds two columns to FC `items` and introduces a new
  `status` enum value. Old backups pre-v14 restore fine; new backups will not
  restore into a pre-v14 build.
- **Wire format:** none. The exchange envelope is untouched. `recipient_hint`
  is already there.
- **Behavior change visible to families:** items that used to go into the
  bidding pool with a stated-wish label now stay out of the pool entirely.
  Communicate this to any pilot family in a running game before rolling the
  build.
- **Not a legal change:** the app does not make the owner's wish legally
  binding. The comment is honored inside FairPlay as a family process
  choice; the legal instrument is still the signed memorandum plus the will.
  This distinction has to be preserved in every piece of copy on the
  pre-assigned card — "already assigned" refers to family process, not law.
- **Detector is heuristic:** the comment detector will miss some phrasings
  and will occasionally flag names used non-assignmentally. That is
  acceptable *because the PR reviews every detection.* If we ever let the
  detector make silent decisions, this trade-off changes and the safety case
  changes with it. Do not remove the PR review step.

## Out of scope for this handoff

- Automatic name → participant matching, including auto-resolving the
  detected name to a participant ID without PR review. The owner writes
  "Sarah"; the family might have three Sarahs. Matching is the PR's job, not
  the software's.
- Retroactive re-classification of items in games already in progress.
- Registry-side changes. Registry already prints the comment on the owner's
  own sheets; the trustee packet is what needed to be lifted, and it is a
  Print-feature concern shared with FairPlay via the exchange envelope.
- Value handling. Whether the owner said "don't appraise it" is a comment,
  not a directive. The PR can honor it inside FC's high-value workflow, but
  automating "skip appraisal because the owner asked" is a separate
  conversation about the fiduciary chain of custody.

## Recommended sequencing

1. Ship the trustee-packet edit first (small, single-file, tested). This
   alone gives the trustee the sentence they need to see, even before Fair
   Choice knows how to pre-assign.
2. Ship the FC v14 migration and the structured-hint half of the import
   behavior. UI can lag — an `owner_assigned` item without the greyed heir
   card still stays out of the pool because of the status query, so the
   model change alone is correct-by-construction even if the UI shows it as
   a generic "not available" row for a build or two.
3. Ship the comment detector + the PR review step in the import screen.
   This is the change that catches items the owner "didn't do correctly in
   the app."
4. Ship the heir + PR UI polish (greyed cards, badges, controls).
5. Grow the roundtrip and self-tests to lock the behavior in.
6. **Registry follow-up:** add the soft prompt in the intake flow so
   detected intent becomes structured intent at authorship. Not blocking.
