/**
 * Mail transport.
 *
 * Three transports, all behind the same interface:
 *   SmtpMailer     — real delivery through the owner's mail provider.
 *   ConsoleMailer  — development. Writes the message to disk, sends nothing.
 *   RecordingMailer— tests. Keeps messages in memory.
 *
 * The app boots with ConsoleMailer unless SMTP settings are present, so no
 * accidental email can ever leave a development machine.
 *
 * Any user configures their own email server via environment variables:
 *   REINDEER_SMTP_HOST   — e.g. smtp.gmail.com, smtp.mailgun.org, smtp.resend.com
 *   REINDEER_SMTP_PORT   — 587 (default), 465 (TLS), 2525, etc.
 *   REINDEER_SMTP_SECURE — 'true' for port 465 implicit TLS
 *   REINDEER_SMTP_USER   — username (often the full email address)
 *   REINDEER_SMTP_PASS   — password or app-specific password
 *   REINDEER_SMTP_FROM   — From: address (defaults to SMTP_USER if not set)
 *
 * For backwards compatibility, OLD_SMTP_* vars are still recognized.
 */
import fs from 'node:fs';
import path from 'node:path';

export class Mailer {
  async send() { throw new Error('Mailer.send is not implemented'); }
  async verify() { return { ok: true }; }
  get describe() { return 'unconfigured'; }
  get isReal() { return false; }
}

export class SmtpMailer extends Mailer {
  constructor(config) {
    super();
    this.config = config;
    this._transport = null;
  }

  async transport() {
    if (this._transport) return this._transport;
    const { default: nodemailer } = await import('nodemailer');
    this._transport = nodemailer.createTransport({
      host: this.config.host,
      port: this.config.port ?? 587,
      secure: this.config.secure ?? (this.config.port === 465),
      auth: this.config.user ? { user: this.config.user, pass: this.config.pass } : undefined,
    });
    return this._transport;
  }

  async verify() {
    try {
      await (await this.transport()).verify();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: friendlySmtpError(e) };
    }
  }

  /**
   * Send a message. Accepts both `text` and `body` for the plain-text
   * content — `body` is normalised to `text` so callers that use the
   * older interface (e.g. auth service magic-link emails) still work.
   */
  async send(message) {
    try {
      const text = message.text ?? message.body ?? '';
      const info = await (await this.transport()).sendMail({
        from: this.config.from,
        to: message.to,
        cc: message.cc,
        subject: message.subject,
        text,
        html: message.html,
        attachments: message.attachments,
      });
      return { ok: true, message_id: info.messageId, accepted: info.accepted ?? [] };
    } catch (e) {
      return { ok: false, error: friendlySmtpError(e) };
    }
  }

  get describe() { return `SMTP ${this.config.host}:${this.config.port ?? 587} as ${this.config.from}`; }
  get isReal() { return true; }
}

export class ConsoleMailer extends Mailer {
  constructor(outDir) { super(); this.outDir = outDir; }

  async send(message) {
    fs.mkdirSync(this.outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(this.outDir, `mail-${stamp}`);
    const text = message.text ?? message.body ?? '';
    fs.writeFileSync(`${base}.txt`,
      `To: ${[].concat(message.to).join(', ')}\nSubject: ${message.subject}\n\n${text}\n`);
    if (message.html) fs.writeFileSync(`${base}.html`, message.html);
    for (const a of message.attachments ?? []) {
      fs.writeFileSync(path.join(this.outDir, a.filename), a.content);
    }
    return { ok: true, message_id: `console:${stamp}`, accepted: [].concat(message.to), written_to: base };
  }

  get describe() { return `console mailer, writing to ${this.outDir} (nothing is actually sent)`; }
}

export class RecordingMailer extends Mailer {
  constructor() { super(); this.sent = []; this.failNext = null; }

  async send(message) {
    if (this.failNext) { const e = this.failNext; this.failNext = null; return { ok: false, error: e }; }
    this.sent.push(message);
    return { ok: true, message_id: `test:${this.sent.length}`, accepted: [].concat(message.to) };
  }

