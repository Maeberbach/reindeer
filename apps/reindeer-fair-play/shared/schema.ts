import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import type * as z from "zod";
import { LEGAL_CATEGORY_LABELS } from "./legalCategories";

/* ------------------------------------------------------------------ */
/* sessions — one row: the current family session                      */
/* ------------------------------------------------------------------ */
export const sessions = sqliteTable("sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  /** What the family calls this estate. Null until the heir running the session names it. */
  estateName: text("estate_name"),
  /**
   * The trustee's name, captured optionally at setup. The trustee lives
   * outside the app — they retain fiduciary responsibility for the
   * high-value bucket and the financial-side balance of the trust or
   * estate, and they do not log in. Null when the family has not written
   * a name down yet; the Record of Decisions and trustee packet then
   * print with a blank line for the trustee to fill in by hand.
   */
  trusteeName: text("trustee_name"),
  /**
   * Participant id of the trustee currently seated inside the app. Null
   * unless a trustee is present. When set, that participant row has
   * role='trustee' and administersOnly=true, and is filtered out of
   * every draft/ranking/equalization computation.
   */
  trusteeParticipantId: integer("trustee_participant_id"),
  /**
   * Participant id of the current captain — whoever the heirs have
   * empowered to run this session's phases. Nullable until welcome runs
   * (createWelcome seeds this to the heir-admin's id). On trustee
   * take-over this points at the trustee row; on hand-back it returns to
   * the heir-admin. In-game endpoints (advance phase, resolve conflicts,
   * close registration, etc.) gate on this via denyIfNotCaptain. Setup
   * endpoints (roster edits before method agreement, propose transfer)
   * gate on isAdmin via denyIfNotHeirAdmin.
   *
   * See docs/specs/2026-08-08-captain-model.md.
   */
  captainParticipantId: integer("captain_participant_id"),
  // 'welcome' | 'estate_name' | 'registration' | 'intake' (a.k.a. cataloging)
  //   | 'ranking' | 'groupings' | 'draft' | 'secondary_ranking'
  //   | 'secondary_draft' | 'complete'
  phase: text("phase").notNull().default("welcome"),
  /** Set when the captain closes the heir roster and cataloging opens. */
  registrationClosedAt: integer("registration_closed_at"),
  // 'all' | 'topN' — how deep heirs must rank before the draft opens
  rankDepthMode: text("rank_depth_mode").notNull().default("topN"),
  rankTopN: integer("rank_top_n").default(20),
  // Ranking deadline window (primary). Days is 7–30; opened/deadline are epoch ms.
  rankingWindowDays: integer("ranking_window_days").notNull().default(30),
  rankingOpenedAt: integer("ranking_opened_at"),
  rankingDeadline: integer("ranking_deadline"),
  // The same three, for the secondary ranking pass over leftovers.
  secondaryRankingWindowDays: integer("secondary_ranking_window_days")
    .notNull()
    .default(30),
  secondaryRankingOpenedAt: integer("secondary_ranking_opened_at"),
  secondaryRankingDeadline: integer("secondary_ranking_deadline"),
  currentRound: integer("current_round").notNull().default(0),
  // JSON string of participantIds, highest priority first
  priorityOrder: text("priority_order").notNull().default("[]"),
  // JSON blob of per-capability heir permissions — see HEIR_CAPABILITIES.
  heirPermissions: text("heir_permissions").notNull().default("{}"),
  // 'off' | 'sample_items'
  //
  // A rehearsal always runs on pretend items. An earlier build also offered
  // practice over the real catalogue; that option was withdrawn deliberately.
  // Rehearsing on the real estate teaches heirs what they are about to lose:
  // they watch the real pocket watch go to a sibling, form an expectation, and
  // then the round is thrown away. The disappointment is real even though the
  // award was not, which is worse than not rehearsing at all.
  //
  // The column keeps its text type rather than a narrower one so that a database
  // written by an older build still opens. Anything that is not 'off' is treated
  // as a sample-item rehearsal.
  practiceMode: text("practice_mode").notNull().default("off"),
  // JSON blob: { currentRound, priorityOrder, contestedLossCounters, awards, phaseBefore }
  practiceState: text("practice_state"),
  /* ---- v4 flow overhaul ---- */
  // captain-controlled contributions during cataloging.
  heirsCanAddInventory: integer("heirs_can_add_inventory", { mode: "boolean" })
    .notNull()
    .default(false),
  heirsCanProposeGroupings: integer("heirs_can_propose_groupings", { mode: "boolean" })
    .notNull()
    .default(false),
  // Auto-draft: uncontested rounds resolve themselves from each heir's ranking.
  autoDraftEnabled: integer("auto_draft_enabled", { mode: "boolean" })
    .notNull()
    .default(true),
  autoRoundStreak: integer("auto_round_streak").notNull().default(0),
  // True once an heir chose "Pause" at a reconciliation checkpoint.
  autoDraftPaused: integer("auto_draft_paused", { mode: "boolean" })
    .notNull()
    .default(false),
  // While the current round is contested the engine steps aside.
  autoDraftHoldRound: integer("auto_draft_hold_round"),
  // JSON blob — see ReconciliationState.
  reconciliation: text("reconciliation"),
  // How long before a silent heir triggers the captain nudge banner. Lowered in QA.
  reconciliationNudgeMs: integer("reconciliation_nudge_ms").notNull().default(300000),
  // Set when the captain marks cataloging finished.
  inventoryCompletedAt: integer("inventory_completed_at"),
  /* ---- v6 collaborative categorization ---- */
  // Ninth heir capability: heirs may assign or change categories anywhere,
  // including from inside the ranking panes. On by default.
  heirsCanCategorize: integer("heirs_can_categorize", { mode: "boolean" })
    .notNull()
    .default(true),
  /* ---- v7a session lifecycle: pause / resume ---- */
  // 'active' | 'paused' | 'archived'
  state: text("state").notNull().default("active"),
  pausedAt: integer("paused_at"),
  // Adapted from the spec's text id: the app's participant ids are integers.
  pausedBy: integer("paused_by"),
  pauseReason: text("pause_reason"),
  pauseCount: integer("pause_count").notNull().default(0),
  totalPausedMs: integer("total_paused_ms").notNull().default(0),
  /**
   * Dollar threshold used by the AI intake analyzer to auto-flag an item
   * for appraisal. Any item whose AI estimate is >= 85% of this threshold
   * is flagged automatically with a reason like "Estimate $4,200 (not an
   * official appraisal) — near your $2,000 threshold". Family-configurable
   * per session by the captain. Independent of the category rule (jewelry,
   * precious metals, vehicles, etc. auto-flag regardless of dollar value).
   * Renamed from appraisal_threshold_usd in v15c3.
   */
  appraisalThresholdUsd: integer("appraisal_threshold_usd").notNull().default(2000),
  createdAt: integer("created_at").notNull(),
});

/* ------------------------------------------------------------------ */
/* taxonomy — enabled rooms & categories for this estate               */
/* ------------------------------------------------------------------ */
export const taxonomy = sqliteTable("taxonomy", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: integer("session_id").notNull(),
  // 'room' | 'category'
  kind: text("kind").notNull(),
  label: text("label").notNull(),
  isEnabled: integer("is_enabled", { mode: "boolean" }).notNull().default(false),
  isCustom: integer("is_custom", { mode: "boolean" }).notNull().default(false),
});

/* ------------------------------------------------------------------ */
/* participants                                                        */
/* ------------------------------------------------------------------ */
export const participants = sqliteTable("participants", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: integer("session_id").notNull(),
  name: text("name").notNull(),
  isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
  administersOnly: integer("administers_only", { mode: "boolean" })
    .notNull()
    .default(false),
  email: text("email"),
  phone: text("phone"),
  contestedLossCounter: integer("contested_loss_counter").notNull().default(0),
  seatOrder: integer("seat_order").notNull().default(0),
  // Opt-in: auto-confirm this heir's top-ranked available item each round.
  autoSubmit: integer("auto_submit", { mode: "boolean" }).notNull().default(false),
  // Consent: may the captain open this heir's ranking and adjust it on their behalf?
  allowsCaptainAssist: integer("allows_captain_assist", { mode: "boolean" })
    .notNull()
    .default(false),
  // Set the first time an heir walks the guided sequence and confirms who they are.
  profileConfirmedAt: integer("profile_confirmed_at"),
  /**
   * 'heir' (default), 'trustee', 'representative', or 'helper'.
   * A trustee is the fiduciary named by the owner. A proxy acts on
   * behalf of another participant. Neither trustees nor proxies draft,
   * rank, receive items, or appear in equalization math; they must have
   * administersOnly === true. Proxies additionally must set
   * representsParticipantId.
   *
   * A helper is someone the captain invites to assist with inventory
   * collection — photographing items, entering them, running batch
   * intake — who is NOT an heir and does not participate in
   * distribution. Helpers have administersOnly === true and may only
   * access inventory routes (add items, upload photos, edit names/notes,
   * scan duplicates). They cannot rank, draft, resolve disputes, or
   * manage the session. Helpers sign in via the same magic-link flow
   * as heirs.
   */
  role: text("role").notNull().default("heir"),
  /**
   * For role === 'representative' only. Points at the participant
   * whose interests this person is acting on. Null for heirs and
   * trustees.
   */
  representsParticipantId: integer("represents_participant_id"),
});

/* ------------------------------------------------------------------ */
/* captainTransfers — audit log of every hand-over of the captain role           */
/* ------------------------------------------------------------------ */
export const captainTransfers = sqliteTable("captain_transfers", {
  id: text("id").primaryKey(),
  sessionId: integer("session_id").notNull(),
  previousCaptainParticipantId: integer("previous_captain_participant_id").notNull(),
  newCaptainParticipantId: integer("new_captain_participant_id").notNull(),
  transferredAt: integer("transferred_at").notNull(),
  /** What happened to the outgoing captain. */
  previousCaptainDisposition: text("previous_captain_disposition").notNull(),
  reason: text("reason"),
  /** Kept for the read-only log — the rows themselves may be deleted. */
  previousCaptainName: text("previous_captain_name").notNull().default(""),
  newCaptainName: text("new_captain_name").notNull().default(""),
});

export type CaptainTransfer = typeof captainTransfers.$inferSelect;

