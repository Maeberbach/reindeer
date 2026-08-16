/**
 * Multi-estate mode toggle.
 *
 * When OFF (default): single estate per install — the current behavior.
 *   The app uses the one and only session row. No estate picker on login.
 *
 * When ON: multiple estates per install.
 *   Login shows an estate picker. Each estate has its own session row,
 *   its own participants, its own items. The captain can create new
 *   estates from the login screen.
 *
 * The toggle is stored in app_settings so it persists across restarts.
 * Toggling it on doesn't migrate data — it just unlocks the UI. The
 * existing single estate becomes "Estate #1" and remains fully functional.
 */

import { sqlite } from "../storage";

const TOGGLE_KEY = "multi_estate_mode";

/** Returns true if multi-estate mode is enabled. */
export function isMultiEstateMode(): boolean {
  const row = sqlite
    .prepare(`SELECT value FROM app_settings WHERE key = ?`)
    .get(TOGGLE_KEY) as { value: string } | undefined;
  return row?.value === "true";
}

/** Enables or disables multi-estate mode. Captain only (enforced at route). */
export function setMultiEstateMode(enabled: boolean): void {
  const now = Date.now();
  sqlite
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(TOGGLE_KEY, enabled ? "true" : "false", now);
}

/** Lists all estates (session rows) for the estate picker. */
export function listEstates(): Array<{
  id: number;
  name: string;
  estateName: string | null;
  phase: string;
  createdAt: number;
}> {
  const rows = sqlite
    .prepare(
      `SELECT id, name, estate_name, phase, created_at FROM sessions ORDER BY created_at ASC`,
    )
    .all() as Array<{
    id: number;
    name: string;
    estate_name: string | null;
    phase: string;
    created_at: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    estateName: r.estate_name,
    phase: r.phase,
    createdAt: r.created_at,
  }));
}

/** Creates a new estate (session row). Returns the new session ID. */
export function createEstate(name: string): number {
  const now = Date.now();
  const result = sqlite
    .prepare(
      `INSERT INTO sessions (name, estate_name, phase, rank_depth_mode, rank_top_n,
        current_round, priority_order, heir_permissions, practice_mode, practice_state,
        created_at)
       VALUES (?, NULL, 'welcome', 'topN', 20, 0, '[]', ?, 'off', NULL, ?)`,
    )
    .run(name, JSON.stringify({ heirsCanAddInventory: false, heirsCanProposeGroupings: false, autoDraftEnabled: true, heirsCanCategorize: false }), now);

  return result.lastInsertRowid as number;
}
