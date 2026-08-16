import { ulid } from '../db/index.js';

/**
 * Per-partner memorandums \u2014 Slice B of the couple-mode rebuild.
 *
 * A memorandum is one partner's personal list of who-should-get-what. Solo
 * owners have one. Couples have two (one per partner). Each memorandum has a
 * version number that advances on every sign event.
 *
 * The mental model:
 *
 *   \u2022 Owner opens the memorandum writer for the first time \u2192 an empty
 *     draft (version = 1, is_signed = 0) is opened for them.
 *   \u2022 They add entries. Each entry is one item + who they want it to go
 *     to + an optional note explaining the gift.
 *   \u2022 They print and sign. `sign()` freezes the draft (is_signed \u2192 1)
 *     and inserts a memorandum_signings row snapshotting the frozen
 *     entries as JSON.
 *   \u2022 Later, if they want to change their mind, `openNextDraft()` seeds a
 *     new draft (version = 2, is_signed = 0) with the last signed
 *     version's contents. The prior signed version stays on record for
 *     reprint.
 *
 * Conflict detection is intentionally derived at read time \u2014 not stored on
 * any row \u2014 by comparing each partner's latest version (draft-or-signed)
 * against the other partner's. That way there is never a stale conflict
 * count sitting around after an edit.
 *
 * This repo is agnostic about heir validity, item existence, or household
 * mode. Those checks live at the route layer where scope context is known.
 */
export class MemorandumRepo {
  constructor(db, audit = null) {
    this.db = db;
    this.audit = audit;
  }

  /* ------------------------------------------------------------------ */
  /* Reads                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Return the current draft memorandum for a participant, or null if there
   * is no draft (i.e. their last version is signed, or they have never
   * started one).
   */
  getDraft(participantId, ctx) {
    const row = this.db.prepare(
      `SELECT version FROM memorandum_entries
        WHERE scope_id = ? AND participant_id = ? AND is_signed = 0
        ORDER BY version DESC LIMIT 1`,
    ).get(ctx.scopeId, participantId);
    if (!row) return null;
    return this.getVersion(participantId, row.version, ctx);
  }

  /**
   * Return the full memorandum for a specific version (draft or signed).
   * Returns null if that version does not exist.
   */
  getVersion(participantId, version, ctx) {
    const entries = this.db.prepare(
      `SELECT * FROM memorandum_entries
        WHERE scope_id = ? AND participant_id = ? AND version = ?
        ORDER BY created_at ASC`,
    ).all(ctx.scopeId, participantId, version);
    if (entries.length === 0) return null;
    const signing = this.db.prepare(
      `SELECT * FROM memorandum_signings
        WHERE scope_id = ? AND participant_id = ? AND version = ?`,
    ).get(ctx.scopeId, participantId, version);
    return {
      participant_id: participantId,
      version,
      is_signed: entries[0].is_signed === 1,
      signed_at: signing ? signing.signed_at : null,
      conflict_count_at_sign: signing ? signing.conflict_count_at_sign : null,
      entries: entries.map(shapeEntry),
    };
  }

  /**
   * List every version (draft + signed) for a participant, newest first.
   * The rows are lightweight \u2014 no entries payload \u2014 so the caller can
   * present a reprint list without loading everything.
   */
  listVersions(participantId, ctx) {
    const rows = this.db.prepare(
      `SELECT
         me.version,
         MIN(me.is_signed) AS min_signed,
         MAX(me.is_signed) AS max_signed,
         COUNT(*)          AS entry_count,
         ms.signed_at,
         ms.conflict_count_at_sign
       FROM memorandum_entries me
       LEFT JOIN memorandum_signings ms
         ON ms.scope_id = me.scope_id
        AND ms.participant_id = me.participant_id
        AND ms.version = me.version
       WHERE me.scope_id = ? AND me.participant_id = ?
       GROUP BY me.version
       ORDER BY me.version DESC`,
    ).all(ctx.scopeId, participantId);
    return rows.map((r) => ({
      version: r.version,
      is_signed: r.min_signed === 1 && r.max_signed === 1,
      entry_count: r.entry_count,
      signed_at: r.signed_at || null,
      conflict_count_at_sign: r.conflict_count_at_sign ?? null,
    }));
  }

