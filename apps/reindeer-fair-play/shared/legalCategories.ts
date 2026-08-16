/* ==================================================================== */
/* Legal category classes — Reindeer: FairPlay                      */
/* ==================================================================== */
/*
 * Categories in this app stay fluid: the captain can rename,
 * add, merge, and delete them, and nothing here prevents that. What this file
 * adds is a LEGAL CLASS sitting behind the label, because some kinds of
 * property cannot simply be handed to whoever ranked them highest.
 *
 * Three reasons this matters, and only these three:
 *
 *   1. Some property is a federal "collectible" under IRC 408(m)(2) — art, a
 *      rug or antique, any metal or gem, any stamp or coin, and alcoholic
 *      beverages. Gains on collectibles carry a maximum 28% federal long-term
 *      rate rather than the ordinary capital-gains rate, so an heir taking one
 *      is not in the same tax position as an heir taking a sofa.
 *      https://www.law.cornell.edu/uscode/text/26/408
 *
 *   2. Form 706 Schedule F requires an expert appraisal, plus the appraiser's
 *      qualifications under oath, for any single item OR COLLECTION OF SIMILAR
 *      ITEMS valued above $3,000. Household effects should be inventoried
 *      room by room and valued individually, except items worth under $100
 *      each, which may be grouped.
 *      https://www.irs.gov/pub/irs-pdf/f706sf.pdf
 *      https://www.irs.gov/instructions/i706
 *
 *   3. Some property cannot be transferred by agreement at all. Firearms move
 *      under federal and state transfer law, and an NFA firearm passing to an
 *      heir requires a tax-exempt ATF Form 5 transfer. A distribution round
 *      cannot make an unlawful transfer lawful.
 *      https://www.law.cornell.edu/cfr/text/27/479.90a
 *      https://www.atf.gov/media/25196/download
 *
 * This file only CLASSIFIES and only WARNS. It never blocks a distribution and
 * never gives legal or tax advice — that is the estate's attorney's job. The
 * point is that the captain sees the flag before the award,
 * not after.
 */

/** What kind of legal handling a category implies. */
export type LegalClass =
  /** IRC 408(m)(2) collectible — 28% maximum federal long-term rate. */
  | "collectible"
  /** Transfer is regulated in its own right, independent of the estate. */
  | "regulated_transfer"
  /** Title or registration must be reassigned, not just handed over. */
  | "titled"
  /** Ordinary household and personal effects. */
  | "household"
  /** No monetary class; value is entirely sentimental. */
  | "sentimental"
  /** Paper and digital records that are evidence, not property to divide. */
  | "records";

export interface LegalCategory {
  label: string;
  legalClass: LegalClass;
  /**
   * True where a single item, or a collection of similar items, commonly clears
   * the Form 706 Schedule F $3,000 appraisal trigger. A prompt, not a rule.
   */
  appraisalLikely: boolean;
  /**
   * True for the categories that most often become the actual fight. These are
   * the candidates for their own separate round.
   */
  commonlyContested: boolean;
  /** Plain-language note shown to the captain. No jargon. */
  note: string;
  /** Authority for the note, so the captain can hand it to the estate's attorney. */
  authority?: string;
}

/**
 * The standing legal classification. Labels here are seeded as categories, but
 * the captain remains free to rename or remove any of them; classification is looked
 * up by label and simply returns null for a label it does not recognize.
 */
