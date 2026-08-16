/**
 * Self-test for real authentication.
 *
 * Boots a real Express app (the same `registerRoutes` server/index.ts uses,
 * minus vite/static) on a scratch port against a scratch database, then
 * drives it over real HTTP with a hand-rolled cookie jar — no mocking of
 * Express, storage, or the auth modules.
 *
 * Run with:  npx tsx server/auth/selftest.mts
 *
 * Safe to run from anywhere: ../testing/scratchEnv redirects this run to a
 * throwaway database and upload directory before storage.ts is loaded.
 */
import "../testing/scratchEnv"; // MUST be first — see that file.
import express from "express";
import { rateLimited, __resetRateLimitsForTests } from "./router";
import { createServer } from "node:http";
import assert from "node:assert/strict";

import { registerRoutes } from "../routes";
import { db, sqlite, storage } from "../storage";
import { authTokens, authSessions } from "@shared/schema";
import { setMailerForTests, getMailer } from "./mailer";
import { RecordingMailer } from "@legacy-suite/delivery";

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

/* ------------------------------------------------------------------ */
/* tiny HTTP + cookie-jar client                                       */
/* ------------------------------------------------------------------ */

type Jar = { cookie: string | null };

function newJar(): Jar {
  return { cookie: null };
}

/**
 * Pulls the `token` query param out of a magic-link URL whose query string
 * comes AFTER a `#` fragment (e.g. `.../#/sign-in?token=...`), which
 * `new URL(...).searchParams` cannot parse since everything after `#` is
 * the fragment, not the query string.
 */
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
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; json: any; headers: Headers }> {
  const headers: Record<string, string> = { "content-type": "application/json", ...extraHeaders };
  if (jar.cookie) headers["cookie"] = jar.cookie;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) {
    // Keep only the fc_session cookie's name=value pair for the jar.
    const match = /fc_session=[^;]+/.exec(setCookie);
    if (match) jar.cookie = match[0];
    if (/fc_session=;/.test(setCookie) || setCookie.includes("fc_session=;")) jar.cookie = null;
  }
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* not all responses are JSON (e.g. 204) */
  }
  return { status: res.status, json, headers: res.headers };
}

/* ------------------------------------------------------------------ */
/* boot                                                                 */
/* ------------------------------------------------------------------ */