  /**
   * Detect conflicts between two participants' latest versions
   * (draft-or-signed).
   *
   * A conflict is a shared item where the two partners' latest memorandums
   * both name a recipient AND those recipients differ.
   *
   * If either partner has no memorandum yet, there are no conflicts to
   * report \u2014 there is nothing to disagree with.
   */
  detectConflicts(participantAId, participantBId, ctx) {
    const a = this._latestVersion(participantAId, ctx);
    const b = this._latestVersion(participantBId, ctx);
    if (a == null || b == null) return [];
    // Two conflict types:
    // 1) Both partners named DIFFERENT heirs for the same item (classic).
    // 2) Both partners marked the same item as important AND assigned it
    //    (even if they named the same heir — the importance + assignment
    //    overlap means they both care deeply about it and should discuss).
    const rows = this.db.prepare(
      `SELECT
         a.item_id AS item_id,
         a.assigned_to_heir_id AS a_heir_id,
         b.assigned_to_heir_id AS b_heir_id,
         a.note AS a_note,
         b.note AS b_note,
         a.is_important AS a_important,
         b.is_important AS b_important,
         CASE WHEN a.assigned_to_heir_id <> b.assigned_to_heir_id THEN 'recipient_mismatch'
              WHEN a.is_important = 1 AND b.is_important = 1 THEN 'both_important_assigned'
              ELSE 'recipient_mismatch'
         END AS conflict_type
       FROM memorandum_entries a
       JOIN memorandum_entries b
         ON a.scope_id = b.scope_id
        AND a.item_id = b.item_id
       WHERE a.scope_id = ?
         AND a.participant_id = ? AND a.version = ?
         AND b.participant_id = ? AND b.version = ?
         AND a.assigned_to_heir_id IS NOT NULL
         AND b.assigned_to_heir_id IS NOT NULL
         AND (
           a.assigned_to_heir_id <> b.assigned_to_heir_id
           OR (a.is_important = 1 AND b.is_important = 1)
         )`,
    ).all(ctx.scopeId, participantAId, a, participantBId, b);
    return rows.map((r) => ({
      item_id: r.item_id,
      conflict_type: r.conflict_type,
      participant_a_id: participantAId,
      participant_a_heir_id: r.a_heir_id,
      participant_a_note: r.a_note || '',
      participant_b_id: participantBId,
      participant_b_heir_id: r.b_heir_id,
      participant_b_note: r.b_note || '',
    }));
  }

