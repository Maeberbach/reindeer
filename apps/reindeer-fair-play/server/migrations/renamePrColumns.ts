/**
 * Reindeer FairPlay — column/table rename migration (PR → Captain).
 *
 * For databases created before the Captain terminology migration, this
 * renames the remaining pr_* columns and the pr_transfers table to their
 * captain_* equivalents. Safe to run multiple times — checks each rename
 * before applying it.
 *
 * If the database was created fresh on v2.1+, this is a no-op — the
 * columns already have their final names via init.ts.
 */
import type Database from "better-sqlite3";

export function migratePrToCaptain(sqlite: Database.Database): void {
  const hasColumn = (table: string, column: string): boolean => {
    const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((r) => r.name === column);
  };

  const hasTable = (table: string): boolean => {
    const row = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
    return !!row;
  };

  // SQLite didn't support ALTER TABLE RENAME COLUMN until 3.25.0 (2018).
  // better-sqlite3 ships a newer version, so this is safe.
  const renameColumn = (table: string, oldCol: string, newCol: string): void => {
    if (hasColumn(table, oldCol)) {
      sqlite.exec(`ALTER TABLE ${table} RENAME COLUMN ${oldCol} TO ${newCol}`);
      console.log(`  Renamed ${table}.${oldCol} → ${newCol}`);
    }
  };

  const renameTable = (oldTable: string, newTable: string): void => {
    if (hasTable(oldTable) && !hasTable(newTable)) {
      sqlite.exec(`ALTER TABLE ${oldTable} RENAME TO ${newTable}`);
      console.log(`  Renamed table ${oldTable} → ${newTable}`);
    }
  };

  const renameIndex = (oldIndex: string, newIndex: string, table: string, columns: string): void => {
    const hasOldIndex = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get(oldIndex);
    const hasNewIndex = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get(newIndex);
    if (hasOldIndex && !hasNewIndex) {
      sqlite.exec(`DROP INDEX IF EXISTS ${oldIndex}`);
      sqlite.exec(`CREATE INDEX IF NOT EXISTS ${newIndex} ON ${table} (${columns})`);
      console.log(`  Rebuilt index ${oldIndex} → ${newIndex}`);
    }
  };

  console.log("[migration] Captain rename check...");

  // 1. participants.allows_pr_assist → allows_captain_assist
  if (hasTable("participants")) {
    renameColumn("participants", "allows_pr_assist", "allows_captain_assist");
  }

  // 2. pr_transfers table → captain_transfers
  if (hasTable("pr_transfers")) {
    // Rename the table first
    renameTable("pr_transfers", "captain_transfers");

    // Rename columns (table is now captain_transfers)
    if (hasTable("captain_transfers")) {
      renameColumn("captain_transfers", "previous_pr_participant_id", "previous_captain_participant_id");
      renameColumn("captain_transfers", "new_pr_participant_id", "new_captain_participant_id");
      renameColumn("captain_transfers", "previous_pr_disposition", "previous_captain_disposition");
      renameColumn("captain_transfers", "previous_pr_name", "previous_captain_name");
      renameColumn("captain_transfers", "new_pr_name", "new_captain_name");
    }

    // Rebuild the index
    renameIndex("pr_transfers_session", "captain_transfers_session", "captain_transfers", "session_id, transferred_at");
  }

  console.log("[migration] Captain rename complete.");
}
