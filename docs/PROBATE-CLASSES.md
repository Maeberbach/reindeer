# Registry scope — what the owner is asked, and what is deliberately left out

Status: SUPERSEDED as of 5 August 2026. Read `TWO-LISTS.md` instead — it records the
two-lane / two-schedule design that was actually approved and built. This file is kept only
for the rejected reasoning below, so it is not re-proposed.

Supersedes an earlier draft of this file that proposed an eight-class probate taxonomy. That
draft was wrong and the reasoning is recorded below so it is not re-proposed.

## The correcting insight

An earlier draft asked the owner to classify each item by why it might be contested —
heirloom, jewelry, promised, and so on. The owner rejected it for a reason that holds:

> only Heirs will know what they mean to them the owner just needs to put them into inventory
> and decide if there is a specific heir to receive it

Sentimental significance is knowledge held by the **heirs**, not the owner. A mother has no way
to know which of her things her children will grieve over. Asking her to predict it produces
guesses that are worse than silence, and it spends the attention of an elderly person on a
question she cannot answer, on the way to the two questions she is the only person who *can*
answer.

Emotional weight therefore gets collected during distribution, from the heirs, in Legacy: Fair
Choice. It is not registry work.

## What the registry asks — exactly two things

1. **What is this?** A photograph, and an identification. Typed, or produced by recognition for
   owners who cannot type comfortably on a phone.
2. **Is there a specific heir in mind?** A name if there is one. An affirmative "no one in
   particular" if there is not.

That is the whole owner-facing job. Everything else the record needs is either derived, or
supplied later by someone better placed to supply it.

## The one schema change: `naming_state`

A blank recipient field cannot express the owner's instruction, because blank is ambiguous — the
trustee cannot tell "I chose not to name anyone" from "I never got to this one." That difference
is legally material: it is the difference between a specific bequest and property falling into
the residuary, and specific bequests abate last, after residuary and general bequests
(https://docs.legis.wisconsin.gov/document/statutes/1995/863.21).

Three explicit values on `items`:

- `named` — a specific person is recorded.
- `deliberately_unnamed` — an affirmative choice. The trustee decides. The app stops
  asking about this item and never prompts on it again.
- `undecided` — default. Not yet answered.

This is the entire structural change. No class column, no value band, no new capture step, no
new threshold setting.

## Value — not an owner question

Value matters at distribution, not at capture. It is needed to equalize, and equalization happens
when the estate is settled, not while the owner is photographing a sideboard. Owner's framing:

> the value question is only important at the time of distribution so back end ai value
> estimation is needed then

Consequences:

- The registry stops asking the owner to price anything. The existing `value_estimate_cents`,
  `value_basis` and `high_value_flag` columns stay exactly as they are — nothing is dropped — but
  they are filled in later by appraisal, by the trustee, or by backend estimation at
  distribution time.
- **The photograph is the asset that makes later valuation possible.** Photo quality and
  retention matter more than any field on the form, because an estimate produced months later
  has nothing else to work from.
- Vision still never sets a value. That rule is unchanged and is now load-bearing in a second
  way: valuation belongs to the settlement stage and to the trustee's determination.

Whether an item needs equalizing is the trustee's call in every case. The app supplies
facts and prints the naming state; it states no conclusion.

## Recognition is an accessibility feature, not a convenience

> AI identification is needed for those without phone typing skills

This reframes automatic recognition. It is not a labour-saver for the capable — it is the input
method for owners who cannot type on a phone at all. Without it, those owners cannot use the
registry unassisted. It stays off for now by owner decision, but it is an accessibility
requirement rather than a nice-to-have, and it is recorded that way in `docs/ROADMAP.md`.

Its job is identification only: what the object is, and a maker only where one is genuinely
legible in the photograph. Never a value.

## Firearms — free, no new field

Firearms genuinely do need separate handling: ATF and NFA transfer rules apply, the executor may
possess a registered firearm during probate but must file ATF Form 5 before probate closes, and
unregistered NFA firearms are contraband that cannot pass to an heir at all
(https://www.law.cornell.edu/cfr/text/27/479.90a, https://www.atf.gov/media/25196/download). An
executor who cannot lawfully possess them must route custody through a licensed dealer
(https://piercelaw.com/news/probate-question-and-answer/how-can-an-estate-handle-appraising-and-selling-firearms-if-the-executor-isnt-allowed-to-possess-or-transport-guns-nc/).

`Firearms` is already one of the seeded object categories, so this needs no new field and no new
question. The printed schedule simply carries a handling note wherever that category appears.
Nothing is asked of the owner.

## Why the earlier taxonomy is not coming back

Kept as a record so this is not relitigated. The research is sound but it answers a distribution
question, not a capture question:

- Personal items are five times more likely than money to cause family conflict (Allianz Life) —
  https://www.santaellalaw.com/blog/2026/february/how-to-prevent-family-disputes-over-sentimental-/
- More than half of the lawsuits one firm sees concern items totalling under 10% of estate value —
  https://www.kaveshlaw.com/blog/preventing-inheritance-fights-over-sentimental-stuff-the-law-firm-of-kavesh-minor-amp-otis-inc-.cfm
- Disputes over tangible personal property are a top-three cause of estate administration
  conflict — https://www.wealthmanagement.com/estate-planning/dividing-the-stuff-shouldn-t-be-an-afterthought
- Jewelry, photographs and albums lead the sentimental flashpoints; informal verbal promises
  produce the "he said, she said" disputes —
  https://www.blutlawgroup.com/blog/2025/05/3-sentimental-items-that-cause-disputes-in-estate-administration/
- Jewelry and personal possessions account for 21% of sibling estate disputes —
  https://www.llphlegal.com/blog/2018/05/10-important-statistics-about-sibling-estate-disputes/

All of it argues that the contested-category question is real and worth asking. It just has to be
asked of the heirs, during distribution, in FairPlay — where the answers are known and where
they are actually used.
