import {
  sessions,
  participants,
  items,
  groupings,
  groupingOptIns,
  appraisalFlags,
  picks,
  duplicateGroups,
  taxonomy,
  rankings,
  rankingEditsLog,
  classificationChanges,
  categoryChanges,
  notifications,
  captainTransfers,
  sessionStateChanges,
  STANDARD_ROOMS,
  STANDARD_CATEGORIES,
  PRACTICE_SAMPLE_ITEMS,
  DEFAULT_HEIR_PERMISSIONS,
  placeholderHeirName,
  methodAgreements,
  itemMedia,
  itemInterests,
} from "@shared/schema";
import type {
  Session,
  Participant,
  InsertParticipant,
  Item,
  InsertItem,
  Grouping,
  InsertGrouping,
  GroupingOptIn,
  AppraisalFlag,
  Pick as DraftPick,
  DuplicateGroup,
  Taxonomy,
  TaxonomyRow,
  PracticeState,
  PracticeResults,
  PracticeHeir,
  Ranking,
  RankingEditLog,
  RankingItemStat,
  RankingWindow,
  ClassificationChange,
  CategoryChange,
  CategoryChangeSource,
  CategoryChangedPayload,
  AppNotification,
  ClassificationFlag,
  ClassificationChangedPayload,
  ReconciliationState,
  CaptainTransfer,
  SessionStateChange,
  SessionLifecycleState,
  StageLine,
  StageProgress,
  ItemMedia,
  ItemInterest,
} from "@shared/schema";
import { CONTESTED_CATEGORY_LABELS, CONTESTED_ROUND_KIND, LEGAL_CATEGORIES } from "@shared/legalCategories";
import {
  AI_CATEGORY_CONFIDENCE_THRESHOLD,
  CATEGORY_CONFLICT_WINDOW_MS,
  CATEGORY_RATE_LIMIT,
  CATEGORY_RATE_WINDOW_MS,
  categorySentence,
  CLASSIFICATION_FANOUT_PHASES,
  CLASSIFICATION_OPEN_PHASES,
  EMPTY_RECONCILIATION,
  FLAG_LABEL,
  parseReconciliation,
  reconciliationInterval,
  PAUSE_REASON_MAX_LEN,
} from "@shared/schema";
import {
  DAY_MS,
  RANKING_WINDOW_MAX_DAYS,
  RANKING_WINDOW_MIN_DAYS,
  rankingWindowOf,
  windowPhaseOf,
  registrationOpen,
} from "@shared/schema";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { FEATURE_FLAGS } from "./featureFlags";
import { looksLikeSameThing, explainMatch } from "./duplicates/match";
import { initSchema } from "./migrations/init";
import { migratePrToCaptain } from "./migrations/renamePrColumns";
import { and, eq, inArray } from "drizzle-orm";

/**
 * Where the estate lives on disk.
 *
 * This was hardcoded, which meant a test run opened the same file as a real
 * family's records — and one already did. Tests now point somewhere else.
 */
export const DB_PATH = process.env.REINDEER_FAIR_PLAY_DB_PATH ?? "data.db";

// Ensure the DB directory exists (needed when using a persistent disk mount)
const _dbDir = path.dirname(DB_PATH);
if (_dbDir && _dbDir !== ".") fs.mkdirSync(_dbDir, { recursive: true });

/**
 * Estate identifier for encryption key derivation.
 * Each install is one estate; when multi-estate is enabled, each estate
 * will have its own ULID and DB file path.
 */
const ESTATE_ID = process.env.REINDEER_FAIR_PLAY_ESTATE_ID ?? "fair-play-estate";

/**
 * Open the estate database, encrypted with SQLCipher when the encryption
 * feature flag is on. When the flag is off (current testing mode), the DB
 * opens as plain SQLite — no behavior change.
 *
 * better-sqlite3-multiple-ciphers is a drop-in for better-sqlite3 with
 * SQLCipher support. When encryption is off, we use plain better-sqlite3.
 */
function openEstateDb(dbPath: string): Database.Database {
  if (FEATURE_FLAGS.encryption) {
    try {
      // Dynamic require so the package is optional during testing
      const EncryptedDatabase = eval("require")("better-sqlite3-multiple-ciphers");
      const key = deriveEstateKey(ESTATE_ID);
      const instance = new EncryptedDatabase(dbPath);
      instance.pragma(`key = '${key}'`);
      return instance as unknown as Database.Database;
    } catch (err) {
      console.warn(
        "[reindeer:fair-play] Encryption requested but better-sqlite3-multiple-ciphers " +
        "is not installed. Opening database UNENCRYPTED. " +
        "Run: npm install better-sqlite3-multiple-ciphers"
      );
    }
  }
  return new Database(dbPath);
}

// Derive the per-estate encryption key when encryption is enabled.
// Uses HMAC-SHA256(REINDEER_MASTER_KEY, estateId) → hex key for PRAGMA key.
function deriveEstateKey(estateId: string): string {
  const masterKey = process.env.REINDEER_MASTER_KEY;
  if (!masterKey) {
    throw new Error(
      "REINDEER_MASTER_KEY is not set. Cannot derive estate encryption key. " +
      "Set it in the environment or disable encryption via FEATURE_FLAGS.encryption."
    );
  }
  const crypto = eval("require")("node:crypto");
  return crypto.createHmac("sha256", masterKey).update(estateId).digest("hex");
}

export const sqlite = openEstateDb(DB_PATH);
sqlite.pragma("journal_mode = WAL");

// Schema is created in one pass by initSchema. The old v1..v15 migration
// ladder was collapsed in v2.1 because nothing has shipped yet; there is no
// historical database to upgrade. See migrations/init.ts for the full DDL.
initSchema(sqlite);

// For databases created before the Captain terminology migration,
// rename any remaining pr_* columns/tables to captain_*.
// No-op on fresh databases where init.ts already used the final names.
migratePrToCaptain(sqlite);

export const db = drizzle(sqlite);

export const HEIRLOOM_GROUPING_NAME = "Heirlooms";

/** Per-heir view of how far through the rank requirement everyone is. */
export type RankCompleteness = {
  required: number;
  mode: string;
  totalAvailable: number;
  heirs: {
    participantId: number;
    name: string;
    ranked: number;
    shortfall: number;
    complete: boolean;
  }[];
  allComplete: boolean;
  underRanked: { participantId: number; name: string; shortfall: number }[];
};

/**
 * Who is making a ranking edit, and under which mode it should be logged.
 * `self` — the participant editing their own list, or the captain editing directly.
 * `assist` — the captain working inside another heir's list via assist mode.
 */
export type RankEditContext = {
  editedBy: number;
  mode: "self" | "assist";
};

function httpError(message: string, status: number) {
  const err: any = new Error(message);
  err.status = status;
  return err;
}

export interface IStorage {
  getSession(): Promise<Session>;
  resetSession(): Promise<Session>;
  updateSession(patch: Partial<Session>): Promise<Session>;

  /* ---- v7a: session lifecycle (pause / resume) ---- */
  pauseSession(
    sessionId: number | undefined,
    participantId: number | null,
    reason?: string | null,
  ): Promise<{ session: Session; change: SessionStateChange }>;
  resumeSession(
    sessionId: number | undefined,
    participantId: number | null,
    extendRankingDays?: number | null,
  ): Promise<{ session: Session; change: SessionStateChange }>;
  getSessionState(sessionId?: number): Promise<{
    state: SessionLifecycleState;
    pausedAt: number | null;
    pausedBy: number | null;
    pauseReason: string | null;
    pauseCount: number;
    totalPausedMs: number;
    stateChanges: SessionStateChange[];
  }>;
  getStateChanges(sessionId?: number): Promise<SessionStateChange[]>;
  getRemainingPausedMs(sessionId?: number): Promise<number>;

  listParticipants(): Promise<Participant[]>;
  createParticipant(p: InsertParticipant): Promise<Participant>;
  updateParticipant(id: number, patch: Partial<Participant>): Promise<Participant | undefined>;
  deleteParticipant(id: number): Promise<void>;
  replaceParticipants(rows: Omit<InsertParticipant, "sessionId">[]): Promise<Participant[]>;

  listItems(): Promise<Item[]>;
  createItem(i: Omit<InsertItem, "sessionId">): Promise<Item>;
  updateItem(id: number, patch: Partial<Item>): Promise<Item | undefined>;
  deleteItem(id: number): Promise<void>;

  listGroupings(): Promise<Grouping[]>;
  createGrouping(g: Omit<InsertGrouping, "sessionId">): Promise<Grouping>;
  listOptIns(): Promise<GroupingOptIn[]>;
  setOptIn(groupingId: number, participantId: number, choice: string): Promise<GroupingOptIn>;
  resolveGrouping(groupingId: number): Promise<{ grouping: Grouping; message: string }>;
  ensureHeirloomGrouping(): Promise<Grouping>;
  confirmHeirloom(itemId: number, confirmed: boolean): Promise<Item | undefined>;

  listAppraisalFlags(): Promise<AppraisalFlag[]>;
  /**
   * Flag an item for the trustee's appraisal queue. Single-actor: no
   * confirmation gate. Source is 'heir' | 'owner' | 'ai' | 'category'.
   * For heir source, participantId is the flagging heir; for the other
   * three sources participantId is null. Reason is optional for heirs
   * (a hunch is enough); AI writes an estimate + "not an official
   * appraisal" caveat; category writes a plain-language rule reason.
   * Idempotent: re-calling on an item that is already actively flagged
   * returns the existing row unchanged.
   */
  flagForAppraisal(input: {
    itemId: number;
    source: "heir" | "owner" | "ai" | "category";
    participantId: number | null;
    reason: string | null;
  }): Promise<AppraisalFlag>;

  /**
   * Run the two auto-flag rules against one item, given the AI analysis
   * result. Called by applyAiAnalysis after storing the analyzer output.
   *
   * Rule A (AI estimate): if analysis.estimatedValueUsd >= 0.85 * session
   * threshold and no active appraisal_flags row exists for the item, insert
   * one with source='ai' and a reason that carries the estimate.
   *
   * Rule B (category rule): if the item's category has appraisalLikely=true
   * and no active appraisal_flags row exists, insert one with
   * source='category' and a plain-language reason.
   *
   * Both rules respect captain reverts within the current threshold cycle:
   * a reverted row means "the captain has already looked at this and said
   * no," so the auto-flag stays quiet until either the threshold changes
   * (see rescanAllItemsForAppraisal) or an heir flags it manually.
   *
   * Returns the number of new rows inserted (0, 1, or 2 in edge cases).
   */
  autoFlagAfterAiAnalysis(itemId: number, analysis: {
    estimatedValueUsd: number | null;
    category: string | null;
  }): Promise<number>;

  /**
   * Re-sweep every non-practice item in the session against both auto-flag
   * rules, treating current AI reverts as cleared for this cycle. Called
   * after a threshold change so "unflagging comes back if a new threshold
   * is chosen" (per user rule, 8 Aug 2026). Owner-source rows remain
   * untouchable. Returns the count of new flags created.
   */
  rescanAllItemsForAppraisal(): Promise<number>;
  /**
   * Captain reverses an honest mistake in escalation. Refuses (returns
   * undefined) when the escalation is owner-sourced — owner selections are
   * permanent. Refuses when the row is already reverted. Stamps
   * revertedAt + revertedByCaptainId on the row and flips item.status back
   * to 'in_pool'. The row is kept for the audit trail, not deleted.
   */
  unflagAppraisal(input: {
    nominationId: number;
    captainId: number;
  }): Promise<AppraisalFlag | undefined>;

  listPicks(): Promise<DraftPick[]>;
  submitPick(participantId: number, itemId: number, highValue?: boolean): Promise<DraftPick>;
  revealRound(): Promise<{ resolved: number; roundComplete: boolean; log: string[] }>;

  startGroupingsRound(): Promise<Session>;
  startDraft(): Promise<Session>;

  listRankings(participantId?: number): Promise<Ranking[]>;
  replaceRankings(
    participantId: number,
    ranks: { itemId: number; rank: number }[],
    ctx?: RankEditContext,
  ): Promise<Ranking[]>;
  moveRanking(
    participantId: number,
    itemId: number,
    newRank: number,
    ctx?: RankEditContext,
  ): Promise<Ranking[]>;
  deleteRanking(participantId: number, itemId: number, ctx?: RankEditContext): Promise<Ranking[]>;
  rankingAggregate(): Promise<RankingItemStat[]>;
  listRankingEdits(participantId?: number): Promise<RankingEditLog[]>;
  dismissRankingEdits(participantId: number): Promise<{ dismissed: number }>;
  rankingCompleteness(): Promise<RankCompleteness>;
  autoSuggest(participantId: number): Promise<{ itemId: number; rank: number; name: string } | null>;
  nextPhase(force: boolean): Promise<Session>;

  listTaxonomy(): Promise<TaxonomyRow[]>;
  addTaxonomy(kind: string, label: string, isEnabled?: boolean): Promise<Taxonomy>;
  setTaxonomyEnabled(id: number, isEnabled: boolean): Promise<Taxonomy>;
  mergeTaxonomy(kind: string, sourceIds: number[]): Promise<{ row: Taxonomy; reassigned: number }>;

  startPractice(mode: "sample_items", heirCount?: number): Promise<Session>;
  endPractice(): Promise<Session>;
  practiceResults(): Promise<PracticeResults | null>;

  stageProgress(): Promise<StageProgress>;

  listDuplicateGroups(): Promise<DuplicateGroup[]>;
  scanDuplicates(): Promise<DuplicateGroup[]>;
  /** One item against the whole pool, whatever its origin. Never throws. */
  scanDuplicatesForItem(itemId: number): Promise<{
    matches: { id: number; name: string; reason: string; score: number }[];
    groupId: number | null;
  }>;
  resolveDuplicate(groupId: number, keepItemId: number, participantId: number | null): Promise<void>;

  /* ---- v6 collaborative categorization ---- */
  setItemCategory(
    itemId: number,
    category: string | null,
    actorId: number | null,
    source?: CategoryChangeSource,
  ): Promise<CategoryWriteResult>;
  listCategoryChanges(itemId?: number): Promise<CategoryChange[]>;
  categoryChangesSince(participantId: number | null, sinceMs: number): Promise<number>;
  clearNeedsDiscussion(itemId: number): Promise<Item>;
  applyAiAnalysis(
    itemId: number,
    result: AiAnalysis,
    actorId?: number | null,
  ): Promise<{ item: Item; autoAssigned: boolean }>;
  categorizationStatus(): Promise<CategorizationStatus>;

  /* ---- item interests (desire layer) ---- */
  /** Get all interest rows for a participant. */
  listInterests(participantId: number): Promise<ItemInterest[]>;
  /** Get all interest rows for the session (all participants). */
  listAllInterests(): Promise<ItemInterest[]>;
  /** Upsert a single heir's interest level for one item. */
  setInterest(participantId: number, itemId: number, interest: "want" | "interested" | "dont_care"): Promise<ItemInterest>;
  /** Count how many heirs marked 'want' for an item. Returns the count. */
  countWantsForItem(itemId: number): Promise<number>;
  /** Get all items with 2+ 'want' interests — auto-flag candidates. */
  itemsWithMultipleWants(): Promise<{ itemId: number; wantCount: number }[]>;
}

/** What `setItemCategory` reports back to the route layer. */
export type CategoryWriteResult = {
  item: Item;
  change: CategoryChange | null;
  notified: number;
  /** Another participant touched the same item inside the conflict window. */
  conflict: boolean;
};

/** The analyser's answer, in the shape storage cares about. */
export type AiAnalysis = {
  category: string | null;
  confidence: number;
  suggestions: { category: string; confidence: number }[];
  /** Rough dollar estimate; null when the model didn't or couldn't offer one. */
  estimatedValueUsd: number | null;
  highValue: boolean;
  highValueReason?: string;
};

