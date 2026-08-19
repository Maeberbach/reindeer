/**
 * Persistent corporate settings store.
 *
 * Feature flags live in memory by default (testing mode). When this
 * module is wired in, flag values are loaded from the corporate_settings
 * table on startup and persisted on every admin toggle. This means
 * flags survive server restarts — critical for production deploys
 * where an admin might flip subscriptionGate on, then the container
 * redeploys and the flag would otherwise reset to its code default.
 *
 * The store is deliberately simple: key/value pairs in a single table.
 * No schema per setting, no types — just strings. The caller is
 * responsible for coercing to boolean/number/etc.
 */

/**
 * Create a corporate settings store backed by the given SQLite db.
 * @param {import('better-sqlite3').Database} db
 */
export function createCorporateSettings(db) {
  const get = db.prepare('SELECT value FROM corporate_settings WHERE key = ?');
  const set = db.prepare(`
    INSERT INTO corporate_settings (key, value, updated_at, updated_by)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `);
  const all = db.prepare('SELECT key, value FROM corporate_settings');

  return {
    /** Get a single setting value, or null if not stored. */
    get(key) {
      const row = get.get(key);
      return row ? row.value : null;
    },

    /** Set a setting value. */
    set(key, value, updatedBy = 'admin') {
      set.run(key, String(value), new Date().toISOString(), updatedBy);
    },

    /** Get all settings as a plain object. */
    getAll() {
      const rows = all.all();
      const out = {};
      for (const r of rows) out[r.key] = r.value;
      return out;
    },

    /**
     * Load feature flags from the DB into the provided flags object.
     * Only overrides keys that already exist in the flags object —
     * does not introduce new flags. Missing DB rows keep code defaults.
     */
    loadFlags(flags) {
      const stored = this.getAll();
      for (const key of Object.keys(flags)) {
        if (key in stored) {
          flags[key] = stored[key] === 'true';
        }
      }
    },

    /**
     * Persist a single flag toggle to the DB.
     */
    saveFlag(key, value, updatedBy = 'admin') {
      this.set(`flag.${key}`, value ? 'true' : 'false', updatedBy);
    },

    /**
     * Load all flags from DB using the flag.* prefix convention.
     */
    loadAllFlags(flags) {
      const stored = this.getAll();
      for (const key of Object.keys(flags)) {
        const dbKey = `flag.${key}`;
        if (dbKey in stored) {
          flags[key] = stored[dbKey] === 'true';
        }
      }
    },
  };
}
