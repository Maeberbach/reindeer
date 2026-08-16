/**
 * `createAuthRouter()` — the authentication HTTP surface, mounted at
 * `/api/auth` BEFORE any deny-by-default gate (see server/routes.ts).
 *
 * Every route here reads `req.actor` (set by `attachActor`) for identity and
 * never trusts a client-supplied participant id.
 */
import { Router, type Request, type Response } from "express";
import { wrapRouterAsync } from "../asyncHandler";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { storage, db } from "../storage";
import { authSessions, estateTitle } from "@shared/schema";
import { eq } from "drizzle-orm";
import { issueToken } from "./tokens";
import {
  redeemToken,
  revokeSession,
  revokeAllForParticipant,
  listSessionsForParticipant,
  getSessionRow,
} from "./sessionStore";
import { setSessionCookie, clearSessionCookie } from "./cookies";
import { sendMagicLinkEmail } from "./mailer";
import { recordAuthEvent } from "./events";
import { requireAuth, requireCaptain } from "./middleware";
import {
  setPassphrase,
  clearPassphrase,
  verifyPassphrase,
  getCredential,
} from "./passphrase";
import { createBootstrapSession } from "./sessionStore";
import { CAPTAIN_PASSPHRASE_WRONG, CAPTAIN_SIGN_IN_RATE_LIMIT, CAPTAIN_SIGN_IN_RATE_WINDOW_MS } from "@shared/schema";