/* ------------------------------------------------------------------ */
/* sessionStateChanges — append-only audit of pause/resume transitions */
/* ------------------------------------------------------------------ */
export const sessionStateChanges = sqliteTable("session_state_changes", {
  id: text("id").primaryKey(),
  sessionId: integer("session_id").notNull(),
  fromState: text("from_state").notNull(),
  toState: text("to_state").notNull(),
  changedByParticipantId: integer("changed_by_participant_id"),
  changedAt: integer("changed_at").notNull(),
  reason: text("reason"),
  // JSON string — e.g. { pausedDurationMs, extendRankingDays }.
  metadata: text("metadata"),
});

export type SessionStateChange = typeof sessionStateChanges.$inferSelect;
export const insertSessionStateChangeSchema = createInsertSchema(sessionStateChanges);
export type InsertSessionStateChange = z.infer<typeof insertSessionStateChangeSchema>;

/** Estate lifecycle states. */
export const SESSION_STATES = ["active", "paused", "archived"] as const;
export type SessionLifecycleState = (typeof SESSION_STATES)[number];

/** Reason text is free-form but capped, matching the pause dialog's counter. */
export const PAUSE_REASON_MAX_LEN = 500;

/* ------------------------------------------------------------------ */
/* items                                                               */
/* ------------------------------------------------------------------ */
export const items = sqliteTable("items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: integer("session_id").notNull(),
  name: text("name").notNull(),
  room: text("room").notNull().default(""),
  /**
   * Optional. Null (or the empty string) means the item sits in the
   * implicit "Uncategorized" bucket — it still enters rankings and the draft.
   */
  category: text("category"),
  notes: text("notes").notNull().default(""),
  aiEstimatedValue: real("ai_estimated_value"),
  // 'ai' | 'manual' | null
  estimateSource: text("estimate_source"),
  photoUrl: text("photo_url"),
  thumbnailUrl: text("thumbnail_url"),
  // 'available' | 'awarded' | 'in_grouping' | 'needs_appraisal' | 'duplicate_dismissed' | 'owner_assigned' (v15c3)
  status: text("status").notNull().default("available"),
  awardedToParticipantId: integer("awarded_to_participant_id"),
  awardedInRound: integer("awarded_in_round"),
  isHeirloomCandidate: integer("is_heirloom_candidate", { mode: "boolean" })
    .notNull()
    .default(false),
  isHeirloomConfirmed: integer("is_heirloom_confirmed", { mode: "boolean" })
    .notNull()
    .default(false),
  // Needs-appraisal boolean (v15c3 rename — was needs_appraisal). True when
  // an active row exists in appraisal_flags for this item. Items flagged
  // for appraisal leave the ranking and draft pools until the captain
  // reverts (or the trustee closes the appraisal cycle). This is the
  // "trustee's dollar queue" flag — orthogonal to items.is_important.
  needsAppraisal: integer("needs_appraisal", { mode: "boolean" }).notNull().default(false),
  isSentimental: integer("is_sentimental", { mode: "boolean" }).notNull().default(false),
  /* ---- v8 high-value fiduciary workflow ---- */
  /**
   * The item's fiduciary state. See ITEM_STATES. Independent of `status` above,
   * which is a pool/draft-flow flag. `highValueState` is the fiduciary lifecycle
   * a high-value item moves through from flag to finalization.
   */
  highValueState: text("high_value_state").notNull().default("normal"),
  /** Best current dollar estimate. Drafting and provisional allocation may use this. */
  estimatedValue: real("estimated_value"),
  /**
   * The value the captain/fiduciary has locked in for final accounting.
   * Must be set (via itemValuations with status='approved') before the item
   * can move to `ready_for_finalization` or `finalized`.
   */
  approvedValue: real("approved_value"),
  /** 'ai' | 'manual' | 'appraisal' | 'comparable_sale' | 'auction' | 'other' */
  valueSource: text("value_source"),
  /** 'estimated' | 'pending_review' | 'approved' | 'disputed' | 'stale' */
  valueStatus: text("value_status").notNull().default("estimated"),
  /** Epoch ms of the currently-active valuation. */
  valuationDate: integer("valuation_date"),
  /** Free-text notes from the appraiser / captain about the valuation. */
  valuationNotes: text("valuation_notes").notNull().default(""),
  /** Provisional recipient during allocation; may differ from final recipient. */
  provisionalRecipientId: integer("provisional_recipient_id"),
  addedDuringDraft: integer("added_during_draft", { mode: "boolean" })
    .notNull()
    .default(false),
  groupingId: integer("grouping_id"),
  duplicateGroupId: integer("duplicate_group_id"),
  isPractice: integer("is_practice", { mode: "boolean" }).notNull().default(false),
  // Who catalogued the item. Null when the Captain added it.
  createdByParticipantId: integer("created_by_participant_id"),
  // 'primary' | 'secondary' | null — stamped at award time.
  draftPhase: text("draft_phase"),
  /* ---- v6 AI categorization ---- */
  /** 0-1 confidence of the category the analyser proposed. */
  aiCategoryConfidence: real("ai_category_confidence"),
  // 'user' | 'auto' | 'reviewed'
  aiCategorySource: text("ai_category_source").notNull().default("user"),
  /** JSON array of {category, confidence}, top 3, highest first. */
  aiSuggestions: text("ai_suggestions"),
  aiSuggestsHighValue: integer("ai_suggests_high_value", { mode: "boolean" })
    .notNull()
    .default(false),
  aiHighValueReason: text("ai_high_value_reason"),
  /** Set when two people categorised the same item within 30 seconds. */
  needsDiscussion: integer("needs_discussion", { mode: "boolean" })
    .notNull()
    .default(false),
  /* ---- v9 inventory import provenance ---- */
  /** 'reindeer_registry' when the item arrived from Reindeer Registry. */
  originApp: text("origin_app"),
  /** The item's id in the app it came from. Stable across re-imports. */
  originItemId: text("origin_item_id"),
  importBatchId: text("import_batch_id"),
  quantity: integer("quantity").notNull().default(1),
  conditionNote: text("condition_note").notNull().default(""),
  /** JSON object: serial numbers, hallmarks, engravings, appraisal refs. */
  identifiers: text("identifiers").notNull().default("{}"),
  /** The owner's own words about the item, recorded before death. */
  inventoryStory: text("inventory_story").notNull().default(""),
  /**
   * The owner's own words about why they marked this item Important in
   * Registry, if any. Distinct from inventory_story (biography). This is the
   * comment that traveled from Registry's owner_important_comment field via
   * the exchange envelope. content — display only, never a valuation.
   */
  ownerImportantComment: text("owner_important_comment").notNull().default(""),
  /**
   * What the owner said they wanted to happen to this item.
   *
   * The raw text the owner wrote in the Registry recipient-hint field. From
   * v15 onward, when this is non-empty the item is staged as an owner
   * assignment (see the `ownerAssignedSource='recipient_hint'` path in
   * importService). The captain still reviews and can dismiss it. Once approved,
   * the assignment is written to the owner_assigned_* columns below and this
   * field is preserved verbatim for the audit trail.
   */
  recipientHint: text("recipient_hint").notNull().default(""),
  recipientHintNote: text("recipient_hint_note").notNull().default(""),
  /**
   * v15 — owner-assigned item lifecycle.
   *
   * These four columns are populated when the captain confirms (during import
   * review) that the owner assigned this item to someone. Two sources are
   * possible today: the structured `recipient_hint` field, or a detected
   * assignment inside the owner's Important comment. Every write is audited
   * in the classification changes log.
   *
   * When `ownerAssignedSource` is non-empty, the item's `status` is
   * 'owner_assigned' and it is held out of every ranking, drafting,
   * grouping, and bidding pool. The captain can move it back to 'available' with
   * a recorded reason (Return to pool) or award it directly to the named
   * person (Award to named person).
   */
  ownerAssignedName: text("owner_assigned_name").notNull().default(""),
  ownerAssignedParticipantId: integer("owner_assigned_participant_id"),
  /** '' | 'recipient_hint' | 'comment_detected' | 'captain_manual' | 'memorandum' */
  ownerAssignedSource: text("owner_assigned_source").notNull().default(""),
  /** Verbatim quote of the words that established the assignment. */
  ownerAssignedEvidence: text("owner_assigned_evidence").notNull().default(""),
  /**
   * Commit 4 \u2014 memorandum-locked items.
   *
   * True when this item was locked by a frozen memorandum travelling in
   * the import bundle. When true, the item is displayed but unselectable
   * everywhere in the game: no ranking, no bidding, no swaps. Heirs see
   * a name + room + one photo and the note \u201cHandled as a special gift
   * under the will.\u201d Recipient identity never crosses into FC \u2014
   * that lives only on the paper the trustee holds.
   *
   * memorandumOwnerName carries the deceased owner's name for the group
   * heading in the UI (e.g. \u201cHandled by Mary\u2019s memorandum\u201d).
   * When the export left the field empty, the UI shows a neutral fallback.
   */
  lockedByMemorandum: integer("locked_by_memorandum", { mode: "boolean" }).notNull().default(false),
  memorandumOwnerName: text("memorandum_owner_name").notNull().default(""),
});

/* ------------------------------------------------------------------ */
/* categoryChanges — audit of every category assignment                */
/* ------------------------------------------------------------------ */
export const categoryChanges = sqliteTable("category_changes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: integer("session_id").notNull(),
  itemId: integer("item_id").notNull(),
  oldCategory: text("old_category"),
  newCategory: text("new_category"),
  /** Null when the Captain acted without signing in. */
  changedByParticipantId: integer("changed_by_participant_id"),
  changedAt: integer("changed_at").notNull(),
  // 'user' | 'ai_auto' | 'ai_dismissed' | 'reviewed_by_heir' | 'reviewed_by_pr'
  source: text("source").notNull().default("user"),
  /** Session phase at the moment of the change. */
  phase: text("phase").notNull().default(""),
});

export const CATEGORY_CHANGE_SOURCES = [
  "user",
  "ai_auto",
  "ai_dismissed",
  "reviewed_by_heir",
  "reviewed_by_pr",
] as const;
export type CategoryChangeSource = (typeof CATEGORY_CHANGE_SOURCES)[number];

/** The label shown wherever an item has no category. */
export const UNCATEGORIZED_LABEL = "Uncategorized";

/** True when an item sits in the implicit uncategorized bucket. */
export function isUncategorized(item: { category?: string | null }): boolean {
  return !item.category || item.category.trim() === "";
}

/** One AI category suggestion. */
export type AiSuggestion = { category: string; confidence: number };

/** Parse the stored `aiSuggestions` JSON blob. */
export function parseAiSuggestions(raw: string | null | undefined): AiSuggestion[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((s) => s && typeof s.category === "string")
        .map((s) => ({ category: String(s.category), confidence: Number(s.confidence) || 0 }));
    }
  } catch {
    /* fall through */
  }
  return [];
}

