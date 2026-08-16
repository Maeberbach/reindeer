/**
 * Express middleware for the real authentication model.
 *
 * The one rule that matters: identity comes ONLY from the signed session
 * cookie. `attachActor` never looks at the request body, query string, or
 * `x-participant-id` header — that was the vulnerability. Every other guard
 * in this file, and every route handler downstream, reads `req.actor` and
 * nothing else.
 */
import type { Request, Response, NextFunction } from "express";
import { lookupSession, touchSession } from "./sessionStore";
import { readSignedSessionCookie, COOKIE_NAME } from "./cookies";
import type { Participant } from "@shared/schema";
import { SIGN_IN_REQUIRED_MESSAGE, CAPTAIN_ONLY_MESSAGE } from "@shared/schema";

declare global {
  namespace Express {
    interface Request {
      /** The signed-in participant, resolved ONLY from the session cookie. Null if signed out. */
      actor?: Participant | null;
      /** The internal auth_sessions row id backing req.actor, when signed in. */
      authSessionRowId?: string | null;
    }
  }
}

/**
 * Resolves `req.actor` strictly from the signed session cookie. Ignores
 * `req.body.participantId`, `req.body.actorId`, `x-participant-id`, and
 * `?participantId=` completely — those are the exploited paths and must
 * never again influence who the server thinks is acting.
 */
export async function attachActor(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const raw = readSignedSessionCookie(req);
    const found = await lookupSession(raw);
    if (!found) {
      req.actor = null;
      req.authSessionRowId = null;
      return next();
    }
    req.actor = found.participant;
    req.authSessionRowId = found.session.id;
    // Sliding expiry: every authenticated request pushes expiry forward.
    void touchSession(found.session.id);
    next();
  } catch (e) {
    next(e);
  }
}

/** 401 with a plain-language message when there is no valid session. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.actor) {
    res.status(401).json({ message: SIGN_IN_REQUIRED_MESSAGE });
    return;
  }
  next();
}

/**
 * 403 unless the actor is the Captain. Fails closed: a null
 * actor (nobody signed in, or an invalid/expired/revoked session) is denied,
 * never treated as the captain.
 */
export function requireCaptain(req: Request, res: Response, next: NextFunction): void {
  if (!req.actor) {
    res.status(401).json({ message: SIGN_IN_REQUIRED_MESSAGE });
    return;
  }
  if (!req.actor.isAdmin) {
    res.status(403).json({ message: CAPTAIN_ONLY_MESSAGE });
    return;
  }
  next();
}

/**
 * A participant may act on their own record; the captain may act on anyone's.
 * `targetId` is the id the action targets (e.g. the heir whose ranking is
 * being read), NOT the actor. Fails closed on a null actor.
 */
export function requireSelfOrPR(targetId: (req: Request) => number | null | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.actor) {
      res.status(401).json({ message: SIGN_IN_REQUIRED_MESSAGE });
      return;
    }
    if (req.actor.isAdmin) return next();
    const target = targetId(req);
    if (target !== null && target !== undefined && req.actor.id === target) return next();
    res.status(403).json({ message: "You can only do this for your own account." });
  };
}