export const LEGAL_CATEGORIES: readonly LegalCategory[] = [
  /* ---- IRC 408(m)(2) collectibles ---- */
  {
    label: "Art & Decor",
    legalClass: "collectible",
    appraisalLikely: true,
    commonlyContested: true,
    note: "Artwork is a collectible under federal tax law. Gains are taxed at up to 28%, not the ordinary rate. A single piece worth more than $3,000 needs a qualified appraisal for the estate tax return.",
    authority: "IRC 408(m)(2)(A); Form 706 Schedule F",
  },
  {
    label: "Jewelry",
    legalClass: "collectible",
    appraisalLikely: true,
    commonlyContested: true,
    note: "Jewelry containing metal or gems is a collectible under federal tax law. Jewelry is also the single most common thing families fight over, so consider giving it its own round.",
    authority: "IRC 408(m)(2)(C); Form 706 Schedule F",
  },
  {
    label: "Precious Metals & Bullion",
    legalClass: "collectible",
    appraisalLikely: true,
    commonlyContested: false,
    note: "Gold, silver, and other bullion is a collectible under federal tax law, taxed at up to 28%. Value moves daily, so record the date any figure was taken.",
    authority: "IRC 408(m)(2)(C)",
  },
  {
    label: "Coins & Stamps",
    legalClass: "collectible",
    appraisalLikely: true,
    commonlyContested: false,
    note: "Coins and stamps are collectibles under federal tax law. A graded collection is usually appraised as a collection, not coin by coin.",
    authority: "IRC 408(m)(2)(D); Form 706 Schedule F",
  },
  {
    label: "Rugs & Antiques",
    legalClass: "collectible",
    appraisalLikely: true,
    commonlyContested: false,
    note: "Rugs and antiques are named collectibles under federal tax law, separate from ordinary furniture.",
    authority: "IRC 408(m)(2)(B)",
  },
  {
    label: "Wine & Spirits",
    legalClass: "collectible",
    appraisalLikely: false,
    commonlyContested: false,
    note: "Alcoholic beverages are collectibles under federal tax law. Some states also restrict transferring a cellar, so ask before moving it.",
    authority: "IRC 408(m)(2)(E)",
  },
  {
    label: "Collectibles",
    legalClass: "collectible",
    appraisalLikely: true,
    commonlyContested: false,
    note: "A catch-all for collectibles that do not fit the named groups. A collection of similar items above $3,000 in total needs an appraisal, even if no single piece does.",
    authority: "IRC 408(m)(2)(F); Form 706 Schedule F",
  },
  {
    label: "Musical Instruments",
    legalClass: "collectible",
    appraisalLikely: true,
    commonlyContested: false,
    note: "A named-maker instrument can be worth many times what it looks like it is worth. Get it looked at before it is awarded.",
    authority: "Form 706 Schedule F",
  },

  /* ---- Transfer is regulated in its own right ---- */
  {
    label: "Firearms",
    legalClass: "regulated_transfer",
    appraisalLikely: false,
    commonlyContested: false,
    note: "Firearms do not move on this app's say-so. Federal and state transfer law applies, and a National Firearms Act item passing to an heir needs an ATF Form 5 transfer approved first. In some states the captain may not even be permitted to possess or transport them. Ask the estate's attorney before any firearm is handed to anyone.",
    authority: "27 CFR 479.90a; ATF Form 5",
  },

  /* ---- Title or registration must be reassigned ---- */
  {
    label: "Vehicles",
    legalClass: "titled",
    appraisalLikely: true,
    commonlyContested: false,
    note: "A vehicle needs its title reassigned through the state, so choosing a recipient here is only the first step. For the estate tax return, use the retail value, not the trade-in value.",
    authority: "Form 706 Schedule F instructions",
  },
  {
    label: "Real Property Contents",
    legalClass: "titled",
    appraisalLikely: false,
    commonlyContested: false,
    note: "Anything attached to the house may pass with the house rather than as personal property. Check before listing a fixture here.",
  },

  /* ---- Ordinary household effects ---- */
  {
    label: "Furniture",
    legalClass: "household",
    appraisalLikely: false,
    commonlyContested: false,
    note: "Ordinary household furniture. Items under $100 each may be grouped rather than listed one by one.",
    authority: "Form 706 Schedule F instructions",
  },
  {
    label: "Silver & China",
    legalClass: "household",
    appraisalLikely: true,
    commonlyContested: false,
    note: "Sterling and full china services often clear the $3,000 appraisal trigger as a set, even when no single piece would.",
    authority: "Form 706 Schedule F",
  },
  { label: "Kitchenware", legalClass: "household", appraisalLikely: false, commonlyContested: false, note: "Ordinary household goods. Group anything under $100 each." },
  { label: "Electronics", legalClass: "household", appraisalLikely: false, commonlyContested: false, note: "Ordinary household goods. Wipe accounts and stored data before handing anything over." },
  { label: "Tools", legalClass: "household", appraisalLikely: false, commonlyContested: false, note: "Ordinary household goods. A full workshop can be worth more as a set than piece by piece." },
  { label: "Books", legalClass: "household", appraisalLikely: false, commonlyContested: false, note: "Ordinary household goods, unless a signed or first edition is in there — move that one to Collectibles." },
  { label: "Sporting Goods", legalClass: "household", appraisalLikely: false, commonlyContested: false, note: "Ordinary household goods." },
  { label: "Clothing", legalClass: "household", appraisalLikely: false, commonlyContested: false, note: "Ordinary personal effects. Furs and designer pieces are worth pulling out separately." },
  { label: "Miscellaneous", legalClass: "household", appraisalLikely: false, commonlyContested: false, note: "Anything that has not found a home yet. Try not to leave things here." },

  /* ---- Purely sentimental, and the real flashpoints ---- */
  {
    label: "Photographs",
    legalClass: "sentimental",
    appraisalLikely: false,
    commonlyContested: true,
    note: "Photographs are worth almost nothing and are fought over constantly, because only one person can have the original. Copying and sharing usually settles it better than awarding does. Give these their own round.",
  },
  {
    label: "Personal Possessions",
    legalClass: "sentimental",
    appraisalLikely: false,
    commonlyContested: true,
    note: "Letters, keepsakes, a watch, a ring worn every day. Almost no money and the most feeling. Give these their own round.",
  },
  {
    label: "Heirlooms",
    legalClass: "sentimental",
    appraisalLikely: false,
    commonlyContested: true,
    note: "Anything the family already calls an heirloom. The label itself is a warning that more than one person expects it.",
  },

  /* ---- Records, not property to divide ---- */
  {
    label: "Documents",
    legalClass: "records",
    appraisalLikely: false,
    commonlyContested: false,
    note: "Deeds, titles, policies, and tax records are evidence the estate needs, not property to divide. Keep them with the captain.",
  },
  {
    label: "Digital Assets",
    legalClass: "records",
    appraisalLikely: false,
    commonlyContested: false,
    note: "Accounts, photo libraries, domains, and stored files. Access is governed by the provider's terms and state digital-assets law, not by who ranked it highest.",
    authority: "Form 706 Schedule F (digital assets)",
  },
];

