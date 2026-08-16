/**
 * Express 4 does not catch rejected promises from async route handlers.
 * This wrapper ensures rejections are forwarded to Express error middleware
 * instead of hanging the request or crashing the process.
 *
 * Usage on a Router:
 *
 *   import { asyncHandler } from "../asyncHandler";
 *   router.get("/path", asyncHandler(async (req, res) => { ... }));
 *
 * Or to wrap an entire router's methods at once:
 *
 *   import { wrapRouterAsync } from "../asyncHandler";
 *   wrapRouterAsync(router);
 */
import type { Request, Response, NextFunction, Router } from "express";

type AsyncFn = (req: Request, res: Response, next: NextFunction) => Promise<any>;

/** Wrap a single async handler so rejections go to next(err). */
export function asyncHandler(fn: AsyncFn) {
  return (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);
}

/**
 * Patch all HTTP methods on a Router so async handlers are automatically
 * wrapped. Mirrors the pattern used in routes.ts for the main Express app.
 * Call once after the Router is created, before any routes are registered
 * (or it will miss routes registered before the call).
 */
export function wrapRouterAsync(router: Router): void {
  const methods = ["get", "post", "patch", "put", "delete"] as const;
  for (const m of methods) {
    const original = (router as any)[m].bind(router);
    (router as any)[m] = (path: any, ...handlers: any[]) => {
      const wrapped = handlers.map((h: any) => {
        if (typeof h !== "function") return h;
        if (h.constructor.name !== "AsyncFunction") return h;
        return (req: Request, res: Response, next: NextFunction) =>
          Promise.resolve(h(req, res, next)).catch(next);
      });
      return original(path, ...wrapped);
    };
  }
}
