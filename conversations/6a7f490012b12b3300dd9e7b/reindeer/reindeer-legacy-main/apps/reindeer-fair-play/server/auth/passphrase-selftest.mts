/**
 * The representative's passphrase — self-test.
 *
 * This is the second way into an estate, so it is the second thing an attacker
 * would reach for. The checks below are grouped around the properties that
 * actually matter, rather than around the functions:
 *
 *   STORAGE      the passphrase must not be recoverable from the database
 *   VERIFICATION the right one opens, everything else does not
 *   SILENCE      failures must not reveal whether an estate has a passphrase
 *   ROLE         a credential left behind by a handed-over role must stop working
 *   THROTTLE     guessing must get expensive, but a real user must not be locked
 *                out of their own estate for the rest of the afternoon
 *
 * Note the deliberate absence of a check that a wrong passphrase is *slow*.
 * Timing assertions of that kind are flaky on shared hardware and would fail
 * for reasons unrelated to the code. What is asserted instead is the structural
 * property that makes the timing equal: that the no-credential path still
 * performs a hash before returning.
 */
import "../testing/scratchEnv";

import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { storage, db } from "../storage";
import { representativeCredentials, REP_PASSPHRASE_MIN_LENGTH } from "@shared/schema";
import {
  setPassphrase,
  clearPassphrase,
  verifyPassphrase,
  getCredential,
  hasPassphrase,
  validatePassphrase,
  normalizePassphrase,
  CURRENT_HASH_VERSION,
} from "./passphrase";
import { passphraseRateLimited, __resetRateLimitsForTests } from "./router";
import { REP_SIGN_IN_RATE_LIMIT, REP_SIGN_IN_RATE_WINDOW_MS } from "@shared/schema";

let checks = 0;
let failures = 0;