/** Above this the analyser assigns the category itself. */
export const AI_CATEGORY_CONFIDENCE_THRESHOLD = 0.75;

/** Two changes by different people inside this window count as a conflict. */
export const CATEGORY_CONFLICT_WINDOW_MS = 30_000;

/** Category edits allowed per participant per minute before the soft warning. */
export const CATEGORY_RATE_LIMIT = 20;
export const CATEGORY_RATE_WINDOW_MS = 60_000;

/** Copy for the floodguard toast. */
export const CATEGORY_THROTTLE_MESSAGE =
  "Slow down — give others a chance to weigh in.";

/** Payload written for a `category_changed` notification. */
export type CategoryChangedPayload = {
  changeId: number;
  itemId: number;
  itemName: string;
  oldCategory: string | null;
  newCategory: string | null;
  changedByParticipantId: number | null;
  changedByParticipantName: string;
  source: CategoryChangeSource;
  needsDiscussion: boolean;
};

/** One-line sentence describing a category change. */
export function categorySentence(p: CategoryChangedPayload): string {
  const who = p.changedByParticipantName;
  const item = `\u201c${p.itemName}\u201d`;
  if (!p.newCategory) return `${who} cleared the category on ${item}`;
  if (!p.oldCategory) return `${who} categorised ${item} as ${p.newCategory}`;
  return `${who} changed ${item} from ${p.oldCategory} to ${p.newCategory}`;
}

/* ------------------------------------------------------------------ */
/* rankings — each heir's private ordering of the pool                 */
/* ------------------------------------------------------------------ */
export const rankings = sqliteTable("rankings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: integer("session_id").notNull(),
  participantId: integer("participant_id").notNull(),
  itemId: integer("item_id").notNull(),
  rank: integer("rank").notNull(),
  createdAt: integer("created_at").notNull().default(0),
  updatedAt: integer("updated_at").notNull().default(0),
});

/* ------------------------------------------------------------------ */
/* rankingEditsLog — audit trail of ranking edits made for an heir     */
/* ------------------------------------------------------------------ */
export const rankingEditsLog = sqliteTable("ranking_edits_log", {
  id: text("id").primaryKey(),
  sessionId: integer("session_id").notNull(),
  /** Whose ranking was edited. */
  participantId: integer("participant_id").notNull(),
  itemId: integer("item_id").notNull(),
  /** null when the item was newly added to the ranking. */
  oldRank: integer("old_rank"),
  /** null when the item was removed from the ranking. */
  newRank: integer("new_rank"),
  /** The participant (normally the captain) who made the edit. */
  editedByParticipantId: integer("edited_by_participant_id").notNull(),
  editedAt: integer("edited_at").notNull(),
  // 'self' | 'assist'
  mode: text("mode").notNull().default("self"),
  /** Set when the heir dismisses the "captain made N adjustments" summary. */
  dismissedAt: integer("dismissed_at"),
});

/* ------------------------------------------------------------------ */
/* groupings                                                           */
/* ------------------------------------------------------------------ */
export const groupings = sqliteTable("groupings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: integer("session_id").notNull(),
  name: text("name").notNull(),
  // 'heirloom' | 'custom'
  type: text("type").notNull().default("custom"),
  // 'open' | 'resolved_awarded' | 'resolved_broken_up'
  status: text("status").notNull().default("open"),
  awardedToParticipantId: integer("awarded_to_participant_id"),
  resolvedInRound: integer("resolved_in_round"),
});

/* ------------------------------------------------------------------ */
/* groupingOptIns                                                      */
/* ------------------------------------------------------------------ */
export const groupingOptIns = sqliteTable("grouping_opt_ins", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  groupingId: integer("grouping_id").notNull(),
  participantId: integer("participant_id").notNull(),
  // 'want' | 'pass' | null
  choice: text("choice"),
});

/* ------------------------------------------------------------------ */
/* appraisalFlags (v15 commit 3 rename — was appraisalFlags)      */
/* ------------------------------------------------------------------ */
/**
 * One row per "this item should be appraised by the trustee" flag.
 *
 * Two orthogonal properties live on every item:
 *   1. Important — emotional/heart flag (see items.is_important).
 *      Affects the game (who wins) but NOT the trustee's dollar work.
 *   2. Needs appraisal — this table + items.needs_appraisal.
 *      Sends the item to the trustee for a real number so equalization
 *      is legally fair. Does NOT change who wins.
 *
 * A single actor (heir hunch, owner via Registry, AI estimate, or
 * eventually category rule) can flag an item; the captain can undo an
 * honest mistake by setting reverted_at + reverted_by_captain_id.
 * Owner-source rows CANNOT be reverted (the owner is deceased at this
 * stage). Reverted rows stay in the audit trail per project rule.
 */
export const appraisalFlags = sqliteTable("appraisal_flags", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: integer("session_id").notNull(),
  itemId: integer("item_id").notNull(),
  // 'heir' | 'owner' | 'ai' | 'category' (category source lands in commit 4)
  flaggedBySource: text("flagged_by_source").notNull(),
  // Set only when source='heir'; null for owner / ai / category.
  flaggedByParticipantId: integer("flagged_by_participant_id"),
  // Optional free text. Heirs may leave blank ("a hunch is enough"). AI
  // writes a reason with the estimate + "not an official appraisal"
  // caveat. Owner-source reason comes from the ReindeerExchange envelope.
  reason: text("reason"),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  // Captain reversion (visible in audit trail per project rule).
  revertedAt: integer("reverted_at"),
  revertedByCaptainId: integer("reverted_by_captain_id"),
});

/* ------------------------------------------------------------------ */
/* picks                                                               */
/* ------------------------------------------------------------------ */
export const picks = sqliteTable("picks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: integer("session_id").notNull(),
  round: integer("round").notNull(),
  participantId: integer("participant_id").notNull(),
  itemId: integer("item_id").notNull(),
  // 1 = first, 2 = second, 3 = third
  pickOrder: integer("pick_order").notNull().default(1),
  // 'awarded' | 'lost_contest' | 'pending'
  outcome: text("outcome").notNull().default("pending"),
  isTiebreak: integer("is_tiebreak", { mode: "boolean" })
    .notNull()
    .default(false),
  affectsRegularDraftCounter: integer("affects_regular_draft_counter", {
    mode: "boolean",
  })
    .notNull()
    .default(true),
  isPractice: integer("is_practice", { mode: "boolean" }).notNull().default(false),
  // 'manual' | 'auto_rank' — how the pick reached the table.
  source: text("source").notNull().default("manual"),
});

/* ------------------------------------------------------------------ */
/* duplicateGroups                                                     */
/* ------------------------------------------------------------------ */
export const duplicateGroups = sqliteTable("duplicate_groups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: integer("session_id").notNull(),
  resolvedBy: integer("resolved_by"),
  // 'open' | 'resolved'
  status: text("status").notNull().default("open"),
});

/* ------------------------------------------------------------------ */
/* classificationChanges — audit of heir flag toggles                  */
/* ------------------------------------------------------------------ */
export const classificationChanges = sqliteTable("classification_changes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: integer("session_id").notNull(),
  itemId: integer("item_id").notNull(),
  // 'isHeirloom' | 'needsAppraisal' | 'isSentimental'
  flagName: text("flag_name").notNull(),
  oldValue: integer("old_value", { mode: "boolean" }).notNull().default(false),
  newValue: integer("new_value", { mode: "boolean" }).notNull().default(false),
  /** Null when the Captain acted without signing in. */
  changedByParticipantId: integer("changed_by_participant_id"),
  changedAt: integer("changed_at").notNull(),
  reason: text("reason").notNull().default(""),
  /** Session phase at the moment of the change. */
  phase: text("phase").notNull().default(""),
  isRevert: integer("is_revert", { mode: "boolean" }).notNull().default(false),
  revertedAt: integer("reverted_at"),
  revertedByParticipantId: integer("reverted_by_participant_id"),
  /** JSON [{participantId, rank}] stripped when a high-value flag went on. */
  removedRankings: text("removed_rankings").notNull().default("[]"),
});

/* ------------------------------------------------------------------ */
/* notifications — per-participant inbox                               */
/* ------------------------------------------------------------------ */
export const notifications = sqliteTable("notifications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: integer("session_id").notNull(),
  /** Recipient. */
  participantId: integer("participant_id").notNull(),
  type: text("type").notNull(),
  /** JSON payload — shape depends on `type`. */
  payload: text("payload").notNull().default("{}"),
  createdAt: integer("created_at").notNull(),
  readAt: integer("read_at"),
});

/** Every notification kind the app can raise. */
export const NOTIFICATION_TYPES = [
  "classification_changed",
  "ranking_affected",
  "item_returned",
  "reconciliation_requested",
  "reconciliation_reminder",
  "reconciliation_stalled",
  "auto_draft_paused",
  "category_changed",
  "estate_paused",
  "estate_resumed",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Payload written for a `classification_changed` notification. */
export type ClassificationChangedPayload = {
  changeId: number;
  itemId: number;
  itemName: string;
  flagName: ClassificationFlag;
  oldValue: boolean;
  newValue: boolean;
  changedByParticipantId: number | null;
  changedByParticipantName: string;
  reason?: string;
  isRevert: boolean;
};

/** The three flags heirs may toggle. */
export const CLASSIFICATION_FLAGS = ["isHeirloom", "needsAppraisal", "isSentimental"] as const;
export type ClassificationFlag = (typeof CLASSIFICATION_FLAGS)[number];

/** Human label for a flag, used in notification copy. */
export const FLAG_LABEL: Record<ClassificationFlag, string> = {
  isHeirloom: "heirloom",
  needsAppraisal: "high-value",
  isSentimental: "sentimental",
};

/** Phases in which heirs may still change classification flags. */
export const CLASSIFICATION_OPEN_PHASES = [
  "intake",
  "ranking",
  "groupings",
  "secondary_ranking",
] as const;

/** Phases whose flag changes fan out to everyone at the table. */
export const CLASSIFICATION_FANOUT_PHASES = ["ranking", "secondary_ranking"] as const;

/** One-line sentence describing a classification change. */
export function classificationSentence(p: ClassificationChangedPayload): string {
  const label = FLAG_LABEL[p.flagName] ?? p.flagName;
  if (p.isRevert) {
    return `${p.changedByParticipantName} reverted the ${label} flag on \u201c${p.itemName}\u201d`;
  }
  return p.newValue
    ? `${p.changedByParticipantName} flagged \u201c${p.itemName}\u201d as ${label}`
    : `${p.changedByParticipantName} removed the ${label} flag from \u201c${p.itemName}\u201d`;
}

/* ------------------------------------------------------------------ */
/* reconciliation                                                      */
/* ------------------------------------------------------------------ */
export type ReconciliationState = {
  active: boolean;
  /** Draft round at which the checkpoint opened. */
  round: number;
  startedAt: number;
  /** participantId -> 'continue' | 'pause' */
  responses: Record<string, "continue" | "pause">;
  /** null while open. */
  resolution: "continue" | "paused" | null;
  nudgedAt: number | null;
  /** Set once the stalled-notification has been raised, so it fires once. */
  stalledNotifiedAt: number | null;
};

export const EMPTY_RECONCILIATION: ReconciliationState = {
  active: false,
  round: 0,
  startedAt: 0,
  responses: {},
  resolution: null,
  nudgedAt: null,
  stalledNotifiedAt: null,
};

export function parseReconciliation(raw: string | null | undefined): ReconciliationState {
  if (!raw) return { ...EMPTY_RECONCILIATION };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object")
      return { ...EMPTY_RECONCILIATION, ...(parsed as object) };
  } catch {
    /* fall through */
  }
  return { ...EMPTY_RECONCILIATION };
}