export type CategorizationStatus = {
  total: number;
  categorized: number;
  uncategorized: number;
  needsDiscussion: number;
  heirsCanCategorize: boolean;
  aiMode: "mock" | "live";
  /** Who has been doing the categorising, busiest first. */
  collaborators: { participantId: number | null; name: string; count: number }[];
};

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class DatabaseStorage implements IStorage {
  /* ---------------- session ---------------- */
  async getSession(): Promise<Session> {
    try {
      const existing = db.select().from(sessions).get();
      if (existing) {
        this.seedTaxonomy(existing.id);
        return existing;
      }
      const created = db
        .insert(sessions)
        .values({
          name: "Family Estate Session",
          estateName: null,
          phase: "welcome",
          rankDepthMode: "topN",
          rankTopN: 20,
          currentRound: 0,
          priorityOrder: "[]",
          heirPermissions: JSON.stringify(DEFAULT_HEIR_PERMISSIONS),
          practiceMode: "off",
          practiceState: null,
          createdAt: Date.now(),
        })
        .returning()
        .get();
      this.seedTaxonomy(created.id);
      return created;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Database error reading session: ${message}. ` +
        `If this persists, the database may be locked or corrupted.`,
      );
    }
  }

  /**
   * Seed the 15 standard rooms + 14 standard categories + the contested stages,
   * all disabled.
   *
   * Stages are seeded switched off on purpose. Running the contested categories
   * as separate rounds is a decision for the captain, not a
   * default imposed on every family: a small estate with four pieces of jewelry
   * does not need a jewelry round, and being marched through empty stages would
   * only make the process feel longer than it is. The seeded row order is the
   * order the rounds run in.
   */
  private seedTaxonomy(sessionId: number) {
    // Seed once per session only — merged-away or deleted labels must not
    // silently reappear on the next read.
    const existing = db.select().from(taxonomy).all();
    if (existing.length > 0) return;
    const have = new Set(existing.map((t) => `${t.kind}::${t.label}`));
    const rows: { kind: string; label: string }[] = [
      ...STANDARD_ROOMS.map((label) => ({ kind: "room", label })),
      ...STANDARD_CATEGORIES.map((label) => ({ kind: "category", label })),
      ...CONTESTED_CATEGORY_LABELS.map((label) => ({ kind: CONTESTED_ROUND_KIND, label })),
    ];
    for (const r of rows) {
      if (have.has(`${r.kind}::${r.label}`)) continue;
      db.insert(taxonomy)
        .values({ sessionId, kind: r.kind, label: r.label, isEnabled: false, isCustom: false })
        .run();
    }
  }

  async resetSession(): Promise<Session> {
    db.delete(picks).run();
    db.delete(groupingOptIns).run();
    db.delete(groupings).run();
    db.delete(appraisalFlags).run();
    db.delete(duplicateGroups).run();
    db.delete(items).run();
    db.delete(rankings).run();
    db.delete(classificationChanges).run();
    db.delete(categoryChanges).run();
    db.delete(notifications).run();
    db.delete(participants).run();
    db.delete(taxonomy).run();
    db.delete(captainTransfers).run();
    db.delete(sessions).run();
    return this.getSession();
  }

  async updateSession(patch: Partial<Session>): Promise<Session> {
    const s = await this.getSession();
    db.update(sessions).set(patch).where(eq(sessions.id, s.id)).run();
    return db.select().from(sessions).where(eq(sessions.id, s.id)).get()!;
  }

  /* ================================================================= */
  /* v7a — session lifecycle (pause / resume)                          */
  /*                                                                     */
  /* The app is single-session: there is exactly one row in `sessions`,  */
  /* so the `sessionId` parameters on every method below are accepted   */
  /* for API-shape compatibility with the spec but are otherwise        */
  /* ignored — every call resolves against `getSession()`'s one row.    */
  /* ================================================================= */

  private async recordStateChange(
    s: Session,
    fromState: string,
    toState: string,
    changedByParticipantId: number | null,
    reason: string | null,
    metadata?: Record<string, unknown>,
  ): Promise<SessionStateChange> {
    return db
      .insert(sessionStateChanges)
      .values({
        id: randomUUID(),
        sessionId: s.id,
        fromState,
        toState,
        changedByParticipantId,
        changedAt: Date.now(),
        reason,
        metadata: metadata ? JSON.stringify(metadata) : null,
      })
      .returning()
      .get();
  }

  async pauseSession(
    _sessionId: number | undefined,
    participantId: number | null,
    reason?: string | null,
  ): Promise<{ session: Session; change: SessionStateChange }> {
    const s = await this.getSession();
    if (s.state === "paused") {
      throw httpError("The estate is already paused.", 400);
    }
    if (s.state === "archived") {
      throw httpError("An archived estate cannot be paused.", 400);
    }
    const cleanReason = reason && reason.trim() !== "" ? reason.trim() : null;
    if (cleanReason && cleanReason.length > PAUSE_REASON_MAX_LEN) {
      throw httpError(`Reason must be ${PAUSE_REASON_MAX_LEN} characters or fewer.`, 400);
    }
    const now = Date.now();
    const patch: Partial<Session> = {
      state: "paused",
      pausedAt: now,
      pausedBy: participantId,
      pauseReason: cleanReason,
      pauseCount: (s.pauseCount ?? 0) + 1,
    };
    db.update(sessions).set(patch).where(eq(sessions.id, s.id)).run();
    const fresh = db.select().from(sessions).where(eq(sessions.id, s.id)).get()!;
    const change = await this.recordStateChange(fresh, "active", "paused", participantId, cleanReason);

    const roster = await this.listParticipants();
    const actor = participantId === null ? null : roster.find((p) => p.id === participantId) ?? null;
    const actorName = actor?.name ?? "The captain";
    for (const p of roster) {
      await this.notify(p.id, "estate_paused", {
        pausedBy: actorName,
        reason: cleanReason,
        message: cleanReason
          ? `The estate has been paused by ${actorName}. Reason: ${cleanReason}`
          : `The estate has been paused by ${actorName}.`,
      });
    }
    return { session: fresh, change };
  }

  async resumeSession(
    _sessionId: number | undefined,
    participantId: number | null,
    extendRankingDays?: number | null,
  ): Promise<{ session: Session; change: SessionStateChange }> {
    const s = await this.getSession();
    if (s.state !== "paused") {
      throw httpError("The estate is not currently paused.", 400);
    }
    const now = Date.now();
    const pausedAt = s.pausedAt ?? now;
    const elapsed = Math.max(0, now - pausedAt);
    const patch: Record<string, unknown> = {
      state: "active",
      pausedAt: null,
      pausedBy: null,
      pauseReason: null,
      totalPausedMs: (s.totalPausedMs ?? 0) + elapsed,
    };

    // Option A: the underlying ranking deadlines never move; only an explicit
    // extension (offered in the Resume dialog once paused >= 24h) shifts them.
    const days = extendRankingDays && extendRankingDays > 0 ? Math.floor(extendRankingDays) : 0;
    if (days > 0) {
      const shiftMs = days * DAY_MS;
      if (s.rankingDeadline) patch.rankingDeadline = s.rankingDeadline + shiftMs;
      if (s.secondaryRankingDeadline)
        patch.secondaryRankingDeadline = s.secondaryRankingDeadline + shiftMs;
    }

    db.update(sessions).set(patch).where(eq(sessions.id, s.id)).run();
    const fresh = db.select().from(sessions).where(eq(sessions.id, s.id)).get()!;
    const change = await this.recordStateChange(fresh, "paused", "active", participantId, null, {
      pausedDurationMs: elapsed,
      extendRankingDays: days || undefined,
    });

    const roster = await this.listParticipants();
    for (const p of roster) {
      await this.notify(p.id, "estate_resumed", {
        message: "The estate has been resumed. Continue where you left off.",
      });
    }
    return { session: fresh, change };
  }

  async getSessionState(_sessionId?: number) {
    const s = await this.getSession();
    const stateChanges = await this.getStateChanges();
    return {
      state: (s.state ?? "active") as SessionLifecycleState,
      pausedAt: s.pausedAt ?? null,
      pausedBy: s.pausedBy ?? null,
      pauseReason: s.pauseReason ?? null,
      pauseCount: s.pauseCount ?? 0,
      totalPausedMs: s.totalPausedMs ?? 0,
      stateChanges,
    };
  }

  async getStateChanges(_sessionId?: number): Promise<SessionStateChange[]> {
    const s = await this.getSession();
    return db
      .select()
      .from(sessionStateChanges)
      .where(eq(sessionStateChanges.sessionId, s.id))
      .all()
      .sort((a, b) => b.changedAt - a.changedAt);
  }

  /** How much paused time (including any pause in progress) counts against ranking countdowns. */
  async getRemainingPausedMs(_sessionId?: number): Promise<number> {
    const s = await this.getSession();
    const base = s.totalPausedMs ?? 0;
    if (s.state !== "paused" || !s.pausedAt) return base;
    return base + Math.max(0, Date.now() - s.pausedAt);
  }

  /* ---------------- participants ---------------- */
  async listParticipants(): Promise<Participant[]> {
    return db.select().from(participants).all();
  }

  async createParticipant(p: InsertParticipant): Promise<Participant> {
    // Trustee invariants: a trustee is never an heir. They may act as
    // captain but they cannot draft, rank, receive items, or appear in
    // equalization math.
    if (p.role === "trustee") {
      if (p.administersOnly !== true) {
        throw Object.assign(
          new Error("A trustee must be administers-only \u2014 they never receive items."),
          { status: 400 },
        );
      }
      const roster = await this.listParticipants();
      if (roster.some((r) => r.role === "trustee")) {
        throw Object.assign(
          new Error("This session already has a trustee."),
          { status: 409 },
        );
      }
    }
    // Helper invariants: a helper is invited for inventory collection
    // only. They are never an heir, never admin, and must be
    // administers-only so they are excluded from equalization math.
    if (p.role === "helper") {
      if (p.administersOnly !== true) {
        throw Object.assign(
          new Error("A helper must be administers-only — they never receive items."),
          { status: 400 },
        );
      }
      if (p.isAdmin === true) {
        throw Object.assign(
          new Error("A helper cannot be an admin."),
          { status: 400 },
        );
      }
    }

    // Representative invariants: acts on behalf of another participant.
    // Never drafts, ranks, or receives items; the represented person
    // still does. Must point at an existing heir or trustee row.
    if (p.role === "representative") {
      if (p.administersOnly !== true) {
        throw Object.assign(
          new Error("A proxy must be administers-only \u2014 they never receive items."),
          { status: 400 },
        );
      }
      if (p.representsParticipantId == null) {
        throw Object.assign(
          new Error("A proxy must name the person they act for."),
          { status: 400 },
        );
      }
      const roster = await this.listParticipants();
      const target = roster.find((r) => r.id === p.representsParticipantId);
      if (!target) {
        throw Object.assign(
          new Error("The person a proxy acts for is not on the roster."),
          { status: 404 },
        );
      }
      if (target.role === "representative") {
        throw Object.assign(
          new Error("A proxy cannot act for another proxy."),
          { status: 400 },
        );
      }
    } else if (p.representsParticipantId != null) {
      // Only proxies may set this field. An heir or trustee row
      // with a stray representsParticipantId would be a data-model bug.
      throw Object.assign(
        new Error("Only a proxy can name who they act for."),
        { status: 400 },
      );
    }
    return db.insert(participants).values(p).returning().get();
  }

  async updateParticipant(id: number, patch: Partial<Participant>) {
    // Preserve trustee invariants on updates. You cannot promote an heir
    // to trustee (create a new participant instead) and you cannot demote
    // a trustee below administers-only.
    if (patch.role !== undefined || patch.administersOnly !== undefined) {
      const existing = db.select().from(participants).where(eq(participants.id, id)).get();
      if (existing) {
        const nextRole = patch.role ?? existing.role;
        const nextAdminOnly = patch.administersOnly ?? existing.administersOnly;
        if (nextRole === "trustee" && nextAdminOnly !== true) {
          throw Object.assign(
            new Error("A trustee must remain administers-only."),
            { status: 400 },
          );
        }
        if (existing.role === "heir" && patch.role === "trustee") {
          throw Object.assign(
            new Error("An heir cannot be promoted to trustee. Invite the trustee separately."),
            { status: 400 },
          );
        }
      }
    }
    db.update(participants).set(patch).where(eq(participants.id, id)).run();
    return db.select().from(participants).where(eq(participants.id, id)).get();
  }

  async deleteParticipant(id: number) {
    db.delete(participants).where(eq(participants.id, id)).run();
  }

  async replaceParticipants(rows: Omit<InsertParticipant, "sessionId">[]) {
    const s = await this.getSession();
    db.delete(participants).run();
    for (const r of rows) {
      db.insert(participants).values({ ...r, sessionId: s.id }).run();
    }
    // v4: saving the roster no longer opens cataloguing. The captain does that
    // deliberately with "Start session" once the table is complete.
    return this.listParticipants();
  }

  /**
   * Open the session for cataloguing. Requires at least two participants and
   * one Captain, which is the same bar the landing page uses
   * before it stops forcing everyone onto the Participants screen.
   */
  async startSession(): Promise<Session> {
    const s = await this.getSession();
    const roster = await this.listParticipants();
    if (roster.length < 2) {
      throw Object.assign(new Error("Add at least two participants before starting."), {
        status: 400,
      });
    }
    if (!roster.some((p) => p.isAdmin)) {
      throw Object.assign(
        new Error("Mark one participant as the captain before starting."),
        { status: 400 },
      );
    }
    if (!registrationOpen(s.phase)) return s;
    return this.updateSession({ phase: "intake", registrationClosedAt: Date.now() });
  }

  /* ---------------- v5: welcome → estate name → registration ---------------- */

  /**
   * First launch. Creates the Captain and moves the session
   * on to naming the estate. Nothing else in the app exists until this runs.
   */
  async createWelcome(captainName: string, administersOnly: boolean) {
    const s = await this.getSession();
    const roster = await this.listParticipants();
    if (roster.some((p) => p.isAdmin)) {
      throw Object.assign(
        new Error("This estate already has a captain."),
        { status: 409 },
      );
    }
    const name = captainName.trim();
    if (!name) throw Object.assign(new Error("Enter your name."), { status: 400 });
    const captain = await this.createParticipant({
      sessionId: s.id,
      name,
      isAdmin: true,
      administersOnly,
      seatOrder: 0,
    });
    // The heir-admin becomes the initial captain. Any transfer (trustee
    // take-over, or a captain-transfer endpoint in a later commit) updates
    // this field. Every in-game guard reads captainParticipantId, not
    // isAdmin.
    const session = await this.updateSession({
      phase: "estate_name",
      captainParticipantId: captain.id,
    });
    return { session, participant: captain };
  }

  /**
   * The heir running the session names the estate; the roster registration
   * phase opens. Optionally captures the trustee's name at the same time —
   * the trustee is the fiduciary named by the trust or will who sits
   * outside the app and handles the high-value bucket. Trustee name may be
   * blank now and set later via {@link setTrusteeName}.
   */
  async setEstateName(
    estateName: string,
    trusteeName?: string | null,
  ): Promise<Session> {
    const name = estateName.trim();
    if (!name) throw Object.assign(new Error("Name this estate."), { status: 400 });
    const s = await this.getSession();
    const patch: Partial<Session> = { estateName: name };
    if (trusteeName !== undefined) {
      const trimmed = (trusteeName ?? "").trim();
      patch.trusteeName = trimmed.length > 0 ? trimmed : null;
    }
    // Naming is only a gate the first time through; later renames keep the phase.
    if (s.phase === "estate_name" || s.phase === "welcome") patch.phase = "registration";
    return this.updateSession(patch);
  }

  /**
   * Set or clear the trustee's name after estate setup. Trimmed empty string
   * clears the field. This captures the fiduciary of record on the trust or
   * will for the Record of Decisions and the trustee packet. It does NOT
   * seat the trustee inside the app — that happens through
   * {@link inviteTrustee} + {@link trusteeTakeOver}.
   */
  async setTrusteeName(trusteeName: string | null): Promise<Session> {
    const trimmed = (trusteeName ?? "").trim();
    return this.updateSession({ trusteeName: trimmed.length > 0 ? trimmed : null });
  }

  /* ---------------- trustee stepping in as captain ---------------- */

  /**
   * Create a trustee participant row for the trustee named on the session.
   * The trustee is administers-only and role='trustee' — the invariants
   * on {@link createParticipant} enforce this. Their email is required so
   * the caller can send them a magic link; the auth code path stays the
   * same as any participant. Idempotent: if a trustee participant already
   * exists on the session, this returns it without creating another.
   */
  async inviteTrustee(
    name: string,
    email: string,
  ): Promise<Participant> {
    const trimmedName = name.trim();
    if (!trimmedName) {
      throw Object.assign(new Error("Enter the trustee's name."), { status: 400 });
    }
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      throw Object.assign(new Error("Enter the trustee's email."), { status: 400 });
    }
    const s = await this.getSession();
    const roster = await this.listParticipants();
    const existing = roster.find((p) => p.role === "trustee");
    if (existing) return existing;
    // Also record the trustee's name on the session for docs.
    if ((s.trusteeName ?? "").trim() !== trimmedName) {
      await this.updateSession({ trusteeName: trimmedName });
    }
    const created = await this.createParticipant({
      sessionId: s.id,
      name: trimmedName,
      isAdmin: true, // trustee runs admin actions when they take over
      administersOnly: true,
      role: "trustee",
      email: trimmedEmail,
      // Seat the trustee at the end — they don't appear in draft rounds
      // anyway (administersOnly filter) but this keeps output stable.
      seatOrder: roster.length,
    });
    return created;
  }

  /**
   * Flip the captain seat over to the trustee. Requires a trustee
   * participant to exist. Refuses if the trustee is already seated as
   * captain. The trustee's own action — the route gate ensures only the
   * trustee participant can call this.
   *
   * There is no separate `trusteeMode` flag. Trustee-in-charge is derived:
   * `session.captainParticipantId === session.trusteeParticipantId`. This
   * removes a class of drift where a boolean and a foreign key could
   * disagree.
   */
  async trusteeTakeOver(trusteeParticipantId: number): Promise<Session> {
    const s = await this.getSession();
    const trustee = db
      .select()
      .from(participants)
      .where(eq(participants.id, trusteeParticipantId))
      .get();
    if (!trustee || trustee.role !== "trustee") {
      throw Object.assign(
        new Error("Only the trustee can take over the session."),
        { status: 403 },
      );
    }
    if (s.captainParticipantId === trustee.id) {
      throw Object.assign(
        new Error("The trustee is already running this session."),
        { status: 409 },
      );
    }
    return this.updateSession({
      trusteeParticipantId: trustee.id,
      captainParticipantId: trustee.id,
    });
  }

  /**
   * Trustee hands the session back to the heirs. Trustee-initiated only —
   * the route gate ensures no heir can call this. Refuses if the trustee
   * is not currently seated as captain. Captain reverts to the heir-admin
   * row — the person who completed welcome. If no heir-admin exists
   * (should be impossible past welcome), captain reverts to null and the
   * next request will fail denyIfNotCaptain, which is the safer failure
   * than pointing at a dangling row.
   */
  async trusteeHandBack(trusteeParticipantId: number): Promise<Session> {
    const s = await this.getSession();
    if (s.captainParticipantId !== s.trusteeParticipantId || s.trusteeParticipantId === null) {
      throw Object.assign(
        new Error("The trustee is not running this session."),
        { status: 409 },
      );
    }
    if (s.trusteeParticipantId !== trusteeParticipantId) {
      throw Object.assign(
        new Error("Only the seated trustee can hand this session back."),
        { status: 403 },
      );
    }
    const roster = await this.listParticipants();
    const heirAdmin = roster.find((p) => p.isAdmin && p.role === "heir");
    return this.updateSession({
      trusteeParticipantId: null,
      captainParticipantId: heirAdmin?.id ?? null,
    });
  }

  /** Heirs plus a captain who also drafts — the people a draft is shared between. */
  async draftParticipantCount(): Promise<number> {
    const roster = await this.listParticipants();
    // administersOnly filter already excludes the trustee since a trustee
    // is always administersOnly=true. Belt-and-braces: also exclude role.
    return roster.filter((p) => !p.administersOnly && p.role !== "trustee").length;
  }

  /** captain locks the heir roster and cataloging opens. */
  async closeRegistration(): Promise<Session> {
    const s = await this.getSession();
    if (!registrationOpen(s.phase)) {
      throw Object.assign(new Error("Registration is already closed."), { status: 409 });
    }
    if (s.phase !== "registration") {
      throw Object.assign(
        new Error("Name the estate before closing registration."),
        { status: 409 },
      );
    }
    const drafters = await this.draftParticipantCount();
    if (drafters < 2) {
      throw Object.assign(new Error("Need at least 2 draft participants"), { status: 400 });
    }
    return this.updateSession({ phase: "intake", registrationClosedAt: Date.now() });
  }

  async listCaptainTransfers(): Promise<CaptainTransfer[]> {
    return db.select().from(captainTransfers).all();
  }

  /**
   * Hand the captain role to an existing heir. The outgoing captain either
   * steps back to being an heir (when they were also drafting) or leaves the
   * roster entirely (when they only administered).
   *
   * Config 2 (trustee runs the session) does NOT go through this path. That
   * is handled by /api/session/mode/trustee and unwound by
   * /api/session/mode/end. Removing the "new_outside_pr" branch closed off
   * an old path that created an outside admin without confirmation.
   */
  async transferPr(opts: {
    actor: Participant;
    mode: "to_existing_heir";
    targetHeirId?: number;
    reason?: string | null;
  }): Promise<{ transfer: CaptainTransfer; newCaptain: Participant }> {
    const s = await this.getSession();
    const outgoing = opts.actor;
    const roster = await this.listParticipants();
    let incoming: Participant;

    if (opts.mode === "to_existing_heir") {
      const target = roster.find((p) => p.id === opts.targetHeirId);
      if (!target) {
        throw Object.assign(new Error("Choose an heir to take the role."), { status: 400 });
      }
      if (target.id === outgoing.id) {
        throw Object.assign(new Error("You already hold the captain role."), { status: 400 });
      }
      if (target.isAdmin) {
        throw Object.assign(new Error("That person already administers."), { status: 400 });
      }
      // They were an heir, so they keep drafting: captain-heir, not a pure captain.
      incoming = (await this.updateParticipant(target.id, {
        isAdmin: true,
        administersOnly: false,
      }))!;
    } else {
      // Only "to_existing_heir" is supported. An outside captain is the trustee
      // and is set through /api/session/mode/trustee, not through this transfer path.
      throw Object.assign(
        new Error(
          "An outside captain must be set through the trustee handoff. Transfer only hands the role to an existing heir.",
        ),
        { status: 400 },
      );
    }

    const disposition: "became_heir" | "removed" = outgoing.administersOnly
      ? "removed"
      : "became_heir";
    if (disposition === "became_heir") {
      await this.updateParticipant(outgoing.id, { isAdmin: false, administersOnly: false });
    } else {
      await this.deleteParticipant(outgoing.id);
    }

    const transfer = db
      .insert(captainTransfers)
      .values({
        id: randomUUID(),
        sessionId: s.id,
        previousCaptainParticipantId: outgoing.id,
        newCaptainParticipantId: incoming.id,
        transferredAt: Date.now(),
        previousCaptainDisposition: disposition,
        reason: opts.reason?.trim() || null,
        previousCaptainName: outgoing.name,
        newCaptainName: incoming.name,
      })
      .returning()
      .get();

    return { transfer, newCaptain: incoming };
  }

  /** True while the estate has no captain or no name yet. */
  async bootstrapIncomplete(): Promise<boolean> {
    return (await this.bootstrapStatus()).incomplete;
  }

  /** The same question, with the reasons spelled out for the interface. */
  async bootstrapStatus() {
    const s = await this.getSession();
    const roster = await this.listParticipants();
    const admins = roster.filter((p) => p.isAdmin).length;
    const reasons: string[] = [];
    if (admins < 1) reasons.push("Tell us your name to begin.");
    else if (!s.estateName) reasons.push("Name this estate.");
    else if (registrationOpen(s.phase) && roster.filter((p) => !p.administersOnly).length < 2)
      reasons.push("Register at least two people who will take part in the draft.");
    return {
      incomplete: registrationOpen(s.phase) && reasons.length > 0,
      participants: roster.length,
      admins,
      reasons,
    };
  }

  /**
   * captain closes cataloguing and opens the ranking window.
   *
   * v14 Trustee Handoff precondition: every non-admin heir on the roster must
   * have a Method Agreement on file before ranking may open. This is the
   * up-front buy-in that lets FairPlay hand items off to the trustee
   * without collecting per-item consent later. Enforced inline (rather than
   * calling `fiduciary.allHeirsHaveMethodAgreement`) to avoid a circular
   * import between storage.ts and fiduciary/fiduciaryStorage.ts.
   */
  async markInventoryComplete(): Promise<Session> {
    const s = await this.getSession();
    if (s.phase !== "intake") {
      throw Object.assign(new Error("Cataloging is not the current phase."), { status: 409 });
    }
    const roster = await this.listParticipants();
    const heirs = roster.filter((p) => !p.administersOnly);
    if (heirs.length === 0) {
      throw Object.assign(
        new Error("No heirs on the roster. Add heirs before opening ranking."),
        { status: 409 },
      );
    }
    const signed = db
      .select({ participantId: methodAgreements.participantId })
      .from(methodAgreements)
      .where(eq(methodAgreements.sessionId, s.id))
      .all();
    const signedSet = new Set(signed.map((r) => r.participantId));
    const missing = heirs.filter((h) => !signedSet.has(h.id));
    if (missing.length > 0) {
      const names = missing.map((h) => h.name).join(", ");
      throw Object.assign(
        new Error(
          `Cannot open ranking — Method Agreement not yet signed by: ${names}. Every heir must sign the up-front agreement before ranking begins.`,
        ),
        { status: 409 },
      );
    }
    return this.updateSession({
      phase: "ranking",
      inventoryCompletedAt: Date.now(),
      ...this.openWindowPatch("ranking"),
    });
  }

  /** captain reopens cataloguing after marking it complete by mistake. */
  async reopenInventory(): Promise<Session> {
    const s = await this.getSession();
    if (s.phase !== "ranking") {
      throw Object.assign(
        new Error("Only a session sitting in Ranking can be sent back to Cataloging."),
        { status: 409 },
      );
    }
    return this.updateSession({
      phase: "intake",
      inventoryCompletedAt: null,
      rankingOpenedAt: null,
      rankingDeadline: null,
    });
  }

  /** Who contributed how many items to the catalogue. */
  async catalogingStatus() {
    const s = await this.getSession();
    const roster = await this.listParticipants();
    const all = (await this.listItems()).filter((i) => !i.isPractice);
    const byContributor = [
      {
        participantId: null as number | null,
        name: "the captain",
        count: all.filter((i) => i.createdByParticipantId === null).length,
        isCaptain: true,
      },
      ...roster.map((p) => ({
        participantId: p.id as number | null,
        name: p.name,
        count: all.filter((i) => i.createdByParticipantId === p.id).length,
        isCaptain: !!p.isAdmin,
      })),
    ].filter((r) => r.count > 0 || r.participantId !== null);
    return {
      phase: s.phase,
      total: all.length,
      complete: !!s.inventoryCompletedAt,
      completedAt: s.inventoryCompletedAt ?? null,
      totalItems: all.length,
      withPhotos: all.filter((i) => !!i.photoUrl).length,
      unroomed: all.filter((i) => !i.room).length,
      heirsCanAddInventory: !!s.heirsCanAddInventory,
      inventoryCompletedAt: s.inventoryCompletedAt ?? null,
      contributors: byContributor,
    };
  }

  /* ---------------- items ---------------- */
  async listItems(): Promise<Item[]> {
    return db.select().from(items).all();
  }

  async createItem(i: Omit<InsertItem, "sessionId">): Promise<Item> {
    const s = await this.getSession();
    return db
      .insert(items)
      .values({ ...i, sessionId: s.id, addedDuringDraft: s.phase === "draft" })
      .returning()
      .get();
  }

  async updateItem(id: number, patch: Partial<Item>) {
    db.update(items).set(patch).where(eq(items.id, id)).run();
    return db.select().from(items).where(eq(items.id, id)).get();
  }

  async deleteItem(id: number) {
    db.delete(items).where(eq(items.id, id)).run();
  }

  /* ---------------- groupings ---------------- */
  async listGroupings(): Promise<Grouping[]> {
    return db.select().from(groupings).all();
  }

  async createGrouping(g: Omit<InsertGrouping, "sessionId">): Promise<Grouping> {
    const s = await this.getSession();
    return db.insert(groupings).values({ ...g, sessionId: s.id }).returning().get();
  }

  async ensureHeirloomGrouping(): Promise<Grouping> {
    const existing = db
      .select()
      .from(groupings)
      .where(eq(groupings.type, "heirloom"))
      .get();
    if (existing) return existing;
    return this.createGrouping({
      name: HEIRLOOM_GROUPING_NAME,
      type: "heirloom",
      status: "open",
      awardedToParticipantId: null,
      resolvedInRound: null,
    });
  }

  async confirmHeirloom(itemId: number, confirmed: boolean) {
    const grouping = await this.ensureHeirloomGrouping();
    if (confirmed) {
      db.update(items)
        .set({ isHeirloomConfirmed: true, groupingId: grouping.id, status: "in_grouping" })
        .where(eq(items.id, itemId))
        .run();
    } else {
      db.update(items)
        .set({
          isHeirloomConfirmed: false,
          isHeirloomCandidate: false,
          groupingId: null,
          status: "available",
        })
        .where(eq(items.id, itemId))
        .run();
    }
    return db.select().from(items).where(eq(items.id, itemId)).get();
  }

  async listOptIns(): Promise<GroupingOptIn[]> {
    return db.select().from(groupingOptIns).all();
  }

  async setOptIn(groupingId: number, participantId: number, choice: string) {
    const existing = db
      .select()
      .from(groupingOptIns)
      .where(
        and(
          eq(groupingOptIns.groupingId, groupingId),
          eq(groupingOptIns.participantId, participantId),
        ),
      )
      .get();
    if (existing) {
      db.update(groupingOptIns)
        .set({ choice })
        .where(eq(groupingOptIns.id, existing.id))
        .run();
      return db.select().from(groupingOptIns).where(eq(groupingOptIns.id, existing.id)).get()!;
    }
    return db
      .insert(groupingOptIns)
      .values({ groupingId, participantId, choice })
      .returning()
      .get();
  }

  private async priorityIndex(): Promise<Record<number, number>> {
    const s = await this.getSession();
    const order: number[] = JSON.parse(s.priorityOrder || "[]");
    const map: Record<number, number> = {};
    order.forEach((id, idx) => (map[id] = idx));
    return map;
  }

  /**
   * Resolve a grouping.
   *  - all heirs pass  -> broken up, items return to the ordinary pool
   *  - exactly one want -> uncontested award
   *  - more than one    -> tiebreak (does NOT touch the regular contested-loss counter)
   */
  async resolveGrouping(groupingId: number) {
    const s = await this.getSession();
    const grouping = db.select().from(groupings).where(eq(groupings.id, groupingId)).get();
    if (!grouping) throw new Error("Grouping not found");
    const groupItems = db.select().from(items).where(eq(items.groupingId, groupingId)).all();
    const optIns = db
      .select()
      .from(groupingOptIns)
      .where(eq(groupingOptIns.groupingId, groupingId))
      .all();
    const wanters = optIns.filter((o) => o.choice === "want").map((o) => o.participantId);

    if (wanters.length === 0) {
      for (const it of groupItems) {
        db.update(items)
          .set({ groupingId: null, status: "available" })
          .where(eq(items.id, it.id))
          .run();
      }
      db.update(groupings)
        .set({ status: "resolved_broken_up", resolvedInRound: s.currentRound })
        .where(eq(groupings.id, groupingId))
        .run();
      return {
        grouping: db.select().from(groupings).where(eq(groupings.id, groupingId)).get()!,
        message: `All heirs passed — "${grouping.name}" was broken up and its ${groupItems.length} item(s) returned to the ordinary draft pool.`,
      };
    }

    let winner = wanters[0];
    let message = "";
    if (wanters.length === 1) {
      message = `Uncontested — awarded to the only interested heir.`;
    } else {
      // Tiebreak: highest contested-loss counter wins, ties broken by priority order.
      const prio = await this.priorityIndex();
      const rows = wanters.map((id) => db.select().from(participants).where(eq(participants.id, id)).get()!);
      rows.sort((a, b) => {
        if (b.contestedLossCounter !== a.contestedLossCounter)
          return b.contestedLossCounter - a.contestedLossCounter;
        return (prio[a.id] ?? 99) - (prio[b.id] ?? 99);
      });
      winner = rows[0].id;
      // Record tiebreak picks. Losses here NEVER affect the regular-draft counter.
      for (const it of groupItems.slice(0, 1)) {
        for (const p of rows) {
          db.insert(picks)
            .values({
              sessionId: s.id,
              round: s.currentRound,
              participantId: p.id,
              itemId: it.id,
              pickOrder: 1,
              outcome: p.id === winner ? "awarded" : "lost_contest",
              isTiebreak: true,
              affectsRegularDraftCounter: false,
            })
            .run();
        }
      }
      message = `Tiebreak between ${rows.length} heirs — counters untouched (groupings tiebreak losses do not affect the regular draft).`;
    }

    for (const it of groupItems) {
      db.update(items)
        .set({
          status: "awarded",
          awardedToParticipantId: winner,
          awardedInRound: s.currentRound,
          draftPhase: s.phase === "secondary_draft" ? "secondary" : "primary",
        })
        .where(eq(items.id, it.id))
        .run();
    }
    db.update(groupings)
      .set({
        status: "resolved_awarded",
        awardedToParticipantId: winner,
        resolvedInRound: s.currentRound,
      })
      .where(eq(groupings.id, groupingId))
      .run();

    return {
      grouping: db.select().from(groupings).where(eq(groupings.id, groupingId)).get()!,
      message,
    };
  }

  /* ---------------- high value ---------------- */
  async listAppraisalFlags(): Promise<AppraisalFlag[]> {
    return db.select().from(appraisalFlags).all();
  }

  async flagForAppraisal(input: {
    itemId: number;
    source: "heir" | "owner" | "ai" | "category";
    participantId: number | null;
    reason: string | null;
  }) {
    const s = await this.getSession();
    // Idempotent: an active (not-reverted) row for this item wins. A row
    // that was previously reverted stays in the audit trail; we insert a
    // fresh escalation on top of it.
    const existing = db
      .select()
      .from(appraisalFlags)
      .where(eq(appraisalFlags.itemId, input.itemId))
      .all();
    const active = existing.find((r) => r.revertedAt == null);
    if (active) return active;

    const inserted = db
      .insert(appraisalFlags)
      .values({
        sessionId: s.id,
        itemId: input.itemId,
        flaggedBySource: input.source,
        flaggedByParticipantId: input.source === "heir" ? input.participantId : null,
        reason: input.reason ?? null,
      })
      .returning()
      .get();

    db.update(items).set({ status: "needs_appraisal", needsAppraisal: true }).where(eq(items.id, input.itemId)).run();
    return inserted;
  }

  async unflagAppraisal(input: { nominationId: number; captainId: number }) {
    const nom = db
      .select()
      .from(appraisalFlags)
      .where(eq(appraisalFlags.id, input.nominationId))
      .get();
    if (!nom) return undefined;
    if (nom.flaggedBySource === "owner") return undefined; // permanent
    if (nom.revertedAt != null) return undefined; // already reverted

    db.update(appraisalFlags)
      .set({ revertedAt: Date.now(), revertedByCaptainId: input.captainId })
      .where(eq(appraisalFlags.id, input.nominationId))
      .run();
    // Item returns to the pool. needsAppraisal flips off so ranking/draft picks
    // it back up cleanly. Any prior needsAppraisal set by other means (e.g.
    // a stale needsAppraisal=true from an older code path) is intentionally
    // cleared here — the captain's undo is authoritative.
    db.update(items)
      .set({ status: "available", needsAppraisal: false })
      .where(eq(items.id, nom.itemId))
      .run();
    return db
      .select()
      .from(appraisalFlags)
      .where(eq(appraisalFlags.id, input.nominationId))
      .get();
  }

  /**
   * Money formatter for reason strings. Compact and unambiguous:
   *   1234  -> "$1,234"
   *   1234567 -> "$1,234,567"
   * Never uses decimals — the AI's estimate doesn't warrant that precision.
   */
  private fmtEstimate(n: number): string {
    const rounded = Math.round(n);
    return "$" + rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  /**
   * Look up a category's appraisal-rule metadata. Case- and label-tolerant
   * (leading/trailing whitespace ignored). Returns null for unrecognized
   * labels, which is intentional: an unknown category never auto-flags.
   */
  private categoryRuleFor(label: string | null): { label: string; appraisalLikely: boolean } | null {
    if (!label) return null;
    const wanted = label.trim().toLowerCase();
    const hit = LEGAL_CATEGORIES.find((c) => c.label.toLowerCase() === wanted);
    return hit ? { label: hit.label, appraisalLikely: hit.appraisalLikely } : null;
  }

  async autoFlagAfterAiAnalysis(
    itemId: number,
    analysis: { estimatedValueUsd: number | null; category: string | null },
  ): Promise<number> {
    const item = db.select().from(items).where(eq(items.id, itemId)).get();
    if (!item) return 0;
    // Practice items never enter the trustee queue — they aren't real.
    if (item.isPractice) return 0;

    // If an active flag already exists, both rules are no-ops. flagForAppraisal
    // is itself idempotent, but skipping avoids two DB round-trips.
    const anyActive = db
      .select()
      .from(appraisalFlags)
      .where(eq(appraisalFlags.itemId, itemId))
      .all()
      .some((r) => r.revertedAt == null);
    if (anyActive) return 0;

    // A reverted row in the current cycle means "the captain already said no"
    // and we respect that until a threshold change wipes reverts. We check
    // both AI-source AND category-source reverts here so a category flag
    // doesn't come back the instant the AI is re-run either.
    const reverts = db
      .select()
      .from(appraisalFlags)
      .where(eq(appraisalFlags.itemId, itemId))
      .all()
      .filter((r) => r.revertedAt != null);
    const aiRevert = reverts.find((r) => r.flaggedBySource === "ai");
    const categoryRevert = reverts.find((r) => r.flaggedBySource === "category");

    const s = await this.getSession();
    const threshold = s.appraisalThresholdUsd ?? 2000;
    const softFloor = threshold * 0.85;

    let inserted = 0;

    // Rule A — AI estimate crosses the 85% soft floor.
    if (
      analysis.estimatedValueUsd != null &&
      analysis.estimatedValueUsd >= softFloor &&
      !aiRevert
    ) {
      const reason =
        `AI estimate ${this.fmtEstimate(analysis.estimatedValueUsd)} — near your ` +
        `${this.fmtEstimate(threshold)} threshold. Not an official appraisal; the trustee will get a real one.`;
      await this.flagForAppraisal({
        itemId,
        source: "ai",
        participantId: null,
        reason,
      });
      inserted += 1;
    }

    // Rule B — category rule. Only fires when Rule A didn't already create a
    // row (or when the AI-source row is a still-active revert). flagForAppraisal
    // is idempotent, but writing both rows would create noise in the audit
    // trail without adding information.
    const catRule = this.categoryRuleFor(analysis.category ?? item.category ?? null);
    if (inserted === 0 && catRule && catRule.appraisalLikely && !categoryRevert) {
      const reason = `${catRule.label} is on the auto-appraisal list for your family.`;
      await this.flagForAppraisal({
        itemId,
        source: "category",
        participantId: null,
        reason,
      });
      inserted += 1;
    }

    return inserted;
  }

  async rescanAllItemsForAppraisal(): Promise<number> {
    const s = await this.getSession();
    // Clear the AI-source and category-source reverts so this cycle can
    // re-flag items the captain previously waved off. Reverted rows are
    // stamped with a new revertedAt of null? — no. We keep the audit trail:
    // rows remain reverted, but we mark their supersession via a fresh
    // needsAppraisal recompute below. autoFlagAfterAiAnalysis reads reverts
    // from the same table, so simply skipping revert-respect on this pass
    // is enough. We copy the loop inline instead of tweaking
    // autoFlagAfterAiAnalysis, to keep the normal single-item path honest.
    const all = (await this.listItems()).filter((i) => !i.isPractice);
    let created = 0;
    for (const item of all) {
      // Skip items with an active row — they're already on the trustee's list.
      const rows = db
        .select()
        .from(appraisalFlags)
        .where(eq(appraisalFlags.itemId, item.id))
        .all();
      if (rows.some((r) => r.revertedAt == null)) continue;

      const threshold = s.appraisalThresholdUsd ?? 2000;
      const softFloor = threshold * 0.85;

      // Rule A first.
      if (item.aiEstimatedValue != null && item.aiEstimatedValue >= softFloor) {
        const reason =
          `AI estimate ${this.fmtEstimate(item.aiEstimatedValue)} — near your ` +
          `${this.fmtEstimate(threshold)} threshold. Not an official appraisal; the trustee will get a real one.`;
        await this.flagForAppraisal({
          itemId: item.id,
          source: "ai",
          participantId: null,
          reason,
        });
        created += 1;
        continue;
      }

      // Rule B fallback.
      const catRule = this.categoryRuleFor(item.category ?? null);
      if (catRule && catRule.appraisalLikely) {
        const reason = `${catRule.label} is on the auto-appraisal list for your family.`;
        await this.flagForAppraisal({
          itemId: item.id,
          source: "category",
          participantId: null,
          reason,
        });
        created += 1;
      }
    }
    return created;
  }

  /* ---------------- draft ---------------- */
  async listPicks(): Promise<DraftPick[]> {
    return db.select().from(picks).all();
  }

  private async heirs(): Promise<Participant[]> {
    const all = await this.listParticipants();
    return all.filter((p) => !p.administersOnly);
  }

  /** Pick level a participant still owes in the current round (0 = nothing owed). */
  private owedLevel(p: { id: number }, roundPicks: DraftPick[]): number {
    const mine = roundPicks
      .filter((x) => x.participantId === p.id && !x.isTiebreak)
      .sort((a, b) => a.pickOrder - b.pickOrder);
    if (mine.length === 0) return 1;
    const last = mine[mine.length - 1];
    if (last.outcome === "lost_contest" && last.pickOrder < 3) return last.pickOrder + 1;
    return 0;
  }

  async submitPick(
    participantId: number,
    itemId: number,
    highValue = false,
    source: "manual" | "auto_rank" = "manual",
  ): Promise<DraftPick> {
    const s = await this.getSession();
    const all = await this.listPicks();
    const roundPicks = all.filter((p) => p.round === s.currentRound);
    const participant = db
      .select()
      .from(participants)
      .where(eq(participants.id, participantId))
      .get();
    if (!participant) throw new Error("Participant not found");
    const target = db.select().from(items).where(eq(items.id, itemId)).get();
    if (target?.needsAppraisal) {
      throw Object.assign(
        new Error(
          "That item was flagged high-value and is out of the draft pool. Any heir or the trustee may unflag it if the family agrees to return it to the game.",
        ),
        { status: 409 },
      );
    }
    const level = this.owedLevel(participant, roundPicks);
    if (level === 0) throw new Error("You have no pick to submit in this round");
    const dup = roundPicks.find(
      (p) => p.participantId === participantId && p.pickOrder === level && !p.isTiebreak,
    );
    if (dup) throw new Error("Pick already submitted");
    return db
      .insert(picks)
      .values({
        sessionId: s.id,
        round: s.currentRound,
        participantId,
        itemId,
        pickOrder: level,
        outcome: "pending",
        isTiebreak: false,
        // High-value round losses never shift the ordinary-draft counter.
        affectsRegularDraftCounter: !highValue,
        source,
      })
      .returning()
      .get();
  }

  async revealRound() {
    const s = await this.getSession();
    const awardPhase = s.phase === "secondary_draft" ? "secondary" : "primary";
    const log: string[] = [];
    const all = await this.listPicks();
    // Practice picks are excluded here as a second lock, not the first one. The
    // routes already send a reveal to `revealPracticeRound` whenever a rehearsal
    // is running, and `endPractice` deletes every practice row. But this is the
    // function that awards real heirlooms and increments real contested-loss
    // counters, so it does not rely on either of those holding. If a rehearsal
    // ever ended half-way — a crash between clearing the mode and deleting the
    // rows — a pretend pick must not be able to award a real thing.
    const roundPicks = all.filter(
      (p) => p.round === s.currentRound && !p.isTiebreak && !p.isPractice,
    );
    const pending = roundPicks.filter((p) => p.outcome === "pending");
    if (pending.length === 0) {
      return { resolved: 0, roundComplete: false, log: ["No pending picks to reveal."] };
    }
    const level = Math.min(...pending.map((p) => p.pickOrder));
    const atLevel = pending.filter((p) => p.pickOrder === level);
    const prio = await this.priorityIndex();

    const byItem: Record<number, DraftPick[]> = {};
    for (const p of atLevel) {
      (byItem[p.itemId] ||= []).push(p);
    }

    let resolved = 0;
    for (const [itemIdStr, group] of Object.entries(byItem)) {
      const itemId = Number(itemIdStr);
      const item = db.select().from(items).where(eq(items.id, itemId)).get();
      if (group.length === 1) {
        const p = group[0];
        db.update(picks).set({ outcome: "awarded" }).where(eq(picks.id, p.id)).run();
        db.update(items)
          .set({
            status: "awarded",
            awardedToParticipantId: p.participantId,
            awardedInRound: s.currentRound,
            draftPhase: awardPhase,
          })
          .where(eq(items.id, itemId))
          .run();
        log.push(`${item?.name ?? "Item"} — uncontested, awarded.`);
        resolved++;
      } else {
        const rows = group.map((g) => ({
          pick: g,
          part: db.select().from(participants).where(eq(participants.id, g.participantId)).get()!,
        }));
        rows.sort((a, b) => {
          if (b.part.contestedLossCounter !== a.part.contestedLossCounter)
            return b.part.contestedLossCounter - a.part.contestedLossCounter;
          return (prio[a.part.id] ?? 99) - (prio[b.part.id] ?? 99);
        });
        const winner = rows[0];
        db.update(picks).set({ outcome: "awarded" }).where(eq(picks.id, winner.pick.id)).run();
        db.update(items)
          .set({
            status: "awarded",
            awardedToParticipantId: winner.part.id,
            awardedInRound: s.currentRound,
            draftPhase: awardPhase,
          })
          .where(eq(items.id, itemId))
          .run();
        for (const loser of rows.slice(1)) {
          db.update(picks)
            .set({ outcome: "lost_contest" })
            .where(eq(picks.id, loser.pick.id))
            .run();
          if (loser.pick.affectsRegularDraftCounter) {
            db.update(participants)
              .set({ contestedLossCounter: loser.part.contestedLossCounter + 1 })
              .where(eq(participants.id, loser.part.id))
              .run();
          }
        }
        log.push(
          `${item?.name ?? "Item"} — contested by ${rows.length}. ${winner.part.name} wins; ${rows
            .slice(1)
            .map((r) => r.part.name)
            .join(", ")} +1 contested-loss.`,
        );
        resolved++;
      }
    }

    // Is the round finished? (nobody owes a further pick, nothing pending)
    const after = (await this.listPicks()).filter(
      (p) => p.round === s.currentRound && !p.isTiebreak,
    );
    const heirs = await this.heirs();
    // An heir who owes a pick but has nothing ranked and available simply
    // passes for the round — otherwise the round could never complete.
    const owedHeirs = heirs.filter((h) => this.owedLevel(h, after) > 0);
    const stillOwed: typeof owedHeirs = [];
    for (const h of owedHeirs) {
      if (await this.autoSuggest(h.id)) stillOwed.push(h);
    }
    const stillPending = after.some((p) => p.outcome === "pending");
    const available = (await this.listItems()).filter((i) => i.status === "available");

    let roundComplete = false;
    if (!stillPending && (stillOwed.length === 0 || available.length === 0)) {
      roundComplete = true;
      // rotate priority: P1 goes to the back
      const order: number[] = JSON.parse(s.priorityOrder || "[]");
      const rotated = order.length > 1 ? [...order.slice(1), order[0]] : order;
      const remaining = (await this.listItems()).filter((i) => i.status === "available");
      const rankedIds = new Set(db.select().from(rankings).all().map((r) => r.itemId));
      const rankedRemaining = remaining.filter((i) => rankedIds.has(i.id));

      let nextPhase: string;
      let note: string;
      if (remaining.length === 0) {
        nextPhase = "complete";
        note = "Pool empty — the draft is complete.";
      } else if (rankedRemaining.length > 0) {
        nextPhase = s.phase === "secondary_draft" ? "secondary_draft" : "draft";
        note = `Round ${s.currentRound} complete. Priority rotated.`;
      } else if (s.phase === "secondary_draft") {
        nextPhase = "complete";
        note =
          "No ranked items left in the secondary draft — distribution is complete. Any leftovers are listed on Results.";
      } else {
        nextPhase = "secondary_ranking";
        note = `Primary draft finished. ${remaining.length} item(s) went unranked — moving to Secondary Ranking.`;
      }

      await this.updateSession({
        priorityOrder: JSON.stringify(rotated),
        currentRound: s.currentRound + 1,
        phase: nextPhase,
        ...(nextPhase === "secondary_ranking" ? this.openWindowPatch("secondary_ranking") : {}),
      });
      log.push(note);
    }

    if (roundComplete) {
      const swept = await this.runAutoSubmitSweep();
      for (const line of swept) log.push(line);
    }

    return { resolved, roundComplete, log };
  }

  async startGroupingsRound(): Promise<Session> {
    const s = await this.getSession();
    await this.ensureHeirloomGrouping();
    const heirs = await this.heirs();
    let order: number[] = JSON.parse(s.priorityOrder || "[]");
    if (order.length !== heirs.length) {
      order = shuffle(heirs.map((h) => h.id));
    }
    return this.updateSession({
      phase: "groupings",
      priorityOrder: JSON.stringify(order),
      currentRound: s.currentRound === 0 ? 1 : s.currentRound,
    });
  }

  async startDraft(): Promise<Session> {
    const s = await this.getSession();
    const heirs = await this.heirs();
    let order: number[] = JSON.parse(s.priorityOrder || "[]");
    if (order.length !== heirs.length) {
      order = shuffle(heirs.map((h) => h.id));
    }
    // Any grouping still open at draft start keeps its items reserved; the
    // ordinary pool is everything with status 'available'.
    return this.updateSession({
      phase: "draft",
      priorityOrder: JSON.stringify(order),
      currentRound: Math.max(1, s.currentRound),
    });
  }

  /* ---------------- ranking ---------------- */

  /**
   * Rankings are practice-scoped: while a practice round is running every read
   * and write is redirected into the practice blob, so discarding practice
   * cannot disturb the real rankings.
   */
  private practiceRanksOf(state: PracticeState, participantId: number) {
    return (state.rankings?.[String(participantId)] ?? [])
      .slice()
      .sort((a, b) => a.rank - b.rank);
  }

  private asRankingRows(
    sessionId: number,
    participantId: number,
    rows: { itemId: number; rank: number }[],
  ): Ranking[] {
    return rows.map((r, i) => ({
      id: -(i + 1),
      sessionId,
      participantId,
      itemId: r.itemId,
      rank: r.rank,
      createdAt: 0,
      updatedAt: 0,
    }));
  }

  /** Items an heir is allowed to rank right now (the live pool). */
  private async rankablePool(): Promise<Item[]> {
    const s = await this.getSession();
    const all = await this.listItems();
    if (s.practiceMode !== "off") return this.practicePool(s);
    // High-value items sit out of the ranking and draft pools until the captain
    // reverts the flag.
    const live = all.filter((i) => i.status === "available" && !i.isPractice && !i.needsAppraisal);
    // While a contested stage is open, only that stage's items are in play, so
    // jewelry is not traded against garden tools and the photographs are not
    // lost to someone who spent their picks on furniture. Everything else
    // follows once the stages close.
    const stage = this.openStageLabel(live);
    return stage === null ? live : live.filter((i) => this.sameLabel(i.category, stage));
  }

  /** Case- and space-insensitive label match, as the captain types these by hand. */
  private sameLabel(a: string | null | undefined, b: string): boolean {
    return (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();
  }

  /** The enabled contested stages, in the order their rounds run. */
  private stageRows(): Taxonomy[] {
    return db
      .select()
      .from(taxonomy)
      .all()
      .filter((t) => t.kind === CONTESTED_ROUND_KIND && t.isEnabled)
      .sort((a, b) => a.id - b.id);
  }

  /**
   * The stage currently being divided, or null.
   *
   * A stage is finished the moment it has nothing left in play — which also
   * means a stage that never had any items is skipped rather than presented as
   * an empty round. Null means either no stages are switched on, or they are all
   * done and the general round has begun.
   */
  private openStageLabel(live: Item[]): string | null {
    for (const row of this.stageRows()) {
      if (live.some((i) => this.sameLabel(i.category, row.label))) return row.label;
    }
    return null;
  }

  async listRankings(participantId?: number): Promise<Ranking[]> {
    const s = await this.getSession();
    if (s.practiceMode !== "off") {
      const state = this.practiceStateOf(s);
      if (!state) return [];
      const ids =
        participantId !== undefined
          ? [participantId]
          : Object.keys(state.rankings ?? {}).map(Number);
      return ids.flatMap((pid) =>
        this.asRankingRows(s.id, pid, this.practiceRanksOf(state, pid)),
      );
    }
    const rows = db.select().from(rankings).all();
    const filtered =
      participantId === undefined ? rows : rows.filter((r) => r.participantId === participantId);
    return filtered.sort((a, b) =>
      a.participantId === b.participantId ? a.rank - b.rank : a.participantId - b.participantId,
    );
  }

  /** Replace an heir's whole ordering. Ranks are renumbered 1..n. */
  async replaceRankings(
    participantId: number,
    ranks: { itemId: number; rank: number }[],
    ctx?: RankEditContext,
  ): Promise<Ranking[]> {
    const s = await this.getSession();
    const before = new Map(
      (await this.listRankings(participantId)).map((r) => [r.itemId, r.rank] as const),
    );
    const pool = new Set((await this.rankablePool()).map((i) => i.id));
    const seen = new Set<number>();
    const ordered = ranks
      .slice()
      .sort((a, b) => a.rank - b.rank)
      .filter((r) => {
        if (!pool.has(r.itemId) || seen.has(r.itemId)) return false;
        seen.add(r.itemId);
        return true;
      })
      .map((r, i) => ({ itemId: r.itemId, rank: i + 1 }));

    if (s.practiceMode !== "off") {
      const state = this.practiceStateOf(s);
      if (!state) throw new Error("No practice round is running");
      state.rankings = { ...(state.rankings ?? {}), [String(participantId)]: ordered };
      await this.savePracticeState(state);
      return this.asRankingRows(s.id, participantId, ordered);
    }

    const now = Date.now();
    const run = sqlite.transaction(() => {
      db.delete(rankings).where(eq(rankings.participantId, participantId)).run();
      for (const r of ordered) {
        db.insert(rankings)
          .values({
            sessionId: s.id,
            participantId,
            itemId: r.itemId,
            rank: r.rank,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      }
    });
    run();
    const after = new Map(ordered.map((r) => [r.itemId, r.rank] as const));
    this.logRankEdits(s.id, participantId, before, after, ctx);
    return this.listRankings(participantId);
  }

  /**
   * Write one audit row per item whose rank actually changed. Only edits made
   * with an explicit context are logged: every assist-mode edit, and direct
   * edits the captain makes inside somebody else's list. An heir reordering their
   * own list autosaves without filling the log.
   */
  private logRankEdits(
    sessionId: number,
    participantId: number,
    before: Map<number, number>,
    after: Map<number, number>,
    ctx?: RankEditContext,
  ) {
    if (!ctx) return;
    if (ctx.mode === "self" && ctx.editedBy === participantId) return;
    const now = Date.now();
    const itemIds = new Set<number>(
      Array.from(before.keys()).concat(Array.from(after.keys())),
    );
    const rows: any[] = [];
    for (const itemId of Array.from(itemIds)) {
      const oldRank = before.get(itemId) ?? null;
      const newRank = after.get(itemId) ?? null;
      if (oldRank === newRank) continue;
      rows.push({
        id: randomUUID(),
        sessionId,
        participantId,
        itemId,
        oldRank,
        newRank,
        editedByParticipantId: ctx.editedBy,
        editedAt: now,
        mode: ctx.mode,
        dismissedAt: null,
      });
    }
    if (rows.length === 0) return;
    const run = sqlite.transaction(() => {
      for (const r of rows) db.insert(rankingEditsLog).values(r).run();
    });
    run();
  }

  async listRankingEdits(participantId?: number): Promise<RankingEditLog[]> {
    const rows = db.select().from(rankingEditsLog).all();
    return rows
      .filter((r) => participantId === undefined || r.participantId === participantId)
      .sort((a, b) => b.editedAt - a.editedAt);
  }

  /** The heir has seen the summary — clear every outstanding badge. */
  async dismissRankingEdits(participantId: number): Promise<{ dismissed: number }> {
    const now = Date.now();
    const open = (await this.listRankingEdits(participantId)).filter((r) => !r.dismissedAt);
    for (const r of open) {
      db.update(rankingEditsLog)
        .set({ dismissedAt: now })
        .where(eq(rankingEditsLog.id, r.id))
        .run();
    }
    return { dismissed: open.length };
  }

  /**
   * Name-free, per-item statistics. This is everything a captain who also drafts is
   * allowed to see — no individual heir's rank value ever appears here.
   */
  async rankingAggregate(): Promise<RankingItemStat[]> {
    const [pool, all, heirs] = await Promise.all([
      this.listItems(),
      this.listRankings(),
      this.heirs(),
    ]);
    const heirIds = new Set(heirs.map((h) => h.id));
    const visible = pool.filter((i) => !i.isPractice);
    return visible.map((item) => {
      const ranks = all
        .filter((r) => r.itemId === item.id && heirIds.has(r.participantId))
        .map((r) => r.rank)
        .sort((a, b) => a - b);
      const mid = Math.floor(ranks.length / 2);
      const median =
        ranks.length === 0
          ? null
          : ranks.length % 2
            ? ranks[mid]
            : (ranks[mid - 1] + ranks[mid]) / 2;
      return {
        itemId: item.id,
        name: item.name,
        room: item.room,
        category: item.category,
        status: item.status,
        rankedBy: ranks.length,
        totalHeirs: heirs.length,
        median,
        min: ranks.length ? ranks[0] : null,
        max: ranks.length ? ranks[ranks.length - 1] : null,
        topFive: ranks.filter((r) => r <= 5).length,
      };
    });
  }

  /** Move one item to `newRank`, shifting everything else along. */
  async moveRanking(
    participantId: number,
    itemId: number,
    newRank: number,
    ctx?: RankEditContext,
  ): Promise<Ranking[]> {
    const current = (await this.listRankings(participantId)).map((r) => ({
      itemId: r.itemId,
      rank: r.rank,
    }));
    const without = current.filter((r) => r.itemId !== itemId);
    const target = Math.max(1, Math.min(Math.round(newRank), without.length + 1));
    without.splice(target - 1, 0, { itemId, rank: target });
    return this.replaceRankings(
      participantId,
      without.map((r, i) => ({ itemId: r.itemId, rank: i + 1 })),
      ctx,
    );
  }

  async deleteRanking(
    participantId: number,
    itemId: number,
    ctx?: RankEditContext,
  ): Promise<Ranking[]> {
    const current = await this.listRankings(participantId);
    return this.replaceRankings(
      participantId,
      current.filter((r) => r.itemId !== itemId).map((r, i) => ({ itemId: r.itemId, rank: i + 1 })),
      ctx,
    );
  }

  /** How many items each heir must rank, and who is short. */
  async rankingCompleteness(): Promise<RankCompleteness> {
    const s = await this.getSession();
    const pool = await this.rankablePool();
    const poolIds = new Set(pool.map((i) => i.id));
    const required =
      s.rankDepthMode === "all"
        ? pool.length
        : Math.min(s.rankTopN ?? 20, pool.length);
    const all = await this.listRankings();
    const heirs = await this.heirs();
    const rows = heirs.map((h) => {
      const ranked = all.filter(
        (r) => r.participantId === h.id && poolIds.has(r.itemId),
      ).length;
      const shortfall = Math.max(0, required - ranked);
      return {
        participantId: h.id,
        name: h.name,
        ranked,
        shortfall,
        complete: shortfall === 0,
      };
    });
    return {
      required,
      mode: s.rankDepthMode,
      totalAvailable: pool.length,
      heirs: rows,
      allComplete: rows.every((r) => r.complete),
      underRanked: rows
        .filter((r) => !r.complete)
        .map((r) => ({ participantId: r.participantId, name: r.name, shortfall: r.shortfall })),
    };
  }

  /** The heir's highest-ranked item that is still available this round. */
  async autoSuggest(
    participantId: number,
  ): Promise<{ itemId: number; rank: number; name: string } | null> {
    const s = await this.getSession();
    const mine = await this.listRankings(participantId);
    const pool = await this.rankablePool();
    const byId = new Map(pool.map((i) => [i.id, i]));
    // Skip anything this heir already tried (and lost) in the current round.
    const round = s.practiceMode !== "off" ? this.practiceStateOf(s)?.currentRound ?? 1 : s.currentRound;
    const triedThisRound = new Set(
      (await this.listPicks())
        .filter(
          (p) =>
            p.participantId === participantId &&
            p.round === round &&
            p.isPractice === (s.practiceMode !== "off"),
        )
        .map((p) => p.itemId),
    );
    for (const r of mine) {
      const item = byId.get(r.itemId);
      if (item && !triedThisRound.has(r.itemId)) {
        return { itemId: r.itemId, rank: r.rank, name: item.name };
      }
    }
    return null;
  }

  /**
   * Submit on behalf of every heir who opted into auto-submit and still owes a
   * pick. Returns human-readable log lines for the reveal panel.
   */
  async runAutoSubmitSweep(): Promise<string[]> {
    const s = await this.getSession();
    if (s.practiceMode !== "off") return [];
    if (s.phase !== "draft" && s.phase !== "secondary_draft") return [];
    const log: string[] = [];
    const heirs = (await this.heirs()).filter((h) => h.autoSubmit);
    for (const h of heirs) {
      const roundPicks = (await this.listPicks()).filter(
        (p) => p.round === s.currentRound && !p.isPractice,
      );
      if (this.owedLevel(h, roundPicks) === 0) continue;
      const suggestion = await this.autoSuggest(h.id);
      if (!suggestion) continue;
      try {
        await this.submitPick(h.id, suggestion.itemId, false, "auto_rank");
        log.push(`${h.name} auto-submitted #${suggestion.rank}: ${suggestion.name}.`);
      } catch {
        /* nothing owed or already submitted — nothing to do */
      }
    }
    return log;
  }

  /* ---------------- ranking window ---------------- */

  /** Patch that opens (or re-opens) a ranking window starting now. */
  private openWindowPatch(phase: "ranking" | "secondary_ranking", nowMs = Date.now()) {
    const sessionRow = db.select().from(sessions).all()[0];
    const days =
      (phase === "secondary_ranking"
        ? sessionRow?.secondaryRankingWindowDays
        : sessionRow?.rankingWindowDays) ?? 30;
    const deadline = nowMs + days * DAY_MS;
    return phase === "secondary_ranking"
      ? { secondaryRankingOpenedAt: nowMs, secondaryRankingDeadline: deadline }
      : { rankingOpenedAt: nowMs, rankingDeadline: deadline };
  }

  /** The window that applies to the session's current phase, if any. */
  async activeWindow(): Promise<RankingWindow | null> {
    const s = await this.getSession();
    const wp = windowPhaseOf(s.phase);
    return wp ? rankingWindowOf(s, wp) : null;
  }

  /**
   * True when ranking edits must be refused. Only meaningful during the two
   * ranking phases — during the draft phases ranking stays editable.
   */
  async rankingLocked(): Promise<{ locked: boolean; window: RankingWindow | null }> {
    const s = await this.getSession();
    if (s.practiceMode !== "off") return { locked: false, window: null };
    const wp = windowPhaseOf(s.phase);
    if (!wp) return { locked: false, window: null };
    const w = rankingWindowOf(s, wp);
    return { locked: w.closed, window: w };
  }

  /** Change the window length and recompute the deadline from its open time. */
  async setRankingWindowDays(
    days: number,
    phase?: "ranking" | "secondary_ranking",
  ): Promise<Session> {
    const s = await this.getSession();
    const target = phase ?? windowPhaseOf(s.phase) ?? "ranking";
    if (!Number.isFinite(days)) throw httpError("Enter a number of days", 400);
    const d = Math.round(days);
    if (d < RANKING_WINDOW_MIN_DAYS || d > RANKING_WINDOW_MAX_DAYS) {
      throw httpError(
        `Choose between ${RANKING_WINDOW_MIN_DAYS} and ${RANKING_WINDOW_MAX_DAYS} days.`,
        400,
      );
    }
    const secondary = target === "secondary_ranking";
    const openedAt = secondary ? s.secondaryRankingOpenedAt : s.rankingOpenedAt;
    const patch: Partial<Session> = secondary
      ? { secondaryRankingWindowDays: d }
      : { rankingWindowDays: d };

    // Only recompute while that window is actually open.
    if (openedAt) {
      const deadline = openedAt + d * DAY_MS;
      if (deadline <= Date.now()) {
        throw httpError(
          "This would end ranking in the past. Choose a larger value or extend manually.",
          400,
        );
      }
      Object.assign(
        patch,
        secondary ? { secondaryRankingDeadline: deadline } : { rankingDeadline: deadline },
      );
    }
    return this.updateSession(patch);
  }

  /** Push the deadline out. Defaults to +7 days. */
  async extendRankingWindow(opts: {
    days?: number;
    hours?: number;
    phase?: "ranking" | "secondary_ranking";
    fromNow?: boolean;
  }): Promise<Session> {
    const s = await this.getSession();
    const target = opts.phase ?? windowPhaseOf(s.phase) ?? "ranking";
    const secondary = target === "secondary_ranking";
    const ms =
      opts.days !== undefined || opts.hours !== undefined
        ? (opts.days ?? 0) * DAY_MS + (opts.hours ?? 0) * 60 * 60 * 1000
        : 7 * DAY_MS;
    if (ms <= 0) throw httpError("Enter a positive amount of time", 400);
    const now = Date.now();
    const current = (secondary ? s.secondaryRankingDeadline : s.rankingDeadline) ?? now;
    const next = (opts.fromNow ? now : current) + ms;
    const patch: Partial<Session> = secondary
      ? { secondaryRankingDeadline: next }
      : { rankingDeadline: next };
    // A window that was never opened gets an open stamp so the countdown works.
    if (!(secondary ? s.secondaryRankingOpenedAt : s.rankingOpenedAt)) {
      Object.assign(
        patch,
        secondary ? { secondaryRankingOpenedAt: now } : { rankingOpenedAt: now },
      );
    }
    return this.updateSession(patch);
  }

  /** Lock every heir out immediately. */
  async closeRankingNow(phase?: "ranking" | "secondary_ranking"): Promise<Session> {
    const s = await this.getSession();
    const target = phase ?? windowPhaseOf(s.phase) ?? "ranking";
    const now = Date.now();
    return this.updateSession(
      target === "secondary_ranking"
        ? { secondaryRankingDeadline: now, secondaryRankingOpenedAt: s.secondaryRankingOpenedAt ?? now }
        : { rankingDeadline: now, rankingOpenedAt: s.rankingOpenedAt ?? now },
    );
  }

  /** Re-open a closed window with a fresh 7 days from now. */
  async reopenRanking(phase?: "ranking" | "secondary_ranking"): Promise<Session> {
    const s = await this.getSession();
    const target = phase ?? windowPhaseOf(s.phase) ?? "ranking";
    const secondary = target === "secondary_ranking";
    const deadline = secondary ? s.secondaryRankingDeadline : s.rankingDeadline;
    if (deadline !== null && deadline !== undefined && deadline > Date.now()) {
      throw httpError("Ranking is still open — use Extend instead.", 400);
    }
    return this.extendRankingWindow({ days: 7, phase: target, fromNow: true });
  }

  /* ---------------- phase advancement ---------------- */

  /** The phase that follows `from`, given what the session contains. */
  private async computeNextPhase(from: string): Promise<string> {
    const itemsAll = await this.listItems();
    const available = itemsAll.filter((i) => i.status === "available" && !i.isPractice);
    switch (from) {
      case "welcome":
        return "estate_name";
      case "estate_name":
        return "registration";
      case "setup":
      case "registration":
        return "intake";
      case "intake":
        return "ranking";
      case "ranking": {
        const open = db
          .select()
          .from(groupings)
          .all()
          .filter((g) => g.status === "proposed" || g.status === "open");
        return open.length > 0 ? "groupings" : "draft";
      }
      case "groupings":
        return "draft";
      case "draft":
        return available.length > 0 ? "secondary_ranking" : "complete";
      case "secondary_ranking":
        return "secondary_draft";
      case "secondary_draft":
        return "complete";
      default:
        return "complete";
    }
  }

  /**
   * Advance the session one phase. Leaving a ranking phase requires either
   * every heir meeting the rank requirement, a passed deadline plus `force`,
   * or an explicit captain override.
   */
  async nextPhase(force: boolean): Promise<Session> {
    const s = await this.getSession();
    if (s.practiceMode !== "off") {
      throw httpError("End the practice round before advancing the phase", 400);
    }
    const to = await this.computeNextPhase(s.phase);
    const leavingRanking = s.phase === "ranking" || s.phase === "secondary_ranking";

    if (leavingRanking && !force) {
      const completeness = await this.rankingCompleteness();
      if (!completeness.allComplete) {
        const w = rankingWindowOf(s, s.phase as "ranking" | "secondary_ranking");
        const detail = completeness.underRanked
          .map((u) => `${u.name} needs ${u.shortfall} more rank${u.shortfall === 1 ? "" : "s"}`)
          .join("; ");
        const err: any = httpError(
          w.closed
            ? `The ranking window has closed, but some heirs are under-ranked: ${detail}. Confirm to advance anyway.`
            : `Every heir must rank at least ${completeness.required} item${completeness.required === 1 ? "" : "s"} first — ${detail}.`,
          400,
        );
        err.code = w.closed ? "rank_gate_deadline_passed" : "rank_gate_incomplete";
        err.underRanked = completeness.underRanked;
        err.required = completeness.required;
        err.deadlinePassed = w.closed;
        throw err;
      }
    }

    if (to === "groupings") return this.startGroupingsRound();
    if (to === "draft" || to === "secondary_draft") {
      await this.startDraft();
      if (to === "secondary_draft") await this.updateSession({ phase: "secondary_draft" });
      await this.runAutoSubmitSweep();
      return this.getSession();
    }
    if (to === "ranking" || to === "secondary_ranking") {
      return this.updateSession({ phase: to, ...this.openWindowPatch(to) });
    }
    return this.updateSession({ phase: to });
  }

  /* ---------------- taxonomy ---------------- */
  async listTaxonomy(): Promise<TaxonomyRow[]> {
    await this.getSession();
    const rows = db.select().from(taxonomy).all();
    const all = db.select().from(items).all().filter((i) => !i.isPractice);
    return rows.map((r) => ({
      ...r,
      itemCount: all.filter((i) => (r.kind === "room" ? i.room : i.category) === r.label).length,
    }));
  }

  async addTaxonomy(kind: string, label: string, isEnabled = true): Promise<Taxonomy> {
    const s = await this.getSession();
    const trimmed = label.trim();
    if (!trimmed) throw new Error("A label is required");
    const existing = db
      .select()
      .from(taxonomy)
      .where(and(eq(taxonomy.kind, kind), eq(taxonomy.label, trimmed)))
      .get();
    if (existing) return existing;
    return db
      .insert(taxonomy)
      .values({ sessionId: s.id, kind, label: trimmed, isEnabled, isCustom: true })
      .returning()
      .get();
  }

  /**
   * Free-text "Other…" escape hatch: record any unknown label as a disabled
   * custom row so the captain can enable it later from Administration.
   */
  async ensureTaxonomyLabel(kind: string, label: string) {
    const trimmed = (label ?? "").trim();
    if (!trimmed) return;
    const existing = db
      .select()
      .from(taxonomy)
      .where(and(eq(taxonomy.kind, kind), eq(taxonomy.label, trimmed)))
      .get();
    if (existing) return;
    await this.addTaxonomy(kind, trimmed, false);
  }

  async setTaxonomyEnabled(id: number, isEnabled: boolean): Promise<Taxonomy> {
    const row = db.select().from(taxonomy).where(eq(taxonomy.id, id)).get();
    if (!row) throw new Error("Room or category not found");
    if (!isEnabled) {
      const count = db
        .select()
        .from(items)
        .all()
        .filter(
          (i) => !i.isPractice && (row.kind === "room" ? i.room : i.category) === row.label,
        ).length;
      if (count > 0) {
        const err: any = new Error(
          `Move or merge the ${count} item${count === 1 ? "" : "s"} using this label first.`,
        );
        err.status = 409;
        throw err;
      }
    }
    db.update(taxonomy).set({ isEnabled }).where(eq(taxonomy.id, id)).run();
    return db.select().from(taxonomy).where(eq(taxonomy.id, id)).get()!;
  }

  async deleteTaxonomy(id: number): Promise<void> {
    const row = db.select().from(taxonomy).where(eq(taxonomy.id, id)).get();
    if (!row) return;
    const count = db
      .select()
      .from(items)
      .all()
      .filter((i) => (row.kind === "room" ? i.room : i.category) === row.label).length;
    if (count > 0) {
      const err: any = new Error(
        `Move or merge the ${count} item${count === 1 ? "" : "s"} using this label first.`,
      );
      err.status = 409;
      throw err;
    }
    db.delete(taxonomy).where(eq(taxonomy.id, id)).run();
  }

  /** Rename a taxonomy label and cascade the new name to all items using it. */
  async renameTaxonomy(id: number, newLabel: string): Promise<Taxonomy> {
    const row = db.select().from(taxonomy).where(eq(taxonomy.id, id)).get();
    if (!row) throw new Error("Room or category not found");
    const trimmed = newLabel.trim();
    if (!trimmed) throw new Error("A label is required");
    // Check for duplicate
    const dup = db.select().from(taxonomy)
      .where(and(eq(taxonomy.kind, row.kind), eq(taxonomy.label, trimmed)))
      .get();
    if (dup && dup.id !== id) throw new Error(`A ${row.kind} named "${trimmed}" already exists.`);
    // Update the taxonomy row
    db.update(taxonomy).set({ label: trimmed, isCustom: true }).where(eq(taxonomy.id, id)).run();
    // Cascade to items
    const all = db.select().from(items).all();
    for (const item of all) {
      if (row.kind === "room" && item.room === row.label) {
        db.update(items).set({ room: trimmed }).where(eq(items.id, item.id)).run();
      } else if (row.kind === "category" && item.category === row.label) {
        db.update(items).set({ category: trimmed }).where(eq(items.id, item.id)).run();
      }
    }
    return db.select().from(taxonomy).where(eq(taxonomy.id, id)).get()!;
  }

  /**
   * Merge 2+ rooms (or categories) into one hyphen-joined label. Every item
   * carrying a source label is reassigned and the sources are removed — all in
   * a single SQLite transaction.
   */
  async mergeTaxonomy(kind: string, sourceIds: number[]) {
    const s = await this.getSession();
    const rows = db
      .select()
      .from(taxonomy)
      .where(inArray(taxonomy.id, sourceIds))
      .all()
      .filter((r) => r.kind === kind);
    if (rows.length < 2) throw new Error("Select at least two of the same kind to merge");

    // Block if any source label is tied up in an in-flight groupings round or draft.
    const labels = rows.map((r) => r.label);
    const affected = db
      .select()
      .from(items)
      .all()
      .filter((i) => labels.includes(kind === "room" ? i.room : i.category ?? ""));
    const openGroupings = db.select().from(groupings).where(eq(groupings.status, "open")).all();
    const pendingPicks = db
      .select()
      .from(picks)
      .all()
      .filter((p) => p.outcome === "pending");
    const inFlight = affected.find(
      (i) =>
        (i.groupingId && openGroupings.some((g) => g.id === i.groupingId)) ||
        pendingPicks.some((p) => p.itemId === i.id),
    );
    if (inFlight) {
      const err: any = new Error(
        `"${inFlight.name}" is in an in-flight round. Finish or resolve the round before merging.`,
      );
      err.status = 409;
      throw err;
    }

    // Keep the order the captain sees in the list (id order) for a predictable label.
    const ordered = [...rows].sort((a, b) => sourceIds.indexOf(a.id) - sourceIds.indexOf(b.id));
    const newLabel = ordered.map((r) => r.label).join("-");

    const run = sqlite.transaction(() => {
      for (const it of affected) {
        db.update(items)
          .set(kind === "room" ? { room: newLabel } : { category: newLabel })
          .where(eq(items.id, it.id))
          .run();
      }
      db.delete(taxonomy).where(inArray(taxonomy.id, ordered.map((r) => r.id))).run();
      const dupe = db
        .select()
        .from(taxonomy)
        .where(and(eq(taxonomy.kind, kind), eq(taxonomy.label, newLabel)))
        .get();
      if (dupe) {
        db.update(taxonomy)
          .set({ isEnabled: true, isCustom: true })
          .where(eq(taxonomy.id, dupe.id))
          .run();
        return dupe.id;
      }
      return db
        .insert(taxonomy)
        .values({ sessionId: s.id, kind, label: newLabel, isEnabled: true, isCustom: true })
        .returning()
        .get().id;
    });
    const newId = run() as number;
    return {
      row: db.select().from(taxonomy).where(eq(taxonomy.id, newId)).get()!,
      reassigned: affected.length,
    };
  }

  /* ---------------- practice ---------------- */
  practiceStateOf(s: Session): PracticeState | null {
    if (s.practiceMode === "off" || !s.practiceState) return null;
    try {
      const raw = JSON.parse(s.practiceState) as Partial<PracticeState> & {
        awards?: unknown;
      };
      // Older blobs stored `awards` as an item -> award map and carried no
      // award history. Normalise so the summary always has an array to read.
      const legacyMap =
        raw.awards && !Array.isArray(raw.awards)
          ? (raw.awards as Record<string, { participantId: number; round: number }>)
          : undefined;
      const counters = raw.contestedLossCounters ?? {};
      const roster: PracticeHeir[] = Array.isArray(raw.heirs)
        ? (raw.heirs as PracticeHeir[])
        : // Legacy blob: rebuild the roster from the stored priority order.
          (raw.priorityOrder ?? []).map((id, idx) => ({
            id,
            name:
              db.select().from(participants).where(eq(participants.id, id)).get()?.name ??
              `Participant ${id}`,
            isPlaceholder: false,
            priorityPosition: idx,
            contestedLossCounter: counters[String(id)] ?? 0,
          }));
      return {
        currentRound: raw.currentRound ?? 1,
        heirs: roster,
        priorityOrder: raw.priorityOrder ?? [],
        contestedLossCounters: raw.contestedLossCounters ?? {},
        awardsByItem: raw.awardsByItem ?? legacyMap ?? {},
        awards: Array.isArray(raw.awards) ? (raw.awards as PracticeState["awards"]) : [],
        finalCounters: raw.finalCounters ?? raw.contestedLossCounters ?? {},
        rankings: raw.rankings ?? {},
        phaseBefore: raw.phaseBefore ?? s.phase,
      };
    } catch {
      return null;
    }
  }

  private async savePracticeState(state: PracticeState) {
    // Keep the roster's derived fields in step with the authoritative maps.
    state.heirs = state.heirs.map((h) => ({
      ...h,
      priorityPosition: state.priorityOrder.indexOf(h.id),
      contestedLossCounter: state.contestedLossCounters[String(h.id)] ?? 0,
    }));
    await this.updateSession({ practiceState: JSON.stringify(state) });
  }

  /** The roster of heirs taking part in the running practice round. */
  private rosterOf(state: PracticeState): PracticeHeir[] {
    return state.heirs ?? [];
  }

  /**
   * Begin a rehearsal over pretend items.
   *
   * `mode` is kept as a parameter, pinned to its one legal value, so that each
   * caller reads as a deliberate request for a sample-item rehearsal rather than
   * inheriting whatever a default happens to be. There is no real-inventory
   * rehearsal any more — see the note on `practiceMode` in shared/schema.ts.
   */
  async startPractice(mode: "sample_items", heirCount?: number): Promise<Session> {
    const s = await this.getSession();
    if (s.practiceMode !== "off") throw new Error("A practice round is already running");
    const heirs = await this.heirs();
    if (heirs.length < 1) throw new Error("Add at least one heir before practising");

    // Clean any stale practice rows first.
    db.delete(picks).where(eq(picks.isPractice, true)).run();
    db.delete(items).where(eq(items.isPractice, true)).run();

    void mode;
    {
      for (const sample of PRACTICE_SAMPLE_ITEMS) {
        db.insert(items)
          .values({
            sessionId: s.id,
            name: sample.name,
            room: sample.room,
            category: sample.category,
            notes: "Pretend item — practice round only",
            aiEstimatedValue: sample.aiEstimatedValue,
            estimateSource: "manual",
            photoUrl: null,
            thumbnailUrl: null,
            status: "available",
            awardedToParticipantId: null,
            awardedInRound: null,
            isHeirloomCandidate: false,
            isHeirloomConfirmed: false,
            addedDuringDraft: false,
            groupingId: null,
            duplicateGroupId: null,
            isPractice: true,
          })
          .run();
      }
    }

    // How many heirs run this rehearsal (independent of the real roster).
    const n = Math.max(2, Math.min(8, Math.round(heirCount ?? heirs.length)));
    const roster: PracticeHeir[] = heirs.slice(0, n).map((h, idx) => ({
      id: h.id,
      name: h.name,
      isPlaceholder: false,
      priorityPosition: idx,
      contestedLossCounter: 0,
    }));
    // Fill any shortfall with practice-only placeholder heirs (negative ids).
    for (let k = 0; roster.length < n; k++) {
      roster.push({
        id: -(k + 1),
        name: placeholderHeirName(k),
        isPlaceholder: true,
        priorityPosition: roster.length,
        contestedLossCounter: 0,
      });
    }

    // Reuse the real priority order only when it still covers exactly this
    // roster — a stale order (from a reset or roster change) would leave the
    // practice round with unknown participant ids and no visible turn order.
    let realOrder: number[] = [];
    try {
      realOrder = JSON.parse(s.priorityOrder || "[]");
    } catch {
      realOrder = [];
    }
    const rosterIds = roster.map((h) => h.id);
    const orderIsValid =
      realOrder.length === rosterIds.length && realOrder.every((id) => rosterIds.includes(id));
    const order = orderIsValid ? realOrder : shuffle(rosterIds);
    const zeroed = Object.fromEntries(rosterIds.map((id) => [String(id), 0]));
    const state: PracticeState = {
      currentRound: 1,
      heirs: roster.map((h) => ({ ...h, priorityPosition: order.indexOf(h.id) })),
      priorityOrder: order,
      contestedLossCounters: { ...zeroed },
      awardsByItem: {},
      awards: [],
      finalCounters: { ...zeroed },
      // Practice rankings start empty and are thrown away on discard; the real
      // `rankings` table is never read or written while practice is running.
      rankings: {},
      phaseBefore: s.phase,
    };
    return this.updateSession({ practiceMode: mode, practiceState: JSON.stringify(state) });
  }

  async endPractice(): Promise<Session> {
    const s = await this.getSession();
    const run = sqlite.transaction(() => {
      db.delete(picks).where(eq(picks.isPractice, true)).run();
      db.delete(items).where(eq(items.isPractice, true)).run();
    });
    run();
    void s;
    return this.updateSession({ practiceMode: "off", practiceState: null });
  }

  /** The item pool a practice round draws from. */
  private practicePool(s: Session): Item[] {
    // `s` is no longer consulted to choose between two pools, because there is
    // only one now. It stays in the signature because every caller already holds
    // the session and a future stage-aware rehearsal would want it. A database
    // written by an older build may still record 'real_inventory' here; such a
    // session lands in this branch and gets sample items, which is the safe
    // direction for that mistake to fall.
    void s;
    return db
      .select()
      .from(items)
      .all()
      .filter((i) => i.isPractice);
  }

  async submitPracticePick(participantId: number, itemId: number): Promise<DraftPick> {
    const s = await this.getSession();
    const state = this.practiceStateOf(s);
    if (!state) throw new Error("No practice round is running");
    const roundPicks = db
      .select()
      .from(picks)
      .all()
      .filter((p) => p.isPractice && p.round === state.currentRound);
    const participant = this.rosterOf(state).find((h) => h.id === participantId);
    if (!participant) throw new Error("That heir is not part of this practice round");
    const level = this.owedLevel(participant, roundPicks);
    if (level === 0) throw new Error("You have no pick to submit in this round");
    return db
      .insert(picks)
      .values({
        sessionId: s.id,
        round: state.currentRound,
        participantId,
        itemId,
        pickOrder: level,
        outcome: "pending",
        isTiebreak: false,
        // A rehearsal cannot cost anyone a real turn. The practice reveal keeps
        // its own contested-loss tally inside `practiceState`, so this flag has
        // no effect on the rehearsal itself; setting it false stops the row
        // claiming an authority over the real draft it must never have.
        affectsRegularDraftCounter: false,
        isPractice: true,
      })
      .returning()
      .get();
  }

  /**
   * Reveal a practice round. Awards, counters and priority rotation all land in
   * the shadow `practiceState` blob — no real row is ever touched.
   */
  async revealPracticeRound() {
    const s = await this.getSession();
    const state = this.practiceStateOf(s);
    if (!state) throw new Error("No practice round is running");
    const log: string[] = [];
    const roundPicks = db
      .select()
      .from(picks)
      .all()
      .filter((p) => p.isPractice && p.round === state.currentRound);
    const pending = roundPicks.filter((p) => p.outcome === "pending");
    if (pending.length === 0) {
      return { resolved: 0, roundComplete: false, log: ["No pending practice picks to reveal."] };
    }
    const level = Math.min(...pending.map((p) => p.pickOrder));
    const atLevel = pending.filter((p) => p.pickOrder === level);
    const prio: Record<number, number> = {};
    state.priorityOrder.forEach((id, idx) => (prio[id] = idx));
    const pool = this.practicePool(s);

    const byItem: Record<number, DraftPick[]> = {};
    for (const p of atLevel) (byItem[p.itemId] ||= []).push(p);

    let resolved = 0;
    for (const [itemIdStr, group] of Object.entries(byItem)) {
      const itemId = Number(itemIdStr);
      const item = pool.find((i) => i.id === itemId);
      if (group.length === 1) {
        db.update(picks).set({ outcome: "awarded" }).where(eq(picks.id, group[0].id)).run();
        state.awardsByItem[String(itemId)] = {
          participantId: group[0].participantId,
          round: state.currentRound,
        };
        const winnerPart = this.rosterOf(state).find((h) => h.id === group[0].participantId);
        state.awards.push({
          itemId,
          itemName: item?.name ?? `Item ${itemId}`,
          room: item?.room ?? "",
          category: item?.category ?? "",
          participantId: group[0].participantId,
          participantName: winnerPart?.name ?? "",
          round: state.currentRound,
          wasContested: false,
          losingParticipantIds: [],
          losingParticipantNames: [],
        });
        log.push(`${item?.name ?? "Item"} — uncontested, awarded (practice).`);
      } else {
        const roster = this.rosterOf(state);
        const rows = group.map((g) => ({
          pick: g,
          part: roster.find((h) => h.id === g.participantId)!,
        }));
        rows.sort((a, b) => {
          const ca = state.contestedLossCounters[String(a.part.id)] ?? 0;
          const cb = state.contestedLossCounters[String(b.part.id)] ?? 0;
          if (cb !== ca) return cb - ca;
          return (prio[a.part.id] ?? 99) - (prio[b.part.id] ?? 99);
        });
        const winner = rows[0];
        db.update(picks).set({ outcome: "awarded" }).where(eq(picks.id, winner.pick.id)).run();
        state.awardsByItem[String(itemId)] = {
          participantId: winner.part.id,
          round: state.currentRound,
        };
        state.awards.push({
          itemId,
          itemName: item?.name ?? `Item ${itemId}`,
          room: item?.room ?? "",
          category: item?.category ?? "",
          participantId: winner.part.id,
          participantName: winner.part.name,
          round: state.currentRound,
          wasContested: true,
          losingParticipantIds: rows.slice(1).map((r) => r.part.id),
          losingParticipantNames: rows.slice(1).map((r) => r.part.name),
        });
        for (const loser of rows.slice(1)) {
          db.update(picks).set({ outcome: "lost_contest" }).where(eq(picks.id, loser.pick.id)).run();
          const key = String(loser.part.id);
          state.contestedLossCounters[key] = (state.contestedLossCounters[key] ?? 0) + 1;
        }
        log.push(
          `${item?.name ?? "Item"} — contested by ${rows.length}. ${winner.part.name} wins; ${rows
            .slice(1)
            .map((r) => r.part.name)
            .join(", ")} +1 practice contested-loss.`,
        );
      }
      resolved++;
    }

    const after = db
      .select()
      .from(picks)
      .all()
      .filter((p) => p.isPractice && p.round === state.currentRound);
    const stillOwed = this.rosterOf(state).filter((h) => this.owedLevel(h, after) > 0);
    const stillPending = after.some((p) => p.outcome === "pending");
    const remaining = pool.filter((i) => !state.awardsByItem[String(i.id)]);

    let roundComplete = false;
    if (!stillPending && (stillOwed.length === 0 || remaining.length === 0)) {
      roundComplete = true;
      state.priorityOrder =
        state.priorityOrder.length > 1
          ? [...state.priorityOrder.slice(1), state.priorityOrder[0]]
          : state.priorityOrder;
      state.currentRound += 1;
      log.push(
        remaining.length === 0
          ? "Practice pool empty — the practice draft is complete."
          : `Practice round ${state.currentRound - 1} complete. Priority rotated.`,
      );
    }
    state.finalCounters = { ...state.contestedLossCounters };
    await this.savePracticeState(state);
    return { resolved, roundComplete, log };
  }

  /**
   * Read-only view of everything a practice run produced, for the Practice
   * Results summary. Returns null when no practice round is running.
   */

  /**
   * Report which contested stage is in play, in language a family can read.
   *
   * This is a read-only view assembled from the taxonomy rows and the items; no
   * stage state is stored anywhere, so this can never disagree with the pool the
   * heirs are actually ranking. That is the whole reason it is computed rather
   * than tracked.
   */
  async stageProgress(): Promise<StageProgress> {
    await this.getSession();
    const all = (await this.listItems()).filter((i) => !i.isPractice);
    const rows = this.stageRows();

    const lineFor = (label: string, members: Item[]): StageLine => {
      const heldBack = members.filter((i) => i.needsAppraisal && i.status === "available").length;
      const remaining = members.filter((i) => i.status === "available" && !i.needsAppraisal).length;
      return {
        label,
        total: members.length,
        // Anything not still available has gone to someone. Held-back items are
        // counted separately above and excluded here so the four numbers add up.
        awarded: members.length - remaining - heldBack,
        remaining,
        heldBack,
      };
    };

    const staged = rows.map((r) => lineFor(r.label, all.filter((i) => this.sameLabel(i.category, r.label))));
    const general = lineFor(
      "Everything else",
      all.filter((i) => !rows.some((r) => this.sameLabel(i.category, r.label))),
    );

    if (rows.length === 0) {
      return {
        usingStages: false,
        open: null,
        finished: [],
        waiting: [],
        general,
        headline:
          general.remaining > 0
            ? `Everything is being divided together — ${general.remaining} ${general.remaining === 1 ? "thing" : "things"} still to go.`
            : "Everything has been divided.",
      };
    }

    const openIndex = staged.findIndex((l) => l.remaining > 0);
    const open = openIndex === -1 ? null : staged[openIndex];
    const finished = staged.filter((l, k) => l.remaining === 0 && (openIndex === -1 || k < openIndex));
    const waiting = openIndex === -1 ? [] : staged.slice(openIndex + 1).filter((l) => l.remaining > 0);

    let headline: string;
    if (open) {
      const n = open.remaining;
      headline = `Now dividing: ${open.label} — ${n} ${n === 1 ? "thing" : "things"} still to choose.`;
    } else if (general.remaining > 0) {
      const n = general.remaining;
      headline = `The ${staged.length === 1 ? "special round" : "special rounds"} are finished. Now everything else — ${n} ${n === 1 ? "thing" : "things"} still to choose.`;
    } else {
      headline = "Everything has been divided.";
    }

    return { usingStages: true, open, finished, waiting, general, headline };
  }


  async practiceResults(): Promise<PracticeResults | null> {
    const s = await this.getSession();
    const state = this.practiceStateOf(s);
    if (!state) return null;
    const all = await this.listParticipants();
    const roster = this.rosterOf(state);
    const nameOf = (id: number) =>
      roster.find((h) => h.id === id)?.name ??
      all.find((p) => p.id === id)?.name ??
      `Participant ${id}`;
    return {
      mode: s.practiceMode,
      currentRound: state.currentRound,
      awards: state.awards.map((a) => ({
        ...a,
        participantName: a.participantName || nameOf(a.participantId),
        losingParticipantNames:
          a.losingParticipantNames?.length === a.losingParticipantIds.length
            ? a.losingParticipantNames
            : a.losingParticipantIds.map(nameOf),
      })),
      counters: roster.map((h) => ({
        participantId: h.id,
        name: h.name,
        isPlaceholder: h.isPlaceholder,
        practiceContestedLosses: state.finalCounters[String(h.id)] ?? 0,
        realContestedLossCounter: h.isPlaceholder
          ? 0
          : (all.find((p) => p.id === h.id)?.contestedLossCounter ?? 0),
      })),
      priorityOrder: state.priorityOrder.map((id) => ({
        participantId: id,
        name: nameOf(id),
        isPlaceholder: roster.find((h) => h.id === id)?.isPlaceholder ?? false,
      })),
    };
  }

  /**
   * The single read the client uses. In practice mode every value the heirs see
   * is drawn from the shadow state; the underlying rows are returned untouched.
   */
  async getClientState() {
    await this.maybeFlagStalledReconciliation();
    const session = await this.getSession();
    const allParticipants = await this.listParticipants();
    const allItems = await this.listItems();
    const allPicks = await this.listPicks();
    const base = {
      session,
      participants: allParticipants,
      groupings: await this.listGroupings(),
      optIns: await this.listOptIns(),
      nominations: await this.listAppraisalFlags(),
      duplicateGroups: await this.listDuplicateGroups(),
      // Counts only — individual orderings stay private to their heir and the captain.
      rankSummary: await this.rankingCompleteness(),
      rankingWindow: rankingWindowOf(session, "ranking"),
      secondaryRankingWindow: rankingWindowOf(session, "secondary_ranking"),
      reconciliation: await this.reconciliationStatus(),
      cataloging: await this.catalogingStatus(),
      categorization: await this.categorizationStatus(),
      bootstrapIncomplete: await this.bootstrapStatus(),
      serverNow: Date.now(),
    };
    const state = this.practiceStateOf(session);
    if (!state) {
      return {
        ...base,
        items: allItems.filter((i) => !i.isPractice),
        picks: allPicks.filter((p) => !p.isPractice),
      };
    }
    const pool = this.practicePool(session);
    return {
      ...base,
      session: {
        ...session,
        phase: "draft",
        currentRound: state.currentRound,
        priorityOrder: JSON.stringify(state.priorityOrder),
      },
      // Sign-in tiles and the draft show exactly the practice roster. Real
      // heirs left out of this rehearsal are hidden until practice ends; the captain
      // is always kept so administration stays reachable.
      participants: [
        ...this.rosterOf(state).map((h) => {
          const real = allParticipants.find((p) => p.id === h.id);
          return {
            id: h.id,
            sessionId: session.id,
            name: h.name,
            isAdmin: real?.isAdmin ?? false,
            administersOnly: false,
            contestedLossCounter: state.contestedLossCounters[String(h.id)] ?? 0,
            seatOrder: real?.seatOrder ?? 100 + h.priorityPosition,
            autoSubmit: real?.autoSubmit ?? false,
            allowsCaptainAssist: real?.allowsCaptainAssist ?? false,
          } as Participant;
        }),
        ...allParticipants
          .filter((p) => !this.rosterOf(state).some((h) => h.id === p.id))
          .filter((p) => p.isAdmin || p.administersOnly)
          .map((p) => ({ ...p, administersOnly: true })),
      ],
      items: pool.map((i) => {
        const award = state.awardsByItem[String(i.id)];
        return award
          ? {
              ...i,
              status: "awarded",
              awardedToParticipantId: award.participantId,
              awardedInRound: award.round,
            }
          : { ...i, status: "available", awardedToParticipantId: null, awardedInRound: null };
      }),
      picks: allPicks.filter((p) => p.isPractice),
    };
  }

  /* ================================================================= */
  /* notifications                                                     */
  /* ================================================================= */

  async listNotifications(participantId: number, limit = 60): Promise<AppNotification[]> {
    return db
      .select()
      .from(notifications)
      .where(eq(notifications.participantId, participantId))
      .all()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  async notify(
    participantId: number,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<AppNotification> {
    const s = await this.getSession();
    return db
      .insert(notifications)
      .values({
        sessionId: s.id,
        participantId,
        type,
        payload: JSON.stringify(payload),
        createdAt: Date.now(),
      })
      .returning()
      .get();
  }

  async getNotification(id: number): Promise<AppNotification | undefined> {
    return db.select().from(notifications).where(eq(notifications.id, id)).get();
  }

  async markNotificationRead(id: number): Promise<AppNotification | undefined> {
    db.update(notifications).set({ readAt: Date.now() }).where(eq(notifications.id, id)).run();
    return db.select().from(notifications).where(eq(notifications.id, id)).get();
  }

  async markAllNotificationsRead(participantId: number): Promise<{ marked: number }> {
    const unread = (await this.listNotifications(participantId, 500)).filter((n) => !n.readAt);
    for (const n of unread) {
      db.update(notifications).set({ readAt: Date.now() }).where(eq(notifications.id, n.id)).run();
    }
    return { marked: unread.length };
  }

  /* ================================================================= */
  /* classification flags                                              */
  /* ================================================================= */

  /** Flag name as heirs know it -> the column that actually stores it. */
  private flagColumn(flag: ClassificationFlag): "isHeirloomCandidate" | "needsAppraisal" | "isSentimental" {
    if (flag === "isHeirloom") return "isHeirloomCandidate";
    if (flag === "needsAppraisal") return "needsAppraisal";
    return "isSentimental";
  }

  /* ================================================================= */
  /* v6 — categories                                                   */
  /* ================================================================= */

  /** Empty strings and whitespace all mean the same thing: no category. */
  private normalizeCategory(raw: string | null | undefined): string | null {
    if (raw === null || raw === undefined) return null;
    const t = String(raw).trim();
    return t === "" ? null : t;
  }

  async listCategoryChanges(itemId?: number): Promise<CategoryChange[]> {
    const rows = itemId
      ? db.select().from(categoryChanges).where(eq(categoryChanges.itemId, itemId)).all()
      : db.select().from(categoryChanges).all();
    return rows.sort((a, b) => b.changedAt - a.changedAt);
  }

  /** How many category edits this participant has made in the given window. */
  async categoryChangesSince(participantId: number | null, sinceMs: number): Promise<number> {
    const cutoff = Date.now() - sinceMs;
    return db
      .select()
      .from(categoryChanges)
      .all()
      .filter(
        (r) =>
          r.changedAt >= cutoff &&
          (r.changedByParticipantId ?? null) === (participantId ?? null) &&
          // Machine assignments are not the human flooding the table.
          r.source !== "ai_auto",
      ).length;
  }

  /**
   * True when this participant has crossed the soft floodguard. The caller
   * warns rather than blocks: a burst of tidying is legitimate, it just wants
   * to be visible.
   */
  async categoryRateExceeded(participantId: number | null): Promise<boolean> {
    const n = await this.categoryChangesSince(participantId, CATEGORY_RATE_WINDOW_MS);
    return n >= CATEGORY_RATE_LIMIT;
  }

  /**
   * Assign, change, or clear an item's category.
   *
   * Last write wins. When a different participant touched the same item
   * inside the conflict window the item is marked for discussion instead of
   * anyone being refused — the family sorts it out in words, not in software.
   */
  async setItemCategory(
    itemId: number,
    categoryRaw: string | null,
    actorId: number | null,
    source: CategoryChangeSource = "user",
  ): Promise<CategoryWriteResult> {
    const s = await this.getSession();
    const item = db.select().from(items).where(eq(items.id, itemId)).get();
    if (!item) throw Object.assign(new Error("Item not found"), { status: 404 });

    const next = this.normalizeCategory(categoryRaw);
    const prev = this.normalizeCategory(item.category);
    if (next === prev) {
      return { item, change: null, notified: 0, conflict: !!item.needsDiscussion };
    }

    // Did somebody else just categorise this very item?
    const recent = (await this.listCategoryChanges(itemId)).find(
      (r) =>
        Date.now() - r.changedAt <= CATEGORY_CONFLICT_WINDOW_MS &&
        (r.changedByParticipantId ?? null) !== (actorId ?? null) &&
        r.source !== "ai_auto",
    );
    const conflict = !!recent;

    if (next) await this.ensureTaxonomyLabel("category", next);

    const patch: Record<string, unknown> = {
      category: next,
      needsDiscussion: conflict ? true : !!item.needsDiscussion,
    };
    if (source === "ai_auto") {
      patch.aiCategorySource = "auto";
    } else if (source === "reviewed_by_heir" || source === "reviewed_by_pr") {
      patch.aiCategorySource = "reviewed";
    } else {
      patch.aiCategorySource = "user";
      patch.aiCategoryConfidence = null;
    }
    db.update(items).set(patch).where(eq(items.id, itemId)).run();

    const change = db
      .insert(categoryChanges)
      .values({
        sessionId: s.id,
        itemId,
        oldCategory: prev,
        newCategory: next,
        changedByParticipantId: actorId,
        changedAt: Date.now(),
        source,
        phase: s.phase,
      })
      .returning()
      .get();

    const roster = await this.listParticipants();
    const actor = actorId === null ? null : roster.find((p) => p.id === actorId) ?? null;
    const actorName =
      source === "ai_auto" ? "Automatic sorting" : actor?.name ?? "The captain";

    const notified = await this.fanOutCategory(change, item.name, actorName, roster, s.phase, conflict);

    const fresh = db.select().from(items).where(eq(items.id, itemId)).get()!;
    return { item: fresh, change, notified, conflict };
  }

  /**
   * Mirror of the v4 classification fan-out: during the ranking phases a
   * category change reshapes what other heirs are looking at, so everyone
   * else hears about it. Automatic assignments stay quiet.
   */
  private async fanOutCategory(
    change: CategoryChange,
    itemName: string,
    actorName: string,
    roster: Participant[],
    phase: string,
    needsDiscussion: boolean,
  ): Promise<number> {
    if (change.source === "ai_auto") return 0;
    if (!(CLASSIFICATION_FANOUT_PHASES as readonly string[]).includes(phase)) return 0;
    const payload: CategoryChangedPayload = {
      changeId: change.id,
      itemId: change.itemId,
      itemName,
      oldCategory: change.oldCategory ?? null,
      newCategory: change.newCategory ?? null,
      changedByParticipantId: change.changedByParticipantId ?? null,
      changedByParticipantName: actorName,
      source: change.source as CategoryChangeSource,
      needsDiscussion,
    };
    let count = 0;
    for (const p of roster) {
      if (change.changedByParticipantId !== null && p.id === change.changedByParticipantId) continue;
      await this.notify(p.id, "category_changed", {
        ...payload,
        message: categorySentence(payload),
      } as unknown as Record<string, unknown>);
      count++;
    }
    return count;
  }

  /** The family talked it over; take the amber badge off. */
  async clearNeedsDiscussion(itemId: number): Promise<Item> {
    db.update(items).set({ needsDiscussion: false }).where(eq(items.id, itemId)).run();
    const fresh = db.select().from(items).where(eq(items.id, itemId)).get();
    if (!fresh) throw Object.assign(new Error("Item not found"), { status: 404 });
    return fresh;
  }

  /**
   * Record what the analyser saw. A confident reading assigns the category
   * outright, but only when a person has not already chosen one; anything
   * less is kept as a suggestion and the item stays uncategorized.
   */
  async applyAiAnalysis(
    itemId: number,
    result: AiAnalysis,
    actorId: number | null = null,
  ): Promise<{ item: Item; autoAssigned: boolean }> {
    const item = db.select().from(items).where(eq(items.id, itemId)).get();
    if (!item) throw Object.assign(new Error("Item not found"), { status: 404 });

    // Persist the model's estimated dollar value onto the item so downstream
    // logic (rescan, review screen, RoD) doesn't have to re-run the model.
    // Only overwrite when the analyzer actually produced a number — a null
    // means "model declined," not "the item is worthless."
    const itemPatch: Record<string, unknown> = {
      aiSuggestions: JSON.stringify(result.suggestions ?? []),
      aiCategoryConfidence: result.confidence ?? null,
      aiSuggestsHighValue: !!result.highValue,
      aiHighValueReason: result.highValueReason ?? null,
    };
    if (result.estimatedValueUsd != null) {
      itemPatch.aiEstimatedValue = result.estimatedValueUsd;
      itemPatch.estimateSource = "ai";
    }
    db.update(items).set(itemPatch).where(eq(items.id, itemId)).run();

    const humanChose =
      !!this.normalizeCategory(item.category) && item.aiCategorySource !== "auto";
    const confident =
      !!result.category && (result.confidence ?? 0) >= AI_CATEGORY_CONFIDENCE_THRESHOLD;

    if (confident && !humanChose) {
      const written = await this.setItemCategory(itemId, result.category, actorId, "ai_auto");
      db.update(items)
        .set({ aiCategoryConfidence: result.confidence ?? null })
        .where(eq(items.id, itemId))
        .run();
      // Auto-flag AFTER the category is set: Rule B needs to see the
      // AI-assigned category, otherwise a Jewelry item that the human
      // hadn't categorized yet would skip the category rule.
      await this.autoFlagAfterAiAnalysis(itemId, {
        estimatedValueUsd: result.estimatedValueUsd,
        category: result.category,
      });
      const fresh = db.select().from(items).where(eq(items.id, itemId)).get()!;
      return { item: fresh, autoAssigned: written.change !== null };
    }

    // Auto-flag also runs on the not-confident branch — Rule A (AI estimate)
    // doesn't need the category to be settled, and Rule B uses whatever
    // category is already on the item.
    await this.autoFlagAfterAiAnalysis(itemId, {
      estimatedValueUsd: result.estimatedValueUsd,
      category: result.category ?? item.category ?? null,
    });

    const fresh = db.select().from(items).where(eq(items.id, itemId)).get()!;
    return { item: fresh, autoAssigned: false };
  }

  /** Counts for the Administration page and the review queue header. */
  async categorizationStatus(): Promise<CategorizationStatus> {
    const s = await this.getSession();
    const all = (await this.listItems()).filter((i) => !i.isPractice);
    const roster = await this.listParticipants();
    const uncategorized = all.filter((i) => !this.normalizeCategory(i.category));
    // Only this session's edits count — a reset should not leave ghosts from
    // a previous family's run in the collaborator list.
    const changes = (await this.listCategoryChanges()).filter((c) => c.sessionId === s.id);

    const tally = new Map<number | null, number>();
    for (const c of changes) {
      if (c.source === "ai_auto") continue;
      const key = c.changedByParticipantId ?? null;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    const collaborators = Array.from(tally.entries())
      .map(([participantId, count]) => ({
        participantId,
        name:
          participantId === null
            ? "the captain"
            : roster.find((p) => p.id === participantId)?.name ?? "Someone",
        count,
      }))
      .sort((a, b) => b.count - a.count);

    return {
      total: all.length,
      categorized: all.length - uncategorized.length,
      uncategorized: uncategorized.length,
      needsDiscussion: all.filter((i) => i.needsDiscussion).length,
      heirsCanCategorize: !!s.heirsCanCategorize,
      aiMode:
        String(process.env.MOCK_AI ?? "").toLowerCase() === "true"
          ? "mock"
          : (() => {
              // Inline check: OPENAI_API_KEY env var OR stored key in app_settings.
              // Avoids importing ai/openaiSettings (circular dependency: that
              // module imports db/sqlite from this file).
              if (process.env.OPENAI_API_KEY) return "live" as const;
              try {
                const row = sqlite
                  .prepare("SELECT value FROM app_settings WHERE key = ?")
                  .get("openai_api_key") as { value: string } | undefined;
                return row?.value ? "live" : "mock";
              } catch {
                return "mock";
              }
            })(),
      collaborators,
    };
  }

  async listClassificationChanges(): Promise<ClassificationChange[]> {
    return db
      .select()
      .from(classificationChanges)
      .all()
      .sort((a, b) => b.changedAt - a.changedAt);
  }

  /** Rewrite one heir's ranks so they run 1..n in the given item order. */
  private renumberRankings(participantId: number, orderedItemIds: number[]) {
    const rows = db
      .select()
      .from(rankings)
      .where(eq(rankings.participantId, participantId))
      .all();
    if (rows.length === 0) return;
    // Park every row far out of the way first so the unique (participant,rank)
    // index cannot trip while the new order is written.
    for (const r of rows) {
      db.update(rankings)
        .set({ rank: r.rank + 100000 })
        .where(eq(rankings.id, r.id))
        .run();
    }
    orderedItemIds.forEach((itemId, idx) => {
      const row = rows.find((r) => r.itemId === itemId);
      if (!row) return;
      db.update(rankings)
        .set({ rank: idx + 1, updatedAt: Date.now() })
        .where(eq(rankings.id, row.id))
        .run();
    });
  }

  /** Strip an item from every heir's ranking, remembering where it sat. */
  private stripItemFromRankings(itemId: number): { participantId: number; rank: number }[] {
    const affected = db.select().from(rankings).where(eq(rankings.itemId, itemId)).all();
    const removed = affected.map((r) => ({ participantId: r.participantId, rank: r.rank }));
    for (const r of affected) {
      db.delete(rankings).where(eq(rankings.id, r.id)).run();
      const rest = db
        .select()
        .from(rankings)
        .where(eq(rankings.participantId, r.participantId))
        .all()
        .sort((a, b) => a.rank - b.rank);
      this.renumberRankings(r.participantId, rest.map((x) => x.itemId));
    }
    return removed;
  }

  /** Put a stripped item back where each heir had it. */
  private restoreItemToRankings(
    itemId: number,
    removed: { participantId: number; rank: number }[],
  ) {
    const s = db.select().from(sessions).all()[0];
    for (const entry of removed) {
      const existing = db
        .select()
        .from(rankings)
        .where(eq(rankings.participantId, entry.participantId))
        .all()
        .sort((a, b) => a.rank - b.rank);
      if (existing.some((r) => r.itemId === itemId)) continue;
      const order = existing.map((r) => r.itemId);
      const at = Math.max(0, Math.min(order.length, entry.rank - 1));
      order.splice(at, 0, itemId);
      // Insert far out of the way, then renumber the whole list.
      db.insert(rankings)
        .values({
          sessionId: s?.id ?? 1,
          participantId: entry.participantId,
          itemId,
          rank: 900000 + entry.participantId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        .run();
      this.renumberRankings(entry.participantId, order);
    }
  }

  private classificationLocked(phase: string): boolean {
    return !(CLASSIFICATION_OPEN_PHASES as readonly string[]).includes(phase);
  }

  /**
   * Heir (or captain) toggles heirloom / high-value / sentimental on an item.
   * Every change is logged, high-value items leave the pools, and during the
   * ranking phases the whole table is notified.
   */
  async setItemFlags(
    itemId: number,
    flags: Partial<Record<ClassificationFlag, boolean>>,
    actorId: number | null,
    reason = "",
  ): Promise<{ item: Item; changes: ClassificationChange[]; notified: number }> {
    const s = await this.getSession();
    if (this.classificationLocked(s.phase)) {
      throw Object.assign(
        new Error(
          "Classifications are locked once the draft has begun. Ask the captain.",
        ),
        { status: 403 },
      );
    }
    const item = db.select().from(items).where(eq(items.id, itemId)).get();
    if (!item) throw Object.assign(new Error("Item not found"), { status: 404 });
    const roster = await this.listParticipants();
    const actor = actorId === null ? null : roster.find((p) => p.id === actorId) ?? null;
    const actorName = actor?.name ?? "The captain";

    const written: ClassificationChange[] = [];
    let notified = 0;

    for (const [flagRaw, next] of Object.entries(flags)) {
      const flag = flagRaw as ClassificationFlag;
      if (typeof next !== "boolean") continue;
      const column = this.flagColumn(flag);
      const current = !!(item as any)[column];
      if (current === next) continue;

      let removed: { participantId: number; rank: number }[] = [];
      if (flag === "needsAppraisal" && next) removed = this.stripItemFromRankings(itemId);

      const patch: Record<string, unknown> = { [column]: next };
      // Confirming an heirloom candidate off also clears the confirmation.
      if (flag === "isHeirloom" && !next) patch.isHeirloomConfirmed = false;
      db.update(items).set(patch).where(eq(items.id, itemId)).run();

      const row = db
        .insert(classificationChanges)
        .values({
          sessionId: s.id,
          itemId,
          flagName: flag,
          oldValue: current,
          newValue: next,
          changedByParticipantId: actorId,
          changedAt: Date.now(),
          reason,
          phase: s.phase,
          isRevert: false,
          removedRankings: JSON.stringify(removed),
        })
        .returning()
        .get();
      written.push(row);

      notified += await this.fanOutClassification(row, item.name, actorName, roster, s.phase, removed);
    }

    const fresh = db.select().from(items).where(eq(items.id, itemId)).get()!;
    return { item: fresh, changes: written, notified };
  }

  /**
   * Tell the table about a flag change. During the ranking phases every
   * participant except the person who made the change hears about it; during
   * cataloguing nobody is disturbed.
   */
  private async fanOutClassification(
    change: ClassificationChange,
    itemName: string,
    actorName: string,
    roster: Participant[],
    phase: string,
    removed: { participantId: number; rank: number }[],
  ): Promise<number> {
    if (!(CLASSIFICATION_FANOUT_PHASES as readonly string[]).includes(phase)) return 0;
    const payload: ClassificationChangedPayload = {
      changeId: change.id,
      itemId: change.itemId,
      itemName,
      flagName: change.flagName as ClassificationFlag,
      oldValue: !!change.oldValue,
      newValue: !!change.newValue,
      changedByParticipantId: change.changedByParticipantId ?? null,
      changedByParticipantName: actorName,
      reason: change.reason || undefined,
      isRevert: !!change.isRevert,
    };
    let count = 0;
    for (const p of roster) {
      if (change.changedByParticipantId !== null && p.id === change.changedByParticipantId) continue;
      await this.notify(p.id, "classification_changed", payload as unknown as Record<string, unknown>);
      count++;
    }
    // A high-value flag also costs some heirs a place in their own ranking —
    // that deserves its own line in the inbox.
    if (change.flagName === "needsAppraisal" && change.newValue) {
      for (const entry of removed) {
        if (change.changedByParticipantId !== null && entry.participantId === change.changedByParticipantId)
          continue;
        await this.notify(entry.participantId, "ranking_affected", {
          changeId: change.id,
          itemId: change.itemId,
          itemName,
          flagName: change.flagName,
          changedByParticipantName: actorName,
          previousRank: entry.rank,
          message: `\u201c${itemName}\u201d was flagged high-value by ${actorName} and removed from your ranking.`,
        });
        count++;
      }
    }
    return count;
  }

  /** captain undoes an heir's flag change and puts any lost rankings back. */
  async revertClassificationChange(
    changeId: number,
    actorId: number | null,
  ): Promise<{ item: Item; change: ClassificationChange }> {
    const s = await this.getSession();
    if (this.classificationLocked(s.phase)) {
      throw Object.assign(new Error("Classifications are locked once the draft has begun."), {
        status: 403,
      });
    }
    const change = db
      .select()
      .from(classificationChanges)
      .where(eq(classificationChanges.id, changeId))
      .get();
    if (!change) throw Object.assign(new Error("Change not found"), { status: 404 });
    if (change.revertedAt) {
      throw Object.assign(new Error("That change has already been reverted."), { status: 409 });
    }
    const item = db.select().from(items).where(eq(items.id, change.itemId)).get();
    if (!item) throw Object.assign(new Error("Item not found"), { status: 404 });

    const roster = await this.listParticipants();
    const actor = actorId === null ? null : roster.find((p) => p.id === actorId) ?? null;
    const actorName = actor ? `${actor.name} (captain)` : "The captain";
    const flag = change.flagName as ClassificationFlag;
    const column = this.flagColumn(flag);

    db.update(items).set({ [column]: !!change.oldValue } as any).where(eq(items.id, item.id)).run();

    let restored: { participantId: number; rank: number }[] = [];
    if (flag === "needsAppraisal" && change.newValue) {
      try {
        restored = JSON.parse(change.removedRankings || "[]");
      } catch {
        restored = [];
      }
      this.restoreItemToRankings(item.id, restored);
    }

    db.update(classificationChanges)
      .set({ revertedAt: Date.now(), revertedByParticipantId: actorId })
      .where(eq(classificationChanges.id, change.id))
      .run();

    const revertRow = db
      .insert(classificationChanges)
      .values({
        sessionId: s.id,
        itemId: item.id,
        flagName: change.flagName,
        oldValue: !!change.newValue,
        newValue: !!change.oldValue,
        changedByParticipantId: actorId,
        changedAt: Date.now(),
        reason: `Reverted change #${change.id}`,
        phase: s.phase,
        isRevert: true,
        removedRankings: "[]",
      })
      .returning()
      .get();

    await this.fanOutClassification(revertRow, item.name, actorName, roster, s.phase, []);

    for (const entry of restored) {
      await this.notify(entry.participantId, "item_returned", {
        changeId: revertRow.id,
        itemId: item.id,
        itemName: item.name,
        restoredRank: entry.rank,
        message: `\u201c${item.name}\u201d was returned to available inventory and put back at #${entry.rank} in your ranking.`,
      });
    }

    const fresh = db.select().from(items).where(eq(items.id, item.id)).get()!;
    return { item: fresh, change: revertRow };
  }

  /* ================================================================= */
  /* reconciliation + auto-draft                                       */
  /* ================================================================= */

  private async saveReconciliation(rec: ReconciliationState) {
    await this.updateSession({ reconciliation: JSON.stringify(rec) });
  }

  /** Live view of the checkpoint, including who is still silent. */
  async reconciliationStatus() {
    const s = await this.getSession();
    const rec = parseReconciliation(s.reconciliation);
    const heirs = await this.heirs();
    const pending = heirs.filter((h) => !rec.responses[String(h.id)]);
    const nudgeMs = s.reconciliationNudgeMs ?? 300000;
    const elapsed = rec.active ? Date.now() - rec.startedAt : 0;
    return {
      ...rec,
      openedAt: rec.active ? rec.startedAt : null,
      resolvedAt: rec.resolution ? rec.startedAt : null,
      outcome: rec.resolution,
      streak: s.autoRoundStreak ?? 0,
      interval: reconciliationInterval(s.practiceMode),
      paused: !!s.autoDraftPaused,
      autoEnabled: !!s.autoDraftEnabled,
      nudgeMs,
      elapsedMs: elapsed,
      pending: pending.map((h) => ({ participantId: h.id, name: h.name })),
      responded: heirs
        .filter((h) => rec.responses[String(h.id)])
        .map((h) => ({
          participantId: h.id,
          name: h.name,
          choice: rec.responses[String(h.id)],
        })),
      stalled: rec.active && pending.length > 0 && elapsed >= nudgeMs,
    };
  }

  /** Open a checkpoint and ask every heir to continue or pause. */
  async openReconciliation(): Promise<ReconciliationState> {
    const s = await this.getSession();
    const rec: ReconciliationState = {
      ...EMPTY_RECONCILIATION,
      active: true,
      round: s.currentRound,
      startedAt: Date.now(),
      responses: {},
    };
    await this.saveReconciliation(rec);
    for (const h of await this.heirs()) {
      await this.notify(h.id, "reconciliation_requested", {
        round: s.currentRound,
        message: `Five uncontested rounds have run automatically. Continue, or pause the draft?`,
      });
    }
    return rec;
  }

  async respondReconciliation(participantId: number, choice: "continue" | "pause") {
    const s = await this.getSession();
    const rec = parseReconciliation(s.reconciliation);
    if (!rec.active) {
      throw Object.assign(new Error("There is no reconciliation checkpoint open."), { status: 409 });
    }
    rec.responses[String(participantId)] = choice;
    const heirs = await this.heirs();
    const everyone = heirs.every((h) => rec.responses[String(h.id)]);
    if (!everyone) {
      await this.saveReconciliation(rec);
      return this.reconciliationStatus();
    }
    const anyPause = Object.values(rec.responses).some((v) => v === "pause");
    rec.active = false;
    rec.resolution = anyPause ? "paused" : "continue";
    await this.saveReconciliation(rec);
    await this.updateSession({ autoRoundStreak: 0, autoDraftPaused: anyPause });
    if (anyPause) {
      const pausers = heirs
        .filter((h) => rec.responses[String(h.id)] === "pause")
        .map((h) => h.name);
      for (const p of await this.listParticipants()) {
        if (!p.isAdmin) continue;
        await this.notify(p.id, "auto_draft_paused", {
          round: rec.round,
          pausedBy: pausers,
          message: `Automatic rounds are paused \u2014 ${pausers.join(", ")} asked to stop. Resume when the table is ready.`,
        });
      }
    }
    return this.reconciliationStatus();
  }

  /** captain pokes whoever has not answered the checkpoint yet. */
  async nudgeReconciliation(actorId: number | null) {
    const s = await this.getSession();
    const rec = parseReconciliation(s.reconciliation);
    if (!rec.active) {
      throw Object.assign(new Error("There is no reconciliation checkpoint open."), { status: 409 });
    }
    const heirs = await this.heirs();
    const pending = heirs.filter((h) => !rec.responses[String(h.id)]);
    for (const h of pending) {
      await this.notify(h.id, "reconciliation_reminder", {
        round: rec.round,
        message: "The captain is waiting on your answer: continue or pause?",
      });
    }
    rec.nudgedAt = Date.now();
    await this.saveReconciliation(rec);
    return { nudged: pending.map((p) => p.name), status: await this.reconciliationStatus() };
  }

  /** Raise the captain's "nobody answered" alert exactly once per checkpoint. */
  private async maybeFlagStalledReconciliation() {
    const s = await this.getSession();
    // v7a: while the estate is paused, no poll-driven side effects should
    // fire — there is no real timer to cancel here (this whole mechanism is
    // poll-driven, not setTimeout-based), so gating the check itself is the
    // equivalent of "pausing" it. See v7a_lifecycle_qa_findings.md.
    if (s.state === "paused") return;
    const rec = parseReconciliation(s.reconciliation);
    if (!rec.active || rec.stalledNotifiedAt) return;
    const nudgeMs = s.reconciliationNudgeMs ?? 300000;
    if (Date.now() - rec.startedAt < nudgeMs) return;
    const heirs = await this.heirs();
    const pending = heirs.filter((h) => !rec.responses[String(h.id)]);
    if (pending.length === 0) return;
    rec.stalledNotifiedAt = Date.now();
    await this.saveReconciliation(rec);
    for (const p of await this.listParticipants()) {
      if (!p.isAdmin) continue;
      await this.notify(p.id, "reconciliation_stalled", {
        round: rec.round,
        pending: pending.map((h) => h.name),
        message: `Still waiting on ${pending.map((h) => h.name).join(", ")} to answer the checkpoint.`,
      });
    }
  }

  async resumeAutoDraft(): Promise<Session> {
    return this.updateSession({
      autoDraftPaused: false,
      autoRoundStreak: 0,
      autoDraftHoldRound: null,
      reconciliation: JSON.stringify(EMPTY_RECONCILIATION),
    });
  }

  /**
   * One tick of the automatic draft. Called from the state poll: when every
   * heir's next choice is distinct the round resolves itself, and after a run
   * of uncontested rounds the table is asked whether to keep going.
   */
  async autoDraftStep(): Promise<{
    acted: boolean;
    reason: string;
    contested?: boolean;
    log?: string[];
  }> {
    const s = await this.getSession();
    if (s.state === "paused") return { acted: false, reason: "estate_paused" };
    if (s.practiceMode !== "off") return { acted: false, reason: "practice" };
    if (s.phase !== "draft" && s.phase !== "secondary_draft")
      return { acted: false, reason: "not_drafting" };
    if (!s.autoDraftEnabled) return { acted: false, reason: "disabled" };
    if (s.autoDraftPaused) return { acted: false, reason: "paused" };
    const rec = parseReconciliation(s.reconciliation);
    if (rec.active) return { acted: false, reason: "reconciling" };
    if (s.autoDraftHoldRound === s.currentRound)
      return { acted: false, reason: "contested_round_in_progress" };

    const heirs = await this.heirs();
    if (heirs.length < 2) return { acted: false, reason: "too_few_heirs" };
    const roundPicks = (await this.listPicks()).filter(
      (p) => p.round === s.currentRound && !p.isPractice,
    );
    const owing = heirs.filter((h) => this.owedLevel(h, roundPicks) > 0);
    if (owing.length === 0) return { acted: false, reason: "nothing_owed" };

    const plan: { heir: Participant; itemId: number; name: string; rank: number }[] = [];
    for (const h of owing) {
      const suggestion = await this.autoSuggest(h.id);
      if (!suggestion) continue;
      plan.push({ heir: h, ...suggestion });
    }
    if (plan.length === 0) return { acted: false, reason: "nothing_ranked" };
    if (plan.length < owing.length) return { acted: false, reason: "incomplete_rankings" };

    const byItem: Record<number, string[]> = {};
    for (const p of plan) (byItem[p.itemId] ||= []).push(p.heir.name);
    const contested = Object.values(byItem).some((names) => names.length > 1);

    for (const p of plan) {
      try {
        await this.submitPick(p.heir.id, p.itemId, false, "auto_rank");
      } catch {
        /* already submitted — leave it alone */
      }
    }

    if (contested) {
      // Hand the round back to the table: normal reveal, then second choices.
      await this.updateSession({ autoRoundStreak: 0, autoDraftHoldRound: s.currentRound });
      return { acted: true, reason: "contested", contested: true };
    }

    // A short pause so the table can watch the round land.
    await new Promise((r) => setTimeout(r, 600));
    const result = await this.revealRound();
    const after = await this.getSession();
    const streak = (s.autoRoundStreak ?? 0) + 1;
    await this.updateSession({ autoRoundStreak: streak, autoDraftHoldRound: null });

    const interval = reconciliationInterval(after.practiceMode);
    if (
      streak > 0 &&
      streak % interval === 0 &&
      after.phase !== "complete" &&
      (await this.listItems()).some((i) => i.status === "available" && !i.isPractice && !i.needsAppraisal)
    ) {
      await this.openReconciliation();
    }

    return { acted: true, reason: "auto_round", contested: false, log: result.log };
  }

  /* ---------------- duplicates ---------------- */
  async listDuplicateGroups(): Promise<DuplicateGroup[]> {
    return db.select().from(duplicateGroups).all();
  }

  /**
   * Sweep the WHOLE live pool for duplicates, regardless of how each item got
   * here — imported from Reindeer: Registry (photographed or pulled out of a
   * video walkthrough), typed in by hand, or created during AI evaluation.
   *
   * This used to bucket on exact normalised name only, which was the weakest
   * of the suite's three duplicate rules: an item flagged on the way in went
   * invisible the moment it went live. It now calls the one shared rule in
   * `server/duplicates/match.ts`, so a duplicate stays a duplicate.
   *
   * Grouping is transitive: A~B and B~C put all three in one group, so the
   * family sees one decision instead of two overlapping ones.
   *
   * Nothing is ever deleted here. This only proposes groups; `resolveDuplicate`
   * requires a person to choose which record survives.
   */
  async scanDuplicates(): Promise<DuplicateGroup[]> {
    const s = await this.getSession();
    const all = await this.listItems();

    const candidates = all.filter(
      (it) =>
        !it.isPractice &&
        it.status !== "duplicate_dismissed" &&
        it.status !== "awarded" &&
        // Owner-assigned items are locked to the owner's stated recipient
        // and must not be merged into another item by the duplicate scanner.
        // The owner's authorship is preserved by keeping the row distinct.
        it.status !== "owner_assigned",
    );

    // Union-find so overlapping pairs collapse into one group.
    const parent = new Map<number, number>();
    const find = (x: number): number => {
      let r = parent.get(x) ?? x;
      if (r !== x) {
        r = find(r);
        parent.set(x, r);
      }
      return r;
    };
    const union = (a: number, b: number) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    for (const it of candidates) parent.set(it.id, it.id);

    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i];
        const b = candidates[j];
        if (looksLikeSameThing(a, b).matched) union(a.id, b.id);
      }
    }

    const groups = new Map<number, Item[]>();
    for (const it of candidates) {
      const root = find(it.id);
      const bucket = groups.get(root);
      if (bucket) bucket.push(it);
      else groups.set(root, [it]);
    }

    for (const group of Array.from(groups.values())) {
      if (group.length < 2) continue;
      // Already grouped together and still open? Leave the family's group alone.
      if (group.every((g: Item) => g.duplicateGroupId)) continue;
      const dg = db
        .insert(duplicateGroups)
        .values({ sessionId: s.id, resolvedBy: null, status: "open" })
        .returning()
        .get();
      db.update(items)
        .set({ duplicateGroupId: dg.id })
        .where(inArray(items.id, group.map((g: Item) => g.id)))
        .run();
    }
    return this.listDuplicateGroups();
  }

  /**
   * Check ONE item against the whole pool. Called after AI evaluation so that
   * evaluating inventory also surfaces duplicates, rather than leaving them to
   * a sweep nobody remembers to run.
   *
   * Returns the matches found (for reporting) and groups them if any. Never
   * throws — a duplicate check must not be able to fail an AI evaluation.
   */
  async scanDuplicatesForItem(
    itemId: number,
  ): Promise<{ matches: { id: number; name: string; reason: string; score: number }[]; groupId: number | null }> {
    try {
      const s = await this.getSession();
      const all = await this.listItems();
      const subject = all.find((i) => i.id === itemId);
      if (!subject || subject.isPractice) return { matches: [], groupId: null };

      const matches: { id: number; name: string; reason: string; score: number; item: Item }[] = [];
      for (const other of all) {
        if (other.id === itemId) continue;
        if (other.isPractice) continue;
        if (other.status === "duplicate_dismissed" || other.status === "awarded") continue;
        const r = looksLikeSameThing(subject, other);
        if (r.matched) {
          matches.push({
            id: other.id,
            name: other.name,
            reason: explainMatch(r.reason),
            score: r.score,
            item: other,
          });
        }
      }
      if (!matches.length) return { matches: [], groupId: null };

      // Reuse an open group one of the matches already belongs to, so repeated
      // evaluation does not manufacture a fresh group every pass.
      const existingGroupId =
        subject.duplicateGroupId ?? matches.find((m) => m.item.duplicateGroupId)?.item.duplicateGroupId ?? null;

      const groupId =
        existingGroupId ??
        db
          .insert(duplicateGroups)
          .values({ sessionId: s.id, resolvedBy: null, status: "open" })
          .returning()
          .get().id;

      const ids = [subject.id, ...matches.map((m) => m.id)];
      db.update(items).set({ duplicateGroupId: groupId }).where(inArray(items.id, ids)).run();

      return {
        matches: matches.map(({ id, name, reason, score }) => ({ id, name, reason, score })),
        groupId,
      };
    } catch (e) {
      console.warn("[duplicates] per-item scan failed:", (e as Error)?.message ?? e);
      return { matches: [], groupId: null };
    }
  }

  async resolveDuplicate(groupId: number, keepItemId: number, participantId: number | null) {
    const members = db
      .select()
      .from(items)
      .where(eq(items.duplicateGroupId, groupId))
      .all();

    const keepItem = members.find((m) => m.id === keepItemId);
    if (!keepItem) throw new Error("Keep item not found in duplicate group");

    // ---- Preserve the original owner's voice ----
    //
    // When a duplicate is resolved, the dismissed item is NOT deleted — it
    // stays in the database as `duplicate_dismissed`. But its commentary
    // must survive on the kept item too, so the owner's notes, story,
    // memory, and recipient hints are never lost when a captain chooses
    // an heir's version over the Registry version.
    //
    // Priority: Registry-origin items (originApp = 'reindeer_registry')
    // carry the original owner's voice. If the kept item is NOT from the
    // Registry but a dismissed item IS, the owner's fields are merged
    // into the kept item (without overwriting non-empty values the kept
    // item already has).
    //
    // Fields that carry the owner's voice:
    //   inventoryStory, ownerImportantComment, recipientHint,
    //   recipientHintNote, notes, lockedByMemorandum, memorandumOwnerName
    const ownerVoiceFields = [
      "inventoryStory",
      "ownerImportantComment",
      "recipientHint",
      "recipientHintNote",
      "notes",
    ] as const;

    const registryDismissed = members.filter(
      (m) => m.id !== keepItemId && m.originApp === "reindeer_registry",
    );

    if (registryDismissed.length > 0 && keepItem.originApp !== "reindeer_registry") {
      const merge: Record<string, unknown> = {};
      for (const dismissed of registryDismissed) {
        for (const field of ownerVoiceFields) {
          const val = (dismissed as unknown as Record<string, string>)[field];
          // Only merge if the kept item doesn't already have this field
          // populated and the dismissed item does.
          if (val && val.trim() !== "") {
            const existing = (keepItem as unknown as Record<string, string>)[field];
            if (!existing || existing.trim() === "") {
              merge[field] = val;
            }
          }
        }
      }
      // Also preserve memorandum lock if the dismissed item had it.
      for (const dismissed of registryDismissed) {
        if (dismissed.lockedByMemorandum && !keepItem.lockedByMemorandum) {
          merge.lockedByMemorandum = true;
          merge.memorandumOwnerName = dismissed.memorandumOwnerName || "";
          break;
        }
      }
      if (Object.keys(merge).length > 0) {
        db.update(items).set(merge as any).where(eq(items.id, keepItemId)).run();
      }
    }

    // Copy photos from dismissed items to the kept item, so the heir's
    // photos (or the Registry's photos) survive on the kept record.
    const dismissedIds = members.filter((m) => m.id !== keepItemId).map((m) => m.id);
    if (dismissedIds.length > 0) {
      const dismissedMedia = db
        .select()
        .from(itemMedia)
        .where(inArray(itemMedia.itemId, dismissedIds))
        .all();
      const existingHashes = new Set(
        db.select().from(itemMedia).where(eq(itemMedia.itemId, keepItemId)).all()
          .map((m) => m.url),
      );
      for (const m of dismissedMedia) {
        if (existingHashes.has(m.url)) continue;
        db.insert(itemMedia)
          .values({
            sessionId: m.sessionId,
            itemId: keepItemId,
            kind: m.kind,
            role: m.role,
            mimeType: m.mimeType,
            byteSize: m.byteSize,
            durationMs: m.durationMs,
            transcript: m.transcript,
            label: m.label,
            url: m.url,
            isPrimary: false, // never steal primary from the kept item
            originApp: m.originApp,
            createdAt: Date.now(),
          })
          .run();
      }
    }

    for (const m of members) {
      if (m.id === keepItemId) {
        db.update(items).set({ duplicateGroupId: null }).where(eq(items.id, m.id)).run();
      } else {
        db.update(items)
          .set({ status: "duplicate_dismissed", duplicateGroupId: null })
          .where(eq(items.id, m.id))
          .run();
      }
    }
    db.update(duplicateGroups)
      .set({ status: "resolved", resolvedBy: participantId })
      .where(eq(duplicateGroups.id, groupId))
      .run();
  }

  /* ---- item interests (desire layer) ---- */
  async listInterests(participantId: number): Promise<ItemInterest[]> {
    return db.select().from(itemInterests)
      .where(eq(itemInterests.participantId, participantId))
      .all();
  }

  async listAllInterests(): Promise<ItemInterest[]> {
    return db.select().from(itemInterests).all();
  }

  async setInterest(
    participantId: number,
    itemId: number,
    interest: "want" | "interested" | "dont_care",
  ): Promise<ItemInterest> {
    const session = await this.getSession();
    const now = Date.now();
    db.insert(itemInterests)
      .values({
        sessionId: session.id,
        participantId,
        itemId,
        interest,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [itemInterests.sessionId, itemInterests.participantId, itemInterests.itemId],
        set: { interest, updatedAt: now },
      })
      .run();
    const row = db.select().from(itemInterests)
      .where(and(
        eq(itemInterests.participantId, participantId),
        eq(itemInterests.itemId, itemId),
      ))
      .get();
    return row!;
  }

  async countWantsForItem(itemId: number): Promise<number> {
    const rows = db.select().from(itemInterests)
      .where(and(
        eq(itemInterests.itemId, itemId),
        eq(itemInterests.interest, "want"),
      ))
      .all();
    return rows.length;
  }

  async itemsWithMultipleWants(): Promise<{ itemId: number; wantCount: number }[]> {
    const allInterests = db.select().from(itemInterests)
      .where(eq(itemInterests.interest, "want"))
      .all();
    const counts = new Map<number, number>();
    for (const row of allInterests) {
      counts.set(row.itemId, (counts.get(row.itemId) ?? 0) + 1);
    }
    const result: { itemId: number; wantCount: number }[] = [];
    for (const [itemId, wantCount] of Array.from(counts.entries())) {
      if (wantCount >= 2) result.push({ itemId, wantCount });
    }
    return result;
  }
}

export const storage = new DatabaseStorage();