  get describe() { return 'recording mailer (tests)'; }
}

/**
 * Create the appropriate mailer from environment variables.
 * Supports both REINDEER_SMTP_* (preferred) and OLD_SMTP_* (backwards compat).
 * Falls back to ConsoleMailer when no SMTP host is configured.
 */
export function mailerFromEnv(env = process.env, fallbackDir = '/tmp/reindeer-mail') {
  // Prefer REINDEER_SMTP_* vars, fall back to OLD_SMTP_* for older installs
  const host = env.REINDEER_SMTP_HOST || env.REINDEER_SMTP_HOST;
  if (host) {
    return new SmtpMailer({
      host,
      port: (env.REINDEER_SMTP_PORT || env.OLD_SMTP_PORT) ? Number(env.REINDEER_SMTP_PORT || env.OLD_SMTP_PORT) : 587,
      secure: (env.REINDEER_SMTP_SECURE || env.OLD_SMTP_SECURE) === 'true',
      user: env.REINDEER_SMTP_USER || env.OLD_SMTP_USER,
      pass: env.REINDEER_SMTP_PASS || env.OLD_SMTP_PASS,
      from: env.REINDEER_SMTP_FROM || env.OLD_SMTP_FROM || env.REINDEER_SMTP_USER || env.OLD_SMTP_USER,
    });
  }
  return new ConsoleMailer(env.REINDEER_MAIL_DIR || env.OLD_MAIL_DIR || fallbackDir);
}

function friendlySmtpError(e) {
  const code = e?.code ?? '';
  if (code === 'EAUTH') return 'The mail server rejected the username or password. If the account uses two-factor sign-in, an app password is usually required.';
  if (code === 'ECONNECTION' || code === 'ESOCKET') return 'The mail server could not be reached. Check the server address and port.';
  if (code === 'EMESSAGE' && /size/i.test(e.message)) return 'The mail server refused the message because it is too large. Send the package as a link instead.';
  if (code === 'ETIMEDOUT') return 'The mail server did not respond in time.';
  return e?.message ?? 'The message could not be sent.';
}


/**
 * Create a mailer from a stored config object (from the database).
 * Falls back to env vars if no config is provided.
 */
export function createMailerFromConfig(config = null, env = process.env, fallbackDir = '/tmp/reindeer-mail') {
  // If we have database config with a host, use it
  if (config && config.host) {
    return new SmtpMailer({
      host: config.host,
      port: config.port || 587,
      secure: Boolean(config.secure),
      user: config.user,
      pass: config.pass,
      from: config.from_addr || config.user,
    });
  }
  // Fall back to env vars
  return mailerFromEnv(env, fallbackDir);
}

/**
 * Get SMTP settings from the database. Returns null if not configured.
 */
export function getSmtpSettingsFromDb(db) {
  try {
    const row = db.prepare('SELECT * FROM email_settings WHERE key = ?').get('default');
    if (!row || !row.host) return null;
    return {
      host: row.host,
      port: row.port,
      secure: Boolean(row.secure),
      user: row.user,
      pass: row.pass,
      from_addr: row.from_addr,
    };
  } catch (e) {
    // Table might not exist yet (migration hasn't run)
    return null;
  }
}

/**
 * Save SMTP settings to the database.
 */
export function saveSmtpSettingsToDb(db, settings) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO email_settings (key, host, port, secure, user, pass, from_addr, updated_at)
    VALUES ('default', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      host = excluded.host,
      port = excluded.port,
      secure = excluded.secure,
      user = excluded.user,
      pass = excluded.pass,
      from_addr = excluded.from_addr,
      updated_at = excluded.updated_at
  `).run(
    settings.host || null,
    settings.port || 587,
    settings.secure ? 1 : 0,
    settings.user || null,
    settings.pass || null,
    settings.from_addr || null,
    now
  );
}
