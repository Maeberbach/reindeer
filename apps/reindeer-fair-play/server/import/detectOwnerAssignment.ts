/**
 * detectOwnerAssignment — surface owner assignments hidden inside the
 * Important comment.
 *
 * WHY THIS EXISTS
 *
 * The Registry app gives the owner two ways to say "this belongs to Sarah":
 * the structured recipient hint, and free-text inside the Important
 * comment. Real owners use both. If FairPlay only reads the structured
 * hint, comments like "For Sarah — always meant for her" get treated as
 * decoration and the item goes into the family bidding pool. That is the
 * exact failure the app exists to prevent.
 *
 * This detector runs at stageBundle time on items whose structured hint is
 * empty. It never assigns the item on its own — it produces a candidate
 * that the Captain must confirm or dismiss during import
 * review before the batch can be approved.
 *
 * WHAT IT DOES
 *
 * Two families of signals:
 *
 *   1. Directive phrases: "For Sarah", "Meant for Sarah", "Belongs to
 *      Sarah", "Give this to Sarah", etc. Name follows the phrase.
 *   2. Participant-name match: if the comment contains a name that is
 *      already in the estate's participant list, that is a strong signal
 *      the owner meant to assign the item.
 *
 * Both signals are combined into a single candidate list. Confidence is
 * `both` when the same name comes from both, otherwise `directive_phrase`
 * or `participant_name`.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * - No language model, no external service, no training data.
 * - No auto-assignment. The PR reviews every hit.
 * - No handling of non-Latin scripts (fast follow). The fallback is safe:
 *   the item lands as `available` and the comment still prints on the
 *   trustee packet, so the captain can still catch it manually.
 * - No fuzzy name matching to participants. Exact case-insensitive first
 *   name only. If a family has "Sara" and the owner wrote "Sarah", the captain
 *   sees the sentence and picks the right person; we do not guess.
 */

/** One detected assignment candidate. */
export interface OwnerAssignmentCandidate {
  /** The extracted name, e.g. "Sarah". Preserves original capitalization. */
  name: string;
  /** The verbatim sentence that carried the signal. */
  quote: string;
  /** How strongly the detector believed this. */
  confidence: "participant_name" | "directive_phrase" | "both";
}

/**
 * Words that follow directive phrases but are not names. Blocks matches
 * like "For a rainy day" or "Meant for the family". Case-insensitive.
 */
const NON_NAME_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "my",
  "our",
  "your",
  "his",
  "her",
  "their",
  "some",
  "any",
  "no",
  "one",
  "you",
  "me",
  "us",
  "them",
  "it",
  "this",
  "that",
  "these",
  "those",
  "family",
  "children",
  "kids",
  "grandkids",
  "grandchildren",
  "everyone",
  "everybody",
  "nobody",
  "someone",
  "somebody",
  "anyone",
  "anybody",
  "whoever",
  "posterity",
  "record",
  "safekeeping",
  "later",
  "now",
  "sale",
  "auction",
  "charity",
  "donation",
  "storage",
  "reference",
  "example",
  "instance",
  "sure",
  "certain",
]);

/**
 * Directive phrases the detector understands. Ordered from most specific
 * to least so overlapping matches ("meant for" wins over "for"). Each
 * pattern captures the name-shaped word(s) that follow.
 *
 * A "name" is 1–2 capitalized tokens. This is intentionally strict:
 * lowercase words after "for" ("for a rainy day") are ignored, and long
 * runs ("For Sarah and Michael and the kids") stop at 2 tokens — the captain
 * still sees the whole sentence and can pick the right one.
 */
