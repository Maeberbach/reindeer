import { DEFAULT_ROOMS, DEFAULT_CATEGORIES, MORE_ROOMS, MORE_CATEGORIES, ReindeerError } from '@reindeer/core-api';
import { ulid } from './db/index.js';

/**
 * Bumped whenever DEFAULT_ROOMS or DEFAULT_CATEGORIES gains an entry that
 * existing inventories should be offered. See migration 6.
 */
export const DEFAULTS_VERSION = 4;

/**
 * Room and category registry, shared so an exported inventory can be mapped
 * onto an estate's own lists by name rather than by opaque id.
 */
export class Registry {
  constructor(db, audit) {
    this.db = db;
    this.audit = audit;
  }

  /**
   * The current row from `scopes`, including couple-mode columns added
   * in migration 13. Callers (like the scope-summary route) read this to
   * decide whether to walk household-aware code paths — a solo scope
   * bypasses claim tables entirely.
   */
  getScope(ctx) {
    return this.db.prepare('SELECT * FROM scopes WHERE scope_id = ?').get(ctx.scopeId);
  }

  /**
   * Flip a scope from solo to couple mode.
   *
   * Called by the household-link route once both partners are on the same
   * scope and one has confirmed the link. This is idempotent — calling it
   * on a scope that is already 'couple' does not overwrite the linked_at
   * timestamp — and it is one-way in this method (there is a separate
   * unlink mutator). The route enforces the "two participants exist"
   * precondition; this method just writes the row.
   */
  linkHousehold(ctx, { linkedByParticipantId, linkedHouseholdId = null } = {}) {
    const scope = this.getScope(ctx);
    if (!scope) return null;
    if (scope.household_mode === 'couple') return scope; // idempotent
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE scopes
         SET household_mode = 'couple',
             linked_household_id = COALESCE(?, linked_household_id, scope_id),
             linked_at = ?,
             linked_by_participant_id = ?
       WHERE scope_id = ?`,
    ).run(linkedHouseholdId, now, linkedByParticipantId, ctx.scopeId);
    this.audit?.append?.({
      action: 'scope.link',
      entity: 'scope',
      entity_id: ctx.scopeId,
      payload: { by: linkedByParticipantId, at: now },
    }, ctx);
    return this.getScope(ctx);
  }

  /**
   * Return a couple-mode scope to solo mode.
   *
   * The claim tables are left in place. A survivor-mode migration in a
   * later slice may re-read them; even if it does not, dropping rows on
   * unlink would erase the audit trail of who tagged what and when. Solo
   * mode simply ignores the tables (the routes still work; the trustee
   * cover sheet reads them; nothing else does).
   */
  unlinkHousehold(ctx, { unlinkedByParticipantId } = {}) {
    const scope = this.getScope(ctx);
    if (!scope) return null;
    if (scope.household_mode !== 'couple') return scope; // idempotent
    this.db.prepare(
      `UPDATE scopes
         SET household_mode = 'solo',
             linked_at = NULL,
             linked_by_participant_id = NULL
       WHERE scope_id = ?`,
    ).run(ctx.scopeId);
    this.audit?.append?.({
      action: 'scope.unlink',
      entity: 'scope',
      entity_id: ctx.scopeId,
      payload: { by: unlinkedByParticipantId, at: new Date().toISOString() },
    }, ctx);
    return this.getScope(ctx);
  }

  ensureScope({ scopeId, scopeType, name, ownerName = '' }) {
    const existing = this.db.prepare('SELECT * FROM scopes WHERE scope_id = ?').get(scopeId);
    if (existing) {
      this.topUpDefaults(scopeId);
      return this.db.prepare('SELECT * FROM scopes WHERE scope_id = ?').get(scopeId);
    }
    this.db.prepare('INSERT INTO scopes (scope_id, scope_type, name, owner_name, created_at) VALUES (?,?,?,?,?)')
      .run(scopeId, scopeType, name, ownerName, new Date().toISOString());
    this.seedDefaults(scopeId);
    this.db.prepare('UPDATE scopes SET defaults_version = ? WHERE scope_id = ?').run(DEFAULTS_VERSION, scopeId);
    return this.db.prepare('SELECT * FROM scopes WHERE scope_id = ?').get(scopeId);
  }

  /**
   * Offer an older inventory the rooms and categories it never got.
   *
   * Runs at most once per scope, gated on `defaults_version`. Purely additive:
   * nothing is renamed, reordered or removed, so a room the owner added, and
   * every item pointing at one, is untouched. A scope that has already caught
   * up returns immediately, which is what stops a deleted default from being
   * planted again on the next boot.
   */
  topUpDefaults(scopeId) {
    const scope = this.db.prepare('SELECT defaults_version FROM scopes WHERE scope_id = ?').get(scopeId);
    if (!scope || scope.defaults_version >= DEFAULTS_VERSION) return 0;

    const haveRoom = new Set(this.db.prepare('SELECT LOWER(name) n FROM rooms WHERE scope_id = ?')
      .all(scopeId).map((r) => r.n));
    const haveCat = new Set(this.db.prepare('SELECT LOWER(name) n FROM categories WHERE scope_id = ?')
      .all(scopeId).map((r) => r.n));

    const room = this.db.prepare('INSERT INTO rooms (room_id, scope_id, name, is_custom, sort_order) VALUES (?,?,?,0,?)');
    const cat = this.db.prepare('INSERT INTO categories (category_id, scope_id, name, is_custom, sort_order) VALUES (?,?,?,0,?)');
    let added = 0;
    const tx = this.db.transaction(() => {
      DEFAULT_ROOMS.forEach((n, i) => {
        if (haveRoom.has(n.toLowerCase())) return;
        room.run(ulid(), scopeId, n, i);
        added += 1;
      });
      DEFAULT_CATEGORIES.forEach((n, i) => {
        if (haveCat.has(n.toLowerCase())) return;
        cat.run(ulid(), scopeId, n, i);
        added += 1;
      });
      this.db.prepare('UPDATE scopes SET defaults_version = ? WHERE scope_id = ?').run(DEFAULTS_VERSION, scopeId);
    });
    tx();
    return added;
  }

  /**
   * Rooms the owner could add but has not, for the "Add another room" list.
   *
   * Kept out of the seeded set so the buttons on the capture screen describe
   * the house in front of the owner rather than every house.
   */
  moreRooms(ctx) {
    const have = new Set(this.rooms(ctx).map((r) => r.name.toLowerCase()));
    return MORE_ROOMS.filter((n) => !have.has(n.toLowerCase()));
  }

  /**
   * Categories the owner could pull out but has not, for "Add another
   * category". Silent until asked for, and every one an exact FairPlay name.
   */
  moreCategories(ctx) {
    const have = new Set(this.categories(ctx).map((c) => c.name.toLowerCase()));
    return MORE_CATEGORIES.filter((n) => !have.has(n.toLowerCase()));
  }

  seedDefaults(scopeId, siteId = null) {
    const room = this.db.prepare('INSERT OR IGNORE INTO rooms (room_id, scope_id, name, is_custom, sort_order, site_id) VALUES (?,?,?,0,?,?)');
    const cat = this.db.prepare('INSERT OR IGNORE INTO categories (category_id, scope_id, name, is_custom, sort_order) VALUES (?,?,?,0,?)');
    const tx = this.db.transaction(() => {
      DEFAULT_ROOMS.forEach((n, i) => room.run(ulid(), scopeId, n, i, siteId));
      DEFAULT_CATEGORIES.forEach((n, i) => cat.run(ulid(), scopeId, n, i));
    });
    tx();
  }

  rooms(ctx, siteId = null) {
    // When a siteId is given, return only rooms for that site.
    // NULL site_id rooms belong to the primary/home site.
    if (siteId !== null) {
      return this.db.prepare(
        'SELECT * FROM rooms WHERE scope_id = ? AND (site_id = ? OR (site_id IS NULL AND ? IS NULL)) ORDER BY sort_order, name',
      ).all(ctx.scopeId, siteId, siteId);
    }
    return this.db.prepare('SELECT * FROM rooms WHERE scope_id = ? ORDER BY sort_order, name').all(ctx.scopeId);
  }

  categories(ctx) {
    return this.db.prepare('SELECT * FROM categories WHERE scope_id = ? ORDER BY sort_order, name').all(ctx.scopeId);
  }

  /**
   * Mark where the owner has got to in a room.
   *
   * `documented` is set the first time anything at all is captured in the room
   * and is never cleared, because a recording made in a room is a fact about
   * that room and reopening it later does not un-record it.
   */
  async setRoomState(roomId, state, ctx, { documented = false } = {}) {
    const room = this.db.prepare('SELECT * FROM rooms WHERE room_id = ? AND scope_id = ?').get(roomId, ctx.scopeId);
    if (!room) throw new ReindeerError('That room is not on your list.', 'NOT_FOUND', 404);
    const allowed = ['not_started', 'started', 'done', 'skipped'];
    if (!allowed.includes(state)) throw new ReindeerError('Unknown room state.', 'BAD_STATE', 400);
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE rooms SET
        walkthrough_state = ?,
        completed_at      = CASE WHEN ? IN ('done','skipped') THEN ? ELSE NULL END,
        documented_at     = COALESCE(documented_at, CASE WHEN ? = 1 THEN ? ELSE NULL END)
      WHERE room_id = ? AND scope_id = ?`)
      .run(state, state, now, documented ? 1 : 0, now, roomId, ctx.scopeId);
    await this.audit.append(
      { action: 'room.walkthrough', entity: 'room', entity_id: roomId, payload: { state, documented } },
      ctx,
    );
    return this.db.prepare('SELECT * FROM rooms WHERE room_id = ?').get(roomId);
  }

  /**
   * The state of the whole walk, in the terms the owner cares about.
   *
   * This is what makes a pause safe. Whenever the owner comes back — an hour or
   * three weeks later — this answers "where was I" without them having to
   * remember, and it is the only thing the reminder is built from.
   *
   * A room counts as finished when the owner said so, not when the app judges it
   * full. Someone may have nothing in the shed worth recording, and saying so is
   * a complete answer.
   */
  walkthrough(ctx, siteId = null) {
    const rooms = (siteId !== null
      ? this.db.prepare(`
        SELECT r.room_id, r.name, r.is_custom, r.sort_order,
               r.walkthrough_state, r.documented_at, r.completed_at,
               (SELECT COUNT(*) FROM items i
                  WHERE i.room_id = r.room_id AND i.scope_id = r.scope_id
                    AND i.review_state <> 'discarded') AS item_count
          FROM rooms r
         WHERE r.scope_id = ? AND (r.site_id = ? OR (r.site_id IS NULL AND ? IS NULL))
         ORDER BY r.sort_order, r.name`).all(ctx.scopeId, siteId, siteId)
      : this.db.prepare(`
        SELECT r.room_id, r.name, r.is_custom, r.sort_order,
               r.walkthrough_state, r.documented_at, r.completed_at,
               (SELECT COUNT(*) FROM items i
                  WHERE i.room_id = r.room_id AND i.scope_id = r.scope_id
                    AND i.review_state <> 'discarded') AS item_count
          FROM rooms r
         WHERE r.scope_id = ?
         ORDER BY r.sort_order, r.name`).all(ctx.scopeId));

    const done = rooms.filter((r) => r.walkthrough_state === 'done');
    const skipped = rooms.filter((r) => r.walkthrough_state === 'skipped');
    const started = rooms.filter((r) => r.walkthrough_state === 'started');
    const untouched = rooms.filter((r) => r.walkthrough_state === 'not_started');

    // Pick up where they left off: a half-finished room first, then the next
    // room never opened. Never suggest one they have already closed.
    const nextRoom = started[0] ?? untouched[0] ?? null;

    return {
      rooms,
      next_room: nextRoom ? { room_id: nextRoom.room_id, name: nextRoom.name } : null,
      counts: {
        total: rooms.length,
        done: done.length,
        skipped: skipped.length,
        in_progress: started.length,
        not_started: untouched.length,
        settled: done.length + skipped.length,
      },
      // "Finished" means every room has been answered one way or the other.
      is_complete: rooms.length > 0 && done.length + skipped.length === rooms.length,
      unfinished: [...started, ...untouched]
        .map((r) => ({ room_id: r.room_id, name: r.name, state: r.walkthrough_state })),
    };
  }

  /**
   * Find by name, or create. Used by the UI and the importer.
   *
   * A room the owner invents is `is_custom` and sorts to the front as theirs.
   * One picked off the "Add another room" list is a standard name that simply
   * was not seeded, so it is marked standard and sorts with its siblings —
   * otherwise "Attic" would be presented back to them as though they had
   * thought of it.
   */
  resolveRoom(name, ctx, { createIfMissing = true, isCustom = true, siteId = null } = {}) {
    if (!name) return null;
    // Search within the same site (NULL = primary/home)
    const found = this.db.prepare(
      'SELECT * FROM rooms WHERE scope_id = ? AND name = ? COLLATE NOCASE AND (site_id IS ? OR (site_id IS NULL AND ? IS NULL))',
    ).get(ctx.scopeId, name, siteId, siteId);
    if (found) return found;
    if (!createIfMissing) return null;
    const id = ulid();
    const custom = isCustom && !MORE_ROOMS.some((n) => n.toLowerCase() === name.toLowerCase()) ? 1 : 0;
    this.db.prepare('INSERT INTO rooms (room_id, scope_id, name, is_custom, sort_order, site_id) VALUES (?,?,?,?,?,?)')
      .run(id, ctx.scopeId, name, custom, custom ? 999 : 500, siteId);
    return this.db.prepare('SELECT * FROM rooms WHERE room_id = ?').get(id);
  }

  /**
   * Find by name, or create. Same rule as resolveRoom.
   *
   * A category the owner invents is `is_custom` and sorts to the front as
   * theirs. One pulled off the "Add another category" list is a standard Fair
   * Choice name that simply was not seeded, so it is marked standard and sorts
   * with its siblings.
   */
  resolveCategory(name, ctx, { createIfMissing = true, isCustom = true } = {}) {
    if (!name) return null;
    const found = this.db.prepare('SELECT * FROM categories WHERE scope_id = ? AND name = ? COLLATE NOCASE').get(ctx.scopeId, name);
    if (found) return found;
    if (!createIfMissing) return null;
    const id = ulid();
    const custom = isCustom && !MORE_CATEGORIES.some((n) => n.toLowerCase() === name.toLowerCase()) ? 1 : 0;
    this.db.prepare('INSERT INTO categories (category_id, scope_id, name, is_custom, sort_order) VALUES (?,?,?,?,?)')
      .run(id, ctx.scopeId, name, custom, custom ? 999 : 500);
    return this.db.prepare('SELECT * FROM categories WHERE category_id = ?').get(id);
  }

  /** Rename a room. The owner can call Bedroom 2 "Bobby's Room" etc. */
  async renameRoom(roomId, name, ctx) {
    const room = this.db.prepare('SELECT * FROM rooms WHERE room_id = ? AND scope_id = ?').get(roomId, ctx.scopeId);
    if (!room) throw new ReindeerError('That room is not on your list.', 'NOT_FOUND', 404);
    const trimmed = (name || '').trim();
    if (!trimmed) throw new ReindeerError('A room needs a name.', 'BAD_NAME', 400);
    this.db.prepare('UPDATE rooms SET name = ? WHERE room_id = ? AND scope_id = ?')
      .run(trimmed, roomId, ctx.scopeId);
    await this.audit.append(
      { action: 'room.rename', entity: 'room', entity_id: roomId, payload: { old_name: room.name, new_name: trimmed } },
      ctx,
    );
    return this.db.prepare('SELECT * FROM rooms WHERE room_id = ?').get(roomId);
  }

  /** Deleting a referenced room or category requires reassignment first. */
  async deleteRoom(roomId, ctx) {
    const n = this.db.prepare('SELECT COUNT(*) c FROM items WHERE room_id = ? AND scope_id = ?').get(roomId, ctx.scopeId).c;
    if (n > 0) throw new ReindeerError(`${n} item(s) still use this room. Move them first.`, 'IN_USE', 409, { count: n });
    this.db.prepare('DELETE FROM rooms WHERE room_id = ? AND scope_id = ?').run(roomId, ctx.scopeId);
    await this.audit.append({ action: 'room.delete', entity: 'room', entity_id: roomId }, ctx);
  }

  async deleteCategory(categoryId, ctx) {
    const n = this.db.prepare('SELECT COUNT(*) c FROM items WHERE category_id = ? AND scope_id = ?').get(categoryId, ctx.scopeId).c;
    if (n > 0) throw new ReindeerError(`${n} item(s) still use this category. Move them first.`, 'IN_USE', 409, { count: n });
    this.db.prepare('DELETE FROM categories WHERE category_id = ? AND scope_id = ?').run(categoryId, ctx.scopeId);
    await this.audit.append({ action: 'category.delete', entity: 'category', entity_id: categoryId }, ctx);
  }
}