  /* ------------------------------------------------------------------ */
  /* Writes                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Open (or return) the current draft for a participant.
   *
   * If a draft already exists, return it untouched. Otherwise:
   *   \u2022 First-ever memorandum: create version 1 empty.
   *   \u2022 Subsequent draft after a signed version N: create version N+1
   *     seeded with N's entries so the partner can edit-in-place instead
   *     of starting from scratch.
   *
   * Idempotent: calling twice back-to-back returns the same draft version.
   */
  openDraft(participantId, ctx) {
    const existing = this.getDraft(participantId, ctx);
    if (existing) return existing;

    const latest = this._latestVersion(participantId, ctx);
    if (latest == null) {
      // No memorandum ever. Create empty draft at version 1. We only insert
      // a row when the partner actually adds an entry, so at this point we
      // return an in-memory shell.
      return {
        participant_id: participantId,
        version: 1,
        is_signed: false,
        signed_at: null,
        conflict_count_at_sign: null,
        entries: [],
      };
    }

    // Seed vN+1 from the signed vN.
    const nextVersion = latest + 1;
    const source = this.db.prepare(
      `SELECT * FROM memorandum_entries
        WHERE scope_id = ? AND participant_id = ? AND version = ?
        ORDER BY created_at ASC`,
    ).all(ctx.scopeId, participantId, latest);
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      `INSERT INTO memorandum_entries
         (entry_id, scope_id, participant_id, version, item_id,
          assigned_to_heir_id, note, is_signed, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    );
    const tx = this.db.transaction(() => {
      for (const s of source) {
        insert.run(
          ulid(), ctx.scopeId, participantId, nextVersion, s.item_id,
          s.assigned_to_heir_id, s.note, now, now,
        );
      }
    });
    tx();

    this.audit?.append?.({
      action: 'memorandum.draft_opened',
      entity: 'memorandum',
      entity_id: `${participantId}:v${nextVersion}`,
      payload: { seeded_from_version: latest, entry_count: source.length },
    }, ctx);

    return this.getVersion(participantId, nextVersion, ctx) || {
      participant_id: participantId,
      version: nextVersion,
      is_signed: false,
      signed_at: null,
      conflict_count_at_sign: null,
      entries: [],
    };
  }

  /**
   * Add or update the entry for a specific item in the current draft.
   *
   * Refuses to write into a signed version. The caller must call
   * `openDraft()` first to advance past a signed version.
   */
  upsertEntry({ participantId, itemId, assignedToHeirId, note, isImportant }, ctx) {
    if (!participantId) throw badRequest('participant_id is required.');
    if (!itemId) throw badRequest('item_id is required.');

    const version = this._draftVersionOrNull(participantId, ctx);
    if (version == null) {
      // No draft row yet \u2014 this is the first entry in v1 (or the
      // participant deleted their only draft entry and is starting over).
      // Compute the correct version: either 1, or latest_signed + 1.
      const latest = this._latestVersion(participantId, ctx);
      const targetVersion = latest == null ? 1 : latest + 1;

      const now = new Date().toISOString();
      const entryId = ulid();
      this.db.prepare(
        `INSERT INTO memorandum_entries
           (entry_id, scope_id, participant_id, version, item_id,
            assigned_to_heir_id, note, is_important, is_signed, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      ).run(
        entryId, ctx.scopeId, participantId, targetVersion, itemId,
        assignedToHeirId || null, cleanNote(note), isImportant ? 1 : 0, now, now,
      );
      this.audit?.append?.({
        action: 'memorandum.entry_created',
        entity: 'memorandum_entry', entity_id: entryId,
        payload: { participant_id: participantId, version: targetVersion, item_id: itemId },
      }, ctx);
      return this._getEntry(entryId, ctx);
    }

    // Existing draft. Upsert by (participant, version, item).
    const existing = this.db.prepare(
      `SELECT entry_id FROM memorandum_entries
        WHERE scope_id = ? AND participant_id = ? AND version = ? AND item_id = ?`,
    ).get(ctx.scopeId, participantId, version, itemId);

    const now = new Date().toISOString();
    if (existing) {
      this.db.prepare(
        `UPDATE memorandum_entries
            SET assigned_to_heir_id = ?, note = ?, is_important = ?, updated_at = ?
          WHERE entry_id = ?`,
      ).run(assignedToHeirId || null, cleanNote(note), isImportant ? 1 : 0, now, existing.entry_id);
      this.audit?.append?.({
        action: 'memorandum.entry_updated',
        entity: 'memorandum_entry', entity_id: existing.entry_id,
        payload: { participant_id: participantId, version, item_id: itemId },
      }, ctx);
      return this._getEntry(existing.entry_id, ctx);
    }

