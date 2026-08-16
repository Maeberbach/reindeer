import { ulid } from '../db/index.js';

/**
 * The owner's list of people.
 *
 * Two rules shape everything here.
 *
 * The first is that a name must never be entered twice. On a list of two
 * hundred belongings, an owner types the same four or five names over and
 * over, and every variant spelling becomes a separate heir by the time the
 * file reaches the other app. So `upsert` matches case-insensitively and
 * returns the existing person rather than creating a near-duplicate.
 *
 * The second is that naming somebody here gives them nothing. This is an
 * address book, not a bequest. The binding decision lives in the will and in
 * the signed memorandum; an entry in this table is a convenience for typing.
 * That is why there is no share, no percentage, and no status field.
 */
export class PeopleRepo {
  constructor(db) { this.db = db; }

  list(ctx, { includeArchived = false } = {}) {
    const rows = this.db.prepare(
      `SELECT * FROM scope_people
        WHERE scope_id = ? ${includeArchived ? '' : 'AND archived = 0'}
        ORDER BY sort_order, name COLLATE NOCASE`,
    ).all(ctx.scopeId);
    return rows.map(shape);
  }

  get(personId, ctx) {
    const row = this.db.prepare('SELECT * FROM scope_people WHERE person_id = ? AND scope_id = ?')
      .get(personId, ctx.scopeId);
    return row ? shape(row) : null;
  }

  findByName(name, ctx) {
    const row = this.db.prepare(
      'SELECT * FROM scope_people WHERE scope_id = ? AND name = ? COLLATE NOCASE',
    ).get(ctx.scopeId, String(name ?? '').trim());
    return row ? shape(row) : null;
  }

  /**
   * Create the person, or return the one already there under that name.
   *
   * A relationship supplied later fills a blank one, but never overwrites a
   * relationship the owner already stated — if they said "daughter" on
   * Tuesday and the capture screen guesses "family" on Friday, Tuesday wins.
   */
  upsert({ name, relationship = '', note = '', source = 'typed' }, ctx) {
    const clean = String(name ?? '').trim().replace(/\s+/g, ' ');
    if (!clean) throw Object.assign(new Error('A person needs a name.'), { status: 400 });
    if (clean.length > 120) throw Object.assign(new Error('That name is too long.'), { status: 400 });

    const existing = this.findByName(clean, ctx);
    const now = new Date().toISOString();

    if (existing) {
      const rel = existing.relationship || String(relationship ?? '').trim();
      const nt = existing.note || String(note ?? '').trim();
      if (rel !== existing.relationship || nt !== existing.note) {
        this.db.prepare('UPDATE scope_people SET relationship = ?, note = ?, updated_at = ? WHERE person_id = ?')
          .run(rel, nt, now, existing.person_id);
      }
      return { ...this.get(existing.person_id, ctx), created: false };
    }

    const maxOrder = this.db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM scope_people WHERE scope_id = ?')
      .get(ctx.scopeId).m;
    const personId = ulid();
    this.db.prepare(
      `INSERT INTO scope_people (person_id, scope_id, name, relationship, note, source, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(personId, ctx.scopeId, clean, String(relationship ?? '').trim(), String(note ?? '').trim(),
      source === 'from_item' ? 'from_item' : 'typed', maxOrder + 1, now, now);
    return { ...this.get(personId, ctx), created: true };
  }

  update(personId, patch, ctx) {
    const person = this.get(personId, ctx);
    if (!person) throw Object.assign(new Error('That person is not on the list.'), { status: 404 });
    const name = patch.name != null ? String(patch.name).trim().replace(/\s+/g, ' ') : person.name;
    if (!name) throw Object.assign(new Error('A person needs a name.'), { status: 400 });

    // Renaming onto somebody already on the list would break the unique index
    // with a database error nobody can read. Say it in words instead.
    const clash = this.findByName(name, ctx);
    if (clash && clash.person_id !== personId) {
      throw Object.assign(new Error(`${name} is already on your list.`), { status: 409 });
    }

    this.db.prepare(
      'UPDATE scope_people SET name = ?, relationship = ?, note = ?, updated_at = ? WHERE person_id = ? AND scope_id = ?',
    ).run(
      name,
      patch.relationship != null ? String(patch.relationship).trim() : person.relationship,
      patch.note != null ? String(patch.note).trim() : person.note,
      new Date().toISOString(), personId, ctx.scopeId,
    );
    return this.get(personId, ctx);
  }

  /**
   * Archive rather than delete. Items already recorded carry the name they
   * were given, and a list that silently loses a person the owner once named
   * is worse than one with an extra entry.
   */
  archive(personId, ctx, archived = true) {
    const person = this.get(personId, ctx);
    if (!person) throw Object.assign(new Error('That person is not on the list.'), { status: 404 });
    this.db.prepare('UPDATE scope_people SET archived = ?, updated_at = ? WHERE person_id = ? AND scope_id = ?')
      .run(archived ? 1 : 0, new Date().toISOString(), personId, ctx.scopeId);
    return this.get(personId, ctx);
  }

  /** How many items name each person — shown so the owner can see their own progress. */
  counts(ctx) {
    const rows = this.db.prepare(
      `SELECT h.recipient_name AS name, COUNT(*) AS n
         FROM recipient_hints h
         JOIN items i ON i.item_id = h.item_id
        WHERE h.scope_id = ? AND i.review_state != 'rejected' AND TRIM(h.recipient_name) != ''
        GROUP BY LOWER(TRIM(h.recipient_name))`,
    ).all(ctx.scopeId);
    return new Map(rows.map((r) => [r.name.trim().toLowerCase(), r.n]));
  }

  /**
   * Names already used on items but missing from the roster.
   *
   * This exists for the owner who recorded fifty things before ever opening
   * the people screen. Rather than making them re-type what they already
   * said, the app offers to adopt those names.
   */
  unlisted(ctx) {
    const known = new Set(this.list(ctx, { includeArchived: true }).map((p) => p.name.toLowerCase()));
    const rows = this.db.prepare(
      `SELECT TRIM(h.recipient_name) AS name,
              MAX(TRIM(h.relationship)) AS relationship,
              COUNT(*) AS item_count
         FROM recipient_hints h
         JOIN items i ON i.item_id = h.item_id
        WHERE h.scope_id = ? AND i.review_state != 'rejected' AND TRIM(h.recipient_name) != ''
        GROUP BY LOWER(TRIM(h.recipient_name))
        ORDER BY item_count DESC`,
    ).all(ctx.scopeId);
    return rows
      .filter((r) => !known.has(r.name.toLowerCase()))
      .map((r) => ({ name: r.name, relationship: r.relationship || '', item_count: r.item_count }));
  }
}

function shape(row) {
  return {
    person_id: row.person_id,
    name: row.name,
    relationship: row.relationship || '',
    note: row.note || '',
    source: row.source,
    archived: !!row.archived,
    created_at: row.created_at,
  };
}