/** Every seeded category label, in the order they are offered. */
export const LEGAL_CATEGORY_LABELS: readonly string[] = LEGAL_CATEGORIES.map((c) => c.label);

const BY_LABEL = new Map<string, LegalCategory>(
  LEGAL_CATEGORIES.map((c) => [c.label.trim().toLowerCase(), c]),
);

/**
 * Look up the legal class behind a category label.
 *
 * Returns null for a label this app does not recognize, which is the expected
 * answer for any category the captain invented. An unrecognized
 * category is not an error and is never treated as one; it simply carries no
 * legal note.
 */
export function legalClassOf(label: string | null | undefined): LegalCategory | null {
  if (!label) return null;
  return BY_LABEL.get(label.trim().toLowerCase()) ?? null;
}

/** Categories that most often become the fight, in the order worth running them. */
export const CONTESTED_CATEGORY_LABELS: readonly string[] = LEGAL_CATEGORIES.filter(
  (c) => c.commonlyContested,
).map((c) => c.label);

/**
 * Form 706 Schedule F appraisal trigger: a single item OR a collection of
 * similar items above this figure requires a qualified appraisal with the
 * appraiser's qualifications stated under oath.
 * https://www.irs.gov/pub/irs-pdf/f706sf.pdf
 */
export const SCHEDULE_F_APPRAISAL_TRIGGER = 3000;

/**
 * Household items under this figure may be grouped rather than itemized.
 * https://www.irs.gov/instructions/i706
 */
export const HOUSEHOLD_GROUPING_FLOOR = 100;

/** Maximum federal long-term capital-gains rate on IRC 408(m) collectibles. */
export const COLLECTIBLE_MAX_RATE_PERCENT = 28;

/**
 * Legal notes that apply to a set of items, deduplicated by category.
 *
 * Used to put the warnings in front of the captain BEFORE the
 * award, and to print them into the archived audit trail afterwards. It reports;
 * it never blocks.
 */
export function legalNotesFor(
  items: readonly { category?: string | null; estimatedValue?: number | null }[],
): {
  category: string;
  legalClass: LegalClass;
  count: number;
  note: string;
  authority?: string;
  appraisalTriggered: boolean;
}[] {
  const byCategory = new Map<string, { count: number; total: number; max: number }>();
  for (const it of items) {
    const cls = legalClassOf(it.category);
    if (!cls) continue;
    const acc = byCategory.get(cls.label) ?? { count: 0, total: 0, max: 0 };
    const v = it.estimatedValue ?? 0;
    acc.count += 1;
    acc.total += v;
    acc.max = Math.max(acc.max, v);
    byCategory.set(cls.label, acc);
  }
  const out: ReturnType<typeof legalNotesFor> = [];
  byCategory.forEach((acc, label) => {
    const cls = legalClassOf(label)!;
    // Schedule F fires on a single item OR a collection of similar items, so the
    // category total counts, not just the largest piece.
    const triggered =
      acc.max > SCHEDULE_F_APPRAISAL_TRIGGER || acc.total > SCHEDULE_F_APPRAISAL_TRIGGER;
    out.push({
      category: label,
      legalClass: cls.legalClass,
      count: acc.count,
      note: cls.note,
      authority: cls.authority,
      appraisalTriggered: triggered,
    });
  });
  // Regulated transfers first — those are the ones that can actually be unlawful.
  const rank: Record<LegalClass, number> = {
    regulated_transfer: 0,
    titled: 1,
    collectible: 2,
    sentimental: 3,
    records: 4,
    household: 5,
  };
  return out.sort((a, b) => rank[a.legalClass] - rank[b.legalClass] || a.category.localeCompare(b.category));
}

/**
 * The taxonomy `kind` used for stage rows.
 *
 * Stages live in the existing taxonomy table rather than in new session columns,
 * so adding them required no migration and no wire-format change. A stage row is
 * a category label plus an on/off switch, and the row order is the round order —
 * exactly the shape the taxonomy table already had.
 */
export const CONTESTED_ROUND_KIND = "contested_round";
