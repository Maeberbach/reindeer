/**
 * HTTP surface for the inventory import backend.
 *
 * Mount with:
 *   import { createImportRouter } from "./import";
 *   app.use("/api/import", createImportRouter());
 *
 * Every approve/reject/discard route is captain-only. Identity comes from
 * `req.actor`, set by the shared `attachActor` middleware before this
 * router's requests ever arrive (server/routes.ts mounts `attachActor` and a
 * deny-by-default gate over all of `/api`, including `/api/import`, ahead
 * of this router). This file used to resolve the acting participant from
 * the request body/header itself, the same vulnerability the rest of the
 * app had, and has been switched to the shared guard.
 *
 * `participantId`/`actorId` body fields below are kept in the zod schemas
 * for backward-compatible request shapes, but are no longer read for
 * identity — `actorIdFrom` now derives the acting id from `req.actor` only.
 */
import express, { Router, type Request, type Response } from "express";
import { wrapRouterAsync } from "../asyncHandler";
import { z } from "zod";
import { IMPORT_RULES } from "@shared/schema";
import { denyIfNotCaptain, actorIdOf } from "../auth/sharedGuards";
import {
  stageBundle,
  listBatches,
  getBatch,
  listStaged,
  approveStaged,
  rejectStaged,
  approveBatch,
  discardBatch,
  confirmDetectedAssignment,
  dismissDetectedAssignment,
} from "./importService";

function fail(res: Response, e: any) {
  res.status(e?.status ?? 400).json({ message: e?.message ?? "Request failed" });
}

/* ------------------------------------------------------------------ */
/* validation                                                           */
/* ------------------------------------------------------------------ */

const overridesSchema = z
  .object({
    room: z.string().optional(),
    category: z.string().nullable().optional(),
    name: z.string().optional(),
  })
  .optional();

const approveStagedBodySchema = z.object({
  participantId: z.number().int().nullable().optional(),
  actorId: z.number().int().nullable().optional(),
  overrides: overridesSchema,
});

const rejectStagedBodySchema = z.object({
  participantId: z.number().int().nullable().optional(),
  actorId: z.number().int().nullable().optional(),
  note: z.string().optional().default(""),
});

const confirmDetectionBodySchema = z.object({
  // Optional recipient-name override. When omitted, the detector's
  // suggested name is used. This is the field the captain would set to
  // redirect a comment-detected assignment ("comment says Sarah but I know
  // it's Michael").
  name: z.string().trim().max(200).optional(),
});

const dismissDetectionBodySchema = z.object({
  reason: z.string().trim().max(500).optional().default(""),
});

const batchActionBodySchema = z.object({
  participantId: z.number().int().nullable().optional(),
  actorId: z.number().int().nullable().optional(),
});

/**
 * The acting participant's id, for the audit trail. Resolved ONLY from
 * `req.actor` (the signed-in participant) — the body's `participantId`/
 * `actorId` fields are accepted for shape compatibility but never consulted.
 */
function actorIdFrom(req: Request): number | null {
  return actorIdOf(req);
}

/* ------------------------------------------------------------------ */