/** Uncontested auto-rounds allowed before the table must reconcile. */
export function reconciliationInterval(practiceMode: string | null | undefined): number {
  return practiceMode && practiceMode !== "off" ? 3 : 5;
}

/* ================================================================== */
/* v8 — High-value fiduciary workflow                                  */
/* ================================================================== */

/* ------------------------------------------------------------------ */
/* itemValuations — immutable ledger of every value opinion            */
/* ------------------------------------------------------------------ */
/**
 * Every valuation ever recorded for an item. The row on `items` shows the
 * currently-active values; this table is the history. New rows are appended,
 * never edited. When the captain/fiduciary approves a value, a new row is written
 * with status='approved' and `items.approvedValue` / `items.valueStatus` are
 * updated to point at it.
 */
export const itemValuations = sqliteTable("item_valuations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: integer("session_id").notNull(),
  itemId: integer("item_id").notNull(),
  /** Dollar value in whole dollars or cents — whatever the estate uses uniformly. */
  value: real("value").notNull(),
  /** Optional range for appraisals that give one. */
  valueLow: real("value_low"),
  valueHigh: real("value_high"),
  /** 'ai' | 'manual' | 'appraisal' | 'comparable_sale' | 'auction' | 'other' */
  source: text("source").notNull(),
  /** 'estimated' | 'pending_review' | 'approved' | 'disputed' | 'stale' */
  status: text("status").notNull().default("estimated"),
  /** Free-text methodology / appraiser identity / URL of comp sale. */
  notes: text("notes").notNull().default(""),
  /** Optional signed appraisal PDF or invoice supporting the value. */
  attachmentUrl: text("attachment_url"),
  /** Who authored this valuation — null if the captain entered it. */
  createdByParticipantId: integer("created_by_participant_id"),
  createdAt: integer("created_at").notNull(),
  /** Set when this valuation was superseded by a newer one. */
  supersededAt: integer("superseded_at"),
  supersededByValuationId: integer("superseded_by_valuation_id"),
});

/* ------------------------------------------------------------------ */
/* methodAgreements — each heir's up-front buy-in to FairPlay's     */
/* method (v14, Trustee Handoff rescope)                                */
/* ------------------------------------------------------------------ */
/**
 * One row per heir per session. Records the heir's agreement, before ranking
 * opens, that the family will divide personal property using FairPlay's
 * ranked-draft method — knowing that dollar totals inside FairPlay do not
 * need to be equal because the trustee balances the financial side externally
 * using other estate assets (cash, real property, brokerage, retirement).
 *
 * Immutable once written. The current agreement text is snapshotted onto the
 * row at signing time (agreementTextSnapshot / agreementVersion) so future
 * edits to CURRENT_METHOD_AGREEMENT_TEXT never retroactively change what an
 * heir actually agreed to.
 */
export const methodAgreements = sqliteTable(
  "method_agreements",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: integer("session_id").notNull(),
    participantId: integer("participant_id").notNull(),
    agreedAt: integer("agreed_at").notNull(),
    /** Semver-ish version tag. Matches CURRENT_METHOD_AGREEMENT_VERSION at sign time. */
    agreementVersion: text("agreement_version").notNull().default("1.0"),
    /** Immutable copy of the exact language the heir agreed to. */
    agreementTextSnapshot: text("agreement_text_snapshot").notNull(),
    /** 'magic_link' | 'in_person'. */
    signatureMethod: text("signature_method").notNull().default("magic_link"),
    /** Auth token id when signed via magic link. */
    magicLinkTokenId: integer("magic_link_token_id"),
    clientIp: text("client_ip"),
    clientUserAgent: text("client_user_agent"),
    /**
     * Captain the heir was agreeing to when they signed. Snapshotted so a
     * later captain change requires a fresh signature on the new mandate;
     * old rows stay on the record for audit but no longer count toward
     * the current mandate. Defaults to 0 (nonexistent participant id) for
     * rows written before captain was part of the wire format.
     * See docs/specs/2026-08-08-captain-model.md.
     */
    captainParticipantId: integer("captain_participant_id")
      .notNull()
      .default(0),
  },
  (t) => ({
    /**
     * One signature per (heir, captain) pair. Re-sign on captain change
     * writes a new row rather than overwriting the old one, so the audit
     * log preserves every mandate the heir has ever agreed to.
     */
    uniqPerParticipant: uniqueIndex(
      "method_agreements_session_participant_uniq",
    ).on(t.sessionId, t.participantId, t.captainParticipantId),
  }),
);

export type MethodAgreement = typeof methodAgreements.$inferSelect;
export type InsertMethodAgreement = typeof methodAgreements.$inferInsert;

/** Version tag for the current agreement text. Bump when the text changes. */
export const CURRENT_METHOD_AGREEMENT_VERSION = "2.0";

/**
 * The exact language every heir signs before ranking opens. Written for
 * elderly readers: plain sentences, no legalese, no jargon. The captain's
 * name is spliced in at sign time via renderMethodAgreementText and
 * snapshotted onto each methodAgreements row so future edits here never
 * retroactively change what an heir already agreed to.
 *
 * v2.0 names the captain explicitly — the captain is who the heirs are
 * agreeing to let run this session's phases. If the captain changes, a
 * fresh signature on the new mandate is required before the game resumes.
 * See docs/specs/2026-08-08-captain-model.md.
 *
 * Uses the literal placeholder ${captainName}. Callers must run
 * renderMethodAgreementText before displaying or snapshotting.
 */
export const CURRENT_METHOD_AGREEMENT_TEXT =
  "I agree to divide the personal property in this estate using FairPlay's ranked-draft method. " +
  "I agree that ${captainName} will run this session as captain — opening and closing phases, resolving disputes, and reading out the results. " +
  "I understand that FairPlay sorts items by what matters to each of us, not by dollar totals, " +
  "and that the dollar amounts on either side of the draft do not need to be equal. " +
  "The trustee will balance any dollar differences separately using other estate assets " +
  "(such as cash, real property, brokerage, and retirement accounts) according to the will and trust documents. " +
  "I understand that any heir may ask for an appraised value on any item at any time before the final signing, " +
  "and that items awaiting appraisal will be listed for the trustee to resolve after FairPlay ends. " +
  "I understand that if the captain changes, I will be asked to sign a fresh agreement naming the new captain before the session continues. " +
  "By signing, I am agreeing up front to accept the ranked-draft outcome for the items themselves.";

/**
 * Splices the captain's name into the agreement template. Kept as a
 * separate helper so both the display path (what the heir sees before
 * signing) and the snapshot path (what gets stored in agreement_text_snapshot)
 * produce the exact same string.
 */
export function renderMethodAgreementText(captainName: string): string {
  return CURRENT_METHOD_AGREEMENT_TEXT.replace("${captainName}", captainName);
}

/* ------------------------------------------------------------------ */
/* highValueAuditLog — every event that touches a high-value item      */
/* ------------------------------------------------------------------ */
/**
 * Append-only stream. Every flagging, valuation change, equalization
 * proposal, consent, override, and finalization writes one row. This is the
 * single source of truth for a trustee reconstructing the item's history.
 */
export const highValueAuditLog = sqliteTable("high_value_audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: integer("session_id").notNull(),
  itemId: integer("item_id").notNull(),
  /** See HIGH_VALUE_AUDIT_EVENTS. */
  eventType: text("event_type").notNull(),
  /** JSON blob — shape depends on eventType. */
  payload: text("payload").notNull().default("{}"),
  /** Item state immediately BEFORE this event, for reconstruction. */
  stateBefore: text("state_before").notNull(),
  /** Item state immediately AFTER this event. */
  stateAfter: text("state_after").notNull(),
  /** Value basis at the moment of the event. */
  valueAtEvent: real("value_at_event"),
  valueStatusAtEvent: text("value_status_at_event"),
  /** Actor. Null if the action was captain-attributed but no participant was signed in. */
  actorParticipantId: integer("actor_participant_id"),
  /** 'captain' | 'heir' | 'trustee' | 'system' | 'appraiser'. */
  actorRole: text("actor_role").notNull(),
  /** Free-text if the actor added a reason. */
  reason: text("reason").notNull().default(""),
  createdAt: integer("created_at").notNull(),
});

/* ------------------------------------------------------------------ */
/* Constants                                                          */
/* ------------------------------------------------------------------ */

/**
 * Fiduciary lifecycle states for an item. In v15 the only states that get
 * written are `normal` (default) and `flagged_high_value` (item is escalated
 * to the trustee's appraisal queue). `awaiting_value_review` is preserved
 * because the appraisal-review flow reads it as a display filter.
 */
export const ITEM_STATES = [
  "normal",
  "flagged_high_value",
  "awaiting_value_review",
] as const;
export type ItemState = (typeof ITEM_STATES)[number];

/** Value status progression for an item's active valuation. */
export const VALUE_STATUSES = [
  "estimated",
  "pending_review",
  "approved",
  "disputed",
  "stale",
] as const;
export type ValueStatus = (typeof VALUE_STATUSES)[number];

/** Sources a valuation can come from. */
export const VALUE_SOURCES = [
  "ai",
  "manual",
  "appraisal",
  "comparable_sale",
  "auction",
  "other",
] as const;
export type ValueSource = (typeof VALUE_SOURCES)[number];

