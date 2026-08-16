/**
 * Reindeer FairPlay — schema init.
 *
 * WHY THIS FILE EXISTS
 *
 * FairPlay v2.1 collapses the entire v1..v15 migration ladder into a
 * single fresh-boot schema. Nothing has shipped yet, so no historical
 * database exists that needs upgrading. Every table below is the shape
 * the app expects at v2.1 today, with every column that the v1..v15
 * ladder used to add already present in the `CREATE TABLE` statement.
 *
 * WHAT THIS DOES NOT DO
 *
 * - No `ALTER TABLE ADD COLUMN` calls. Nothing to add — every column is
 *   in the initial CREATE.
 * - No backfill `UPDATE` statements. Fresh DB starts empty.
 * - No `PRAGMA table_info` inspection. There is nothing to inspect on a
 *   file that was just created.
 *
 * COMPATIBILITY
 *
 * A previously-created SQLite file will NOT auto-upgrade to this schema.
 * The old ladder is gone; there is no code path that runs `ADD COLUMN`
 * anymore. Delete `data.db` before booting v2.1 for the first time.
 * That is the point of a fresh-baseline release, and the project's
 * standing rule ("warn the user before schema/wire-format changes") was
 * honored in the handoff that ships with this commit.
 *
 * EVERY TABLE, EVERY INDEX, IN ONE PLACE
 *
 * Downstream code — server/storage.ts, server/auth/*, server/import/*,
 * server/fiduciary/* — expects exactly these tables and columns. If you
 * add a column, add it here (inline in the CREATE), not via a fresh
 * migration file.
 */
import type Database from "better-sqlite3";

