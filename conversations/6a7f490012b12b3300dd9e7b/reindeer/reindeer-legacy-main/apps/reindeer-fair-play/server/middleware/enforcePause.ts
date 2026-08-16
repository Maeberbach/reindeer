import type { Request, Response, NextFunction } from "express";
import { storage } from "../storage";

/**
 * Factory: blocks a write endpoint while the estate is paused.
 *
 * `{ allowRead: true }` is accepted for call-site clarity (some read-ish
 * endpoints want to explicitly document that they are exempt) but this
 * middleware itself is only ever wired onto write endpoints — reads simply
 * never get it attached.
 */
export function enforcePause(_opts: { allowRead?: boolean } = {}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const state = await storage.getSessionState();
      if (state.state === "paused") {
        return res.status(403).json({
          error: "ESTATE_PAUSED",
          pausedBy: state.pausedBy,
          pausedAt: state.pausedAt,
          reason: state.pauseReason,
        });
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}
