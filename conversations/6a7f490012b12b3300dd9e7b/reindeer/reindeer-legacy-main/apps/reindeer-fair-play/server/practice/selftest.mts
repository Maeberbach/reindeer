/**
 * Practice round self-test.
 *
 * The question this answers is narrow and important: when the family rehearses,
 * are they picking over pretend things, or over the actual estate?
 *
 * A rehearsal that runs on the real catalogue teaches the family what they are
 * about to lose. Heirs see the real pocket watch go to a sibling, form an
 * expectation, and then the round is thrown away — which is worse than no
 * rehearsal at all, because the disappointment is real even though the award was
 * not. Practice must therefore be a closed world: pretend items in, pretend
 * items out, and not one byte of the real estate touched.
 *
 * Every check below exists to hold one of those guarantees.
 */
import "../testing/scratchEnv";
import Database from "better-sqlite3";
import { storage } from "../storage";
import { PRACTICE_SAMPLE_ITEMS } from "@shared/schema";

/**
 * Read the rankings table behind the application's back.
 *
 * Needed because the storage layer masks rankings during practice; the only way
 * to prove masking is not deletion is to look at the rows themselves.
 */
function rawRankingRows(): [number, number][] {
  const raw = new Database(process.env.FAIR_CHOICE_DB_PATH!, {
    readonly: true,
  });
  const rows = raw
    .prepare("SELECT item_id, rank FROM rankings ORDER BY rank")
    .all() as { item_id: number; rank: number }[];
  raw.close();
  return rows.map((r) => [r.item_id, r.rank]);
}

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

