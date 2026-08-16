# Reindeer: FairPlay

Part of **My Reindeer Legacy**. Sold separately from Reindeer: Registry.

---

## Whose app this is

FairPlay is the **heirs'** app. They run it together. Registry was the owner's; the desires
recorded there are honored as instructions. FairPlay picks up everything else — the tangible
leftovers the owner did not specifically direct — and gives the heirs a fair, agreed-in-advance
way to divide them, run at a distance so heirs in different states participate on equal footing.

The **trustee** — the person named by the trust or will to wind up the estate (your legal
documents may call them *trustee*, *personal representative*, or *executor*; the app calls them
all **trustee**) — sits **outside** the app by default. In most estates the trustee has already
delegated the personal-property division to the family; they do not need to referee the family
draft. What the trustee retains, and cannot delegate, is legal responsibility for the **high-value
items** and the **financial balance** of the estate. FairPlay segregates those items into a
separate bucket for the trustee's formal appraisal and equalization against other trust assets,
and produces a Record of Decisions the trustee countersigns at the end. When a family needs it,
the trustee can also sign in and run the session as **captain** — they still never draft or
receive items.

## The three protections

FairPlay is designed to protect three parties at once:

**The estate.** High-value items are flagged by an AI value estimate and pulled out of the family
draft into the trustee's queue, so nothing materially valuable is quietly divided as bric-a-brac.

**The heirs.** The rules of the draft are agreed in writing before anyone knows who gets what.
Rankings are private. Every step is recorded. Every heir signs at the end.

**The trustee.** The high-value flag prevents inadvertent legal exposure on items the family
might not have recognized as material. The Record of Decisions gives the trustee a clean, signable
audit trail for the trust file.

## Purpose

Reindeer: Registry answers *what is there and what did the owner want.*
FairPlay answers the harder question that comes later: **how do several
heirs divide what is left over without ending up in court, while the trustee
handles the pieces that carry legal weight.**

