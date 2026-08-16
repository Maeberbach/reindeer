/**
 * Self-test for trustee-as-manager.
 *
 * A trustee is the fiduciary named by the trust or will. Under this model:
 *
 *   - A trustee is never an heir. They cannot draft, rank, receive items,
 *     or appear in equalization math.
 *   - A trustee MAY act as manager/referee of the game — running phases,
 *     resolving disputes — when the heirs need one.
 *   - A trustee may alternatively be listed for documentation only (via
 *     /api/session/trustee-name), never entering the app.
 *   - The trustee's authority comes from the will or trust, not from the
 *     app. Heirs do not grant or rescind it. See
 *     docs/specs/2026-08-08-captain-model.md for the full model that
 *     replaces the earlier "three configurations" framing.
 *
 * The invariants this file verifies:
 *
 *   1. Storage refuses to create a trustee with administersOnly=false.
 *   2. Storage refuses a second trustee on the same session.
 *   3. Storage refuses to promote an heir row into a trustee via patch.
 *   4. /api/session/trustee/invite is heir-admin-only.
 *   5. /api/session/trustee/take-over is trustee-only.
 *   6. /api/session/trustee/hand-back is trustee-only.
 *   7. take-over refuses when no trustee participant exists.
 *   8. take-over refuses when the trustee already holds the captain seat.
 *   9. hand-back refuses when the trustee does not hold the captain seat.
 *  10. hand-back refuses when called by an heir, even if isAdmin.
 *  11. Toggling take-over/hand-back moves session.captainParticipantId
 *      between the trustee row and the heir-admin row; there is no
 *      separate trusteeMode flag — trustee-in-charge is derived from
 *      captainParticipantId === trusteeParticipantId.
 *  12. The trustee never appears in draftParticipantCount.
 *  13. Inviting a second time returns the same trustee (idempotent).
 *  14. Any signed-in heir (not admin, not trustee) can flag any item as
 *      high-value. No approval required. This is a signal-and-safety-net
 *      flag, not a fiduciary act.
 *  15. The trustee can flag any item as high-value with the same endpoint.
 *      The item ends up needsAppraisal=true regardless of who pressed the button.
 *  16. When the trustee flags an item, the audit row records
 *      actorRole='trustee' — not 'heir', not 'captain'. This distinguishes
 *      trustee-recorded flags from heir-recorded flags in the RoD.
 *  17. transfer-pr no longer accepts mode='new_outside_pr'. The captain
 *      role can only be handed to another heir; outside oversight goes
 *      through the trustee, not through captain transfer. Old callers that
 *      send new_outside_pr get 400.
 *
 *  (Section 7 was removed 2026-08-08. It asserted the wrong model — that
 *  heirs could unilaterally rescind the trustee via /end-mode. That endpoint
 *  is gone. The trustee's authority is out-of-app; the in-app escape from
 *  a session that is not working is the Print Snapshot button, which is
 *  covered by its own section in a later revision.)
 *
 * Run with:  npx tsx server/trustee/selftest.mts
 *
 * Safe to run from anywhere: ../testing/scratchEnv redirects this run to a
 * throwaway database and upload directory before storage.ts is loaded.
 */
import "../testing/scratchEnv"; // MUST be first — ESM hoists imports.
import express from "express";
import { createServer } from "node:http";
import assert from "node:assert/strict";

import { registerRoutes } from "../routes";
import { storage, db } from "../storage";
import { highValueAuditLog, type HighValueAuditLogEntry } from "@shared/schema";
import { eq } from "drizzle-orm";
import { setMailerForTests } from "../auth/mailer";
import { RecordingMailer } from "@legacy-suite/delivery";

async function auditLogFor(itemId: number): Promise<HighValueAuditLogEntry[]> {
  return db.select().from(highValueAuditLog).where(eq(highValueAuditLog.itemId, itemId)).all();
}

let checks = 0;
let failures = 0;

function check(label: string, condition: boolean) {
  checks++;
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    failures++;
    console.log(`FAIL  - ${label}`);
  }
}

type Jar = { cookie: string | null };
function newJar(): Jar {
  return { cookie: null };
}

function extractTokenFromLink(linkUrl: string | null | undefined): string | null {
  if (!linkUrl) return null;
  const match = /token=([^&]+)/.exec(linkUrl);
  return match ? decodeURIComponent(match[1]) : null;
}

async function request(
  base: string,
  jar: Jar,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (jar.cookie) headers["cookie"] = jar.cookie;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) {
    const match = /fc_session=[^;]+/.exec(setCookie);
    if (match) jar.cookie = match[0];
    if (setCookie.includes("fc_session=;")) jar.cookie = null;
  }
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* not all responses are JSON */
  }
  return { status: res.status, json };
}

