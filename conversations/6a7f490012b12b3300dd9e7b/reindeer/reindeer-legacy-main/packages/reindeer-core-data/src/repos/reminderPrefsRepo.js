/*
 * Reminder preferences.
 *
 * One row per (scope, participant). Stores a small JSON array of holiday
 * keys the owner (or partner) has asked to be reminded about. The Registry
 * itself does not send email — a Perplexity Computer scheduled task reads
 * this table and dispatches the actual reminders.
 *
 * The vocabulary of allowed keys lives in the router (see
 * apps/reindeer-registry/server/routes/reminders.js) so the frontend and the
 * scheduled task agree on the exact strings.
 */
export class ReminderPrefsRepo {
  constructor(db) { this.db = db; }

  /**
   * Return the participant's picked holidays as an array of keys. An empty
   * array means "no reminders opted in yet." Never returns null.
   */
  get(scopeId, participantId) {
    const row = this.db.prepare(
      'SELECT holidays_json FROM reminder_prefs WHERE scope_id = ? AND participant_id = ?',
    ).get(scopeId, participantId);
    if (!row) return [];
    try {
      const parsed = JSON.parse(row.holidays_json);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }

  /**
   * Replace the participant's list. Caller is expected to have already
   * validated each entry against the router's allowed vocabulary. Storing
   * an empty array is meaningful — it clears all opt-ins.
   */
  set(scopeId, participantId, holidayKeys) {
    const now = new Date().toISOString();
    const json = JSON.stringify(Array.isArray(holidayKeys) ? holidayKeys : []);
    this.db.prepare(
      `INSERT INTO reminder_prefs (scope_id, participant_id, holidays_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(scope_id, participant_id) DO UPDATE SET
         holidays_json = excluded.holidays_json,
         updated_at    = excluded.updated_at`,
    ).run(scopeId, participantId, json, now);
    return this.get(scopeId, participantId);
  }

  /**
   * Used by the scheduled task: list every participant across every scope
   * whose picked holidays include the given key. Returns rows with the
   * participant_id and scope_id so the caller can join to participants for
   * an email address.
   */
  participantsForHoliday(key) {
    const rows = this.db.prepare(
      'SELECT scope_id, participant_id, holidays_json FROM reminder_prefs',
    ).all();
    const hits = [];
    for (const row of rows) {
      try {
        const list = JSON.parse(row.holidays_json);
        if (Array.isArray(list) && list.includes(key)) {
          hits.push({ scope_id: row.scope_id, participant_id: row.participant_id });
        }
      } catch { /* skip corrupt rows */ }
    }
    return hits;
  }
}
