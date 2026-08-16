/**
 * Contested category stages self-test.
 *
 * The commonly contested categories run as their own rounds so that an heir who
 * cares about the jewelry is not made to spend picks against garden tools. Two
 * things must hold for that to be worth anything:
 *
 *   1. While a stage is open, the pool the heirs rank contains that stage and
 *      nothing else. If a single unrelated item leaks in, the protection is
 *      gone — someone will rank it, and the round is no longer about jewelry.
 *   2. The numbers on screen must reconcile. total = awarded + remaining +
 *      heldBack, always. A family that sees four of nine accounted for will
 *      assume the app lost five of their things, and they will be right to.
 *
 * This file exists because the original implementation was destroyed by a
 * careless `git checkout` and rebuilt from the surviving category definitions.
 * There is no original left to diff against, so the behaviour is pinned here
 * instead.
 */
import "../testing/scratchEnv";
import { storage } from "../storage";
import { CONTESTED_ROUND_KIND } from "@shared/legalCategories";
import type { Item } from "@shared/schema";

let passed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail = "") {
  if (condition) {
    passed += 1;
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** The pool heirs may actually rank. Private, and the only thing that matters. */
async function pool(): Promise<Item[]> {
  return await (storage as any).rankablePool();
}

async function poolNames(): Promise<string[]> {
  return (await pool()).map((i) => i.name).sort();
}

async function enableStage(label: string) {
  const rows = await storage.listTaxonomy();
  const row = rows.find((r) => r.kind === CONTESTED_ROUND_KIND && r.label === label);
  if (!row) throw new Error(`no seeded stage row for ${label}`);
  await storage.setTaxonomyEnabled(row.id, true);
}

async function main() {
  console.log("Contested stages — one category at a time, and the numbers add up\n");

  const session = await storage.getSession();
  await storage.createParticipant({
    sessionId: session.id,
    name: "Alice",
    isAdmin: false,
    seatOrder: 1,
  } as any);

  /* ------------------------------------------------ stages are seeded, off */
  const seeded = (await storage.listTaxonomy()).filter((r) => r.kind === CONTESTED_ROUND_KIND);
  check("the five contested stages are seeded", seeded.length === 5, `${seeded.length} rows`);
  check("stages are seeded switched off", seeded.every((r) => !r.isEnabled));
  check(
    "seeded row order is the round order",
    seeded
      .slice()
      .sort((a, b) => a.id - b.id)
      .map((r) => r.label)
      .join(" > ") === "Art & Decor > Jewelry > Photographs > Personal Possessions > Heirlooms",
    seeded.map((r) => r.label).join(" > "),
  );

  /* ---------------------------------------------------------- the estate */
  const made: Record<string, Item> = {};
  const spec: [string, string][] = [
    ["Gold ring", "Jewelry"],
    ["Pearl necklace", "Jewelry"],
    ["Silver brooch", "Jewelry"],
    ["Wedding album", "Photographs"],
    ["Box of slides", "Photographs"],
    ["Oak dresser", "Furniture"],
    ["Garden spade", "Tools & Equipment"],
  ];
  for (const [name, category] of spec) {
    made[name] = await storage.createItem({
      name,
      room: "Living Room",
      category,
      notes: "",
      aiEstimatedValue: 100,
      estimateSource: "manual",
      photoUrl: null,
      thumbnailUrl: null,
    } as any);
  }

  /* -------------------------------- with no stages on, everything is in play */
  let p = await stageReport();
  check("no stages on means usingStages is false", p.usingStages === false);
  check("the whole estate is in one pool", (await pool()).length === 7, `${(await pool()).length}`);
  check(
    "the headline says everything is together",
    /divided together/.test(p.headline),
    p.headline,
  );
  check("nothing is reported as open", p.open === null);
  check("the general line holds all seven", p.general.total === 7, String(p.general.total));

  /* ----------------------------------------------- one stage on: it is alone */
  await enableStage("Jewelry");
  check(
    "with the jewelry stage open, only jewelry can be ranked",
    (await poolNames()).join(", ") === "Gold ring, Pearl necklace, Silver brooch",
    (await poolNames()).join(", "),
  );

  p = await stageReport();
  check("usingStages is true once a stage is on", p.usingStages === true);
  check("the open stage is jewelry", p.open?.label === "Jewelry", String(p.open?.label));
  check("the open stage counts three", p.open?.remaining === 3, String(p.open?.remaining));
  check("nothing is waiting behind it yet", p.waiting.length === 0);
  check(
    "the headline names the stage in plain words",
    p.headline === "Now dividing: Jewelry — 3 things still to choose.",
    p.headline,
  );
  check(
    "the general line covers only what is outside the stages",
    p.general.total === 4,
    String(p.general.total),
  );

  /* ------------------------ a second stage waits its turn, it does not join */
  await enableStage("Photographs");
  check(
    "opening a second stage does not add it to the pool",
    (await poolNames()).join(", ") === "Gold ring, Pearl necklace, Silver brooch",
    (await poolNames()).join(", "),
  );
  p = await stageReport();
  check("photographs are reported as waiting", p.waiting.map((w) => w.label).join() === "Photographs", p.waiting.map((w) => w.label).join());
  check("the waiting stage shows its size", p.waiting[0]?.remaining === 2, String(p.waiting[0]?.remaining));

  /* --------------------------- a high-value item is held back, not lost */
  await storage.updateItem(made["Silver brooch"].id, { needsAppraisal: true } as any);
  check(
    "a high-value item leaves the pool",
    (await poolNames()).join(", ") === "Gold ring, Pearl necklace",
    (await poolNames()).join(", "),
  );
  p = await stageReport();
  check("it is reported as held back, not awarded", p.open?.heldBack === 1, String(p.open?.heldBack));
  check("it is not counted as remaining", p.open?.remaining === 2, String(p.open?.remaining));
  check(
    "the jewelry numbers reconcile with the total",
    !!p.open && p.open.total === p.open.awarded + p.open.remaining + p.open.heldBack,
    p.open ? `${p.open.total} vs ${p.open.awarded}+${p.open.remaining}+${p.open.heldBack}` : "",
  );

  /* -------------------- awarding the stage out moves the round along */
  await storage.updateItem(made["Gold ring"].id, { status: "awarded" } as any);
  p = await stageReport();
  check("the stage stays open while one thing is left", p.open?.label === "Jewelry", String(p.open?.label));
  check("the award is counted", p.open?.awarded === 1, String(p.open?.awarded));

  await storage.updateItem(made["Pearl necklace"].id, { status: "awarded" } as any);
  p = await stageReport();
  check(
    "when the last available thing is gone the next stage opens",
    p.open?.label === "Photographs",
    String(p.open?.label),
  );
  check(
    "the pool follows to the new stage",
    (await poolNames()).join(", ") === "Box of slides, Wedding album",
    (await poolNames()).join(", "),
  );
  check("jewelry is now reported finished", p.finished.map((f) => f.label).join() === "Jewelry", p.finished.map((f) => f.label).join());
  check(
    "a held-back item does not hold a stage open",
    p.finished[0]?.heldBack === 1,
    String(p.finished[0]?.heldBack),
  );

  /* ------------------------- an empty stage is skipped, not shown as a round */
  await enableStage("Heirlooms");
  p = await stageReport();
  check(
    "a stage with no items never becomes the open round",
    p.open?.label === "Photographs",
    String(p.open?.label),
  );
  check(
    "and it is not listed as waiting either",
    !p.waiting.some((w) => w.label === "Heirlooms"),
    p.waiting.map((w) => w.label).join(),
  );

  /* -------------------------- stages done: the general round begins */
  await storage.updateItem(made["Wedding album"].id, { status: "awarded" } as any);
  await storage.updateItem(made["Box of slides"].id, { status: "awarded" } as any);
  p = await stageReport();
  check("with every stage done nothing is open", p.open === null);
  check(
    "the general pool is now in play",
    (await poolNames()).join(", ") === "Garden spade, Oak dresser",
    (await poolNames()).join(", "),
  );
  check(
    "the headline hands over to everything else",
    /finished\. Now everything else — 2 things/.test(p.headline),
    p.headline,
  );

  /* ---------------------- the last item awarded: say so, do not go blank */
  await storage.updateItem(made["Oak dresser"].id, { status: "awarded" } as any);
  await storage.updateItem(made["Garden spade"].id, { status: "awarded" } as any);
  p = await stageReport();
  check("the end is stated plainly", p.headline === "Everything has been divided.", p.headline);
  check("and the pool is empty", (await pool()).length === 0);

  /* ------------------- a hand-typed category still matches its stage */
  const odd = await storage.createItem({
    name: "Loose photographs in a tin",
    room: "Attic",
    category: "  photographs  ",
    notes: "",
    aiEstimatedValue: 10,
    estimateSource: "manual",
    photoUrl: null,
    thumbnailUrl: null,
  } as any);
  void odd;
  p = await stageReport();
  check(
    "a differently-typed category is still caught by its stage",
    p.open?.label === "Photographs",
    String(p.open?.label),
  );
  check(
    "the stage claims it, counting three photographs in total",
    p.open?.total === 3,
    String(p.open?.total),
  );
  check(
    // The general line still reads 2 — the dresser and the spade, both awarded.
    // It counts everything outside the stages whether or not it is still in
    // play, so the test is that the odd item did not land here.
    "so it is not quietly dropped into the general round",
    p.general.total === 2,
    String(p.general.total),
  );

  /* -------------- a rehearsal ignores stages entirely, as it must */
  await storage.startPractice("sample_items", 2);
  const practicePool = await poolNames();
  check(
    "practice overrides stages and offers the pretend items",
    practicePool.length === 10 && practicePool.includes("Green ceramic vase"),
    `${practicePool.length} items`,
  );
  await storage.endPractice();
  check("and the stage reasserts itself afterwards", (await stageReport()).open?.label === "Photographs");

  console.log(`\n${passed} checks passed${failures.length ? `, ${failures.length} FAILED` : ""}`);
  if (failures.length) {
    console.log("\nFailures:\n" + failures.map((f) => "  - " + f).join("\n"));
    process.exit(1);
  }
}

async function stageReport() {
  return await storage.stageProgress();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