These are two different problems occurring at two different times, and
conflating them is what breaks estates. Designated gifts are made to satisfy the
**owner**, while they are alive and able to say so. The remaining items — the
ones nobody was promised and several people quietly want — have to satisfy the
**heirs**, after the owner is gone and cannot arbitrate. Meanwhile the
high-value pieces have to satisfy the **trustee's** standard of fairness on the
financial-balance-sheet side of the estate. FairPlay draws the line between
those two sub-problems in software: the heir-run draft, and the trustee's
segregated bucket. The disputes cluster in
that second category: jewelry and photographs lead the sentimental flashpoints,
and verbal promises collapse into "he said, she said" once the person who made
them is not there
([Blut Law Group](https://www.blutlawgroup.com/blog/2025/05/3-sentimental-items-that-cause-disputes-in-estate-administration/)).
Jewelry and personal possessions account for **21% of sibling estate disputes**,
and siblings are party to **44%** of them
([LLPH Legal](https://www.llphlegal.com/blog/2018/05/10-important-statistics-about-sibling-estate-disputes/)).

FairPlay runs a defined, recorded process for that remainder so the outcome
is the product of an agreed method rather than of who arrived at the house first.

## Process

**It starts from the record, not from scratch.** FairPlay imports the
registry's output directly. Photographs, stories, rooms, categories, appraisal
flags, and any non-binding note about an intended recipient all come across.
Re-importing an updated list **updates** the existing items rather than
multiplying them — verified by test, six items stay six.

**Designated gifts are honored, not re-litigated.** An item the owner assigned
is set aside. It does not enter the division. The distinction between what the
owner directed and what the heirs are dividing is preserved end to end.

**Every heir has a real account.** Access is by email magic link, single-use and
time-limited, with the session held in a signed, http-only cookie and the API
denying by default. There is no way to act as another heir by editing a request.
For a process whose entire value is that it was fair, knowing who actually did
what is not a technicality.

**Duplicates are flagged from every input source.** The most corrosive failure in
a family division is dividing the same object twice, or having an heir discover
that "Grandma's ring" and "Grandmother's diamond ring" were one ring. Fair
Choice checks for likely duplicates across **all** input sources — items
imported from the registry, items pulled out of a video walkthrough, items typed
in by hand here, and items being evaluated by AI — using **one** rule for the
whole suite: a matching serial number, an identical name, one name contained in
another, or names sharing most of the same words. The check is deliberately
blind to where an item came from, and it runs both as a standing sweep and
automatically whenever an item is evaluated. Related pairs collapse into a
single group, so the family makes one decision instead of several overlapping
ones. Each grouping is shown with a plain-language reason it was flagged. The
app **proposes**; a person resolves; nothing is deleted automatically.

**Then the division runs.** Heirs rank what they want. The process reconciles
the rankings and resolves the contested items so the outcome follows the
ranked-draft rules everyone signed up to rather than first-come. Any value
balancing across shares belongs to the trustee outside the app. Items flagged
as high value are pulled into the trustee's queue, with a threshold the owner
or trustee can set. A practice round lets a family rehearse the whole thing on
ten pretend items — a green ceramic vase, a set of golf clubs, grandma's china
— so everyone sees how ranking and contest resolution actually behave before
anything real is on the table. The rehearsal never touches the estate's own
items, and it
cannot: the practice round has no path to real inventory, so nobody can rank the
house by accident and no practice choice can be mistaken later for a decision.
Every pretend item is marked as such on screen and disappears when the round
ends. Rehearsing on things nobody has feelings about is usually what converts
skepticism into participation.

**Every step is recorded, and the result prints.**

## Results

- **A completed division of the remainder**, produced by a stated method every
  participant agreed to before knowing the outcome.
- **A record of how it happened** — who ranked what, who resolved which
  duplicate, what the process decided and why. This is the artifact that answers
  a challenge two years later.
- **A printable result**, so the outcome exists on paper and not only in an app.
- **A printed Record of Decisions for the trustee.** One document, produced on
  demand from the Administration tab, setting out the thresholds that were in
  force, **who set each figure and on whose authority** — the estate attorney by
  name, the trustee, the federal appraisal rule, a state requirement, or the
  trustee's own judgement, recorded honestly either way — every item that needed
  a decision of its own with what it was worth and how it was settled, and a
  signature block for the captain who ran the session and for the confirming
  trustee or attorney. Because current law wants ink, the document says so
  plainly and invites a photograph or scan of the signed copy to be sent to the
  professional, who can then confirm the signing.
- **A clean audit trail.** High-value items are segregated, values are never
  fabricated, and items awaiting appraisal stay visibly unresolved rather than
  quietly counting as zero.

## Why this is better

**Practically.** The default alternatives are round-robin selection, an
auctioneer, or a family meeting. Round-robin is only fair if everyone values
items identically, which is exactly what is not true of sentimental property.
Selling everything converts an heirloom problem into a cash problem and
frequently deepens the grievance. A family meeting depends on the least
conflict-averse person in the room. FairPlay replaces all three with a method
fixed in advance, applied identically to everyone, and executed at a distance so
nobody has to negotiate across a kitchen table days after a funeral. Heirs in
different states participate on equal footing.

**Legally.** Four things matter:

1. **The method precedes the outcome.** A division challenged after the fact is
   defended by showing the rules were set before anyone knew who got what. That
   is the entire structural argument, and it is why the process is defined up
   front rather than negotiated as it goes.
2. **Identity is real.** Authenticated accounts and an audit trail mean the
   record of participation is evidence. A process where anyone could act as
   anyone documents nothing.
3. **Designated gifts stay outside the process.** Specific bequests are the
   last to abate
   ([Wis. Stat. §863.21](https://docs.legis.wisconsin.gov/document/statutes/1995/863.21));
   allowing a division process to reach them would put the app crosswise with
   the instrument it is supposed to implement. It cannot reach them.
4. **One duplicate rule across the whole suite.** An item's duplicate status
   does not depend on which app or which door it came through. That consistency
   is what lets a trustee certify the list was not double-counted.

**A note for trust officers.** The remainder division is the part of estate
administration with the most conflict and the least documentation. This produces
a defined process, an authenticated participant record, and a printed result —
in place of a series of phone calls.

---

### Honest limits

- Not legal advice, and not a substitute for the trustee's judgment. Fair
  Choice runs a process; it does not authorize a distribution.
- It does not appraise, and it will not invent a value. Items awaiting appraisal
  are shown as unresolved.
- Duplicate detection **proposes**. The same object captured in two separate
  walkthroughs under two unrelated names can still reach the division as two
  items until a person groups them.
- Restricted categories still require their own legal handling —
  firearms most obviously
  ([27 CFR §479.90a](https://www.law.cornell.edu/cfr/text/27/479.90a),
  [ATF estate guidance](https://www.atf.gov/media/25196/download),
  [FFL custody in probate](https://piercelaw.com/news/probate-question-and-answer/how-can-an-estate-handle-appraising-and-selling-firearms-if-the-executor-isnt-allowed-to-possess-or-transport-guns-nc/)).
- Rate limiting is in-memory and resets when the server restarts.
- An older build of FairPlay will silently ignore new fields added to the
  exchange format. The suite must be kept in step.

---

## Trustee Handoff model (v14, revised)

**Fair, not Equal — because families aren't calculators.** FairPlay v14
narrows the app's job to what families actually need help with: agreeing on
who gets what among the tangible personal property. Everything numeric — how
to make the whole distribution fair across all estate assets — is where the
trustee already earns their fee.

### What changed from the earlier Equalization Ledger model

The earlier runtime treated FairPlay as a self-contained fairness engine:
every high-value item required an approved dollar value, a chosen
equalization path (unanimous consent, buyout, sale, and so on), and per-item
signed consent from every heir before the item could close. That gate was
strong on paper and stiff in practice; a single unresponsive heir or one
unpriced painting could hold the whole session open indefinitely, and the
family already has a trustee whose statutory job is to balance the numbers.

The v14 rescope moves that responsibility where it belongs:

- Heirs sign **one Method Agreement per session, up front.** It says, in
  plain language: "we accept the ranked-draft outcome for the items
  themselves, and we accept that the trustee balances the money using other
  estate assets." Ranking cannot open until every non-admin heir has signed;
  the agreement version and full text at sign-time are snapshotted onto the
  row and never rewritten.
- **Any heir can flag any item for appraisal** at any time before final
  signing. Flagging never removes the item from the ranked draft — it only
  records that an appraised value should be attached. The first heir to
  flag an item is named as the "escalating heir" on the trustee's record.
- **Finalization no longer waits for a value.** An item finalizes with its
  appraised value if one is on file, and finalizes marked "pending
  appraisal" if none is — the trustee resolves the value downstream, with
  the escalating heir named for context.
- The output at the end of a session is a **Record of Decisions**: every
  item, who it was assigned to, its appraised value where known, and every
  pending-appraisal item with its escalating heir. It is generated on
  request (server-rendered HTML, printable) — a hand-off document to the
  trustee, not a distribution order.

### What did not change

- The ranked-draft engine and the pool/draft state machine are exactly the
  same as before.
- The phase order and the audit-log format are preserved.
- Auth is unchanged (magic-link email, 20-minute single-use tokens, 30-day
  sliding sessions, deny-by-default over `/api`).
- The Registry app is unchanged. It still carries only the non-binding
  `recipient_hint` — the family process still lives entirely in Fair
  Choice.

### v15 update: the retired tables are gone

Commits 6 and 7 finished what the v14 rescope started. The runtime code that
read and wrote the equalization / consent / finalization tables was removed in
commit 6, and the empty tables themselves — `equalizationDecisions`,
`consents`, `finalizationEvents`, and `thresholdDecisions` — were dropped from
the schema in commit 7, along with the four `equalization_*` columns on
`sessions` and the `equalizationPath` / `finalizedAt` / `finalizationEventId`
columns on `items`. The item lifecycle enum (`ITEM_STATES`) is now three
states: `normal`, `flagged_high_value`, `awaiting_value_review`. Older SQLite
files are not auto-upgraded — there is no ladder — so a v15 build creates its
DB fresh from `server/migrations/init.ts`. Anything a historical session
recorded in the retired tables is not migrated forward.

The live high-value trail is now: an `appraisal_flags` row when a heir or the
AI escalates an item, the item's `highValueState`, and the `high_value_audit_log`
rows the flag/unflag/valuation events still write. The trustee sees the flagged
items on the Record of Decisions and resolves value questions in their own
workflow.

### Where the split with the trustee sits

The Method Agreement is the seam. Above it, the family talks about which
items belong to which heirs; below it, the trustee talks about whether the
totals meet the legal standard the trust instrument or the state code imposes. FairPlay never claims to balance the estate. It claims — and
proves in the Record of Decisions — that every heir walked in with the same
rules, ranked their preferences under those rules, and accepted the outcome
for the items themselves. The trustee handles the rest.

### Honest limits (v14 additions)

- The Method Agreement is a consent record, not a legally-binding waiver.
  A trustee or attorney may still want a separate written acknowledgment,
  and FairPlay does not attempt to substitute for one.
- The Record of Decisions names the escalating heir on pending-appraisal
  items but does not itself commission or price the appraisal — the trustee
  arranges that outside the app.