const NAME_TOKEN = /[A-Z][a-zA-Z'\u2019\-]{1,29}/.source;
const NAME_CAPTURE = `(${NAME_TOKEN}(?:\\s+${NAME_TOKEN})?)`;

const DIRECTIVE_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "meant for", re: new RegExp(`\\bmeant\\s+for\\s+${NAME_CAPTURE}`, "i") },
  { label: "intended for", re: new RegExp(`\\bintended\\s+for\\s+${NAME_CAPTURE}`, "i") },
  { label: "going to", re: new RegExp(`\\bgoing\\s+to\\s+${NAME_CAPTURE}`, "i") },
  { label: "give this to", re: new RegExp(`\\bgive(?:\\s+this)?\\s+to\\s+${NAME_CAPTURE}`, "i") },
  { label: "give to", re: new RegExp(`\\bgive\\s+to\\s+${NAME_CAPTURE}`, "i") },
  { label: "belongs to", re: new RegExp(`\\bbelongs?\\s+to\\s+${NAME_CAPTURE}`, "i") },
  { label: "save for", re: new RegExp(`\\bsave\\s+for\\s+${NAME_CAPTURE}`, "i") },
  { label: "keep for", re: new RegExp(`\\bkeep\\s+for\\s+${NAME_CAPTURE}`, "i") },
  { label: "leaving to", re: new RegExp(`\\bleav(?:ing|e)\\s+(?:this\\s+)?(?:to|for)\\s+${NAME_CAPTURE}`, "i") },
  { label: "goes to", re: new RegExp(`\\bgoes\\s+to\\s+${NAME_CAPTURE}`, "i") },
  // "For {Name}" — very common. Anchored to sentence start OR after a
  // period/newline/comma to avoid matching "waited for Sarah" or similar
  // non-directive uses.
  { label: "for", re: new RegExp(`(?:^|[.\\n]|,\\s*)\\s*for\\s+${NAME_CAPTURE}`, "i") },
];

/** Split into sentences on ., !, ?, or newline. Keeps the delimiter out. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function stripPossessive(name: string): string {
  return name.replace(/[\u2019']s$/i, "");
}

function normalizeFirstName(name: string): string {
  return stripPossessive(name).split(/\s+/)[0]?.toLowerCase() ?? "";
}

function isStopword(name: string): boolean {
  const first = normalizeFirstName(name);
  return NON_NAME_STOPWORDS.has(first);
}

/** Case-insensitive canonical key for deduping / merging candidates. */
function nameKey(name: string): string {
  return normalizeFirstName(name);
}

/**
 * Detect owner-assignment candidates in a comment.
 *
 * @param comment The owner's Important comment text.
 * @param participantNames Names of FairPlay participants (heirs) in the
 *   current session. Used to boost signal when the comment mentions one of
 *   them by name. Order does not matter; case-insensitive.
 * @returns Zero or more candidates. Empty array means no signal.
 */
export function detectOwnerAssignment(
  comment: string,
  participantNames: readonly string[],
): OwnerAssignmentCandidate[] {
  const source = (comment ?? "").trim();
  if (source.length === 0) return [];

  const sentences = splitSentences(source);
  // Map from lowercase name key → candidate. Preserves discovery order via
  // an insertion-ordered Map. Merging is what promotes a candidate to
  // "both" confidence.
  const hits = new Map<string, OwnerAssignmentCandidate>();

  const participantSet = new Set(
    participantNames.map((n) => normalizeFirstName(n)).filter(Boolean),
  );

  for (const sentence of sentences) {
    // Directive-phrase pass. Only the first match per sentence — the
    // sentence is the "quote" carrier, not the phrase, so multiple
    // patterns matching the same sentence yield one candidate.
    for (const { re } of DIRECTIVE_PATTERNS) {
      const m = sentence.match(re);
      if (!m) continue;
      const raw = stripPossessive(m[1].trim());
      if (isStopword(raw)) continue;
      const key = nameKey(raw);
      if (!key) continue;
      const existing = hits.get(key);
      if (existing) {
        // Same name from two signals in the same sentence — promote.
        if (existing.confidence === "participant_name") {
          existing.confidence = "both";
        }
      } else {
        hits.set(key, {
          name: raw,
          quote: sentence,
          confidence: participantSet.has(key) ? "both" : "directive_phrase",
        });
      }
      break;
    }

    // Participant-name pass. Look for any participant first-name inside
    // the sentence as a whole-word match. This catches "Sarah picked this
    // out with me" — a name-drop that is not a directive but is still
    // worth showing to the captain when Sarah is in the game. The PR can
    // dismiss it.
    if (participantSet.size === 0) continue;
    // Extract every capitalized run in the sentence, then intersect with
    // participants. Cheap and precise; avoids per-participant regexes.
    const capitalized = sentence.match(new RegExp(NAME_TOKEN, "g")) ?? [];
    for (const cap of capitalized) {
      const bare = stripPossessive(cap);
      const key = nameKey(bare);
      if (!key || !participantSet.has(key)) continue;
      if (isStopword(bare)) continue;
      const existing = hits.get(key);
      if (existing) {
        if (existing.confidence === "directive_phrase") {
          existing.confidence = "both";
        }
      } else {
        hits.set(key, {
          name: bare,
          quote: sentence,
          confidence: "participant_name",
        });
      }
    }
  }

  return Array.from(hits.values());
}
