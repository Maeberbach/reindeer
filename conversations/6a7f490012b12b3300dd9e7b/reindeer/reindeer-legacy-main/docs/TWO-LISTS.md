# Why there are two lists, and two apps

Written 5 August 2026. This supersedes the taxonomy reasoning in
`PROBATE-CLASSES.md`, which described a categorisation scheme that was
considered and rejected. Read this first.

---

## The insight this rests on

> "The designated gifts are to satisfy the owner and the most common emotional
> items are to satisfy the heir. They happen at different times and are
> documented with the two different apps."

That is the whole architecture in two sentences. Everything below is
consequence.

There are two entirely different problems hiding inside "who gets the stuff",
they have different owners, they surface at different times, and trying to solve
both in one list is what makes estate software unusable for the person it is
aimed at.

| | **Designated gifts** | **Contested favourites** |
|---|---|---|
| Whose need | The **owner's**. Peace of mind that a specific thing reaches a specific person. | The **heirs'**. A fair, survivable way to divide what nobody was promised. |
| When | While the owner is alive and able. | After death, in the room, with the family present. |
| Who decides | The owner, alone. | The heirs, under a process, with the trustee supervising. |
| What it needs | A **name** attached to an object, signed. | A **method** — ranking, taking turns, bidding, equalising. |
| Which app | **Reindeer Registry** | **Reindeer: FairPlay** |
| Which schedule | **Schedule A** of the memorandum | **Schedule B** feeds the pool |
| Legal weight | Operative. Directs distribution. | None until the trustee acts. |

An owner cannot do the heirs' job for them. They do not know what their children
will fight over, because sentimental value is created in the *heir*, not in the
object. A mother who spends her energy guessing which of her three children
wants the chipped mixing bowl is spending it in the wrong place. Her job is the
short list of things she has an actual intention about. The bowl belongs on the
inventory so the family knows it exists, and belongs to FairPlay to allocate.

This is also why the registry must never ask the owner to categorise things as
heirloom, sentimental, or contested. Those are heirs' words. Asking an
eighty-year-old to predict them adds work, invites second-guessing, and produces
a field nobody downstream should trust.

---

## The conflicts each list actually prevents

These are not hypothetical categories. They are the failure modes the
literature keeps reporting.

### What Schedule A prevents: the unrecorded promise

The single most common and most destructive pattern is a verbal promise with no
paper behind it. Two heirs each remember being told they would get the same
thing, both are telling the truth as they remember it, and there is no document
to break the tie. This is described plainly as a
["he said, she said" problem](https://www.blutlawgroup.com/blog/2025/05/3-sentimental-items-that-cause-disputes-in-estate-administration/),
and jewellery and photographs lead the list of items it happens to.

Schedule A exists to convert a promise into a record while the person who made
it is still alive to confirm it. That is its entire job, and it is why the
recipient field is the only judgement the registry asks the owner to make.

A second, quieter benefit: specific bequests
[abate last](https://docs.legis.wisconsin.gov/document/statutes/1995/863.21) —
if the estate has to give something up to pay debts, specifically gifted items
are the last to go. Naming a recipient is therefore also a form of protection
for that object.

### What Schedule B prevents: "we didn't know it existed"

An inventory nobody wrote down cannot be divided fairly and cannot be checked.
A trustee who does not know what was in the house cannot tell whether
something left it. Schedule B is the answer to three separate problems:

- **Disappearance between death and distribution.** The commonest accusation in
  a contested settlement is that something went missing before the family sat
  down. Only a pre-existing list can answer it.
- **Nothing to divide with.** FairPlay needs a pool. A ranking process over
  an incomplete list produces an unfair result that *looks* procedurally fair,
  which is worse than an obvious mess.
- **The unrecognised valuable.** An owner frequently does not know that a thing
  passed down to them is worth money. If it is not on the list, no one ever
  looks at it. Logging it costs the owner nothing and preserves the chance of an
  appraisal later.

### Why this split matters more than the money

The reason the low-value list is not optional: the disputes are not about the
money. Personal items are reported as
[five times more likely than money to cause family conflict](https://www.santaellalaw.com/blog/2026/february/how-to-prevent-family-disputes-over-sentimental-/).
One firm reports that
[more than half of the lawsuits they see concern items making up under 10% of the estate](https://www.kaveshlaw.com/blog/preventing-inheritance-fights-over-sentimental-stuff-the-law-firm-of-kavesh-minor-amp-otis-inc-.cfm).
Tangible personal property is a
[top-three cause of estate administration conflict](https://www.wealthmanagement.com/estate-planning/dividing-the-stuff-shouldn-t-be-an-afterthought),
and jewellery and personal possessions account for
[21% of sibling disputes](https://www.llphlegal.com/blog/2018/05/10-important-statistics-about-sibling-estate-disputes/),
with siblings involved in 44% of them.

An app that captured only the valuables would miss the majority of what families
actually fight about.

---

## Consequences for how the software behaves

**The owner is never asked what a thing is worth.** Value matters at
distribution, to the trustee, for equalisation. It does not matter at capture,
and asking is a tax on completion. The registry sends no value at all; Fair
Choice records the item as not yet valued and the professional supplies the
figure. A fabricated estimate wearing an authoritative label is worse than a
blank, because nobody downstream can tell it was a guess.

**Coverage is the registry's metric, not richness.** A complete list of plainly
named things beats a beautiful record of nine items. Hence the two input lanes:
a careful photo flow for the things that get a name, and a room walkthrough for
everything else.

**Two lanes, matched to the two lists.**

- *Photo lane* — deliberate, one object at a time, ends with "for whom". Feeds
  Schedule A.
- *Video lane* — walk through a room, keyframes reviewed in bulk, no recipient
  asked. Feeds Schedule B.

**Nothing is designated by accident.** Bulk intake cannot assign a recipient.
The only way an item reaches Schedule A is an owner naming someone on purpose.

**If there is no specific heir in mind, no name is recorded.** A guess in the
recipient field is worse than an empty one: it looks like an instruction and it
will be treated as one.

---

## Where the two lists meet

FairPlay imports both. It treats them differently:

- Items arriving **with** a recipient are the owner's operative instructions.
  The trustee confirms them and, per your standing rule, decides whether
  equalisation is needed — a specifically named gift often does not require
  balancing, and that determination is theirs to make, not the software's.
- Items arriving **without** one enter the pool for the family process, and are
  parsed there for value, firearms, titled property and special handling.

Re-import is expected, not exceptional. An owner will send a fresh export every
time they finish a room. The boundary is verified by
`server/import/suite-conflict-selftest.mts` (25 checks), which proves that
re-sending the whole inventory updates the existing items rather than
multiplying them, that a designated gift is never duplicated into two competing
gifts, and that a genuine look-alike is flagged for a person instead of being
merged automatically.

### Known gap

The same physical object recorded in two *separate* walkthroughs, where
recognition happened to choose different words for it each time, can survive as
two rows. Three defences exist and each can miss it: frame grouping only works
within one recording, the registry's title-similarity sweep needs 0.72 overlap,
and the cross-app origin id is genuinely different. The catalogue sweep at
`GET /api/duplicates/scan` is the backstop, and it proposes groups only — the
suite never deletes anything on its own.
