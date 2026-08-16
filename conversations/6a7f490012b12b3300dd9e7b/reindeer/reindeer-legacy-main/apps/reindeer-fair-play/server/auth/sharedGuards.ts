/**
 * Guards shared by server/routes.ts, server/fiduciary/router.ts, and
 * server/import/router.ts, so there is exactly one implementation of
 * "who is acting" and "is that person allowed to do this" across the app.
 *
 * All three read identity from `req.actor`, which `attachActor`
 * (server/auth/middleware.ts) resolves strictly from the signed session
 * cookie. Nothing here ever looks at the request body, query string, or any
 * header for identity.
 */
import type { Request, Response } from "express";
import { SIGN_IN_REQUIRED_MESSAGE } from "@shared/schema";
import { storage } from "../storage";

/** The signed-in participant's id, or null if nobody is signed in. Safe to pass on as an audit-trail actorId. */
export function actorIdOf(req: Request): number | null {
  return req.actor?.id ?? null;
}

/**
 * In-game gate. Reserved for the current captain — whoever the heirs
 * empowered to run this session's phases. Reads
 * `session.captainParticipantId` and compares to the signed-in actor.
 *
 * This is the shared implementation used by server/routes.ts,
 * server/fiduciary/router.ts, and server/import/router.ts, so there is
 * exactly one definition of "who may drive the game" across the app.
 *
 * Fails closed on a null actor (401). Before welcome runs,
 * `captainParticipantId` is null and this always denies. That is correct:
 * nothing in-game can happen before welcome.
 */
export async function denyIfNotCaptain(req: Request, res: Response): Promise<boolean> {
  const actor = req.actor ?? null;
  if (!actor) {
    res.status(401).json({ message: SIGN_IN_REQUIRED_MESSAGE });
    return true;
  }
  const session = await storage.getSession();
  if (session.captainParticipantId !== actor.id) {
    res.status(403).json({ message: "Only the captain can do that." });
    return true;
  }
  return false;
}

/** Heirs may act on their own record only; the captain may act on anyone's. Fails closed on a null actor. */
export function isSelfOrPR(actor: { id: number; isAdmin: boolean } | null, participantId: number): boolean {
  if (!actor) return false;
  if (actor.isAdmin) return true;
  return actor.id === participantId;
}