    const entryId = ulid();
    this.db.prepare(
      `INSERT INTO memorandum_entries
         (entry_id, scope_id, participant_id, version, item_id,
          assigned_to_heir_id, note, is_important, is_signed, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      entryId, ctx.scopeId, participantId, version, itemId,
      assignedToHeirId || null, cleanNote(note), isImportant ? 1 : 0, now, now,
    );
    this.audit?.append?.({
      action: 'memorandum.entry_created',
      entity: 'memorandum_entry', entity_id: entryId,
      payload: { participant_id: participantId, version, item_id: itemId },
    }, ctx);
    return this._getEntry(entryId, ctx);
  }

  /**
   * Delete a single entry from the current draft. Refuses to touch a signed
   * version.
   */
  deleteEntry(entryId, participantId, ctx) {
    const row = this.db.prepare(
      `SELECT * FROM memorandum_entries WHERE entry_id = ? AND scope_id = ?`,
    ).get(entryId, ctx.scopeId);
    if (!row) throw notFound('That entry is not on the list.');
    if (row.participant_id !== participantId) throw forbidden('That entry belongs to your partner.');
    if (row.is_signed === 1) throw badRequest('That entry is on a signed memorandum and cannot be edited. Open a new draft.');
    this.db.prepare('DELETE FROM memorandum_entries WHERE entry_id = ?').run(entryId);
    this.audit?.append?.({
      action: 'memorandum.entry_deleted',
      entity: 'memorandum_entry', entity_id: entryId,
      payload: { participant_id: participantId, version: row.version, item_id: row.item_id },
    }, ctx);
    return { entry_id: entryId, deleted: true };
  }

  /**
   * Freeze the current draft and record a signing row.
   *
   * `partnerId` is passed in so we can count conflicts at sign time. In
   * solo mode, pass null; conflict_count_at_sign is stored as 0.
   *
   * Refuses to sign an empty draft \u2014 the paper would be blank.
   */
  sign(participantId, partnerId, ctx) {
    const draft = this.getDraft(participantId, ctx);
    if (!draft) throw badRequest('There is no draft to sign.');
    if (draft.entries.length === 0) {
      throw badRequest('That memorandum is empty. Add at least one item before signing.');
    }

    const conflicts = partnerId
      ? this.detectConflicts(participantId, partnerId, ctx).length
      : 0;

    const now = new Date().toISOString();
    const signingId = ulid();
    const snapshot = JSON.stringify(draft.entries);

    const tx = this.db.transaction(() => {
      this.db.prepare(
        `UPDATE memorandum_entries
            SET is_signed = 1, updated_at = ?
          WHERE scope_id = ? AND participant_id = ? AND version = ?`,
      ).run(now, ctx.scopeId, participantId, draft.version);
      this.db.prepare(
        `INSERT INTO memorandum_signings
           (signing_id, scope_id, participant_id, version,
            entries_snapshot, signed_at, conflict_count_at_sign)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(signingId, ctx.scopeId, participantId, draft.version, snapshot, now, conflicts);
    });
    tx();

    this.audit?.append?.({
      action: 'memorandum.signed',
      entity: 'memorandum', entity_id: `${participantId}:v${draft.version}`,
      payload: { participant_id: participantId, version: draft.version, conflict_count_at_sign: conflicts, entry_count: draft.entries.length },
    }, ctx);

    return {
      signing_id: signingId,
      participant_id: participantId,
      version: draft.version,
      signed_at: now,
      conflict_count_at_sign: conflicts,
      entry_count: draft.entries.length,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                          */
  /* ------------------------------------------------------------------ */

  _latestVersion(participantId, ctx) {
    const row = this.db.prepare(
      `SELECT MAX(version) AS v FROM memorandum_entries
        WHERE scope_id = ? AND participant_id = ?`,
    ).get(ctx.scopeId, participantId);
    return row?.v ?? null;
  }

  _draftVersionOrNull(participantId, ctx) {
    const row = this.db.prepare(
      `SELECT version FROM memorandum_entries
        WHERE scope_id = ? AND participant_id = ? AND is_signed = 0
        ORDER BY version DESC LIMIT 1`,
    ).get(ctx.scopeId, participantId);
    return row ? row.version : null;
  }

  _getEntry(entryId, ctx) {
    const row = this.db.prepare(
      `SELECT * FROM memorandum_entries WHERE entry_id = ? AND scope_id = ?`,
    ).get(entryId, ctx.scopeId);
    return row ? shapeEntry(row) : null;
  }
}

function shapeEntry(row) {
  return {
    entry_id: row.entry_id,
    participant_id: row.participant_id,
    version: row.version,
    item_id: row.item_id,
    assigned_to_heir_id: row.assigned_to_heir_id || null,
    note: row.note || '',
    is_signed: row.is_signed === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const NOTE_MAX = 500;
function cleanNote(v) {
  const s = String(v ?? '').trim();
  if (s.length > NOTE_MAX) throw badRequest(`That note is too long (max ${NOTE_MAX} characters).`);
  return s;
}

function badRequest(msg) { return Object.assign(new Error(msg), { status: 400 }); }
function notFound(msg)   { return Object.assign(new Error(msg), { status: 404 }); }
function forbidden(msg)  { return Object.assign(new Error(msg), { status: 403 }); }