/**
 * Event types that flow into highValueAuditLog. The equalization / consent /
 * finalization events were retired in v15 alongside the machinery that wrote
 * them; only the events the app still writes remain.
 */
export const HIGH_VALUE_AUDIT_EVENTS = [
  "flagged",
  "unflagged",
  "valuation_added",
  "valuation_approved",
  "valuation_disputed",
  "valuation_superseded",
  "provisional_allocation_set",
  "provisional_allocation_cleared",
  "reopened",
  "method_agreement_signed",
] as const;
export type HighValueAuditEvent = (typeof HIGH_VALUE_AUDIT_EVENTS)[number];

/* ------------------------------------------------------------------ */
/* State-transition helpers                                           */
/* ------------------------------------------------------------------ */

/** True if the item's current valuation may be used for FINAL accounting. */
export function valueIsFinal(status: ValueStatus | string | null | undefined): boolean {
  return status === "approved";
}

/** True if drafting/provisional allocation may proceed on this item. */
export function valueIsUsableForProvisional(
  status: ValueStatus | string | null | undefined,
): boolean {
  return status === "estimated" || status === "pending_review" || status === "approved";
}

/* ------------------------------------------------------------------ */
/* insert schemas + types                                              */
/* ------------------------------------------------------------------ */
export const insertSessionSchema = createInsertSchema(sessions).omit({ id: true });
export const insertParticipantSchema = createInsertSchema(participants).omit({ id: true });
export const insertItemSchema = createInsertSchema(items).omit({ id: true });
export const insertGroupingSchema = createInsertSchema(groupings).omit({ id: true });
export const insertGroupingOptInSchema = createInsertSchema(groupingOptIns).omit({ id: true });
export const insertAppraisalFlagSchema = createInsertSchema(appraisalFlags).omit({ id: true });
export const insertPickSchema = createInsertSchema(picks).omit({ id: true });
export const insertDuplicateGroupSchema = createInsertSchema(duplicateGroups).omit({ id: true });
export const insertTaxonomySchema = createInsertSchema(taxonomy).omit({ id: true });
export const insertRankingSchema = createInsertSchema(rankings).omit({ id: true });
export const insertRankingEditLogSchema = createInsertSchema(rankingEditsLog).omit({ id: true });
export const insertClassificationChangeSchema = createInsertSchema(classificationChanges).omit({ id: true });
export const insertCategoryChangeSchema = createInsertSchema(categoryChanges).omit({ id: true });
export const insertNotificationSchema = createInsertSchema(notifications).omit({ id: true });
export const insertCaptainTransferSchema = createInsertSchema(captainTransfers);
export const insertItemValuationSchema = createInsertSchema(itemValuations).omit({ id: true });
export const insertHighValueAuditLogSchema = createInsertSchema(highValueAuditLog).omit({
  id: true,
});

export type InsertSession = z.infer<typeof insertSessionSchema>;
export type Session = typeof sessions.$inferSelect;

export type InsertParticipant = z.infer<typeof insertParticipantSchema>;
export type Participant = typeof participants.$inferSelect;

export type InsertItem = z.infer<typeof insertItemSchema>;
export type Item = typeof items.$inferSelect;

export type InsertGrouping = z.infer<typeof insertGroupingSchema>;
export type Grouping = typeof groupings.$inferSelect;

export type InsertGroupingOptIn = z.infer<typeof insertGroupingOptInSchema>;
export type GroupingOptIn = typeof groupingOptIns.$inferSelect;

export type InsertAppraisalFlag = z.infer<typeof insertAppraisalFlagSchema>;
export type AppraisalFlag = typeof appraisalFlags.$inferSelect;

export type InsertPick = z.infer<typeof insertPickSchema>;
export type Pick = typeof picks.$inferSelect;

export type InsertDuplicateGroup = z.infer<typeof insertDuplicateGroupSchema>;
export type DuplicateGroup = typeof duplicateGroups.$inferSelect;

export type InsertRanking = z.infer<typeof insertRankingSchema>;
export type Ranking = typeof rankings.$inferSelect;

export type InsertRankingEditLog = z.infer<typeof insertRankingEditLogSchema>;
export type RankingEditLog = typeof rankingEditsLog.$inferSelect;

export type InsertClassificationChange = z.infer<typeof insertClassificationChangeSchema>;
export type ClassificationChange = typeof classificationChanges.$inferSelect;

export type InsertCategoryChange = z.infer<typeof insertCategoryChangeSchema>;
export type CategoryChange = typeof categoryChanges.$inferSelect;

export type InsertNotification = z.infer<typeof insertNotificationSchema>;
export type AppNotification = typeof notifications.$inferSelect;

export type InsertItemValuation = z.infer<typeof insertItemValuationSchema>;
export type ItemValuation = typeof itemValuations.$inferSelect;

export type InsertHighValueAuditLog = z.infer<typeof insertHighValueAuditLogSchema>;
export type HighValueAuditLogEntry = typeof highValueAuditLog.$inferSelect;

/** How long an "edited by captain" badge stays on the heir's own ranking page. */
export const ASSIST_BADGE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** A participant who administers the session but does not draft. */
export function isPureCaptainParticipant(
  p: { isAdmin?: boolean | null; administersOnly?: boolean | null } | null | undefined,
): boolean {
  return !!p?.isAdmin && !!p?.administersOnly;
}

/** A participant who administers the session AND takes items in the draft. */
export function isCaptainHeirParticipant(
  p: { isAdmin?: boolean | null; administersOnly?: boolean | null } | null | undefined,
): boolean {
  return !!p?.isAdmin && !p?.administersOnly;
}

/** Aggregated, name-free statistics shown to a captain who is also an heir. */
export type RankingItemStat = {
  itemId: number;
  name: string;
  room: string;
  category: string | null;
  status: string;
  rankedBy: number;
  totalHeirs: number;
  median: number | null;
  min: number | null;
  max: number | null;
  topFive: number;
};

/** Ordered phase list. `groupings` is optional; secondary phases are conditional. */
export const PHASE_ORDER = [
  "welcome",
  "estate_name",
  "registration",
  "intake",
  "ranking",
  "groupings",
  "draft",
  "secondary_ranking",
  "secondary_draft",
  "complete",
] as const;

export type Phase = (typeof PHASE_ORDER)[number];

/**
 * Phase names accepted on the wire. `setup` is the pre-v5 name for the
 * roster-building phase and `cataloging` is the human name for `intake`;
 * both are accepted and normalised so older harnesses keep working.
 */
export const PHASE_ALIASES: Record<string, Phase> = {
  setup: "registration",
  cataloging: "intake",
};

export const PHASE_INPUT_VALUES = [...PHASE_ORDER, "setup", "cataloging"] as const;

/** Map any accepted phase name onto its canonical value. */
export function normalizePhase(p: string): Phase {
  return (PHASE_ALIASES[p] ?? p) as Phase;
}

/** Phases before the heir roster is closed. */
export const PRE_CATALOGING_PHASES = [
  "welcome",
  "estate_name",
  "registration",
] as const;

/** True while heirs may still be added, renamed, or removed. */
export function registrationOpen(phase: string): boolean {
  return (PRE_CATALOGING_PHASES as readonly string[]).includes(normalizePhase(phase));
}

/** The message shown wherever roster editing is no longer permitted. */
export const ROSTER_CLOSED_MESSAGE =
  "The heir roster was closed. Only captain transfers are allowed now.";

/** Confirmation copy for the irreversible close-registration step. */
export const CLOSE_REGISTRATION_WARNING =
  "This locks the heir roster. After closing, you cannot add or remove heirs. " +
  "You will still be able to transfer the captain role to another heir or a new outside captain. Continue?";

/** Fallback title used before the estate has been named. */
export const DEFAULT_ESTATE_TITLE = "The Personal Property Division";

/** The estate's display title. */
export function estateTitle(estateName: string | null | undefined): string {
  const trimmed = (estateName ?? "").trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_ESTATE_TITLE;
}

/* ------------------------------------------------------------------ */
/* ranking window helpers                                              */
/* ------------------------------------------------------------------ */
export const RANKING_WINDOW_MIN_DAYS = 7;
export const RANKING_WINDOW_MAX_DAYS = 30;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Which ranking window a phase uses, or null when no window applies. */
export function windowPhaseOf(phase: string): "ranking" | "secondary_ranking" | null {
  if (phase === "ranking") return "ranking";
  if (phase === "secondary_ranking") return "secondary_ranking";
  return null;
}

export type RankingWindow = {
  /** Which window these numbers describe. */
  phase: "ranking" | "secondary_ranking";
  windowDays: number;
  openedAt: number | null;
  deadline: number | null;
  /** True once the deadline has passed. */
  closed: boolean;
  msRemaining: number | null;
};

/** Read the window belonging to `phase` off a session row. */
export function rankingWindowOf(
  session: {
    rankingWindowDays?: number | null;
    rankingOpenedAt?: number | null;
    rankingDeadline?: number | null;
    secondaryRankingWindowDays?: number | null;
    secondaryRankingOpenedAt?: number | null;
    secondaryRankingDeadline?: number | null;
  },
  phase: "ranking" | "secondary_ranking",
  now = Date.now(),
): RankingWindow {
  const secondary = phase === "secondary_ranking";
  const deadline =
    (secondary ? session.secondaryRankingDeadline : session.rankingDeadline) ?? null;
  return {
    phase,
    windowDays:
      (secondary ? session.secondaryRankingWindowDays : session.rankingWindowDays) ?? 30,
    openedAt: (secondary ? session.secondaryRankingOpenedAt : session.rankingOpenedAt) ?? null,
    deadline,
    closed: deadline !== null && deadline <= now,
    msRemaining: deadline === null ? null : deadline - now,
  };
}

/** "3 days, 4 hours" / "5 hours, 12 minutes" / "8 minutes". */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return "0 minutes";
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (days > 0) return `${plural(days, "day")}, ${plural(hours, "hour")}`;
  if (hours > 0) return `${plural(hours, "hour")}, ${plural(minutes, "minute")}`;
  return plural(minutes, "minute");
}

/** Urgency band driving the countdown colour. */
export function countdownTone(msRemaining: number | null): "normal" | "soon" | "amber" | "red" | "closed" {
  if (msRemaining === null) return "normal";
  if (msRemaining <= 0) return "closed";
  if (msRemaining < 60 * 60 * 1000) return "red";
  if (msRemaining < 24 * 60 * 60 * 1000) return "amber";
  if (msRemaining < 48 * 60 * 60 * 1000) return "soon";
  return "normal";
}