function clientIp(req: Request): string | null {
  return (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.ip ?? null;
}

/* ------------------------------------------------------------------ */
/* Rate limiting: 5 requests per 15 minutes, per email AND per IP.     */
/* In-memory is sufficient for this single-process app; if it ever    */
/* runs multi-process, this should move to the database or a shared   */
/* store, but the guarantee (no unbounded token issuance) matters more */
/* than the storage backend.                                          */
/* ------------------------------------------------------------------ */
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const attemptsByKey = new Map<string, number[]>();

/** Exported only so the self-test can drive it with a controlled clock. */
export function rateLimited(key: string, now: number = Date.now()): boolean {
  const recent = (attemptsByKey.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);

  if (recent.length >= RATE_LIMIT) {
    // Deliberately do NOT record this attempt. Counting refused attempts would
    // let someone extend their own lockout forever simply by trying again —
    // and trying again is exactly what a person does when they press a button
    // and nothing appears to happen. The window has to be able to drain.
    attemptsByKey.set(key, recent);
    return true;
  }

  recent.push(now);
  attemptsByKey.set(key, recent);
  return false;
}

/** Test-only: clear the in-memory counters between checks. */
export function __resetRateLimitsForTests(): void {
  attemptsByKey.clear();
  passphraseAttempts.clear();
}

/* ------------------------------------------------------------------ */
/* Passphrase sign-in is throttled separately from the email flow.     */
/* The two are different risks: asking for a link is harmless to the   */
/* asker and only costs mail, while a passphrase attempt is a guess.   */
/* Sharing one counter would let a few link requests use up the        */
/* representative's ability to sign in at all.                        */
/* ------------------------------------------------------------------ */
const passphraseAttempts = new Map<string, number[]>();

/** Exported so the self-test can drive it with a controlled clock. */
export function passphraseRateLimited(key: string, now: number = Date.now()): boolean {
  const recent = (passphraseAttempts.get(key) ?? []).filter(
    (t) => now - t < CAPTAIN_SIGN_IN_RATE_WINDOW_MS,
  );
  if (recent.length >= CAPTAIN_SIGN_IN_RATE_LIMIT) {
    // As with the email limiter: do not record a refused attempt, or the
    // window can never drain for someone who keeps pressing the button.
    passphraseAttempts.set(key, recent);
    return true;
  }
  recent.push(now);
  passphraseAttempts.set(key, recent);
  return false;
}

/** Cleared on a successful sign-in, so one forgotten passphrase does not lock out the rest of the day. */
function clearPassphraseAttempts(key: string): void {
  passphraseAttempts.delete(key);
}

/** The same generic response every time, whether or not the email matched — no account enumeration. */
const GENERIC_REQUEST_RESPONSE = {
  message:
    "If that email is on the estate's list, a sign-in link is on its way. Check your inbox in a minute or two.",
};

export function createAuthRouter(): Router {
  const router = Router();
  wrapRouterAsync(router);

  /* ---------- request a magic link ---------- */
  router.post("/request", async (req: Request, res: Response) => {
    try {
      const body = z.object({ email: z.string().min(1) }).parse(req.body ?? {});
      const email = body.email.trim().toLowerCase();
      const ip = clientIp(req);
      const userAgent = req.header("user-agent") ?? null;

      const ipLimited = rateLimited(`ip:${ip ?? "unknown"}`);
      const emailLimited = rateLimited(`email:${email}`);
      if (ipLimited || emailLimited) {
        await recordAuthEvent({
          participantId: null,
          kind: "rate_limited",
          detail: `request ip=${ip ?? "unknown"}`,
          ip,
          userAgent,
        });
        // Same generic response even when rate-limited — no signal leaks.
        return res.json(GENERIC_REQUEST_RESPONSE);
      }

      const participants = await storage.listParticipants();
      const match = participants.find((p) => (p.email ?? "").trim().toLowerCase() === email);

      if (match) {
        const session = await storage.getSession();
        const issued = await issueToken({
          sessionId: session.id,
          participantId: match.id,
          purpose: "magic_link",
          requestedIp: ip,
          requestedUserAgent: userAgent,
        });
        await recordAuthEvent({
          participantId: match.id,
          kind: "token_issued",
          detail: "magic_link",
          ip,
          userAgent,
        });
        const linkUrl = `${originOf(req)}/#/sign-in?token=${encodeURIComponent(issued.rawToken)}`;
        try {
          await sendMagicLinkEmail({
            to: email,
            participantName: match.name,
            estateTitle: estateTitle(session.estateName),
            linkUrl,
            shortCode: issued.shortCode,
            isInvite: false,
          });
        } catch (mailErr) {
          console.error("[auth] Magic link email delivery failed:", mailErr);
        }
      }
      // Identical response on match and non-match — no account enumeration.
      return res.json(GENERIC_REQUEST_RESPONSE);
    } catch (e) {
      fail(res, e);
    }
  });

  /* ---------- redeem a token or short code ---------- */
  router.post("/redeem", async (req: Request, res: Response) => {
    try {
      const body = z
        .object({ token: z.string().optional(), shortCode: z.string().optional() })
        .parse(req.body ?? {});
      if (!body.token && !body.shortCode) {
        return res.status(400).json({ message: "Enter the sign-in link or the 6-character code." });
      }
      const ip = clientIp(req);
      const userAgent = req.header("user-agent") ?? null;
      const outcome = await redeemToken(
        { rawToken: body.token, shortCode: body.shortCode },
        { ip, userAgent },
      );
      if (!outcome.ok) {
        const message =
          outcome.reason === "expired"
            ? "That link has expired. Please ask for a new one."
            : outcome.reason === "already_used"
              ? "That link has already been used. Please ask for a new one."
              : "That link isn't valid. Please check it or ask for a new one.";
        return res.status(400).json({ message });
      }
      setSessionCookie(res, outcome.rawSessionToken);
      res.json({ participant: outcome.participant, state: await storage.getClientState() });
    } catch (e) {
      fail(res, e);
    }
  });

  /* ---------- current participant ---------- */
  router.get("/me", requireAuth, async (req: Request, res: Response) => {
    res.json({ participant: req.actor });
  });

  /* ---------- sign out ---------- */
  router.post("/sign-out", async (req: Request, res: Response) => {
    if (req.authSessionRowId) {
      await revokeSession(req.authSessionRowId, req.actor?.id ?? null);
      await recordAuthEvent({
        participantId: req.actor?.id ?? null,
        kind: "sign_out",
        detail: "",
        ip: clientIp(req),
        userAgent: req.header("user-agent") ?? null,
      });
    }
    clearSessionCookie(res);
    res.json({ message: "You've been signed out." });
  });

  /* ---------- own devices ---------- */
  router.get("/sessions", requireAuth, async (req: Request, res: Response) => {
    const rows = await listSessionsForParticipant(req.actor!.id);
    res.json(
      rows.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        lastSeenAt: r.lastSeenAt,
        expiresAt: r.expiresAt,
        revokedAt: r.revokedAt,
        userAgent: r.userAgent,
        ip: r.ip,
        isCurrent: r.id === req.authSessionRowId,
      })),
    );
  });

  /**
   * The Captain sees where every participant is signed in,
   * so they can end a session on a heir's behalf (e.g. a lost or borrowed
   * device). captain-only — a participant's own devices come from GET /sessions.
   */
  router.get("/sessions/all", requireCaptain, async (req: Request, res: Response) => {
    const [rows, participants] = await Promise.all([
      db.select().from(authSessions).all(),
      storage.listParticipants(),
    ]);
    const nameOf = new Map(participants.map((p) => [p.id, p.name] as const));
    const sorted = rows.slice().sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    res.json(
      sorted.map((r) => ({
        id: r.id,
        participantId: r.participantId,
        participantName: nameOf.get(r.participantId) ?? "Unknown",
        createdAt: r.createdAt,
        lastSeenAt: r.lastSeenAt,
        expiresAt: r.expiresAt,
        revokedAt: r.revokedAt,
        userAgent: r.userAgent,
        ip: r.ip,
        isCurrent: r.id === req.authSessionRowId,
      })),
    );
  });

  /** A participant revokes their own device; the captain may revoke anyone's. */
  router.post("/sessions/:id/revoke", requireAuth, async (req: Request, res: Response) => {
    try {
      const sessionRowId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const row = await getSessionRow(sessionRowId);
      if (!row) return res.status(404).json({ message: "That device wasn't found." });
      if (!req.actor!.isAdmin && row.participantId !== req.actor!.id) {
        return res.status(403).json({ message: "You can only manage your own devices." });
      }
      const ok = await revokeSession(row.id, req.actor!.id);
      await recordAuthEvent({
        participantId: row.participantId,
        kind: "session_revoked",
        detail: `by=${req.actor!.id}`,
        ip: clientIp(req),
        userAgent: req.header("user-agent") ?? null,
      });
      res.json({ ok });
    } catch (e) {
      fail(res, e);
    }
  });

  /**
   * captain invites a specific heir: issues a link AND returns the short code so
   * it can be read out over the phone to someone with no usable email.
   */
  router.post("/participants/:id/invite", requireCaptain, async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (Number.isNaN(id)) return res.status(400).json({ message: "That heir wasn't found." });
      const participants = await storage.listParticipants();
      const target = participants.find((p) => p.id === id);
      if (!target) return res.status(404).json({ message: "That heir wasn't found." });

      const session = await storage.getSession();
      const ip = clientIp(req);
      const userAgent = req.header("user-agent") ?? null;
      const issued = await issueToken({
        sessionId: session.id,
        participantId: target.id,
        purpose: "invite",
        requestedIp: ip,
        requestedUserAgent: userAgent,
      });
      await recordAuthEvent({
        participantId: target.id,
        kind: "invite_issued",
        detail: `by=${req.actor!.id}`,
        ip,
        userAgent,
      });

      const linkUrl = `${originOf(req)}/#/sign-in?token=${encodeURIComponent(issued.rawToken)}`;
      let emailSent = false;
      if (target.email) {
        try {
          await sendMagicLinkEmail({
            to: target.email,
            participantName: target.name,
            estateTitle: estateTitle(session.estateName),
            linkUrl,
            shortCode: issued.shortCode,
            isInvite: true,
          });
          emailSent = true;
        } catch (mailErr) {
          console.error("[auth] Invite email delivery failed:", mailErr);
        }
      }

      // Returned to the captain so it can be read aloud to an heir with no email.
      res.json({
        participantId: target.id,
        shortCode: issued.shortCode,
        linkUrl,
        emailSent,
        expiresAt: issued.row.expiresAt,
      });
    } catch (e) {
      fail(res, e);
    }
  });

  /* ================================================================== */
  /* v12 — the representative's passphrase                              */
  /* ================================================================== */

  /**
   * Sign in as the Captain with a passphrase.
   *
   * Unauthenticated by necessity — this is a sign-in route, and the whole
   * /api/auth surface sits ahead of the deny-by-default gate. What keeps it
   * safe is that it grants nothing a passphrase does not already open: there
   * is no route anywhere that sets a passphrase without an existing
   * representative session, so this cannot be used to get into an estate that
   * has not already handed out a passphrase to somebody.
   *
   * Every failure — no passphrase set on this estate, wrong passphrase, or a
   * credential left behind by a handed-over role — returns the same message
   * and the same status. A stranger learns nothing about the estate.
   */
  router.post("/rep-sign-in", async (req: Request, res: Response) => {
    try {
      const body = z.object({ passphrase: z.string().min(1) }).parse(req.body ?? {});
      const ip = clientIp(req);
      const userAgent = req.header("user-agent") ?? null;
      const key = `pass:${ip ?? "unknown"}`;

      if (passphraseRateLimited(key)) {
        await recordAuthEvent({
          participantId: null,
          kind: "rate_limited",
          detail: `rep_sign_in ip=${ip ?? "unknown"}`,
          ip,
          userAgent,
        });
        return res.status(429).json({
          message:
            "Too many attempts. Please wait about fifteen minutes and try again, or ask for a sign-in link by email.",
        });
      }

      const result = await verifyPassphrase(body.passphrase);
      if (!result.ok) {
        await recordAuthEvent({
          participantId: null,
          kind: "sign_in_failed",
          detail: `captain_passphrase ${result.reason}`,
          ip,
          userAgent,
        });
        return res.status(401).json({ message: CAPTAIN_PASSPHRASE_WRONG });
      }

      clearPassphraseAttempts(key);
      const { rawSessionToken } = await createBootstrapSession(result.participantId, ip, userAgent);
      setSessionCookie(res, rawSessionToken);
      await recordAuthEvent({
        participantId: result.participantId,
        kind: "sign_in",
        detail: "captain_passphrase",
        ip,
        userAgent,
      });
      const participant = (await storage.listParticipants()).find(
        (p) => p.id === result.participantId,
      );
      res.json({ participant, state: await storage.getClientState() });
    } catch (e) {
      fail(res, e);
    }
  });

  /** Whether this estate has a representative passphrase, and when it was last set. captain-only. */
  router.get("/captain-passphrase", requireAuth, requireCaptain, async (_req: Request, res: Response) => {
    const credential = await getCredential();
    res.json({
      isSet: credential !== null,
      setAt: credential?.createdAt ?? null,
      changedAt: credential?.changedAt ?? null,
    });
  });

  /**
   * Set or replace the representative's passphrase.
   *
   * Requires an existing representative session, which is what removes any
   * race to claim an estate. Replacing signs the current device out of nothing
   * — existing sessions stay valid — because a passphrase change is not a
   * revocation. "Sign out everywhere" already exists for that.
   */
  router.put("/captain-passphrase", requireAuth, requireCaptain, async (req: Request, res: Response) => {
    try {
      const body = z.object({ passphrase: z.string().min(1) }).parse(req.body ?? {});
      const ip = clientIp(req);
      const userAgent = req.header("user-agent") ?? null;
      const { created } = await setPassphrase({
        participantId: req.actor!.id,
        passphrase: body.passphrase,
        ip,
        userAgent,
      });
      await recordAuthEvent({
        participantId: req.actor!.id,
        kind: created ? "passphrase_set" : "passphrase_changed",
        detail: "",
        ip,
        userAgent,
      });
      res.json({
        created,
        message: created
          ? "Passphrase saved. You can now sign in on another device with it."
          : "Passphrase changed. The old one no longer works.",
      });
    } catch (e) {
      fail(res, e);
    }
  });

  /** Remove the passphrase, returning the representative to email-only sign-in. */
  router.delete("/captain-passphrase", requireAuth, requireCaptain, async (req: Request, res: Response) => {
    try {
      const removed = await clearPassphrase();
      if (removed) {
        await recordAuthEvent({
          participantId: req.actor!.id,
          kind: "passphrase_removed",
          detail: "",
          ip: clientIp(req),
          userAgent: req.header("user-agent") ?? null,
        });
      }
      res.json({
        removed,
        message: removed
          ? "Passphrase removed. Signing in now needs a link emailed to you."
          : "There was no passphrase set.",
      });
    } catch (e) {
      fail(res, e);
    }
  });

  return router;
}

function originOf(req: Request): string {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? req.protocol;
  const host = req.header("host") ?? "localhost";
  return `${proto}://${host}`;
}

function fail(res: Response, e: any) {
  if (e?.issues) {
    const first = e.issues[0];
    return res
      .status(400)
      .json({ message: first ? String(first.message) : "That request wasn't valid." });
  }
  res.status(e?.status ?? 400).json({ message: e?.message ?? "That request didn't work. Please try again." });
}
