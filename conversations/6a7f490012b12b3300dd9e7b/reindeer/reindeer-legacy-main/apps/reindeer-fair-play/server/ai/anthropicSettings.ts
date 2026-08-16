/**
 * Server-side storage for the Anthropic API key.
 *
 * Mirrors openaiSettings.ts — same encrypted-at-rest pattern in the
 * same app_settings table, just a different setting key. On startup,
 * process.env.ANTHROPIC_API_KEY (or REINDEER_VISION_KEY with protocol
 * "anthropic") takes priority over the stored DB key.
 *
 * The key is never returned in full by any API endpoint — only a
 * masked preview and whether one is set.
 */

import { sqlite } from "../storage";
import crypto from "node:crypto";

/* ------------------------------------------------------------------ */
/* Encryption (same scheme as openaiSettings)                          */
/* ------------------------------------------------------------------ */

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
/* API                                                                 */
/* ------------------------------------------------------------------ */

const SETTING_KEY = "anthropic_api_key";

/**
 * Returns the active Anthropic API key.
 * Checks env vars first (ANTHROPIC_API_KEY, or REINDEER_VISION_KEY when
 * REINDEER_VISION_PROTOCOL is "anthropic"), then falls back to DB.
 */
export function getAnthropicApiKey(): string | null {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  if (process.env.REINDEER_VISION_KEY && process.env.REINDEER_VISION_PROTOCOL === "anthropic") {
    return process.env.REINDEER_VISION_KEY;
  }
  const row = sqlite
    .prepare(`SELECT value FROM app_settings WHERE key = ?`)
    .get(SETTING_KEY) as { value: string } | undefined;
  if (!row) return null;
  try {
    return decrypt(row.value);
  } catch {
    console.warn("[anthropic-settings] Failed to decrypt stored key — returning null");
    return null;
  }
}

/** Stores the Anthropic API key (encrypted). Pass empty string to clear. */
export function setAnthropicApiKey(key: string): void {
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
export function getAnthropicApiKeyPreview(): { set: boolean; preview: string | null } {
  const key = getAnthropicApiKey();
  if (!key) return { set: false, preview: null };
  if (key.length <= 8) return { set: true, preview: "sk-…" };
  const head = key.slice(0, 3);
  const tail = key.slice(-4);
  return { set: true, preview: `${head}...${tail}` };
}