/** Phases in which the Ranking page is open to heirs. */
export const RANKING_OPEN_PHASES = [
  "ranking",
  "draft",
  "secondary_ranking",
  "secondary_draft",
] as const;

export type InsertTaxonomy = z.infer<typeof insertTaxonomySchema>;
export type Taxonomy = typeof taxonomy.$inferSelect;
export type TaxonomyRow = Taxonomy & { itemCount: number };

/** One resolved practice award, recorded on every practice reveal. */
export type PracticeAward = {
  itemId: number;
  itemName: string;
  room: string;
  category: string;
  participantId: number;
  participantName: string;
  round: number;
  wasContested: boolean;
  losingParticipantIds: number[];
  losingParticipantNames: string[];
};

/**
 * A heir taking part in a practice round. Real heirs carry their real
 * participant id; placeholders are practice-only and live solely in the
 * `practiceState` blob with a negative id.
 */
export type PracticeHeir = {
  id: number;
  name: string;
  isPlaceholder: boolean;
  priorityPosition: number;
  contestedLossCounter: number;
};

/** Placeholder heir naming: "Practice Heir A", "Practice Heir B", … */
export function placeholderHeirName(index: number): string {
  return `Practice Heir ${String.fromCharCode(65 + index)}`;
}

export const PRACTICE_HEIR_COUNT_OPTIONS = [2, 3, 4, 5, 6, 7, 8] as const;

export type PracticeState = {
  currentRound: number;
  /** Practice roster — real heirs plus any generated placeholders. */
  heirs: PracticeHeir[];
  priorityOrder: number[];
  contestedLossCounters: Record<string, number>;
  /** Fast item -> award lookup used to overlay the pool. */
  awardsByItem: Record<string, { participantId: number; round: number }>;
  /** Full per-round award history, used by the Practice Results summary. */
  awards: PracticeAward[];
  /** Snapshot of the counters after the most recent reveal. */
  finalCounters: Record<string, number>;
  /**
   * Practice-scoped rankings, keyed by participant id. Real rankings in the
   * `rankings` table are never read or written while practice is running.
   */
  rankings: Record<string, { itemId: number; rank: number }[]>;
  phaseBefore: string;
};

/** A single row of the practice results summary. */
export type PracticeResults = {
  mode: string;
  currentRound: number;
  awards: PracticeAward[];
  counters: {
    participantId: number;
    name: string;
    isPlaceholder: boolean;
    practiceContestedLosses: number;
    realContestedLossCounter: number;
  }[];
  priorityOrder: { participantId: number; name: string; isPlaceholder: boolean }[];
};

/* ------------------------------------------------------------------ */
/* contested category stages                                           */
/* ------------------------------------------------------------------ */
/**
 * One category stage and how much of it is left.
 *
 * `total` always equals `awarded + remaining + heldBack`. That is deliberate:
 * if the three parts did not reconcile with the whole, a family looking at the
 * screen would reasonably think the app had lost something of theirs.
 */
export type StageLine = {
  label: string;
  /** Every non-practice item in this category. */
  total: number;
  /** Already gone to someone. */
  awarded: number;
  /** Still to be divided in this stage. */
  remaining: number;
  /** Set aside as high-value, so out of the pool until the captain releases it. */
  heldBack: number;
};

/**
 * Which category stage is in play, and what is done or still waiting.
 *
 * The commonly contested categories — jewelry, personal possessions,
 * photographs, heirlooms — are divided in their own rounds so that an heir who
 * cares about jewelry is not made to spend picks against garden tools. This is
 * the shape both the heirs' screen and the representative's dashboard read to
 * say, in plain words, what is happening now.
 */
export type StageProgress = {
  /** False when no stages are switched on: one pool, everything at once. */
  usingStages: boolean;
  /** The stage being divided now, or null when the staged rounds are over. */
  open: StageLine | null;
  /** Stages with nothing left to divide. */
  finished: StageLine[];
  /** Stages still to come, in the order they will run. */
  waiting: StageLine[];
  /** Everything in no stage at all — the general round that follows. */
  general: StageLine;
  /** A sentence for the screen. Plain language, no jargon. */
  headline: string;
};

/* ------------------------------------------------------------------ */
/* shared constants                                                    */
/* ------------------------------------------------------------------ */
/** The 15 standard rooms seeded (disabled) on every session bootstrap. */
export const STANDARD_ROOMS = [
  "Living Room",
  "Dining Room",
  "Kitchen",
  "Primary Bedroom",
  "Bedroom 2",
  "Bedroom 3",
  "Family Room",
  "Office/Study",
  "Garage",
  "Attic",
  "Basement",
  "Outdoor/Yard",
  "Storage",
  "Closet",
  "Miscellaneous",
] as const;

/** The 14 standard categories seeded (disabled) on every session bootstrap. */
/**
 * The standard categories offered when an estate starts.
 *
 * These now come from the legal classification table, so the set covers the
 * property kinds that federal law treats differently — firearms, collectibles,
 * precious metals, coins, vehicles — rather than only the tidy household
 * groupings. Categories remain fully fluid: the captain can
 * rename, add, merge, and delete any of them. Seeding a legally aware set only
 * changes the starting point, not the freedom.
 *
 * See shared/legalCategories.ts for what each label implies and why.
 */
export const STANDARD_CATEGORIES = LEGAL_CATEGORY_LABELS;

/** Sample items seeded for a "practice with sample items" round. */
export const PRACTICE_SAMPLE_ITEMS = [
  { name: "Green ceramic vase", room: "Living Room", category: "Art & Decor", aiEstimatedValue: 60 },
  { name: "Grandpa's pocket watch", room: "Primary Bedroom", category: "Jewelry", aiEstimatedValue: 400 },
  { name: "Set of golf clubs", room: "Garage", category: "Sporting Goods", aiEstimatedValue: 350 },
  { name: "Grandma's china set", room: "Dining Room", category: "Silver & China", aiEstimatedValue: 700 },
  { name: "Antique lamp", room: "Living Room", category: "Furniture", aiEstimatedValue: 180 },
  { name: "Fishing rod", room: "Storage", category: "Sporting Goods", aiEstimatedValue: 90 },
  { name: "Family photo album", room: "Office/Study", category: "Documents", aiEstimatedValue: 25 },
  { name: "Silver candlesticks pair", room: "Dining Room", category: "Silver & China", aiEstimatedValue: 320 },
  { name: "Toolbox", room: "Garage", category: "Tools", aiEstimatedValue: 140 },
  { name: "Wool blanket", room: "Bedroom 2", category: "Miscellaneous", aiEstimatedValue: 45 },
] as const;

/** @deprecated superseded by the taxonomy table; kept for old imports. */
export const PRESET_ROOMS = [
  "Living Room",
  "Dining Room",
  "Kitchen",
  "Primary Bedroom",
  "Bedroom 2",
  "Bedroom 3",
  "Family Room",
  "Office/Study",
  "Garage",
  "Attic",
  "Basement",
  "Outdoor/Yard",
  "Storage",
] as const;

export const CATEGORIES = [
  "Furniture",
  "Artwork",
  "Jewelry",
  "Silver & China",
  "Electronics",
  "Books & Papers",
  "Tools",
  "Textiles",
  "Kitchenware",
  "Collectibles",
  "Other",
] as const;

export const MAX_PARTICIPANTS = 10;


/* ------------------------------------------------------------------ */
/* heir permissions                                                    */
/* ------------------------------------------------------------------ */

/** Every capability the captain can hand to heirs, one independent toggle each. */
export const HEIR_CAPABILITIES = [
  {
    key: "addItems",
    label: "Heirs can add inventory items",
    help: "Lets heirs catalogue new pieces themselves, including quick add and batch photo intake.",
  },
  {
    key: "changeCategory",
    label: "Heirs can assign or change an item's category",
    help: "Only categories the captain has enabled appear as choices.",
  },
  {
    key: "changeRoom",
    label: "Heirs can assign or change an item's room",
    help: "Useful when the catalogue was photographed before things were moved.",
  },
  {
    key: "scanDuplicates",
    label: "Heirs can scan for duplicates",
    help: "Runs the similarity pass that groups likely repeated entries.",
  },
  {
    key: "resolveDuplicates",
    label: "Heirs can resolve duplicate groups",
    help: "Lets heirs choose which record to keep when a duplicate group is found.",
  },
  {
    key: "editItemNamesNotes",
    label: "Heirs can edit item names and notes",
    help: "Corrections to descriptions and provenance notes, not values or status.",
  },
  {
    key: "deleteOwnItems",
    label: "Heirs can delete items they added",
    help: "Only items that heir catalogued. Nobody but the captain may remove anyone else's entry.",
  },
  {
    key: "uploadPhotos",
    label: "Heirs can upload photos to existing items",
    help: "Attach or replace the photograph on a record that already exists.",
  },
] as const;

/**
 * The ninth toggle. It lives in its own column rather than the permissions
 * blob because it defaults ON — heirs know the family's things best — and
 * because it governs the ranking-page chip pickers as well as Inventory.
 */
export const HEIRS_CAN_CATEGORIZE_CAPABILITY = {
  key: "heirsCanCategorize",
  label: "Heirs can categorize items",
  help: "Lets any heir add or correct a category from Inventory, Ranking, or the review queue. On by default.",
} as const;

export type HeirCapability = (typeof HEIR_CAPABILITIES)[number]["key"];

export type HeirPermissions = Record<HeirCapability, boolean>;

export const DEFAULT_HEIR_PERMISSIONS: HeirPermissions = HEIR_CAPABILITIES.reduce(
  (acc, c) => ({ ...acc, [c.key]: false }),
  {} as HeirPermissions,
);

/** Parse the stored JSON blob, filling in any missing capability with false. */
export function parseHeirPermissions(raw: string | null | undefined): HeirPermissions {
  let obj: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") obj = parsed as Record<string, unknown>;
    } catch {
      obj = {};
    }
  }
  return HEIR_CAPABILITIES.reduce(
    (acc, c) => ({ ...acc, [c.key]: obj[c.key] === true }),
    {} as HeirPermissions,
  );
}

/** True when heirs have been granted `capability` on this session. */
export function canHeirDo(
  session: { heirPermissions?: string | null },
  capability: HeirCapability,
): boolean {
  return parseHeirPermissions(session?.heirPermissions)[capability];
}

