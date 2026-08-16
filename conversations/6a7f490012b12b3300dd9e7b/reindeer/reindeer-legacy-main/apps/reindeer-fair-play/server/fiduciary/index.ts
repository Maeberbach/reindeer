/**
 * v8 — High-value fiduciary workflow module entry point.
 *
 * Wire into server/routes.ts (not done here per file-discipline rules) with:
 *
 *   import { createFiduciaryRouter } from "./fiduciary";
 *   app.use("/api/fiduciary", createFiduciaryRouter());
 */
export { fiduciary, FiduciaryStorage, FiduciaryError } from "./fiduciaryStorage";
export { createFiduciaryRouter } from "./router";