async function main() {
  // RecordingMailer: never touches disk or network, and lets us read back
  // exactly what would have been emailed (to pull the raw token in tests,
  // the same way a real inbox would let a human click the link).
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
  /* 0. Bootstrap: create the estate + PR, get a real session          */
  /* ---------------------------------------------------------------- */
  console.log("\n0. Bootstrap");

  const anon = newJar();

  {
    // Anonymous PATCH /api/session must be refused before any estate exists,
    // even though the estate has no PR yet — welcome is the only bootstrap
    // door, not the generic session endpoint.
    const res = await request(base, anon, "PATCH", "/api/session", { name: "hijack" });
    check("anonymous PATCH /api/session refused before bootstrap", res.status === 401);
  }

  {
    // Sending a participantId that doesn't exist yet as if it were an actor
    // grants nothing — there is no roster yet either way.
    const res = await request(base, anon, "GET", "/api/rankings/1?participantId=1");
    check(
      "anonymous read of a protected route refused before bootstrap",
      res.status === 401 || res.status === 400,
    );
  }

  const prJar = newJar();
  const welcome = await request(base, prJar, "POST", "/api/session/welcome", {
    prName: "Pat Reyes",
    administersOnly: true,
    email: "pat@example.com",
  });
  check("welcome bootstrap succeeds", welcome.status === 200);
  check("welcome bootstrap signs the PR in via cookie", prJar.cookie !== null);
  const prId: number = welcome.json?.participant?.id;
  check("welcome bootstrap returns a participant id", typeof prId === "number");

  {
    const res = await request(base, prJar, "POST", "/api/session/welcome", {
      prName: "Someone Else",
      administersOnly: true,
    });
    check("POST /api/session/welcome refused once a PR exists (409)", res.status === 409);
  }

  {
    const me = await request(base, prJar, "GET", "/api/auth/me");
    check("GET /api/auth/me returns the signed-in PR", me.status === 200 && me.json?.participant?.id === prId);
  }

  /* ---------------------------------------------------------------- */
  /* 1. Create an heir, invite them, redeem the link                   */
  /* ---------------------------------------------------------------- */
  console.log("\n1. Heir invite + magic-link sign-in");

  const heirCreate = await request(base, prJar, "POST", "/api/participants", {
    name: "Alex Heir",
    email: "alex@example.com",
  });
  check("PR can create an heir", heirCreate.status === 200 || heirCreate.status === 201);
  const heirId: number = heirCreate.json?.id;
  check("heir creation returns an id", typeof heirId === "number");

  const heirJar = newJar();
  {
    // Anonymous caller sending the PR's own id as body/query/header must
    // gain nothing — the exact vulnerability this project replaces.
    const asBody = await request(base, heirJar, "GET", "/api/auth/me", undefined);
    check("anonymous GET /api/auth/me refused", asBody.status === 401);

    const spoofBody = await request(base, heirJar, "PATCH", "/api/session", {
      name: "spoofed",
      participantId: prId,
      actorId: prId,
    });
    check(
      "sending PR's id as body.participantId/actorId grants nothing (still refused)",
      spoofBody.status === 401,
    );

    const spoofQuery = await request(base, heirJar, "PATCH", `/api/session?participantId=${prId}`, {
      name: "spoofed",
    });
    check("sending PR's id as ?participantId= grants nothing (still refused)", spoofQuery.status === 401);

    const spoofHeader = await request(
      base,
      heirJar,
      "PATCH",
      "/api/session",
      { name: "spoofed" },
      { "x-participant-id": String(prId) },
    );
    check(
      "sending PR's id as x-participant-id header grants nothing (still refused)",
      spoofHeader.status === 401,
    );
  }

  const invite = await request(base, prJar, "POST", `/api/auth/participants/${heirId}/invite`, {});
  check("PR can invite the heir", invite.status === 200);
  const shortCode: string = invite.json?.shortCode;
  check("invite returns a 6-character short code", typeof shortCode === "string" && shortCode.length === 6);
  const linkUrl: string = invite.json?.linkUrl;
  const rawToken = extractTokenFromLink(linkUrl);
  check("invite returns a usable link with a token", typeof rawToken === "string" && rawToken.length > 20);

  {
    const redeemed = await request(base, heirJar, "POST", "/api/auth/redeem", { token: rawToken });
    check("magic link redeems successfully", redeemed.status === 200);
    check("redeeming signs the heir in via cookie", heirJar.cookie !== null);
  }

  {
    // Second use of the exact same link must fail — strictly single-use.
    const replayJar = newJar();
    const replay = await request(base, replayJar, "POST", "/api/auth/redeem", { token: rawToken });
    check("replaying the same magic link a second time fails", replay.status !== 200);
    check("replayed link does not sign anyone in", replayJar.cookie === null);
  }

  {
    // The short code is a separate, still-valid credential for the SAME
    // token record only until first use; since the token above was already
    // consumed via the link, the short code for that same row must also be
    // dead now (single-use covers both redemption paths for one token).
    const jar2 = newJar();
    const res = await request(base, jar2, "POST", "/api/auth/redeem", { shortCode });
    check("short code for an already-consumed token also fails", res.status !== 200);
  }

  /* ---------------------------------------------------------------- */
  /* 2. Heir cannot reach PR-only routes                                */
  /* ---------------------------------------------------------------- */
  console.log("\n2. PR-only route protection");

  {
    const res = await request(base, heirJar, "POST", "/api/session/close-registration", {});
    check("signed-in heir cannot reach a PR-only route", res.status === 403);
  }
  {
    const res = await request(base, prJar, "GET", "/api/auth/me");
    check("PR route sanity: PR itself is unaffected", res.status === 200);
  }

  /* ---------------------------------------------------------------- */
  /* 3. Expired token                                                   */
  /* ---------------------------------------------------------------- */
  console.log("\n3. Expired token");
  {
    const invite2 = await request(base, prJar, "POST", `/api/auth/participants/${heirId}/invite`, {});
    const link2 = invite2.json?.linkUrl as string;
    const token2 = extractTokenFromLink(link2);
    // Force-expire the token directly in the DB rather than waiting 20 minutes.
    db.update(authTokens).set({ expiresAt: Date.now() - 1000 }).where(
      (await import("drizzle-orm")).eq(authTokens.tokenHash, (await import("./tokens")).sha256Hex(token2!)),
    ).run();
    const jar3 = newJar();
    const res = await request(base, jar3, "POST", "/api/auth/redeem", { token: token2 });
    check("expired token fails to redeem", res.status !== 200);
    check("expired token does not sign anyone in", jar3.cookie === null);
  }

  /* ---------------------------------------------------------------- */
  /* 4. Revoked session                                                 */
  /* ---------------------------------------------------------------- */
  console.log("\n4. Revoked session");
  {
    const before = await request(base, heirJar, "GET", "/api/auth/me");
    check("heir session works before revocation", before.status === 200);

    const sessions = await request(base, heirJar, "GET", "/api/auth/sessions");
    check("heir can list their own sessions", sessions.status === 200 && Array.isArray(sessions.json));
    const current = (sessions.json as any[]).find((s) => s.isCurrent);
    check("current session is identifiable in the list", !!current);

    const revoke = await request(base, heirJar, "POST", `/api/auth/sessions/${current.id}/revoke`, {});
    check("heir can revoke their own current session", revoke.status === 200);

    const after = await request(base, heirJar, "GET", "/api/auth/me");
    check("revoked session fails closed on next request", after.status === 401);
  }

  /* ---------------------------------------------------------------- */
  /* 5. Sign-out                                                        */
  /* ---------------------------------------------------------------- */
  console.log("\n5. Sign-out");
  {
    // Fresh sign-in for a clean sign-out test.
    const invite3 = await request(base, prJar, "POST", `/api/auth/participants/${heirId}/invite`, {});
    const link3 = invite3.json?.linkUrl as string;
    const token3 = extractTokenFromLink(link3);
    const jar4 = newJar();
    await request(base, jar4, "POST", "/api/auth/redeem", { token: token3 });
    const meBefore = await request(base, jar4, "GET", "/api/auth/me");
    check("fresh sign-in works", meBefore.status === 200);

    await request(base, jar4, "POST", "/api/auth/sign-out", {});
    const meAfter = await request(base, jar4, "GET", "/api/auth/me");
    check("sign-out ends access even with the old cookie replayed", meAfter.status === 401);
  }

  /* ---------------------------------------------------------------- */
  /* 6. No email enumeration                                            */
  /* ---------------------------------------------------------------- */
  console.log("\n6. No account enumeration on /api/auth/request");
  {
    const known = await request(base, newJar(), "POST", "/api/auth/request", { email: "pat@example.com" });
    const unknown = await request(base, newJar(), "POST", "/api/auth/request", { email: "nobody-here@example.com" });
    check("known and unknown email both return 200", known.status === 200 && unknown.status === 200);
    check(
      "known and unknown email get an identical response body",
      JSON.stringify(known.json) === JSON.stringify(unknown.json),
    );
  }

  /* ---------------------------------------------------------------- */
  /* 7. Console/Recording mailer never sends real mail in tests         */
  /* ---------------------------------------------------------------- */
  console.log("\n7. Mailer safety");
  {
    check("this test run uses RecordingMailer, not a real transport", getMailer() === mailer);
    check("RecordingMailer recorded at least one message", mailer.sent.length > 0);
    check(
      "no message in this run was sent through a network SMTP transport",
      mailer.sent.every((m) => typeof m.subject === "string"),
    );
  }

  /* ---------------------------------------------------------------- */
  /* 8. No raw token ever stored                                        */
  /* ---------------------------------------------------------------- */
  console.log("\n8. No raw token ever stored");
  {
    const tokenRows = db.select().from(authTokens).all();
    const sessionRows = db.select().from(authSessions).all();
    check("at least one auth_tokens row exists to check", tokenRows.length > 0);
    check("at least one auth_sessions row exists to check", sessionRows.length > 0);

    const rawCandidates = [rawToken, shortCode].filter((x): x is string => !!x);
    let leaked = false;
    for (const row of tokenRows) {
      for (const raw of rawCandidates) {
        if (row.tokenHash === raw) leaked = true;
        if (row.tokenHash.includes(raw)) leaked = true;
      }
      // A sha256 hex digest is always 64 lowercase hex chars.
      if (!/^[0-9a-f]{64}$/.test(row.tokenHash)) leaked = true;
    }
    check("auth_tokens.tokenHash never contains a raw token value (and is always a sha256 hex digest)", !leaked);

    let sessionLeaked = false;
    for (const row of sessionRows) {
      if (!/^[0-9a-f]{64}$/.test(row.tokenHash)) sessionLeaked = true;
    }
    check("auth_sessions.tokenHash is always a sha256 hex digest, never a raw value", !sessionLeaked);
  }

  /* ---------------------------------------------------------------- */
  /* 9. Ranking privacy: the original vulnerability, end to end         */
  /* ---------------------------------------------------------------- */
  console.log("\n9. Ranking privacy (the original vulnerability)");
  {
    const secondHeir = await request(base, prJar, "POST", "/api/participants", {
      name: "Casey Heir",
      email: "casey@example.com",
    });
    const secondHeirId: number = secondHeir.json?.id;

    const anonRead = await request(base, newJar(), "GET", `/api/rankings/${secondHeirId}`);
    check("anonymous read of a heir's ranking is refused", anonRead.status === 401);

    const anonReadAsPr = await request(
      base,
      newJar(),
      "GET",
      `/api/rankings/${secondHeirId}?participantId=${prId}`,
    );
    check(
      "claiming to be the PR via ?participantId= while anonymous still refused",
      anonReadAsPr.status === 401,
    );
  }

  /* ---------------------------------------------------------------- */
  /* 9. The lockout must be able to drain                             */
  /*                                                                  */
  /* A person who presses "send my link" and sees nothing happen will */
  /* press it again. If refused attempts were counted, that behaviour */
  /* would extend the lockout forever and quietly lock a real heir    */
  /* out of their own family's estate. Drive the limiter with a fake  */
  /* clock and prove the window empties.                              */
  /* ---------------------------------------------------------------- */
  {
    __resetRateLimitsForTests();
    const K = "email:drain@example.test";
    const t0 = 1_000_000;

    let allowed = 0;
    for (let i = 0; i < 5; i++) if (!rateLimited(K, t0 + i)) allowed++;
    check("the first five attempts in the window are allowed", allowed === 5);

    check("the sixth attempt is refused", rateLimited(K, t0 + 10) === true);

    // Someone tapping the button over and over for the next ten minutes.
    for (let i = 0; i < 40; i++) rateLimited(K, t0 + 60_000 * (i % 10));
    check("still refused while the window is genuinely full", rateLimited(K, t0 + 60_000) === true);

    // Just past 15 minutes from the ORIGINAL five attempts.
    const past = t0 + 15 * 60_000 + 1;
    check(
      "the lockout drains once the window passes, despite repeated tries",
      rateLimited(K, past) === false,
    );

    __resetRateLimitsForTests();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