async function main() {
  const mailer = new RecordingMailer();
  setMailerForTests(mailer);

  const app = express();
  const httpServer = createServer(app);
  app.use(express.json({ limit: "5mb" }));
  app.use(express.urlencoded({ extended: false }));
  await registerRoutes(httpServer, app);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err?.status ?? 500).json({ message: err?.message ?? "Internal Server Error" });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;

  try {
    await runChecks(base, mailer);
  } finally {
    httpServer.close();
  }

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  if (failures > 0) process.exit(1);
}

async function runChecks(base: string, mailer: RecordingMailer) {
  /* ---------------------------------------------------------------- */
  /* 0. Bootstrap: heir-admin + a couple of heirs so draft count > 0  */
  /* ---------------------------------------------------------------- */
  console.log("\n0. Bootstrap the estate with heir-admin");

  const prJar = newJar();
  const welcome = await request(base, prJar, "POST", "/api/session/welcome", {
    prName: "Ari Admin",
    administersOnly: false,
    email: "ari@example.com",
  });
  check("welcome bootstrap succeeds", welcome.status === 200);
  const prId: number = welcome.json?.participant?.id;
  check("welcome bootstrap returns PR id", typeof prId === "number");

  await request(base, prJar, "POST", "/api/session/estate-name", {
    estateName: "Test Estate",
  });

  // Add two heirs so we have real drafters.
  const heir1 = await request(base, prJar, "POST", "/api/participants", {
    name: "Heir One",
    email: "one@example.com",
  });
  const heir2 = await request(base, prJar, "POST", "/api/participants", {
    name: "Heir Two",
    email: "two@example.com",
  });
  check("heirs created", heir1.status < 300 && heir2.status < 300);

  const rosterBefore = await storage.listParticipants();
  const drafterCountBefore = rosterBefore.filter(
    (p) => !p.administersOnly && p.role !== "trustee",
  ).length;
  check("three drafters before trustee (PR is not administers-only)", drafterCountBefore === 3);

  /* ---------------------------------------------------------------- */
  /* 1. Direct storage invariants                                      */
  /* ---------------------------------------------------------------- */
  console.log("\n1. Storage invariants");

  const s = await storage.getSession();

  // 1a. Trustee cannot be administersOnly:false.
  try {
    await storage.createParticipant({
      sessionId: s.id,
      name: "Bad Trustee",
      isAdmin: true,
      administersOnly: false,
      role: "trustee",
      email: "bad@example.com",
      seatOrder: 99,
    });
    check("createParticipant refuses trustee with administersOnly=false", false);
  } catch (e: any) {
    check(
      "createParticipant refuses trustee with administersOnly=false",
      /administers-only/i.test(e?.message ?? ""),
    );
  }

  // 1b. take-over refuses when no trustee participant exists yet.
  try {
    await storage.trusteeTakeOver(prId);
    check("trusteeTakeOver refuses when caller is not role=trustee", false);
  } catch (e: any) {
    check(
      "trusteeTakeOver refuses when caller is not role=trustee",
      /trustee/i.test(e?.message ?? ""),
    );
  }

  // 1c. hand-back refuses when trustee-mode is off.
  try {
    await storage.trusteeHandBack(prId);
    check("trusteeHandBack refuses when trustee-mode is off", false);
  } catch (e: any) {
    check(
      "trusteeHandBack refuses when trustee-mode is off",
      /not running/i.test(e?.message ?? ""),
    );
  }

  /* ---------------------------------------------------------------- */
  /* 2. Route: /api/session/trustee/invite                             */
  /* ---------------------------------------------------------------- */
  console.log("\n2. /api/session/trustee/invite");

  // 2a. Anonymous caller refused.
  const anon = newJar();
  const anonInvite = await request(base, anon, "POST", "/api/session/trustee/invite", {
    name: "Tiana Trustee",
    email: "tiana@example.com",
  });
  check("anonymous invite refused", anonInvite.status === 401);

  // 2b. Heir-admin can invite.
  const invite1 = await request(base, prJar, "POST", "/api/session/trustee/invite", {
    name: "Tiana Trustee",
    email: "tiana@example.com",
  });
  check("heir-admin can invite the trustee", invite1.status === 200);
  const trusteeId: number = invite1.json?.trustee?.id;
  check("invite returns a trustee id", typeof trusteeId === "number");
  check("invited trustee has role='trustee'", invite1.json?.trustee?.role === "trustee");
  check("invited trustee is administers-only", invite1.json?.trustee?.administersOnly === true);

  // 2c. Idempotent — a second invite returns the same trustee id.
  const invite2 = await request(base, prJar, "POST", "/api/session/trustee/invite", {
    name: "Tiana Trustee",
    email: "tiana@example.com",
  });
  check("second invite is idempotent (same trustee id)", invite2.json?.trustee?.id === trusteeId);

  // 2d. Session.trusteeName was recorded.
  const sessionAfterInvite = await storage.getSession();
  check(
    "session.trusteeName recorded from invite",
    (sessionAfterInvite.trusteeName ?? "").trim() === "Tiana Trustee",
  );

  // 2e. Trustee does not count as a drafter.
  const rosterWithTrustee = await storage.listParticipants();
  const drafterCountAfter = rosterWithTrustee.filter(
    (p) => !p.administersOnly && p.role !== "trustee",
  ).length;
  check(
    "trustee does not count as a drafter (draft count unchanged)",
    drafterCountAfter === drafterCountBefore,
  );

  /* ---------------------------------------------------------------- */
  /* 3. Trustee logs in via magic link                                  */
  /* ---------------------------------------------------------------- */
  console.log("\n3. Trustee login via magic link");

  const trusteeJar = newJar();
  const trusteeInvite = await request(
    base,
    prJar,
    "POST",
    `/api/auth/participants/${trusteeId}/invite`,
    {},
  );
  check("PR can issue magic link to the trustee", trusteeInvite.status === 200);
  const trusteeToken = extractTokenFromLink(trusteeInvite.json?.linkUrl);
  check("magic link contains a token", typeof trusteeToken === "string" && trusteeToken!.length > 20);
  const redeemed = await request(base, trusteeJar, "POST", "/api/auth/redeem", {
    token: trusteeToken,
  });
  check("trustee redeems magic link", redeemed.status === 200);
  check("trustee is signed in via cookie", trusteeJar.cookie !== null);

  // Confirm /api/auth/me sees role=trustee.
  const me = await request(base, trusteeJar, "GET", "/api/auth/me");
  check("auth/me returns role='trustee' for the trustee", me.json?.participant?.role === "trustee");

  /* ---------------------------------------------------------------- */
  /* 4. take-over and hand-back gates                                   */
  /* ---------------------------------------------------------------- */
  console.log("\n4. take-over and hand-back gates");

  // 4a. Heir-admin cannot take over.
  const prTakeOver = await request(base, prJar, "POST", "/api/session/trustee/take-over", {});
  check("heir-admin refused from take-over (403)", prTakeOver.status === 403);

  // 4b. Trustee can take over.
  const takeOver = await request(base, trusteeJar, "POST", "/api/session/trustee/take-over", {});
  check("trustee can take over", takeOver.status === 200);
  check(
    "session.captainParticipantId points to the trustee after take-over",
    takeOver.json?.captainParticipantId === trusteeId,
  );
  check(
    "session.trusteeParticipantId points to the trustee",
    takeOver.json?.trusteeParticipantId === trusteeId,
  );

  // 4c. Second take-over refused (already on).
  const takeOver2 = await request(base, trusteeJar, "POST", "/api/session/trustee/take-over", {});
  check("second take-over refused when already on", takeOver2.status === 409);

  // 4d. Heir-admin cannot hand back.
  const prHandBack = await request(base, prJar, "POST", "/api/session/trustee/hand-back", {});
  check("heir-admin refused from hand-back (403)", prHandBack.status === 403);

  // 4e. Trustee can hand back.
  const handBack = await request(base, trusteeJar, "POST", "/api/session/trustee/hand-back", {});
  check("trustee can hand back", handBack.status === 200);
  check(
    "session.captainParticipantId is no longer the trustee after hand-back",
    handBack.json?.captainParticipantId !== trusteeId,
  );
  check(
    "session.trusteeParticipantId is cleared after hand-back",
    handBack.json?.trusteeParticipantId === null,
  );

  // 4f. Second hand-back refused (trustee no longer captain).
  const handBack2 = await request(base, trusteeJar, "POST", "/api/session/trustee/hand-back", {});
  check("second hand-back refused when trustee is not captain", handBack2.status === 409);

  // 4g. Trustee is still in the roster after hand-back (they can take over again later).
  const rosterAfterHandBack = await storage.listParticipants();
  check(
    "trustee row remains in roster after hand-back",
    rosterAfterHandBack.some((p) => p.id === trusteeId && p.role === "trustee"),
  );

  // 4h. Trustee can take over again after hand-back.
  const takeOverAgain = await request(base, trusteeJar, "POST", "/api/session/trustee/take-over", {});
  check("trustee can take over again after hand-back", takeOverAgain.status === 200);
  check(
    "session.captainParticipantId points to the trustee again",
    takeOverAgain.json?.captainParticipantId === trusteeId,
  );

  /* ---------------------------------------------------------------- */
  /* 5. High-value flag is open to anyone signed in                    */
  /*    ("No boss. There is a referee/captain." — any heir can flag,   */
  /*    the trustee can flag, both are equal signals; no approval.)    */
  /* ---------------------------------------------------------------- */
  console.log("\n5. Any heir can flag high-value; trustee can flag; audit records the role");

  // Create a plain item to flag.
  const item = await storage.createItem({
    name: "Selftest Table Lamp",
    room: "Living Room",
  } as any);
  check("item starts not-high-value", item.needsAppraisal === false);

  // Sign in Heir One as an ordinary heir (not admin, not trustee).
  const heirJar = newJar();
  const heirId: number = heir1.json?.id;
  const heirInvite = await request(
    base,
    prJar,
    "POST",
    `/api/auth/participants/${heirId}/invite`,
    {},
  );
  check("heir-admin can issue magic link to ordinary heir", heirInvite.status === 200);
  const heirToken = extractTokenFromLink(heirInvite.json?.linkUrl);
  const heirLogin = await request(base, heirJar, "POST", "/api/auth/redeem", { token: heirToken });
  check("ordinary heir redeems magic link", heirLogin.status === 200);

  // 5a. Ordinary heir CAN flag an item high-value. No approval required.
  const heirFlag = await request(
    base,
    heirJar,
    "POST",
    `/api/fiduciary/items/${item.id}/flag-high-value`,
    { reason: "Grandma's — feels valuable" },
  );
  check("ordinary heir can flag high-value (200)", heirFlag.status === 200);
  check("item is now high-value after heir flag", heirFlag.json?.needsAppraisal === true);

  // 5b. The audit row for the heir flag records actorRole='heir'.
  const auditAfterHeir = await auditLogFor(item.id);
  const heirFlagRow = auditAfterHeir.find(
    (r) => r.eventType === "flagged" && r.actorParticipantId === heirId,
  );
  check("audit row exists for heir flag", !!heirFlagRow);
  check("audit row records actorRole='heir' for heir flag", heirFlagRow?.actorRole === "heir");

  // 5c. Trustee CAN also flag an item high-value on the same endpoint.
  //     (Create a second plain item so we can see the trustee's own audit row.)
  const item2 = await storage.createItem({
    name: "Selftest Sideboard",
    room: "Dining Room",
  } as any);
  const trusteeFlag = await request(
    base,
    trusteeJar,
    "POST",
    `/api/fiduciary/items/${item2.id}/flag-high-value`,
    { reason: "Insurance schedule item" },
  );
  check("trustee can flag high-value (200)", trusteeFlag.status === 200);
  check("item2 is now high-value after trustee flag", trusteeFlag.json?.needsAppraisal === true);

  // 5d. The audit row for the trustee flag records actorRole='trustee'.
  const auditAfterTrustee = await auditLogFor(item2.id);
  const trusteeFlagRow = auditAfterTrustee.find(
    (r) => r.eventType === "flagged" && r.actorParticipantId === trusteeId,
  );
  check("audit row exists for trustee flag", !!trusteeFlagRow);
  check(
    "audit row records actorRole='trustee' for trustee flag (not 'heir', not 'captain')",
    trusteeFlagRow?.actorRole === "trustee",
  );

  /* ---------------------------------------------------------------- */
  /* 6. Captain transfer no longer accepts new_outside_pr             */
  /* ---------------------------------------------------------------- */
  console.log("\n6. transfer-pr rejects new_outside_pr mode");

  // 6a. Old client sending mode=new_outside_pr gets a 400 zod refusal.
  //     Trustee-mode is currently ON; hand back to heir-admin first so the
  //     transfer-pr endpoint is exercised against an heir-run session.
  await request(base, trusteeJar, "POST", "/api/session/trustee/hand-back", {});
  //     transfer-pr requires registration to be closed — close it now so we
  //     exercise the enum-refusal path rather than the pre-registration guard.
  await request(base, prJar, "POST", "/api/session/close-registration", {});
  const legacyOutsideTransfer = await request(base, prJar, "POST", "/api/session/transfer-pr", {
    mode: "new_outside_pr",
    newPrData: { name: "Some Outside Person", email: null, phone: null },
    confirmationName: "Ari Admin",
  });
  check(
    "transfer-pr refuses mode='new_outside_pr' (400)",
    legacyOutsideTransfer.status === 400,
  );

  /* ---------------------------------------------------------------- */
  /* 7. (removed) end-mode was a wrong model; see docs/specs/          */
  /*    2026-08-08-captain-model.md. Trustee mode ends via hand-back   */
  /*    only. Heirs' escape is the Print Snapshot path plus the        */
  /*    trustee's out-of-app authority — not an in-app veto.           */
  /* ---------------------------------------------------------------- */
}

main().catch((e) => {
  console.error("selftest crashed:", e);
  process.exit(1);
});
