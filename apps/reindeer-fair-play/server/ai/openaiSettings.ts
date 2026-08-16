/**
 * Server-side storage for the OpenAI API key.
 *
 * The key is stored encrypted-at-rest in the SQLite database (not in
 * process.env, which would require a .env file per desktop install).
 * On startup, if process.env.OPENAI_API_KEY is present (e.g. dev or
 * pre-configured server), it takes priority over the stored key.
 *
 * The key is never returned in full by any API endpoint — only a
 * masked preview ("sk-...ab2f") and whether one is set.
 */

import { db, sqlite } from "../storage";
import { eq } from "drizzle-orm";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import crypto from "node:crypto";

/* ------------------------------------------------------------------ */
/* Schema: app_settings (key-value store for runtime config)          */
/* ------------------------------------------------------------------ */

export const appSettings = sqliteTable("app_settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  key: text("key").notNull().unique(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// Ensure the table exists (safe to call multiple times)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

/* ------------------------------------------------------------------ */
/* Encryption                                                          */
/* ------------------------------------------------------------------ */

// For desktop apps, we use a machine-local key derived from a static
// app secret. This isn't vault-grade — it prevents casual exposure in
// the SQLite file. For higher security, Electron's safeStorage could
// be used, but this keeps it cross-platform and simple.

const ENCRYPTION_KEY = process.env.FAIR_CHOICE_APP_SECRET
  ? crypto.scryptSync(process.env.FAIR_CHOICE_APP_SECRET, "fair-choice-salt", 32)
  : crypto.scryptSync("fair-choice-default-encryption-key-v1", "fair-choice-salt", 32);

function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decrypt(ciphertext: string): string {
  const [ivHex, tagHex, dataHex] = ciphertext.split(":");
  if (!ivHex || !tagHex || !dataHex) throw new Error("Invalid ciphertext format");
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const data = Buffer.from(dataHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString("utf8");
}

/* ------------------------------------------------------------------ */
/* API                                                                */
/* ------------------------------------------------------------------ */

const SETTING_KEY = "openai_api_key";

/** Returns the active OpenAI API key, checking env var first, then DB. */
export function getOpenAIApiKey(): string | null {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const row = sqlite
    .prepare(`SELECT value FROM app_settings WHERE key = ?`)
    .get(SETTING_KEY) as { value: string } | undefined;
  if (!row) return null;
  try {
    return decrypt(row.value);
  } catch {
    console.warn("[openai-settings] Failed to decrypt stored key — returning null");
    return null;
  }
}

/** Stores the OpenAI API key (encrypted). Pass empty string to clear. */
export function setOpenAIApiKey(key: string): void {
  const trimmed = key.trim();
  const now = Date.now();
  if (!trimmed) {
    sqlite.prepare(`DELETE FROM app_settings WHERE key = ?`).run(SETTING_KEY);
    return;
  }
  const encrypted = encrypt(trimmed);
  sqlite
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(SETTING_KEY, encrypted, now);
}

/** Returns a masked preview of the key, or null if none is set. */
export function getOpenAIApiKeyPreview(): { set: boolean; preview: string | null } {
  const key = getOpenAIApiKey();
  if (!key) return { set: false, preview: null };
  if (key.length <= 8) return { set: true, preview: "sk-…" };
  const head = key.slice(0, 3);
  const tail = key.slice(-4);
  return { set: true, preview: `${head}...${tail}` };
}

/** Whether AI is currently in live (OpenAI) or mock mode. */
export function isLiveAIMode(): boolean {
  return getOpenAIApiKey() !== null;
}
