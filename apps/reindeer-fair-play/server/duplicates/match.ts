/**
 * One duplicate rule for the whole suite.
 *
 * Before this file existed there were three different rules of three different
 * strengths, which meant an item's duplicate status changed depending on which
 * door it came through:
 *
 *   Reindeer: Registry   token overlap >= 0.72, or a matching serial
 *   FairPlay import    exact name, or one name containing the other
 *   FairPlay standing  exact name only
 *                         scan
 *
 * So "Grandpa's watch" and "Grandpa's pocket watch" were flagged on the way in
 * and then became invisible the moment they went live, because the standing
 * scan used the weakest rule of the three. This module is the single rule all
 * three now call, so a duplicate is a duplicate no matter how the item arrived
 * — photographed, pulled out of a video walkthrough, imported from the
 * registry, or typed in by hand in FairPlay.
 *
 * Deliberately cheap and explainable. A person always makes the final call;
 * `reason` exists so the interface can say WHY two things were grouped rather
 * than asserting it.
 */

export type MatchReason = "serial_match" | "exact_name" | "name_contains" | "token_overlap";

export type MatchResult = { matched: boolean; reason: MatchReason | null; score: number };

/** Same normalisation the registry uses, so the two agree on the same strings. */
export function normalizeName(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Token overlap, 0..1, over the larger token set. */
export function titleSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeName(a).split(" ").filter(Boolean));
  const tb = new Set(normalizeName(b).split(" ").filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  Array.from(ta).forEach((t) => {
    if (tb.has(t)) shared++;
  });
  return shared / Math.max(ta.size, tb.size);
}

/** Fields worth treating as a hard identity claim when they agree. */
const SERIAL_KEYS = ["serial", "serial_number", "serialnumber", "vin", "imei", "hallmark"];

function parseIdentifiers(raw: unknown): Record<string, string> {
  if (!raw) return {};
  if (typeof raw === "object") return raw as Record<string, string>;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Two items whose serial numbers agree are the same object, whatever anyone
 * called them. This outranks every name rule.
 */
export function serialMatch(aIdentifiers: unknown, bIdentifiers: unknown): boolean {
  const a = parseIdentifiers(aIdentifiers);
  const b = parseIdentifiers(bIdentifiers);
  for (const key of Object.keys(a)) {
    if (!SERIAL_KEYS.includes(key.toLowerCase().replace(/[^a-z_]/g, ""))) continue;
    const av = String(a[key] ?? "").trim().toLowerCase();
    if (av.length < 3) continue; // too short to mean anything
    for (const otherKey of Object.keys(b)) {
      if (!SERIAL_KEYS.includes(otherKey.toLowerCase().replace(/[^a-z_]/g, ""))) continue;
      if (String(b[otherKey] ?? "").trim().toLowerCase() === av) return true;
    }
  }
  return false;
}

export const TOKEN_OVERLAP_THRESHOLD = 0.72;

export type Matchable = { name: string; identifiers?: unknown };

/**
 * The whole rule, in priority order. Origin-blind on purpose: nothing here
 * looks at how the item was created.
 */
export function looksLikeSameThing(a: Matchable, b: Matchable): MatchResult {
  if (serialMatch(a.identifiers, b.identifiers)) {
    return { matched: true, reason: "serial_match", score: 1 };
  }

  const na = normalizeName(a.name);
  const nb = normalizeName(b.name);
  if (!na || !nb) return { matched: false, reason: null, score: 0 };

  if (na === nb) return { matched: true, reason: "exact_name", score: 1 };

  // "Grandpa's watch" vs "Grandpa's pocket watch". Guarded against short
  // strings so "pin" does not swallow "pincushion".
  if (na.length > 4 && nb.length > 4 && (na.includes(nb) || nb.includes(na))) {
    return { matched: true, reason: "name_contains", score: 0.9 };
  }

  const score = titleSimilarity(na, nb);
  if (score >= TOKEN_OVERLAP_THRESHOLD) {
    return { matched: true, reason: "token_overlap", score };
  }

  return { matched: false, reason: null, score };
}

/** Plain-language explanation for the review interface. */
export function explainMatch(reason: MatchReason | null): string {
  switch (reason) {
    case "serial_match":
      return "These carry the same serial number.";
    case "exact_name":
      return "These have the same name.";
    case "name_contains":
      return "One name is contained in the other.";
    case "token_overlap":
      return "These names share most of the same words.";
    default:
      return "";
  }
}