/**
 * Capabilities a helper is always granted. These are NOT per-session
 * toggles — a helper's role inherently grants inventory collection
 * access. The captain cannot turn these off individually; if a helper
 * should not have access, the captain removes them from the session.
 *
 * Mirrors the same keys as HEIR_CAPABILITIES so `denyUnlessAllowed`
 * can check one set or the other depending on the actor's role.
 */
export const HELPER_CAPABILITIES: HeirCapability[] = [
  "addItems",
  "uploadPhotos",
  "editItemNamesNotes",
  "scanDuplicates",
];

/** True when this role+capability combination is allowed. */
export function canHelperDo(capability: HeirCapability): boolean {
  return HELPER_CAPABILITIES.includes(capability);
}

/** Is this participant a helper? */
export function isHelperParticipant(
  p: { role?: string | null } | null | undefined,
): boolean {
  return !!p && p.role === "helper";
}


/* ================================================================== */
/* v9 — inventory import staging                                      */
/* ================================================================== */
/**
 * Nothing from a ReindeerExchange bundle enters the live item pool directly.
 * A bundle lands here, the Captain reviews it, and only an
 * explicit approval creates a real row in `items`.
 */

export const importBatches = sqliteTable("import_batches", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: integer("session_id").notNull(),
  /** The batch id the exporting app stamped on the envelope. */
  batchId: text("batch_id").notNull(),
  sourceApp: text("source_app").notNull().default("reindeer_registry"),
  exchangeVersion: text("exchange_version").notNull().default(""),
  ownerName: text("owner_name").notNull().default(""),
  fileName: text("file_name").notNull().default(""),
  bundleSha256: text("bundle_sha256").notNull().default(""),
  byteSize: integer("byte_size").notNull().default(0),
  exportedAt: integer("exported_at"),
  itemCount: integer("item_count").notNull().default(0),
  photoCount: integer("photo_count").notNull().default(0),
  videoCount: integer("video_count").notNull().default(0),
  audioCount: integer("audio_count").notNull().default(0),
  scopeMediaCount: integer("scope_media_count").notNull().default(0),
  /** 'staged' | 'partially_applied' | 'applied' | 'discarded' */
  state: text("state").notNull().default("staged"),
  /** JSON array of room names in the bundle this estate does not have. */
  unmatchedRooms: text("unmatched_rooms").notNull().default("[]"),
  /** JSON array of category names in the bundle this estate does not have. */
  unmatchedCategories: text("unmatched_categories").notNull().default("[]"),
  /** JSON array of checksum failures or other complaints from the reader. */
  problems: text("problems").notNull().default("[]"),
  /** True when the estate was mid-round when the bundle arrived. */
  arrivedDuringLockedRound: integer("arrived_during_locked_round", { mode: "boolean" })
    .notNull()
    .default(false),
  notes: text("notes").notNull().default(""),
  importedAt: integer("imported_at").notNull(),
  importedByParticipantId: integer("imported_by_participant_id"),
});

export const stagedItems = sqliteTable("staged_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: integer("session_id").notNull(),
  importBatchRowId: integer("import_batch_row_id").notNull(),
  batchId: text("batch_id").notNull(),
  originItemId: text("origin_item_id").notNull(),
  name: text("name").notNull(),
  room: text("room").notNull().default(""),
  category: text("category"),
  notes: text("notes").notNull().default(""),
  inventoryStory: text("inventory_story").notNull().default(""),
  /** Owner's Important comment from Registry, staged for captain review. */
  ownerImportantComment: text("owner_important_comment").notNull().default(""),
  quantity: integer("quantity").notNull().default(1),
  conditionNote: text("condition_note").notNull().default(""),
  identifiers: text("identifiers").notNull().default("{}"),
  estimatedValue: real("estimated_value"),
  valueSource: text("value_source"),
  needsAppraisal: integer("needs_appraisal", { mode: "boolean" }).notNull().default(false),
  isSentimental: integer("is_sentimental", { mode: "boolean" }).notNull().default(false),
  /**
   * The owner's structured recipient hint, carried through import staging.
   * When non-empty and not dismissed by the captain at review, this becomes an
   * owner assignment on the approved item.
   */
  recipientHint: text("recipient_hint").notNull().default(""),
  recipientHintNote: text("recipient_hint_note").notNull().default(""),
  /**
   * v15 — detector output for owner-assignment intent in the Important
   * comment. Populated at stageBundle time when `recipientHint` is empty
   * and `ownerImportantComment` matches the detector's rules. The captain must
   * either confirm (name becomes an owner assignment) or dismiss (item
   * lands as 'available') before the batch can be approved.
   *
   * The verbatim `detectedOwnerAssignmentQuote` is preserved even after
   * dismissal so an auditor can later see why the app thought the owner
   * might have been making an assignment.
   */
  detectedOwnerAssignmentName: text("detected_owner_assignment_name").notNull().default(""),
  detectedOwnerAssignmentQuote: text("detected_owner_assignment_quote").notNull().default(""),
  /** '' | 'participant_name' | 'directive_phrase' | 'both' */
  detectedOwnerAssignmentConfidence: text("detected_owner_assignment_confidence").notNull().default(""),
  /** '' | 'pending' | 'confirmed' | 'dismissed' */
  detectedOwnerAssignmentReview: text("detected_owner_assignment_review").notNull().default(""),
  detectedOwnerAssignmentReviewReason: text("detected_owner_assignment_review_reason").notNull().default(""),
  /**
   * Commit 4 \u2014 the exchange envelope's `is_locked_gift` flag arrives
   * here at stage time. Approval mints the item with
   * `owner_assigned_source = 'memorandum'` and the same lockedByMemorandum
   * flag on the items row so downstream UI can group and grey the row.
   *
   * memorandumOwnerName carries the deceased owner's name (for grouping),
   * never any recipient identity.
   */
  lockedByMemorandum: integer("locked_by_memorandum", { mode: "boolean" }).notNull().default(false),
  memorandumOwnerName: text("memorandum_owner_name").notNull().default(""),
  photoCount: integer("photo_count").notNull().default(0),
  videoCount: integer("video_count").notNull().default(0),
  audioCount: integer("audio_count").notNull().default(0),
  /** 'draft' | 'approved' | 'rejected' | 'superseded' */
  state: text("state").notNull().default("draft"),
  appliedItemId: integer("applied_item_id"),
  supersedesStagedId: integer("supersedes_staged_id"),
  /** 'new' | 'updates_existing' | 'possible_duplicate' */
  arrivalKind: text("arrival_kind").notNull().default("new"),
  possibleDuplicateOf: integer("possible_duplicate_of"),
  /** JSON array of strings describing how each field was mapped. */
  mappingNotes: text("mapping_notes").notNull().default("[]"),
  reviewNote: text("review_note").notNull().default(""),
  createdAt: integer("created_at").notNull(),
  reviewedAt: integer("reviewed_at"),
  reviewedByParticipantId: integer("reviewed_by_participant_id"),
});

export const stagedMedia = sqliteTable("staged_media", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: integer("session_id").notNull(),
  stagedItemId: integer("staged_item_id"),
  batchId: text("batch_id").notNull(),
  /** 'photo' | 'video' | 'audio' */
  kind: text("kind").notNull(),
  role: text("role").notNull().default(""),
  mimeType: text("mime_type").notNull().default(""),
  byteSize: integer("byte_size").notNull().default(0),
  durationMs: integer("duration_ms"),
  transcript: text("transcript").notNull().default(""),
  transcriptSource: text("transcript_source"),
  label: text("label").notNull().default(""),
  url: text("url").notNull(),
  isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
  /** Whole-house walkthroughs belong to the estate, not to one item. */
  isScopeMedia: integer("is_scope_media", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull(),
});

export const itemMedia = sqliteTable("item_media", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: integer("session_id").notNull(),
  itemId: integer("item_id").notNull(),
  kind: text("kind").notNull(),
  role: text("role").notNull().default(""),
  mimeType: text("mime_type").notNull().default(""),
  byteSize: integer("byte_size").notNull().default(0),
  durationMs: integer("duration_ms"),
  transcript: text("transcript").notNull().default(""),
  label: text("label").notNull().default(""),
  url: text("url").notNull(),
  isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
  originApp: text("origin_app"),
  createdAt: integer("created_at").notNull(),
});

