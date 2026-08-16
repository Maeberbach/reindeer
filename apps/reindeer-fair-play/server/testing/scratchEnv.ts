/**
 * Point a test run at a throwaway database and upload directory.
 *
 * Import this FIRST, before anything that reaches `server/storage`:
 *
 *   import "../testing/scratchEnv";
 *   import { storage } from "../storage";
 *
 * Order matters and is not cosmetic. ES module imports are hoisted and run
 * before any top-level statement in the importing file, so setting these
 * environment variables inline at the top of a test is too late — storage.ts
 * has already opened the real estate database by then. A test run once wrote
 * fixture rows into real data. This module exists so that cannot happen again.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "fair-choice-selftest-"));

process.env.REINDEER_FAIR_PLAY_DB_PATH = join(scratch, "test.db");
process.env.REINDEER_FAIR_PLAY_UPLOAD_DIR = join(scratch, "uploads");
process.env.REINDEER_FAIR_PLAY_AUTH_SECRET ??= "selftest-only-secret-not-for-production";

export const SCRATCH_DIR = scratch;
export const SCRATCH_DB_PATH = process.env.REINDEER_FAIR_PLAY_DB_PATH;
export const SCRATCH_UPLOAD_DIR = process.env.REINDEER_FAIR_PLAY_UPLOAD_DIR;