export function initSchema(sqlite: Database.Database): void {
  sqlite.exec(`
/* ------------------------------------------------------------------ */
/* sessions — one row per estate                                       */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'setup',
  current_round INTEGER NOT NULL DEFAULT 0,
  priority_order TEXT NOT NULL DEFAULT '[]',
  allow_participant_duplicate_work INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  /* v2 practice mode */
  practice_mode TEXT NOT NULL DEFAULT 'off',
  practice_state TEXT,
  /* v3 heir permissions */
  heir_permissions TEXT NOT NULL DEFAULT '{}',
  rank_depth_mode TEXT NOT NULL DEFAULT 'topN',
  rank_top_n INTEGER DEFAULT 20,
  ranking_window_days INTEGER NOT NULL DEFAULT 30,
  ranking_opened_at INTEGER,
  ranking_deadline INTEGER,
  secondary_ranking_window_days INTEGER NOT NULL DEFAULT 30,
  secondary_ranking_opened_at INTEGER,
  secondary_ranking_deadline INTEGER,
  /* v4 flow overhaul */
  heirs_can_add_inventory INTEGER NOT NULL DEFAULT 0,
  heirs_can_propose_groupings INTEGER NOT NULL DEFAULT 0,
  auto_draft_enabled INTEGER NOT NULL DEFAULT 1,
  auto_round_streak INTEGER NOT NULL DEFAULT 0,
  auto_draft_paused INTEGER NOT NULL DEFAULT 0,
  auto_draft_hold_round INTEGER,
  reconciliation TEXT,
  reconciliation_nudge_ms INTEGER NOT NULL DEFAULT 300000,
  inventory_completed_at INTEGER,
  /* v5 welcome / registration */
  estate_name TEXT,
  registration_closed_at INTEGER,
  /* Trustee (fiduciary) captured for documentation and, optionally, for
     acting as captain of the game.
     - trustee_name: the fiduciary's name, always safe to print on the
       Record of Decisions and trustee packet.
     - trustee_participant_id: the participant row for the seated trustee
       when they are inside the app. Nullable. A trustee participant
       always has role='trustee' and administers_only=1 and never appears
       in draft/ranking/equalization math.
     - captain_participant_id: the participant currently running this
       session's phases. Set at welcome to the heir-admin's row. Changes
       when the trustee takes over or the captain is transferred. See
       docs/specs/2026-08-08-captain-model.md.
     - trustee-in-charge is derived: captain_participant_id ==
       trustee_participant_id (and non-null). No separate boolean. */
  trustee_name TEXT,
  trustee_participant_id INTEGER,
  captain_participant_id INTEGER,
  /* v6 AI categorization */
  heirs_can_categorize INTEGER NOT NULL DEFAULT 1,
  /* v7a session lifecycle */
  state TEXT NOT NULL DEFAULT 'active',
  paused_at INTEGER,
  paused_by INTEGER,
  pause_reason TEXT,
  pause_count INTEGER NOT NULL DEFAULT 0,
  total_paused_ms INTEGER NOT NULL DEFAULT 0,
  /* v15c3 appraisal threshold (used by AI auto-flag; family-configurable) */
  appraisal_threshold_usd INTEGER NOT NULL DEFAULT 2000
);

/* ------------------------------------------------------------------ */
/* participants — one row per person in an estate                      */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  administers_only INTEGER NOT NULL DEFAULT 0,
  contested_loss_counter INTEGER NOT NULL DEFAULT 0,
  seat_order INTEGER NOT NULL DEFAULT 0,
  auto_submit INTEGER NOT NULL DEFAULT 0,
  profile_confirmed_at INTEGER,
  email TEXT,
  phone TEXT,
  allows_captain_assist INTEGER NOT NULL DEFAULT 0,
  /* Role:
     - 'heir' (default): a beneficiary. Drafts, ranks, receives items,
       appears in equalization math.
     - 'trustee': the fiduciary named by the owner in the will or trust.
       Never drafts, ranks, receives items, or appears in equalization.
       Must be administers_only=1. See docs/specs/2026-08-08-captain-model.md.
     - 'representative': a person acting on behalf of another (an heir or
       trustee). Never drafts, ranks, receives items, or appears in
       equalization; the person they represent still does that. Must be
       administers_only=1 and represents_participant_id must be set.
       Can be selected as captain. Introduced with the captain model.
     Enforced at insert time and at every action gate. */
  role TEXT NOT NULL DEFAULT 'heir',
  /* represents_participant_id: for role='representative' only. Points at
     the participant row (heir or trustee) whose interests this person is
     acting on. Null for heirs and trustees. See the captain-model spec
     for why we use a back-reference rather than a role suffix. */
  represents_participant_id INTEGER
);

/* ------------------------------------------------------------------ */
/* items — the property being distributed                              */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  room TEXT NOT NULL DEFAULT '',
  category TEXT,
  notes TEXT NOT NULL DEFAULT '',
  ai_estimated_value REAL,
  estimate_source TEXT,
  photo_url TEXT,
  thumbnail_url TEXT,
  status TEXT NOT NULL DEFAULT 'available',
  awarded_to_participant_id INTEGER,
  awarded_in_round INTEGER,
  is_heirloom_candidate INTEGER NOT NULL DEFAULT 0,
  is_heirloom_confirmed INTEGER NOT NULL DEFAULT 0,
  added_during_draft INTEGER NOT NULL DEFAULT 0,
  grouping_id INTEGER,
  duplicate_group_id INTEGER,
  /* v2 practice */
  is_practice INTEGER NOT NULL DEFAULT 0,
  /* v3 drafts */
  created_by_participant_id INTEGER,
  draft_phase TEXT,
  /* v4 sentimental + high-value + heirlooms */
  needs_appraisal INTEGER NOT NULL DEFAULT 0,
  is_sentimental INTEGER NOT NULL DEFAULT 0,
  /* v6 AI categorization */
  ai_category_confidence REAL,
  ai_category_source TEXT NOT NULL DEFAULT 'user',
  ai_suggestions TEXT,
  ai_suggests_high_value INTEGER NOT NULL DEFAULT 0,
  ai_high_value_reason TEXT,
  needs_discussion INTEGER NOT NULL DEFAULT 0,
  /* v8 high-value fiduciary state */
  high_value_state TEXT NOT NULL DEFAULT 'normal',
  estimated_value REAL,
  approved_value REAL,
  value_source TEXT,
  value_status TEXT NOT NULL DEFAULT 'estimated',
  valuation_date INTEGER,
  valuation_notes TEXT NOT NULL DEFAULT '',
  provisional_recipient_id INTEGER,
  /* v9 inventory + provenance */
  origin_app TEXT,
  origin_item_id TEXT,
  import_batch_id TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  condition_note TEXT NOT NULL DEFAULT '',
  identifiers TEXT NOT NULL DEFAULT '{}',
  inventory_story TEXT NOT NULL DEFAULT '',
  recipient_hint TEXT NOT NULL DEFAULT '',
  recipient_hint_note TEXT NOT NULL DEFAULT '',
  /* v13 owner's Important comment */
  owner_important_comment TEXT NOT NULL DEFAULT '',
  /* v15 owner-assignment binding */
  owner_assigned_name TEXT NOT NULL DEFAULT '',
  owner_assigned_participant_id INTEGER,
  owner_assigned_source TEXT NOT NULL DEFAULT '',
  owner_assigned_evidence TEXT NOT NULL DEFAULT '',
  /* commit 4 memorandum-locked items */
  locked_by_memorandum INTEGER NOT NULL DEFAULT 0,
  memorandum_owner_name TEXT NOT NULL DEFAULT ''
);

/* ------------------------------------------------------------------ */
/* groupings + opt-ins                                                 */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS groupings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'custom',
  status TEXT NOT NULL DEFAULT 'open',
  awarded_to_participant_id INTEGER,
  resolved_in_round INTEGER
);
CREATE TABLE IF NOT EXISTS grouping_opt_ins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grouping_id INTEGER NOT NULL,
  participant_id INTEGER NOT NULL,
  choice TEXT
);

/* ------------------------------------------------------------------ */
/* appraisal_flags                                                     */
/* ------------------------------------------------------------------ */
/*
 * appraisal_flags — v15c3 rename (was appraisal_flags).
 *
 * One row per "this item should be appraised by the trustee" flag. The
 * captain may revert heir/AI flags but not owner-source ones (owner is
 * deceased). Reverted rows stay in the audit trail.
 *
 * flagged_by_source: 'heir' | 'owner' | 'ai' | 'category' (category lands in commit 4)
 * flagged_by_participant_id: heir source only; nullable for owner/ai/category
 * reason: optional heir/owner, always present for ai (with "not an official
 *         appraisal" caveat), category-rule default (e.g. "Category rule: Jewelry")
 * reverted_at / reverted_by_captain_id: null while the row is active
 *
 * Two orthogonal item properties (v15c3 clarification):
 *   - items.is_important — the heart flag (affects who wins)
 *   - items.needs_appraisal — the trustee's dollar queue (affects
 *     equalization math only, never who wins)
 */
CREATE TABLE IF NOT EXISTS appraisal_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  flagged_by_source TEXT NOT NULL,
  flagged_by_participant_id INTEGER,
  reason TEXT,
  created_at INTEGER NOT NULL,
  reverted_at INTEGER,
  reverted_by_captain_id INTEGER
);

/* ------------------------------------------------------------------ */
/* picks — one row per draft pick                                      */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS picks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  round INTEGER NOT NULL,
  participant_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  pick_order INTEGER NOT NULL DEFAULT 1,
  outcome TEXT NOT NULL DEFAULT 'pending',
  is_tiebreak INTEGER NOT NULL DEFAULT 0,
  affects_regular_draft_counter INTEGER NOT NULL DEFAULT 1,
  is_practice INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual'
);

/* ------------------------------------------------------------------ */
/* duplicate_groups                                                    */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS duplicate_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  resolved_by INTEGER,
  status TEXT NOT NULL DEFAULT 'open'
);

/* ------------------------------------------------------------------ */
/* taxonomy — rooms + categories per session                           */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS taxonomy (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  is_enabled INTEGER NOT NULL DEFAULT 0,
  is_custom INTEGER NOT NULL DEFAULT 0
);

/* ------------------------------------------------------------------ */
/* rankings + edits log                                                */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS rankings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  participant_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  rank INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS rankings_participant_item
  ON rankings (session_id, participant_id, item_id);
CREATE UNIQUE INDEX IF NOT EXISTS rankings_participant_rank
  ON rankings (session_id, participant_id, rank);

CREATE TABLE IF NOT EXISTS ranking_edits_log (
  id TEXT PRIMARY KEY,
  session_id INTEGER NOT NULL,
  participant_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  old_rank INTEGER,
  new_rank INTEGER,
  edited_by_participant_id INTEGER NOT NULL,
  edited_at INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'self',
  dismissed_at INTEGER
);
CREATE INDEX IF NOT EXISTS ranking_edits_log_participant
  ON ranking_edits_log (participant_id, edited_at);

/* ------------------------------------------------------------------ */
/* classification_changes — audit for flag flips                       */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS classification_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  flag_name TEXT NOT NULL,
  old_value INTEGER NOT NULL DEFAULT 0,
  new_value INTEGER NOT NULL DEFAULT 0,
  changed_by_participant_id INTEGER,
  changed_at INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  phase TEXT NOT NULL DEFAULT '',
  is_revert INTEGER NOT NULL DEFAULT 0,
  reverted_at INTEGER,
  reverted_by_participant_id INTEGER,
  removed_rankings TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS classification_changes_item
  ON classification_changes (item_id, changed_at);

/* ------------------------------------------------------------------ */
/* notifications                                                       */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  participant_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS notifications_participant
  ON notifications (participant_id, created_at);

/* ------------------------------------------------------------------ */
/* captain_transfers — audit for captain role handoffs                           */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS captain_transfers (
  id TEXT PRIMARY KEY,
  session_id INTEGER NOT NULL,
  previous_captain_participant_id INTEGER NOT NULL,
  new_captain_participant_id INTEGER NOT NULL,
  transferred_at INTEGER NOT NULL,
  previous_captain_disposition TEXT NOT NULL,
  reason TEXT,
  previous_captain_name TEXT NOT NULL DEFAULT '',
  new_captain_name TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS captain_transfers_session
  ON captain_transfers (session_id, transferred_at);

/* ------------------------------------------------------------------ */
/* category_changes — audit for category edits                         */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS category_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  old_category TEXT,
  new_category TEXT,
  changed_by_participant_id INTEGER,
  changed_at INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'user',
  phase TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_category_changes_item ON category_changes(item_id);

/* ------------------------------------------------------------------ */
/* session_state_changes — v7a lifecycle audit                         */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS session_state_changes (
  id TEXT PRIMARY KEY,
  session_id INTEGER NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  changed_by_participant_id INTEGER,
  changed_at INTEGER NOT NULL,
  reason TEXT,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_session_state_changes_session
  ON session_state_changes (session_id, changed_at);

/* ------------------------------------------------------------------ */
/* v8 high-value fiduciary tables                                      */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS item_valuations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  value REAL NOT NULL,
  value_low REAL,
  value_high REAL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'estimated',
  notes TEXT NOT NULL DEFAULT '',
  attachment_url TEXT,
  created_by_participant_id INTEGER,
  created_at INTEGER NOT NULL,
  superseded_at INTEGER,
  superseded_by_valuation_id INTEGER
);
CREATE INDEX IF NOT EXISTS item_valuations_item
  ON item_valuations (session_id, item_id, created_at);
CREATE INDEX IF NOT EXISTS item_valuations_status
  ON item_valuations (session_id, status);

CREATE TABLE IF NOT EXISTS high_value_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  state_before TEXT NOT NULL,
  state_after TEXT NOT NULL,
  value_at_event REAL,
  value_status_at_event TEXT,
  actor_participant_id INTEGER,
  actor_role TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS high_value_audit_log_item
  ON high_value_audit_log (session_id, item_id, created_at);
CREATE INDEX IF NOT EXISTS high_value_audit_log_event
  ON high_value_audit_log (session_id, event_type, created_at);

/* ------------------------------------------------------------------ */
/* v9 inventory import tables                                          */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS import_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  batch_id TEXT NOT NULL,
  source_app TEXT NOT NULL DEFAULT 'reindeer_registry',
  exchange_version TEXT NOT NULL DEFAULT '',
  owner_name TEXT NOT NULL DEFAULT '',
  file_name TEXT NOT NULL DEFAULT '',
  bundle_sha256 TEXT NOT NULL DEFAULT '',
  byte_size INTEGER NOT NULL DEFAULT 0,
  exported_at INTEGER,
  item_count INTEGER NOT NULL DEFAULT 0,
  photo_count INTEGER NOT NULL DEFAULT 0,
  video_count INTEGER NOT NULL DEFAULT 0,
  audio_count INTEGER NOT NULL DEFAULT 0,
  scope_media_count INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'staged',
  unmatched_rooms TEXT NOT NULL DEFAULT '[]',
  unmatched_categories TEXT NOT NULL DEFAULT '[]',
  problems TEXT NOT NULL DEFAULT '[]',
  arrived_during_locked_round INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  imported_at INTEGER NOT NULL,
  imported_by_participant_id INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_import_batches_session_batch
  ON import_batches (session_id, batch_id);

CREATE TABLE IF NOT EXISTS staged_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  import_batch_row_id INTEGER NOT NULL,
  batch_id TEXT NOT NULL,
  origin_item_id TEXT NOT NULL,
  name TEXT NOT NULL,
  room TEXT NOT NULL DEFAULT '',
  category TEXT,
  notes TEXT NOT NULL DEFAULT '',
  inventory_story TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL DEFAULT 1,
  condition_note TEXT NOT NULL DEFAULT '',
  identifiers TEXT NOT NULL DEFAULT '{}',
  estimated_value REAL,
  value_source TEXT,
  needs_appraisal INTEGER NOT NULL DEFAULT 0,
  is_sentimental INTEGER NOT NULL DEFAULT 0,
  recipient_hint TEXT NOT NULL DEFAULT '',
  recipient_hint_note TEXT NOT NULL DEFAULT '',
  photo_count INTEGER NOT NULL DEFAULT 0,
  video_count INTEGER NOT NULL DEFAULT 0,
  audio_count INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'draft',
  applied_item_id INTEGER,
  supersedes_staged_id INTEGER,
  arrival_kind TEXT NOT NULL DEFAULT 'new',
  possible_duplicate_of INTEGER,
  mapping_notes TEXT NOT NULL DEFAULT '[]',
  review_note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  reviewed_by_participant_id INTEGER,
  /* v13 owner's Important comment through staging */
  owner_important_comment TEXT NOT NULL DEFAULT '',
  /* v15 owner-assignment detector fields */
  detected_owner_assignment_name TEXT NOT NULL DEFAULT '',
  detected_owner_assignment_quote TEXT NOT NULL DEFAULT '',
  detected_owner_assignment_confidence TEXT NOT NULL DEFAULT '',
  detected_owner_assignment_review TEXT NOT NULL DEFAULT '',
  detected_owner_assignment_review_reason TEXT NOT NULL DEFAULT '',
  /* commit 4 memorandum-locked items */
  locked_by_memorandum INTEGER NOT NULL DEFAULT 0,
  memorandum_owner_name TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_staged_items_batch ON staged_items (import_batch_row_id);
CREATE INDEX IF NOT EXISTS idx_staged_items_state ON staged_items (session_id, state);
CREATE INDEX IF NOT EXISTS idx_staged_items_origin ON staged_items (session_id, origin_item_id);

CREATE TABLE IF NOT EXISTS staged_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  staged_item_id INTEGER,
  batch_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT '',
  byte_size INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  transcript TEXT NOT NULL DEFAULT '',
  transcript_source TEXT,
  label TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  is_scope_media INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_staged_media_item ON staged_media (staged_item_id);
CREATE INDEX IF NOT EXISTS idx_staged_media_batch ON staged_media (batch_id);

CREATE TABLE IF NOT EXISTS item_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT '',
  byte_size INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  transcript TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  origin_app TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_item_media_item ON item_media (item_id);

/* ------------------------------------------------------------------ */
/* v10 authentication tables                                           */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS auth_tokens (
  id TEXT PRIMARY KEY,
  session_id INTEGER NOT NULL,
  participant_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL,
  short_code TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'magic_link',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consumed_ip TEXT,
  requested_ip TEXT,
  requested_user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_hash ON auth_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_short_code ON auth_tokens (short_code);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_participant ON auth_tokens (participant_id);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  session_id INTEGER NOT NULL,
  participant_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by_participant_id INTEGER,
  user_agent TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_hash ON auth_sessions (token_hash);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_participant ON auth_sessions (participant_id);

CREATE TABLE IF NOT EXISTS auth_events (
  id TEXT PRIMARY KEY,
  session_id INTEGER NOT NULL,
  participant_id INTEGER,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  ip TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_events_participant ON auth_events (participant_id);
CREATE INDEX IF NOT EXISTS idx_auth_events_session ON auth_events (session_id);
CREATE INDEX IF NOT EXISTS idx_auth_events_kind ON auth_events (kind);

/* ------------------------------------------------------------------ */
/* v12 representative_credentials — passphrase sign-in for the captain      */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS representative_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL UNIQUE,
  participant_id INTEGER NOT NULL,
  passphrase_hash TEXT NOT NULL,
  passphrase_salt TEXT NOT NULL,
  hash_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  created_ip TEXT,
  created_user_agent TEXT,
  changed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_rep_credentials_participant
  ON representative_credentials (participant_id);

/* ------------------------------------------------------------------ */
/* v14 method_agreements — up-front Method Agreement signatures         */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS method_agreements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  participant_id INTEGER NOT NULL,
  agreed_at INTEGER NOT NULL,
  agreement_version TEXT NOT NULL,
  agreement_text_snapshot TEXT NOT NULL,
  signature_method TEXT NOT NULL DEFAULT 'magic_link',
  magic_link_token_id INTEGER,
  client_ip TEXT,
  client_user_agent TEXT,
  /* Captain the heir was agreeing to when they signed. Snapshotted so a
     later captain change requires a fresh signature on the new mandate;
     old rows stay on the record for audit but no longer count toward
     the current mandate. See docs/specs/2026-08-08-captain-model.md. */
  captain_participant_id INTEGER NOT NULL DEFAULT 0
);
/* One signature per (heir, captain) pair. Re-sign on captain change
   writes a new row rather than overwriting the old one, so the audit
   log preserves every mandate the heir has ever agreed to. */
CREATE UNIQUE INDEX IF NOT EXISTS method_agreements_unique_heir
  ON method_agreements (session_id, participant_id, captain_participant_id);
CREATE INDEX IF NOT EXISTS method_agreements_session
  ON method_agreements (session_id, agreed_at);

/* ------------------------------------------------------------------ */
/* item_interests — per-heir, per-item interest level                  */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS item_interests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  participant_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  interest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS item_interests_unique
  ON item_interests (session_id, participant_id, item_id);
CREATE INDEX IF NOT EXISTS item_interests_item
  ON item_interests (session_id, item_id);
`);
}
