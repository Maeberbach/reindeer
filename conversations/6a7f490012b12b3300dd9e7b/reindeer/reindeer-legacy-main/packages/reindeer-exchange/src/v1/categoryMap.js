/*
 * How a Registry category reaches FairPlay.
 *
 * Registry speaks the owner's language and FairPlay speaks the law's, so a
 * handed-off inventory has to cross a small translation at the border. There
 * are exactly three ways across, and which one an item takes decides whether
 * FairPlay's AI is allowed to touch its category afterwards.
 *
 *   exact       The two lists use the same word. Nothing to translate; the
 *               category is the owner's and is treated as final.
 *
 *   alias       Different word, same thing. "Guns" is what an owner says,
 *               "Firearms" is what the statute says. Translated on arrival and
 *               then treated exactly like `exact` — still the owner's choice,
 *               still final, still carrying its regulated-transfer flag.
 *
 *   shorthand   A deliberately coarse bucket that stands for several Fair
 *               Choice categories at once. Arrives as a HINT rather than a
 *               choice, which is the one case where the AI may refine it.
 *
 * The distinction matters because FairPlay will not overwrite a category a
 * human picked. Everything that crosses as `exact` or `alias` is protected by
 * that rule. Only `shorthand` is offered up for refinement, and even then the
 * AI may change the category and nothing else — an heir the owner named in
 * Registry is never touched, by any path.
 *
 * `candidates` is advisory. It records which FairPlay categories a bucket
 * was built to cover so the mapping can be read and tested, but the analyser is
 * not restricted to the list; it chooses from FairPlay's full set as usual.
 */

/** How an owner's category is treated once it reaches FairPlay. */
export const CATEGORY_CROSSING = Object.freeze({
  EXACT: 'exact',
  ALIAS: 'alias',
  SHORTHAND: 'shorthand',
});

/**
 * Keyed by the Registry category name, exactly as stored.
 *
 * A name absent from this table is one the owner typed themselves or pulled
 * from the silent list. Those are handled by `crossingFor` below: a silent-list
 * name matches a FairPlay category and crosses as `exact`, and an invented
 * name crosses as itself and is flagged for review on import, as it always was.
 */
export const REGISTRY_CATEGORY_MAP = Object.freeze({
  'Sentimental items': {
    crossing: CATEGORY_CROSSING.SHORTHAND,
    candidates: ['Personal Possessions', 'Heirlooms'],
  },
  Jewelry: {
    crossing: CATEGORY_CROSSING.EXACT,
    category: 'Jewelry',
  },
  'Holiday ornaments': {
    crossing: CATEGORY_CROSSING.SHORTHAND,
    candidates: ['Personal Possessions', 'Collectibles'],
  },
  'Heirloom and special furniture': {
    crossing: CATEGORY_CROSSING.SHORTHAND,
    candidates: ['Heirlooms', 'Furniture', 'Rugs & Antiques'],
  },
  'Collectibles — artwork, rare wine or spirits': {
    crossing: CATEGORY_CROSSING.SHORTHAND,
    candidates: [
      'Art & Decor', 'Wine & Spirits', 'Collectibles', 'Coins & Stamps',
      'Precious Metals & Bullion', 'Silver & China', 'Musical Instruments',
    ],
  },
  Photographs: {
    crossing: CATEGORY_CROSSING.EXACT,
    category: 'Photographs',
  },
  'Everything else': {
    crossing: CATEGORY_CROSSING.SHORTHAND,
    candidates: [
      'Kitchenware', 'Electronics', 'Tools', 'Books', 'Sporting Goods',
      'Clothing', 'Documents', 'Digital Assets', 'Real Property Contents',
      'Miscellaneous',
    ],
  },
  Guns: {
    crossing: CATEGORY_CROSSING.ALIAS,
    category: 'Firearms',
  },
  Vehicles: {
    crossing: CATEGORY_CROSSING.EXACT,
    category: 'Vehicles',
  },
});

/** The Registry names FairPlay is permitted to refine. */
export const SHORTHAND_CATEGORIES = Object.freeze(
  Object.keys(REGISTRY_CATEGORY_MAP)
    .filter((k) => REGISTRY_CATEGORY_MAP[k].crossing === CATEGORY_CROSSING.SHORTHAND),
);

/**
 * Decide how one incoming category name crosses the border.
 *
 * @param {string|null|undefined} name  the Registry category, as stored
 * @param {string[]} [knownCategories]  FairPlay's own category labels, so a
 *   name pulled from Registry's silent list is recognised as an exact match
 *   without this package having to carry a second copy of that list
 * @returns {{crossing: string, category: string|null, candidates: string[]}}
 *   `category` is what FairPlay should store; null means store nothing and
 *   let the AI decide from scratch.
 */
export function crossingFor(name, knownCategories = []) {
  const clean = typeof name === 'string' ? name.trim() : '';
  if (!clean) {
    return { crossing: CATEGORY_CROSSING.SHORTHAND, category: null, candidates: [] };
  }

  const mapped = REGISTRY_CATEGORY_MAP[clean];
  if (mapped) {
    return {
      crossing: mapped.crossing,
      category: mapped.category ?? null,
      candidates: mapped.candidates ?? [],
    };
  }

  // Pulled from the silent list, or simply spelled the same by coincidence.
  const match = knownCategories.find((c) => c.toLowerCase() === clean.toLowerCase());
  if (match) {
    return { crossing: CATEGORY_CROSSING.EXACT, category: match, candidates: [] };
  }

  // Invented by the owner. Carried through as-is and flagged on import, which
  // is the behaviour that predates this table and is deliberately unchanged.
  return { crossing: CATEGORY_CROSSING.EXACT, category: clean, candidates: [] };
}

/** True when FairPlay's AI may refine a category that came from Registry. */
export function isRefinable(name, knownCategories = []) {
  return crossingFor(name, knownCategories).crossing === CATEGORY_CROSSING.SHORTHAND;
}
