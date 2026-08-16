import { ulid } from '../db/index.js';

/**
 * Participants — the people who can sign in to this Registry.
 *
 * A participant is anchored by an email address (case-insensitive, unique).
 * Solo installs may have exactly one participant with role 'owner'. Couple
 * mode adds a second participant with role 'partner'.
 *
 * Participants are distinct from the household roster (`scope_people`):
 * the roster tracks everyone the owner might leave a memento to (children,
 * grandchildren, friends, charities). Only a handful of roster rows ever
 * become participants. When they do, `scope_people.participant_id` links
 * the two (that link is a later slice).
 */
export class ParticipantsRepo {
  constructor(db, audit = null) { this.db = db; this.audit = audit; }

  /** Number of participants across the whole install (all scopes). */
  count() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM participants').get().n;
  }

  /** Number of participants who have actually signed in (status = 'active'). */
  countActive() {
    return this.db.prepare("SELECT COUNT(*) AS n FROM participants WHERE status = 'active'").get().n;
  }

  list() {
    return this.db.prepare('SELECT * FROM participants ORDER BY created_at ASC').all().map(shape);
  }

  get(participantId) {
    const row = this.db.prepare('SELECT * FROM participants WHERE participant_id = ?').get(participantId);
    return row ? shape(row) : null;
  }

  findByEmail(email) {
    const row = this.db.prepare(
      'SELECT * FROM participants WHERE email = ?',
    ).get(normalizeEmail(email));
    return row ? shape(row) : null;
  }

  /**
   * Idempotently upsert a participant by email. Used by the auth service
   * when a magic link is verified for an email that isn't yet on file.
   * A brand-new participant defaults to role 'invited' unless the caller
   * says otherwise (bootstrap uses 'owner').
   */
  upsertByEmail({
    email, displayName = '', role = 'invited', status = 'active', householdScopeId = null,
  }) {
    if (!email) throw badRequest('An email is needed.');
    const normalized = normalizeEmail(email);
    const existing = this.findByEmail(normalized);
    const now = new Date().toISOString();
    if (existing) {
      // We update display_name only when the caller passed a non-empty one
      // (so a routine touch does not blank an existing name). Role moves
      // only upward on a strict priority ladder: owner > partner > invited.
      // This lets the auth path promote 'invited' → 'partner' when a
      // freshly-invited participant consumes their magic link, without
      // ever demoting an owner or clobbering a partner back to invited.
      const rank = (r) => (r === 'owner' ? 4 : r === 'partner' ? 3 : r === 'assistant' ? 2 : r === 'invited' ? 1 : 0);
      const nextRole = rank(role) > rank(existing.role) ? role : existing.role;
      this.db.prepare(
        `UPDATE participants
           SET display_name = CASE WHEN ? != '' THEN ? ELSE display_name END,
               role = ?, status = ?, last_seen_at = ?, updated_at = ?
         WHERE participant_id = ?`,
      ).run(displayName, displayName, nextRole, status, now, now, existing.participant_id);
      return this.get(existing.participant_id);
    }
    const participantId = ulid();
    this.db.prepare(
      `INSERT INTO participants
         (participant_id, email, display_name, role, status, household_scope_id,
          created_at, updated_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      participantId, normalized, displayName, role, status, householdScopeId,
      now, now, now,
    );
    this.audit?.append?.({
      action: 'participant.create', entity: 'participant', entity_id: participantId,
      payload: { email: normalized, role, status },
    }, { scopeType: 'inventory', scopeId: householdScopeId ?? 'system', actorId: 'system' });
    return this.get(participantId);
  }

  updateRole(participantId, role) {
    const now = new Date().toISOString();
    this.db.prepare(
      'UPDATE participants SET role = ?, updated_at = ? WHERE participant_id = ?',
    ).run(role, now, participantId);
    return this.get(participantId);
  }

  /**
   * Set a participant's display name. Used by the client-side name-capture
   * step at partner invitation (owner types partner's preferred first name)
   * and at partner confirm (partner may edit or accept the suggestion).
   * The empty string is allowed — it clears the name.
   */
  updateDisplayName(participantId, displayName) {
    const now = new Date().toISOString();
    const name = String(displayName ?? '');
    this.db.prepare(
      'UPDATE participants SET display_name = ?, updated_at = ? WHERE participant_id = ?',
    ).run(name, now, participantId);
    return this.get(participantId);
  }

  touchLastSeen(participantId) {
    const now = new Date().toISOString();
    this.db.prepare(
      'UPDATE participants SET last_seen_at = ?, updated_at = ? WHERE participant_id = ?',
    ).run(now, now, participantId);
  }
}

function shape(row) {
  return {
    participant_id: row.participant_id,
    email: row.email,
    display_name: row.display_name ?? '',
    role: row.role,
    status: row.status,
    household_scope_id: row.household_scope_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_seen_at: row.last_seen_at ?? null,
  };
}

export function normalizeEmail(e) { return String(e ?? '').trim().toLowerCase(); }
function badRequest(msg) { return Object.assign(new Error(msg), { status: 400 }); }