async function main() {
  console.log("Practice round — sample items must be a closed world\n");

  /* ---------------------------------------------- a real estate to protect */
  const session = await storage.getSession();
  const alice = await storage.createParticipant({
    sessionId: session.id,
    name: "Alice",
    isAdmin: false,
    seatOrder: 901,
  } as any);
  const bob = await storage.createParticipant({
    sessionId: session.id,
    name: "Bob",
    isAdmin: false,
    seatOrder: 902,
  } as any);
  await storage.createParticipant({
    sessionId: session.id,
    name: "Pat",
    isAdmin: true,
    administersOnly: true,
    seatOrder: 900,
  } as any);

  const realNames = ["Real oak table", "Real wedding ring", "Real shotgun"];
  const realIds: number[] = [];
  for (const name of realNames) {
    const it = await storage.createItem({
      name,
      room: "Living Room",
      category: "Furniture",
      notes: "",
      aiEstimatedValue: 100,
      estimateSource: "manual",
      photoUrl: null,
      thumbnailUrl: null,
    } as any);
    realIds.push(it.id);
  }

  // Real rankings, which practice must never read or overwrite.
  await storage.replaceRankings(alice.id, [
    { itemId: realIds[0], rank: 1 },
    { itemId: realIds[1], rank: 2 },
  ]);
  const realRankingsBefore = JSON.stringify(
    (await storage.listRankings(alice.id)).map((r) => [r.itemId, r.rank]),
  );

  const itemsBefore = (await storage.listItems()).filter((i) => !i.isPractice);
  check(
    "estate starts with the real items only",
    itemsBefore.length === 3,
    `${itemsBefore.length} items`,
  );

  /* ------------------------------------------- sample practice: what it uses */
  await storage.startPractice("sample_items", 2);
  const inPractice = await storage.getSession();
  check(
    "session records sample_items mode",
    inPractice.practiceMode === "sample_items",
    String(inPractice.practiceMode),
  );

  const all = await storage.listItems();
  const practiceItems = all.filter((i) => i.isPractice);
  const realItems = all.filter((i) => !i.isPractice);

  check(
    "ten sample items are seeded",
    practiceItems.length === PRACTICE_SAMPLE_ITEMS.length,
    `${practiceItems.length} seeded`,
  );
  check(
    "every sample item is flagged as practice",
    practiceItems.every((i) => i.isPractice === true),
  );
  check(
    "every sample item says in writing that it is pretend",
    practiceItems.every((i) => /pretend/i.test(i.notes ?? "")),
    practiceItems
      .map((i) => i.notes)
      .slice(0, 1)
      .join(""),
  );
  check(
    "the real items are untouched in number",
    realItems.length === 3,
    `${realItems.length} real items`,
  );
  check(
    "no real item was flagged as practice",
    realItems.every((i) => i.isPractice === false),
  );

  /* --------------------------- the pool the family actually picks from */
  /*
   * Reaching into the private pool on purpose.
   *
   * This is the single most important assertion in the file — it is literally
   * "what will the family be shown to pick from" — and there is no public
   * accessor for it. Testing it through a route would prove the same thing more
   * slowly and with more that could go wrong in between.
   */
  const pool: any[] = await (storage as any).rankablePool();
  check(
    "the picking pool contains only sample items",
    pool.length > 0 && pool.every((i) => i.isPractice === true),
    `${pool.length} in pool, ${pool.filter((i) => !i.isPractice).length} of them real`,
  );
  check(
    "no real item name is visible in the pool",
    !pool.some((i) => realNames.includes(i.name)),
    pool
      .filter((i) => realNames.includes(i.name))
      .map((i) => i.name)
      .join(", "),
  );
  check(
    "the pool is the sample list, by name",
    pool.every((i) => PRACTICE_SAMPLE_ITEMS.some((s) => s.name === i.name)),
  );

  /* -------------------------------------------- picking during practice */
  const state1 = await storage.practiceResults();
  check("a practice results summary is available while practising", !!state1);

  const first = pool[0];
  const order = JSON.parse((await storage.getSession()).practiceState!)
    .priorityOrder as number[];
  await storage.submitPracticePick(order[0], first.id);
  const practicePicks = (await storage.listPicks()).filter((p) => p.isPractice);
  check(
    "the practice pick is recorded as practice",
    practicePicks.length === 1 && practicePicks[0].isPractice === true,
  );
  check(
    "the practice pick does not count toward the real draft",
    practicePicks.every((p) => p.affectsRegularDraftCounter === false),
    JSON.stringify(practicePicks.map((p) => p.affectsRegularDraftCounter)),
  );

  const realPicks = (await storage.listPicks()).filter((p) => !p.isPractice);
  check(
    "no real pick was created",
    realPicks.length === 0,
    `${realPicks.length} real picks`,
  );

  /* ------------------------ real state must be exactly as it was left */
  const stillAvailable = (await storage.listItems())
    .filter((i) => !i.isPractice)
    .every(
      (i) => i.status === "available" && i.awardedToParticipantId === null,
    );
  check("no real item was awarded or reserved by practice", stillAvailable);

  /*
   * Rankings during a rehearsal are masked, not deleted.
   *
   * `listRankings` deliberately returns nothing while practice runs, so an heir
   * rehearsing sees a clean slate over the sample items instead of their real
   * order over the real estate. That is correct behaviour and worth pinning
   * down, because the obvious reading of an empty list is "practice wiped my
   * rankings" — so the check below proves the rows are still on disk, untouched,
   * the whole time.
   */
  check(
    "real rankings are hidden from the heir while practising",
    (await storage.listRankings(alice.id)).length === 0,
    `${(await storage.listRankings(alice.id)).length} returned`,
  );
  const onDisk = rawRankingRows();
  check(
    "but the real ranking rows are still on disk during practice",
    JSON.stringify(onDisk) === realRankingsBefore,
    JSON.stringify(onDisk),
  );

  /* ---------------------------------------------------- ending practice */
  await storage.endPractice();
  const after = await storage.listItems();
  const sessionAfter = await storage.getSession();
  check(
    "practice mode is switched off",
    sessionAfter.practiceMode === "off",
    String(sessionAfter.practiceMode),
  );
  check("practice state blob is cleared", sessionAfter.practiceState === null);
  check(
    "every sample item is deleted on end",
    after.filter((i) => i.isPractice).length === 0,
    `${after.filter((i) => i.isPractice).length} left behind`,
  );
  check(
    "all three real items survive",
    after.length === 3,
    `${after.length} items`,
  );
  check(
    "the real items are the same ones",
    realNames.every((n) => after.some((i) => i.name === n)),
  );
  check(
    "practice picks are deleted on end",
    (await storage.listPicks()).filter((p) => p.isPractice).length === 0,
  );
  check(
    "real rankings survive practice ending",
    JSON.stringify(
      (await storage.listRankings(alice.id)).map((r) => [r.itemId, r.rank]),
    ) === realRankingsBefore,
  );

  /* ------------------- a second rehearsal must not inherit the first */
  await storage.startPractice("sample_items", 2);
  const second = (await storage.listItems()).filter((i) => i.isPractice);
  check(
    "a second rehearsal seeds a clean set of ten",
    second.length === PRACTICE_SAMPLE_ITEMS.length,
    `${second.length} items`,
  );
  check(
    "no picks carry over into the second rehearsal",
    (await storage.listPicks()).filter((p) => p.isPractice).length === 0,
  );
  await storage.endPractice();

  /* --------------- placeholder heirs are pretend people, not real heirs */
  await storage.startPractice("sample_items", 5);
  const st = JSON.parse((await storage.getSession()).practiceState!);
  const placeholders = st.heirs.filter((h: any) => h.isPlaceholder);
  check(
    "a bigger rehearsal adds placeholder heirs",
    placeholders.length === 3,
    `${placeholders.length} placeholders`,
  );
  check(
    "placeholder heirs carry negative ids so they cannot collide with real ones",
    placeholders.every((h: any) => h.id < 0),
  );
  const rosterAfter = (await storage.listParticipants()).filter(
    (p) => !p.isAdmin,
  );
  check(
    "no placeholder heir was written into the real roster",
    rosterAfter.length === 2 && rosterAfter.every((h) => h.id > 0),
    `${rosterAfter.length} real heirs`,
  );
  await storage.endPractice();
  void bob;

  console.log(
    `\n${passed} checks passed${failures.length ? `, ${failures.length} FAILED` : ""}`,
  );
  if (failures.length) {
    console.log("\nFailures:\n" + failures.map((f) => "  - " + f).join("\n"));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