export const MEDIA_KINDS = ["photo", "video", "audio"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const STAGED_ITEM_STATES = ["draft", "approved", "rejected", "superseded"] as const;
export type StagedItemState = (typeof STAGED_ITEM_STATES)[number];

export const IMPORT_BATCH_STATES = [
  "staged",
  "partially_applied",
  "applied",
  "discarded",
] as const;
export type ImportBatchState = (typeof IMPORT_BATCH_STATES)[number];

export type ImportBatch = typeof importBatches.$inferSelect;
export type InsertImportBatch = typeof importBatches.$inferInsert;
export type StagedItem = typeof stagedItems.$inferSelect;
export type InsertStagedItem = typeof stagedItems.$inferInsert;
export type StagedMedia = typeof stagedMedia.$inferSelect;
export type InsertStagedMedia = typeof stagedMedia.$inferInsert;
export type ItemMedia = typeof itemMedia.$inferSelect;
export type InsertItemMedia = typeof itemMedia.$inferInsert;

/**
 * The six rules an inventory import must obey. Enforced in
 * server/import/importService.ts and asserted in the round-trip test.
 */
export const IMPORT_RULES = [
  "Every arriving item lands in staging as a draft. Nothing enters the live pool without an explicit approval.",
  "A locked round does not block the import. It queues it, and the captain is told the round is locked.",
  "Rooms and categories map by name. Unmatched names are reported, never silently dropped or invented.",
  "recipient_hint is advisory. It never becomes a ranking, a pick, or an award.",
  "Re-importing the same origin_item_id updates the staged row instead of duplicating it.",
  "Every import, approval, and rejection is recorded with who did it and when.",
] as const;

/* ================================================================== */
/* v10 — Real authentication (email magic links)                      */
/* ================================================================== */
/**
 * Everyone — including the Captain — signs in the same way:
 * request a link (or a 6-character short code, readable over the phone),
 * redeem it once, get a signed session cookie. The captain carries no special
 * auth path; their participant row simply has `isAdmin` set.
 *
 * `tokenHash` columns store sha256(rawToken) ONLY. The raw token/session
 * value is never written to the database. See server/auth/tokens.ts and
 * server/auth/sessionStore.ts.
 */

export const authTokens = sqliteTable("auth_tokens", {
  id: text("id").primaryKey(),
  sessionId: integer("session_id").notNull(),
  participantId: integer("participant_id").notNull(),
  /** sha256 of the raw token. The raw token itself is never stored. */
  tokenHash: text("token_hash").notNull(),
  /** 6-character human-readable code (no O/0/I/1) for phone read-out. */
  shortCode: text("short_code").notNull(),
  /** 'magic_link' | 'invite' */
  purpose: text("purpose").notNull().default("magic_link"),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  consumedAt: integer("consumed_at"),
  consumedIp: text("consumed_ip"),
  requestedIp: text("requested_ip"),
  requestedUserAgent: text("requested_user_agent"),
});

export const authSessions = sqliteTable("auth_sessions", {
  id: text("id").primaryKey(),
  sessionId: integer("session_id").notNull(),
  participantId: integer("participant_id").notNull(),
  /** sha256 of the raw session token carried in the signed cookie. */
  tokenHash: text("token_hash").notNull(),
  createdAt: integer("created_at").notNull(),
  lastSeenAt: integer("last_seen_at").notNull(),
  /** 30-day sliding expiry, extended on every authenticated request. */
  expiresAt: integer("expires_at").notNull(),
  revokedAt: integer("revoked_at"),
  revokedByParticipantId: integer("revoked_by_participant_id"),
  userAgent: text("user_agent"),
  ip: text("ip"),
});

export const authEvents = sqliteTable("auth_events", {
  id: text("id").primaryKey(),
  sessionId: integer("session_id").notNull(),
  /** Null when the event has no known identity (e.g. an unknown email). */
  participantId: integer("participant_id"),
  /**
   * 'token_issued' | 'invite_issued' | 'sign_in' | 'sign_in_failed'
   *   | 'sign_out' | 'session_revoked' | 'rate_limited'
   */
  kind: text("kind").notNull(),
  /** Free-text / JSON detail. Never the raw token or session secret. */
  detail: text("detail").notNull().default(""),
  ip: text("ip"),
  userAgent: text("user_agent"),
  createdAt: integer("created_at").notNull(),
});

export type AuthToken = typeof authTokens.$inferSelect;
export type InsertAuthToken = typeof authTokens.$inferInsert;
export type AuthSession = typeof authSessions.$inferSelect;
export type InsertAuthSession = typeof authSessions.$inferInsert;
export type AuthEvent = typeof authEvents.$inferSelect;
export type InsertAuthEvent = typeof authEvents.$inferInsert;

/** Token/session purposes accepted on the wire. */
export const AUTH_TOKEN_PURPOSES = ["magic_link", "invite"] as const;
export type AuthTokenPurpose = (typeof AUTH_TOKEN_PURPOSES)[number];

/** Every auth_events.kind value the app can raise. */
export const AUTH_EVENT_KINDS = [
  "token_issued",
  "invite_issued",
  "sign_in",
  "sign_in_failed",
  "sign_out",
  "session_revoked",
  "rate_limited",
  // v12 — the representative's passphrase. Recorded so the sign-in history
  // shows when a second way in was created, changed, or taken away again.
  "passphrase_set",
  "passphrase_changed",
  "passphrase_removed",
] as const;
export type AuthEventKind = (typeof AUTH_EVENT_KINDS)[number];

/** Magic-link tokens are valid for 20 minutes and are strictly single-use. */
export const AUTH_TOKEN_TTL_MS = 20 * 60 * 1000;

/** Sessions live 30 days, sliding on use. */
export const AUTH_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Characters used for the 6-character short code. O/0/I/1 excluded. */
export const SHORT_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const SHORT_CODE_LENGTH = 6;

/** Requests-per-window before the sign-in-request endpoint throttles. */
export const AUTH_RATE_LIMIT = 5;
export const AUTH_RATE_WINDOW_MS = 15 * 60 * 1000;

/** Plain-language copy shown wherever a session is missing or invalid. */
export const SIGN_IN_REQUIRED_MESSAGE =
  "Please sign in to continue. Check your email for a sign-in link, or ask the Captain for one.";

/** Plain-language copy shown wherever a heir hits a captain-only action. */
export const CAPTAIN_ONLY_MESSAGE = "This is reserved for the Captain.";

/* ================================================================== */
/* v12 — The Captain's passphrase                     */
/* ================================================================== */
/**
 * Setting up a new estate never needed email: POST /api/session/welcome is
 * allowlisted ahead of the sign-in gate and signs the first representative in
 * directly. The gap was coming BACK — on a second device, or after the first
 * cookie expired, the only door left was an emailed link.
 *
 * So the representative may set a passphrase and sign in with it anywhere.
 * Heirs may not; they continue to sign in by emailed link only.
 *
 * Setting one requires an existing representative session, so there is no
 * unauthenticated route that can mint a way into a running estate.
 *
 * `passphraseHash` is scrypt(passphrase, salt), hex. The passphrase itself is
 * never stored, logged, or returned by any route.
 */
export const representativeCredentials = sqliteTable("representative_credentials", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** One per estate. UNIQUE in the database, so a second insert cannot race in. */
  sessionId: integer("session_id").notNull().unique(),
  participantId: integer("participant_id").notNull(),
  passphraseHash: text("passphrase_hash").notNull(),
  passphraseSalt: text("passphrase_salt").notNull(),
  hashVersion: integer("hash_version").notNull().default(1),
  createdAt: integer("created_at").notNull(),
  createdIp: text("created_ip"),
  createdUserAgent: text("created_user_agent"),
  changedAt: integer("changed_at"),
});

export type RepresentativeCredential = typeof representativeCredentials.$inferSelect;

/**
 * The shortest passphrase the app will accept. Length is what actually makes a
 * passphrase hard to guess, so the rule is a plain minimum rather than a set of
 * character classes an elderly user has to decode.
 */
export const CAPTAIN_PASSPHRASE_MIN_LENGTH = 12;

export const CAPTAIN_PASSPHRASE_HELP =
  "Use at least 12 characters. A short sentence you will remember works well — for example, three or four unrelated words with spaces between them. Longer is safer than complicated.";

/** Offered to the captain once, right after the estate is set up. */
export const CAPTAIN_PASSPHRASE_INVITATION =
  "Set a passphrase so you can sign in again on another device, such as your phone. Without one, getting back in needs a link emailed to you.";

/** Shown after a wrong passphrase. Says nothing about which part was wrong. */
export const CAPTAIN_PASSPHRASE_WRONG =
  "That passphrase does not match. Please try again, or ask for a sign-in link if you are an heir.";

/** Shown when no passphrase has been set on this estate yet. Deliberately identical in tone to the line above — a stranger learns nothing either way. */
export const CAPTAIN_PASSPHRASE_UNAVAILABLE =
  "That passphrase does not match. Please try again, or ask for a sign-in link if you are an heir.";

/** Attempts allowed per window before passphrase sign-in throttles, per IP. */
export const CAPTAIN_SIGN_IN_RATE_LIMIT = 8;
export const CAPTAIN_SIGN_IN_RATE_WINDOW_MS = 15 * 60 * 1000;

/* ================================================================== */
/* item_interests — per-heir, per-item interest level                 */
/* ================================================================== */
/**
 * One row per heir per item per session. Records the heir's interest
 * level — "want", "interested", or "don't care" — so the UI can surface
 * how many heirs want each item and so the draft engine can factor
 * interest density into its heuristics.
 */
export const itemInterests = sqliteTable(
  "item_interests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: integer("session_id").notNull(),
    participantId: integer("participant_id").notNull(),
    itemId: integer("item_id").notNull(),
    /** 'want' | 'interested' | 'dont_care' */
    interest: text("interest").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    /** One interest row per heir per item. */
    uniqPerParticipantItem: uniqueIndex(
      "item_interests_unique",
    ).on(t.sessionId, t.participantId, t.itemId),
    /** Supports the "count wants per item" query. */
    bySessionItem: index("item_interests_item").on(t.sessionId, t.itemId),
  }),
);

export const INTEREST_LEVELS = ["want", "interested", "dont_care"] as const;
export type InterestLevel = (typeof INTEREST_LEVELS)[number];
export type ItemInterest = typeof itemInterests.$inferSelect;
export const insertItemInterestSchema = createInsertSchema(itemInterests).omit({ id: true });
export type InsertItemInterest = z.infer<typeof insertItemInterestSchema>;

/* ================================================================== */
/* estate_subscriptions — per-estate subscription / license state      */
/* ================================================================== */
/**
 * One row per estate, keyed by scope_id (the estate identifier — ESTATE_ID
 * for the single-estate install, a per-estate ULID when multiEstate is on).
 *
 * Drives the subscription gate (FEATURE_FLAGS.subscriptionGate). While the
 * gate is off (current testing mode) this table is informational only —
 * writes are never blocked. When the gate is on, requireSubscriptionForWrite
 * reads this row and returns 402 for estates whose status is
 * 'expired' | 'locked' | 'cancelled', or whose subscription_expires_at /
 * license_expires_at has lapsed. Reads are never blocked; data is never
 * deleted for non-payment.
 *
 * Mirrors the estate_subscriptions table added to apps/reindeer-discovery.
 */
export const estateSubscriptions = sqliteTable("estate_subscriptions", {
  /** The estate identifier this subscription governs. */
  scopeId: text("scope_id").primaryKey(),
  /** 'active' | 'trialing' | 'expired' | 'locked' | 'cancelled'. */
  status: text("status").notNull().default("active"),
  /** ISO-8601 timestamp; null for lifetime / manual subscriptions. */
  subscriptionExpiresAt: text("subscription_expires_at"),
  /** Stripe customer id when billing through Stripe. */
  stripeCustomerId: text("stripe_customer_id"),
  /** Stripe subscription / price id when billing through Stripe. */
  stripeSubscriptionId: text("stripe_subscription_id"),
  /** Reindeer license key (JWT) issued by the registry, for offline / non-Stripe estates. */
  licenseKey: text("license_key"),
  /** ISO-8601 expiry for the offline license key. */
  licenseExpiresAt: text("license_expires_at"),
  /** The trustee / fiduciary account this estate is bound to (registry account id). */
  trusteeAccountId: text("trustee_account_id"),
  /** Pool slots granted by a multi-estate license (0 for single-estate). */
  licensePoolSlots: integer("license_pool_slots").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type EstateSubscription = typeof estateSubscriptions.$inferSelect;
export type InsertEstateSubscription = typeof estateSubscriptions.$inferInsert;
export const insertEstateSubscriptionSchema = createInsertSchema(
  estateSubscriptions,
).omit({});
export type InsertEstateSubscriptionZod = z.infer<typeof insertEstateSubscriptionSchema>;