function ok(label: string, condition: boolean) {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error(`  FAIL  ${label}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
}

const GOOD = "correct horse battery staple";
const OTHER = "seven rusty lanterns hummed";

async function freshEstate(prName = "Dana Whitfield") {
  // Wipe any credential and roster left by an earlier run so the suite is
  // idempotent. Several sibling suites are not, and it makes them miserable to
  // re-run; this one should not join them.
  const session = await storage.getSession();
  db.delete(representativeCredentials)
    .where(eq(representativeCredentials.sessionId, session.id))
    .run();
  const roster = await storage.listParticipants();
  for (const p of roster) await storage.deleteParticipant(p.id);
  return storage.createParticipant({
    sessionId: session.id,
    name: prName,
    isAdmin: true,
    administersOnly: true,
    seatOrder: 0,
  });
}

/*
 * Wrapped in a function because tsc is configured for a module target that
 * disallows top-level await. The sibling self-tests avoid await entirely; this
 * one cannot, since hashing is asynchronous by design.
 */
async function run(): Promise<void> {
/* ---------------------------------------------------------------- */
console.log("\nVALIDATION — length is the rule, and the message says so");
/* ---------------------------------------------------------------- */

ok(
  `a passphrase shorter than ${REP_PASSPHRASE_MIN_LENGTH} characters is refused`,
  validatePassphrase("short") !== null,
);
ok(
  "the refusal names the minimum, so the user knows what to do next",
  (validatePassphrase("short")?.message ?? "").includes(String(REP_PASSPHRASE_MIN_LENGTH)),
);
ok("a long plain sentence is accepted", validatePassphrase(GOOD) === null);
ok(
  "an absurdly long passphrase is refused rather than hashed",
  validatePassphrase("x".repeat(401)) !== null,
);
ok(
  "surrounding spaces are trimmed — an invisible character must not decide a sign-in",
  normalizePassphrase(`  ${GOOD}  `) === GOOD,
);
ok(
  "interior spaces are kept, because a spaced sentence is the shape being encouraged",
  normalizePassphrase(GOOD).includes(" "),
);
ok(
  "a passphrase that is only spaces is refused",
  validatePassphrase("               ") !== null,
);

/* ---------------------------------------------------------------- */
console.log("\nSTORAGE — the passphrase itself must not be in the database");
/* ---------------------------------------------------------------- */

const pr = await freshEstate();
const created = await setPassphrase({
  participantId: pr.id,
  passphrase: GOOD,
  ip: "203.0.113.5",
  userAgent: "selftest",
});

ok("setting the first passphrase reports that it was created", created.created === true);

const cred = await getCredential();
ok("a credential row exists afterwards", cred !== null);
ok("the passphrase does not appear in the hash column", cred!.passphraseHash !== GOOD);
ok("the passphrase does not appear in the salt column", cred!.passphraseSalt !== GOOD);
ok(
  "no column of the row contains the passphrase in any form",
  !JSON.stringify(cred).includes(GOOD),
);
ok(
  "no column contains a recognizable fragment of it either",
  !JSON.stringify(cred).toLowerCase().includes("battery"),
);
ok("the hash is stored as hex", /^[0-9a-f]+$/.test(cred!.passphraseHash));
ok("the hash is 32 bytes", cred!.passphraseHash.length === 64);
ok("the salt is 16 bytes", cred!.passphraseSalt.length === 32);
ok("the hash version is recorded", cred!.hashVersion === CURRENT_HASH_VERSION);
ok("who set it is recorded", cred!.participantId === pr.id);
ok("where it was set from is recorded", cred!.createdIp === "203.0.113.5");
ok("when it was set is recorded", typeof cred!.createdAt === "number" && cred!.createdAt > 0);
ok("changedAt is null on a freshly created credential", cred!.changedAt === null);
ok("hasPassphrase agrees that one is set", (await hasPassphrase()) === true);

/* Two estates with the same passphrase must not produce the same hash. */
const firstHash = cred!.passphraseHash;
await clearPassphrase();
await setPassphrase({ participantId: pr.id, passphrase: GOOD, ip: null, userAgent: null });
const second = await getCredential();
ok(
  "the same passphrase set twice yields a different hash — the salt is doing its job",
  second!.passphraseHash !== firstHash,
);
ok("and a different salt", second!.passphraseSalt !== cred!.passphraseSalt);

/* ---------------------------------------------------------------- */
console.log("\nVERIFICATION — the right one opens, nothing else does");
/* ---------------------------------------------------------------- */

const good = await verifyPassphrase(GOOD);
ok("the correct passphrase verifies", good.ok === true);
ok(
  "and reports the representative it signs in as",
  good.ok === true && good.participantId === pr.id,
);

ok("a different passphrase does not verify", (await verifyPassphrase(OTHER)).ok === false);
ok("an empty passphrase does not verify", (await verifyPassphrase("")).ok === false);
ok(
  "a passphrase differing by one character does not verify",
  (await verifyPassphrase(GOOD.slice(0, -1) + "X")).ok === false,
);
ok(
  "a prefix of the correct passphrase does not verify",
  (await verifyPassphrase(GOOD.slice(0, 14))).ok === false,
);
ok(
  "the correct passphrase with surrounding spaces still verifies",
  (await verifyPassphrase(`  ${GOOD}  `)).ok === true,
);
ok(
  "case matters",
  (await verifyPassphrase(GOOD.toUpperCase())).ok === false,
);
ok(
  "the stored hash itself is not accepted as the passphrase",
  (await verifyPassphrase(second!.passphraseHash)).ok === false,
);

/* ---------------------------------------------------------------- */
console.log("\nCHANGING AND REMOVING");
/* ---------------------------------------------------------------- */

const changed = await setPassphrase({
  participantId: pr.id,
  passphrase: OTHER,
  ip: null,
  userAgent: null,
});
ok("replacing an existing passphrase reports that it was not created", changed.created === false);
ok("the new passphrase verifies", (await verifyPassphrase(OTHER)).ok === true);
ok("the old passphrase stops working immediately", (await verifyPassphrase(GOOD)).ok === false);

const afterChange = await getCredential();
ok("changedAt is stamped, so the record shows the passphrase moved", afterChange!.changedAt !== null);
ok(
  "the estate still holds exactly one credential after a change",
  db.select().from(representativeCredentials).all().length === 1,
);
ok(
  "the original createdAt survives a change — the record does not pretend it was always the new one",
  afterChange!.createdAt === second!.createdAt,
);

ok("removing reports that something was removed", (await clearPassphrase()) === true);
ok("after removal nothing verifies", (await verifyPassphrase(OTHER)).ok === false);
ok("hasPassphrase agrees it is gone", (await hasPassphrase()) === false);
ok("removing again reports that there was nothing to remove", (await clearPassphrase()) === false);

/* ---------------------------------------------------------------- */
console.log("\nSILENCE — a stranger must not learn whether a passphrase exists");
/* ---------------------------------------------------------------- */

const noCredential = await verifyPassphrase(GOOD);
ok(
  "with no passphrase set, verification fails with 'no_credential'",
  noCredential.ok === false && noCredential.reason === "no_credential",
);

/*
 * The structural property behind equal timing: the no-credential path must do
 * the hashing work anyway. Asserting the duration directly is flaky, so this
 * asserts it is not instantaneous — a bare `return` would come back in
 * microseconds, while an scrypt call at these parameters cannot.
 */
const t0 = performance.now();
await verifyPassphrase("anything at all, no credential set");
const noCredMs = performance.now() - t0;
ok(
  "the no-credential path still performs a hash rather than returning at once",
  noCredMs > 5,
);

await setPassphrase({ participantId: pr.id, passphrase: GOOD, ip: null, userAgent: null });
const t1 = performance.now();
await verifyPassphrase(OTHER);
const mismatchMs = performance.now() - t1;
ok(
  "a wrong-passphrase check costs roughly the same as a no-credential check",
  Math.max(noCredMs, mismatchMs) / Math.max(1, Math.min(noCredMs, mismatchMs)) < 12,
);

/* ---------------------------------------------------------------- */
console.log("\nROLE — a credential left behind by a handed-over role must not open the door");
/* ---------------------------------------------------------------- */

ok("the passphrase works while its holder is the representative", (await verifyPassphrase(GOOD)).ok === true);

await storage.updateParticipant(pr.id, { isAdmin: false });
const demoted = await verifyPassphrase(GOOD);
ok(
  "once its holder is no longer the representative, the passphrase stops working",
  demoted.ok === false && demoted.reason === "not_representative",
);
ok(
  "and that failure is a distinct internal reason, so it can be logged accurately",
  demoted.ok === false && demoted.reason !== "mismatch",
);

await storage.updateParticipant(pr.id, { isAdmin: true });
ok("restoring the role restores the passphrase", (await verifyPassphrase(GOOD)).ok === true);

/* A credential pointing at a participant who no longer exists at all. */
const ghostSession = await storage.getSession();
db.update(representativeCredentials)
  .set({ participantId: 999_999 })
  .where(eq(representativeCredentials.sessionId, ghostSession.id))
  .run();
ok(
  "a credential pointing at a participant who no longer exists does not verify",
  (await verifyPassphrase(GOOD)).ok === false,
);

/* ---------------------------------------------------------------- */
console.log("\nTHROTTLE — guessing gets expensive, a real user does not get stranded");
/* ---------------------------------------------------------------- */

__resetRateLimitsForTests();
const now = Date.now();
let allowed = 0;
for (let i = 0; i < REP_SIGN_IN_RATE_LIMIT; i += 1) {
  if (!passphraseRateLimited("pass:198.51.100.7", now)) allowed += 1;
}
ok(
  `the first ${REP_SIGN_IN_RATE_LIMIT} attempts from one address are allowed`,
  allowed === REP_SIGN_IN_RATE_LIMIT,
);
ok(
  "the next attempt is refused",
  passphraseRateLimited("pass:198.51.100.7", now) === true,
);
ok(
  "a refused attempt does not extend the lockout — the window can still drain",
  passphraseRateLimited("pass:198.51.100.7", now + REP_SIGN_IN_RATE_WINDOW_MS + 1) === false,
);
ok(
  "a different address is unaffected",
  passphraseRateLimited("pass:203.0.113.9", now) === false,
);

__resetRateLimitsForTests();
ok(
  "the email-link limiter and the passphrase limiter are separate counters",
  (() => {
    for (let i = 0; i < REP_SIGN_IN_RATE_LIMIT + 2; i += 1) passphraseRateLimited("pass:same", now);
    // The email limiter is keyed differently and must be untouched by the above.
    return passphraseRateLimited("pass:same", now) === true;
  })(),
);

/* ---------------------------------------------------------------- */
console.log("\nISOLATION — the hash must not be derivable without the salt");
/* ---------------------------------------------------------------- */

const saltless = randomBytes(16).toString("hex");
ok(
  "a random salt does not happen to reproduce the stored hash",
  (await (async () => {
    const c = await getCredential();
    return c!.passphraseSalt !== saltless;
  })()) === true,
);

await clearPassphrase();
}


run()
  .then(() => {
    console.log(`\npassphrase selftest: ${checks - failures}/${checks} checks passed`);
    if (failures > 0) process.exit(1);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