export function createImportRouter(): Router {
  const router = Router();
  wrapRouterAsync(router);

  /** Upload a .reindeer bundle. Raw octet-stream body, up to 800mb. */
  router.post(
    "/bundle",
    express.raw({
      type: "application/octet-stream",
      limit: "800mb",
    }),
    async (req: Request, res: Response) => {
      try {
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
          return res.status(400).json({ message: "No bundle bytes were received." });
        }
        const fileName =
          (req.query.fileName as string | undefined) ??
          req.header("x-file-name") ??
          "upload.reindeer";
        const result = await stageBundle(req.body, {
          fileName,
          actorId: actorIdOf(req),
        });
        res.status(201).json(result);
      } catch (e) {
        fail(res, e);
      }
    },
  );

  /** All import batches for this session, most recent first. */
  router.get("/batches", async (_req: Request, res: Response) => {
    try {
      res.json(await listBatches());
    } catch (e) {
      fail(res, e);
    }
  });

  /** One batch with its staged items and media. */
  router.get("/batches/:id", async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid batch id." });
      const detail = await getBatch(id);
      if (!detail) return res.status(404).json({ message: "That import batch was not found." });
      res.json(detail);
    } catch (e) {
      fail(res, e);
    }
  });

  /** Approve every draft row in a batch. captain-only. */
  router.post("/batches/:id/approve", async (req: Request, res: Response) => {
    try {
      if (await denyIfNotCaptain(req, res)) return;
      const id = Number(req.params.id);
      if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid batch id." });
      batchActionBodySchema.parse(req.body ?? {});
      const result = await approveBatch(id, actorIdFrom(req));
      res.json(result);
    } catch (e) {
      fail(res, e);
    }
  });

  /** Discard a batch: reject every remaining draft and mark it discarded. captain-only. */
  router.post("/batches/:id/discard", async (req: Request, res: Response) => {
    try {
      if (await denyIfNotCaptain(req, res)) return;
      const id = Number(req.params.id);
      if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid batch id." });
      batchActionBodySchema.parse(req.body ?? {});
      const result = await discardBatch(id, actorIdFrom(req));
      res.json(result);
    } catch (e) {
      fail(res, e);
    }
  });

  /** Staged items for this session, optionally filtered by state. */
  router.get("/staged", async (req: Request, res: Response) => {
    try {
      const state = typeof req.query.state === "string" ? req.query.state : undefined;
      res.json(await listStaged(undefined, { state }));
    } catch (e) {
      fail(res, e);
    }
  });

  /** Approve one staged item into the live pool (or update the existing item). captain-only. */
  router.post("/staged/:id/approve", async (req: Request, res: Response) => {
    try {
      if (await denyIfNotCaptain(req, res)) return;
      const id = Number(req.params.id);
      if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid staged item id." });
      const body = approveStagedBodySchema.parse(req.body ?? {});
      const result = await approveStaged(id, actorIdFrom(req), body.overrides);
      res.json(result);
    } catch (e) {
      fail(res, e);
    }
  });

  /**
   * Confirm a detected owner-assignment on a staged item. Sets
   * detected_owner_assignment_review to 'confirmed' so the next approve
   * will lift the item into the owner_assigned bucket. captain-only.
   */
  router.post(
    "/staged/:id/detection/confirm",
    async (req: Request, res: Response) => {
      try {
        if (await denyIfNotCaptain(req, res)) return;
        const id = Number(req.params.id);
        if (Number.isNaN(id))
          return res.status(400).json({ message: "Invalid staged item id." });
        const body = confirmDetectionBodySchema.parse(req.body ?? {});
        const result = await confirmDetectedAssignment(id, actorIdFrom(req), {
          name: body.name,
        });
        res.json(result);
      } catch (e) {
        fail(res, e);
      }
    },
  );

  /**
   * Dismiss a detected owner-assignment on a staged item. The item can
   * then be approved into the pool as `available`. captain-only.
   */
  router.post(
    "/staged/:id/detection/dismiss",
    async (req: Request, res: Response) => {
      try {
        if (await denyIfNotCaptain(req, res)) return;
        const id = Number(req.params.id);
        if (Number.isNaN(id))
          return res.status(400).json({ message: "Invalid staged item id." });
        const body = dismissDetectionBodySchema.parse(req.body ?? {});
        const result = await dismissDetectedAssignment(id, actorIdFrom(req), {
          reason: body.reason,
        });
        res.json(result);
      } catch (e) {
        fail(res, e);
      }
    },
  );

  /** Reject one staged item. captain-only. */
  router.post("/staged/:id/reject", async (req: Request, res: Response) => {
    try {
      if (await denyIfNotCaptain(req, res)) return;
      const id = Number(req.params.id);
      if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid staged item id." });
      const body = rejectStagedBodySchema.parse(req.body ?? {});
      const result = await rejectStaged(id, actorIdFrom(req), body.note);
      res.json(result);
    } catch (e) {
      fail(res, e);
    }
  });

  /** The six rules this backend enforces, for display in the review UI. */
  router.get("/rules", async (_req: Request, res: Response) => {
    res.json({ rules: IMPORT_RULES });
  });

  return router;
}
