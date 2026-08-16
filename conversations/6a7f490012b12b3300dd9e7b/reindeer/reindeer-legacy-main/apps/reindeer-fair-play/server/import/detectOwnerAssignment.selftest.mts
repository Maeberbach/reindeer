/**
 * Self-test for the owner-assignment detector.
 *
 * The detector is a pure function with no I/O or DB, so this file does not
 * import scratchEnv. Run with:  npx tsx server/import/detectOwnerAssignment.selftest.mts
 *
 * These tests pin behavior for the review-time UX in the import screen. If a
 * detection ever starts failing here, the PR review step will silently miss
 * the case in production, which is a real user-visible defect for the
 * primary motivating scenario ("owner wrote For Sarah in the comment").
 */
import assert from "node:assert/strict";
import { detectOwnerAssignment } from "./detectOwnerAssignment";

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

const PARTICIPANTS = ["Sarah", "Michael", "Carol"];

async function main(): Promise<void> {
console.log("\n== detectOwnerAssignment ==");

await check("empty comment yields no candidates", () => {
  assert.deepEqual(detectOwnerAssignment("", PARTICIPANTS), []);
  assert.deepEqual(detectOwnerAssignment("   \n\t  ", PARTICIPANTS), []);
});

await check("bare 'For {Name}' at the start of a comment fires", () => {
  const hits = detectOwnerAssignment("For Sarah.", PARTICIPANTS);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, "Sarah");
  assert.equal(hits[0].quote, "For Sarah.");
  assert.equal(hits[0].confidence, "both"); // Sarah is a participant
});

await check("'For {Name}' with unknown participant is directive-only confidence", () => {
  const hits = detectOwnerAssignment("For Deborah.", PARTICIPANTS);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, "Deborah");
  assert.equal(hits[0].confidence, "directive_phrase");
});

await check("'Meant for {Name}' fires and captures the whole sentence", () => {
  const hits = detectOwnerAssignment(
    "It has always been meant for Michael, since he was a boy.",
    PARTICIPANTS,
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, "Michael");
  assert.match(hits[0].quote, /meant for Michael/i);
  assert.equal(hits[0].confidence, "both");
});

await check("possessive 'Sarah's' is normalized to 'Sarah'", () => {
  // Comment implies an assignment even without a directive phrase, via the
  // participant-name path. The name key strips the possessive.
  const hits = detectOwnerAssignment(
    "This was Sarah's favorite growing up.",
    PARTICIPANTS,
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, "Sarah");
  assert.equal(hits[0].confidence, "participant_name");
});

await check("directive without a name never fires", () => {
  assert.deepEqual(
    detectOwnerAssignment("Keep this in the family.", PARTICIPANTS),
    [],
  );
  assert.deepEqual(
    detectOwnerAssignment("Do not sell this at auction.", PARTICIPANTS),
    [],
  );
  assert.deepEqual(
    detectOwnerAssignment("For a rainy day.", PARTICIPANTS),
    [],
  );
});

await check("multiple names in one comment surface as separate candidates", () => {
  const hits = detectOwnerAssignment(
    "For Sarah, but if she doesn't want it, give this to Michael.",
    PARTICIPANTS,
  );
  const names = hits.map((h) => h.name).sort();
  assert.deepEqual(names, ["Michael", "Sarah"]);
});

await check("non-directive name-drop is surfaced but only at participant confidence", () => {
  // "Sarah picked this out with me at the estate sale" — Sarah is a name
  // but the sentence is not a directive. Detector should still surface so
  // the PR can dismiss.
  const hits = detectOwnerAssignment(
    "Sarah picked this out with me at the estate sale in 1998.",
    PARTICIPANTS,
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, "Sarah");
  assert.equal(hits[0].confidence, "participant_name");
});

await check("lowercased 'for sarah' still matches (case-insensitive directive)", () => {
  const hits = detectOwnerAssignment("for Sarah", PARTICIPANTS);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, "Sarah");
});

await check("'Belongs to Sarah' fires", () => {
  const hits = detectOwnerAssignment(
    "This belongs to Sarah. She should have it when I am gone.",
    PARTICIPANTS,
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, "Sarah");
});

await check("no participants provided: directive still fires, name-drop does not", () => {
  const hits = detectOwnerAssignment(
    "For Deborah. Sarah picked this out with me.",
    [],
  );
  // Deborah has a directive so she fires. Sarah is a bare capitalized name
  // in a sentence with no directive and no participant list to ground her,
  // so the detector deliberately ignores her. That is the safe fallback: a
  // family without any FC participants would otherwise get flooded with
  // false positives on every capitalized word in every comment.
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, "Deborah");
  assert.equal(hits[0].confidence, "directive_phrase");
});

await check("stopwords never surface as names", () => {
  assert.deepEqual(detectOwnerAssignment("For the family.", PARTICIPANTS), []);
  assert.deepEqual(detectOwnerAssignment("For my children.", PARTICIPANTS), []);
});

await check("directive followed by two-token name captures the pair", () => {
  const hits = detectOwnerAssignment(
    "Give this to Aunt Sarah when she visits.",
    PARTICIPANTS,
  );
  // The regex captures 1-2 capitalized tokens after the directive.
  // "Aunt Sarah" is captured as one two-token name candidate; Sarah in the
  // participant set also matches, so both signals land on the same key.
  const names = hits.map((h) => h.name).sort();
  // "Aunt Sarah" and "Sarah" collapse via participant key. First seen wins.
  assert.ok(names.length >= 1);
  const anyMatch = hits.find((h) => /sarah/i.test(h.name));
  assert.ok(anyMatch, "expected some Sarah-shaped candidate");
});

console.log(`\n${passed} checks passed.\n`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
