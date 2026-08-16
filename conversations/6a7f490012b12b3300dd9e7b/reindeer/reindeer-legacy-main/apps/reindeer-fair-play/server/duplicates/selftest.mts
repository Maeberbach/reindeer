/**
 * Duplicate detection across every input source.
 *
 * The bug this locks down: the suite had three duplicate rules of three
 * different strengths, so "Grandpa's watch" and "Grandpa's pocket watch" were
 * flagged on the way in and then went invisible once live, because the standing
 * scan matched exact names only.
 *
 * Run with:  npx tsx server/duplicates/selftest.mts
 */
import "../testing/scratchEnv"; // MUST be first.
import assert from "node:assert/strict";

import { db, storage } from "../storage";
import { items, duplicateGroups } from "@shared/schema";
import { looksLikeSameThing, titleSimilarity, serialMatch } from "./match";
import { titleSimilarity as registrySimilarity } from "@legacy-suite/intake-feature/src/duplicates.js";

async function main() {
  let pass = 0;
  const fails: string[] = [];
  const check = async (name: string, fn: () => void | Promise<void>) => {
    try {
      await fn();
      pass++;
      console.log(`  \u2713 ${name}`);
    } catch (e: any) {
      fails.push(`${name} — ${e.message}`);
      console.log(`  \u2717 ${name}\n      ${String(e.message).split("\n")[0]}`);
    }
  };

  console.log("\nDuplicate detection across all input sources\n");

  /* ---------------------------------------------------------------- */
  console.log("1. The shared rule");
  await check("identical names match", () =>
    assert.equal(looksLikeSameThing({ name: "Oak dining chair" }, { name: "oak dining chair" }).reason, "exact_name"));
  await check("THE REGRESSION: a longer description of the same thing matches", () => {
    // Matches on shared words rather than containment: "pocket" sits in the
    // middle, so neither string contains the other. Either way it must match —
    // this is the case the standing scan used to miss entirely.
    const r = looksLikeSameThing({ name: "Grandpa's watch" }, { name: "Grandpa's pocket watch" });
    assert.equal(r.matched, true, "this is the case the standing scan used to miss");
    assert.equal(r.reason, "token_overlap");
  });
  await check("a name that literally contains the other matches on containment", () => {
    const r = looksLikeSameThing({ name: "Pocket watch" }, { name: "Pocket watch chain" });
    assert.equal(r.matched, true);
    assert.equal(r.reason, "name_contains");
  });
  await check("mostly-shared words match", () => {
    const r = looksLikeSameThing({ name: "blue ceramic serving bowl" }, { name: "ceramic serving bowl blue" });
    assert.equal(r.matched, true);
  });
  await check("a matching serial outranks a different name", () => {
    const r = looksLikeSameThing(
      { name: "Pocket watch", identifiers: '{"serial":"992B-4471"}' },
      { name: "Railroad timepiece", identifiers: '{"serial":"992B-4471"}' },
    );
    assert.equal(r.matched, true);
    assert.equal(r.reason, "serial_match");
  });
  await check("short words do not swallow longer ones", () =>
    assert.equal(looksLikeSameThing({ name: "Pin" }, { name: "Pincushion" }).matched, false));
  await check("genuinely different things do not match", () => {
    assert.equal(looksLikeSameThing({ name: "Oak dining chair" }, { name: "Brass floor lamp" }).matched, false);
    assert.equal(looksLikeSameThing({ name: "Pearl brooch" }, { name: "Cast iron skillet" }).matched, false);
  });
  await check("a trivially short serial is ignored", () =>
    assert.equal(serialMatch('{"serial":"1"}', '{"serial":"1"}'), false));

  /* ---------------------------------------------------------------- */
  console.log("\n2. The registry and Fair Choice agree on the same strings");
  const corpus: [string, string][] = [
    ["Grandpa's watch", "Grandpa's pocket watch"],
    ["Oak dining chair", "oak dining chair"],
    ["blue ceramic serving bowl", "ceramic serving bowl blue"],
    ["Oak dining chair", "Brass floor lamp"],
    ["Pin", "Pincushion"],
    ["Pearl brooch", "Cast iron skillet"],
  ];
  for (const [a, b] of corpus) {
    await check(`same verdict for "${a}" vs "${b}"`, () => {
      const fc = looksLikeSameThing({ name: a }, { name: b }).matched;
      const reg = registrySimilarity(a, b) >= 0.72;
      assert.equal(fc, reg, `Fair Choice said ${fc}, registry said ${reg}`);
    });
  }

  /* ---------------------------------------------------------------- */
  console.log("\n3. The standing scan is origin-blind");
  const session = await storage.getSession();
  const mk = (name: string, originApp: string | null, identifiers = "{}") =>
    db
      .insert(items)
      .values({
        sessionId: session.id,
        name,
        room: "Dining Room",
        notes: "",
        originApp,
        identifiers,
        status: "available",
      } as any)
      .returning()
      .get();

  // Four doors: registry import, hand-typed in Fair Choice, and two that
  // resemble each other only under the containment rule.
  const imported = mk("Grandpa's watch", "legacy_registry");
  const typed = mk("Grandpa's pocket watch", null);
  const lamp = mk("Brass floor lamp", "legacy_registry");
  const serialA = mk("Wall clock", null, '{"serial":"CK-77120"}');
  const serialB = mk("Mantel timepiece", "legacy_registry", '{"serial":"CK-77120"}');

  await storage.scanDuplicates();
  const after = db.select().from(items).all();
  const groupOf = (id: number) => after.find((i) => i.id === id)?.duplicateGroupId ?? null;

  await check("an imported item and a hand-typed item are grouped together", () => {
    assert.ok(groupOf(imported.id), "imported item was not grouped");
    assert.equal(groupOf(imported.id), groupOf(typed.id));
  });
  await check("the grouping crosses origins — one came from the registry, one did not", () => {
    const a = after.find((i) => i.id === imported.id)!;
    const b = after.find((i) => i.id === typed.id)!;
    assert.equal(a.originApp, "legacy_registry");
    assert.equal(b.originApp, null);
  });
  await check("two items with the same serial are grouped despite different names", () => {
    assert.ok(groupOf(serialA.id), "serial pair was not grouped");
    assert.equal(groupOf(serialA.id), groupOf(serialB.id));
  });
  await check("an unrelated item is left alone", () => assert.equal(groupOf(lamp.id), null));
  await check("nothing was deleted by the scan", () => assert.equal(after.length, 5));

  /* ---------------------------------------------------------------- */
  console.log("\n4. Per-item check, as run during AI evaluation");
  const fresh = mk("Brass floor lamp, tall", null);
  const perItem = await storage.scanDuplicatesForItem(fresh.id);

  await check("evaluating an item surfaces its duplicates", () => {
    assert.ok(perItem.matches.length >= 1, "expected the lamp to be matched");
    assert.ok(perItem.matches.some((m) => m.id === lamp.id));
  });
  await check("the match carries a plain-language reason", () => {
    const m = perItem.matches.find((x) => x.id === lamp.id)!;
    assert.ok(m.reason.length > 0, "no reason given");
    assert.doesNotMatch(m.reason, /token|overlap|_/, `jargon leaked: "${m.reason}"`);
  });
  await check("the per-item check groups them for review", () => assert.ok(perItem.groupId));
  await check("running it twice does not manufacture a second group", async () => {
    const before = db.select().from(duplicateGroups).all().length;
    const again = await storage.scanDuplicatesForItem(fresh.id);
    const now = db.select().from(duplicateGroups).all().length;
    assert.equal(now, before, "a repeat evaluation created a new group");
    assert.equal(again.groupId, perItem.groupId);
  });
  await check("it returns empty rather than throwing for an unknown item", async () => {
    const r = await storage.scanDuplicatesForItem(999999);
    assert.deepEqual(r, { matches: [], groupId: null });
  });

  /* ---------------------------------------------------------------- */
  console.log("\n5. Resolution stays a human decision");
  await check("a dismissed duplicate is excluded from later scans", async () => {
    const gid = groupOf(imported.id)!;
    await storage.resolveDuplicate(gid, imported.id, null);
    const rows = db.select().from(items).all();
    const kept = rows.find((i) => i.id === imported.id)!;
    const dismissed = rows.find((i) => i.id === typed.id)!;
    assert.equal(kept.status, "available", "the kept item must stay available");
    assert.equal(dismissed.status, "duplicate_dismissed");
    // Both rows still exist. Nothing is destroyed.
    assert.equal(rows.filter((i) => i.id === typed.id).length, 1);
  });
  await check("re-scanning does not re-raise a resolved pair", async () => {
    await storage.scanDuplicates();
    const rows = db.select().from(items).all();
    assert.equal(rows.find((i) => i.id === typed.id)!.duplicateGroupId, null);
  });

  console.log(`\n${pass} checks passed.`);
  if (fails.length) {
    console.log(`${fails.length} FAILED:`);
    fails.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
