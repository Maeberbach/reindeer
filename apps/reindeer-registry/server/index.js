import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCOPE_TYPE } from '@reindeer/core-api';
import { openDb, defaultDataDir, SqliteAuditLog, SqliteItemRepository, FsMediaStore, ScopeMediaStore, Registry, PeopleRepo, HeirsRepo, WillsCaretakersRepo, AddendumVersionsRepo, ParticipantsRepo, MagicLinksRepo, SessionsRepo, MemorandumRepo, ReminderPrefsRepo } from '@reindeer/core-data';
import { SitesRegistry } from '@reindeer/core-data';
import { AuthService } from './auth/service.js';
import { attachSession, authRequired } from './auth/middleware.js';
import { createAuthRouter } from './auth/router.js';
import { createScopeSummaryRouter } from './routes/scopeSummary.js';
import { createHouseholdLinkRouter } from './routes/householdLink.js';
import { createMemorandumRouter } from './routes/memorandum.js';
import { createRemindersRouter } from './routes/reminders.js';
import crypto from 'node:crypto';
import { createIntakeRouter, createExecutionRouter, createPeopleRouter, createSitesRouter, reindeerErrorHandler, MockVisionProvider, HttpVisionProvider, AnthropicVisionProvider, OpenAIVisionProvider, SimpleDuplicateDetector } from '@reindeer/intake-feature';
import { createPrintRouter } from '@reindeer/print-feature';
import { writeBundle } from '@reindeer/exchange';
import { TrusteeRepository, DeliveryService, createDeliveryRouter, createLinkRouter, mailerFromEnv, createMailerFromConfig, getSmtpSettingsFromDb, saveSmtpSettingsToDb, TwoOutputsService, createTwoOutputsRouter } from '@reindeer/delivery';
import { requireLicenseForWrite, requireSubscriptionForWrite } from './licenseMiddleware.js';
import { FEATURE_FLAGS as REGISTRY_FLAGS, isHeirVisibilityEnabled, isSubscriptionGateEnabled, isVideoCaptureEnabled } from './featureFlags.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Composition root. This file is the ONLY place the app knows which
// implementations back the shared ports.
// ---------------------------------------------------------------------------
const DATA_DIR = process.env.REINDEER_INVENTORY_DIR || defaultDataDir('ReindeerRegistry');
const SCOPE_ID = process.env.REINDEER_SCOPE_ID || 'inventory-default';
const OWNER_NAME = process.env.REINDEER_OWNER_NAME || '';

const db = openDb(path.join(DATA_DIR, 'inventory.db'), {
  estateId: SCOPE_ID,
  encrypt: REGISTRY_FLAGS.encryption === true,
});
const audit = new SqliteAuditLog(db);
const sites = new SitesRegistry(db, audit);
const itemRepo = new SqliteItemRepository(db, audit);
const mediaStore = new FsMediaStore(db, path.join(DATA_DIR, 'media'));
const scopeMediaStore = new ScopeMediaStore(db, path.join(DATA_DIR, 'media'));
const registry = new Registry(db, audit);
const people = new PeopleRepo(db);

registry.ensureScope({
  scopeId: SCOPE_ID, scopeType: SCOPE_TYPE.INVENTORY,
  name: 'Reindeer Registry', ownerName: OWNER_NAME,
});

// One-line swap from mock AI to the real vision service.
/**
 * Provider selection.
 *
 * A key alone is enough to switch recognition on, because the default endpoint
 * is Anthropic's. REINDEER_VISION_ENDPOINT only needs setting for a proxy or a
 * self-hosted gateway. HttpVisionProvider is kept for the bespoke in-house
 * shape but is not reachable by accident: it requires REINDEER_VISION_PROTOCOL.
 */
function createVisionProvider() {
  const key = process.env.REINDEER_VISION_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!key) return new MockVisionProvider();
  const protocol = process.env.REINDEER_VISION_PROTOCOL || 'anthropic';
  if (protocol === 'custom') {
    return new HttpVisionProvider({
      endpoint: process.env.REINDEER_VISION_ENDPOINT,
      apiKey: key,
      model: process.env.REINDEER_VISION_MODEL || 'default',
    });
  }
  if (protocol === 'anthropic') {
    return new AnthropicVisionProvider({
      endpoint: process.env.REINDEER_VISION_ENDPOINT || undefined,
      apiKey: key,
      model: process.env.REINDEER_VISION_MODEL || undefined,
    });
  }
  // Default: OpenAI
  return new OpenAIVisionProvider({
    apiKey: key,
    model: process.env.REINDEER_VISION_MODEL || 'gpt-4o',
    endpoint: process.env.REINDEER_VISION_ENDPOINT || 'https://api.openai.com/v1/chat/completions',
  });
}

let vision = createVisionProvider();

const duplicates = new SimpleDuplicateDetector(db, itemRepo, audit);

// Email. Checks database for per-user SMTP settings first, then falls back
// to env vars. Users configure their own email service through the app UI.
let mailer = createMailerFromConfig(getSmtpSettingsFromDb(db), process.env, path.join(DATA_DIR, 'outbox'));

function refreshMailer() {
  mailer = createMailerFromConfig(getSmtpSettingsFromDb(db), process.env, path.join(DATA_DIR, 'outbox'));
  // Email status logged by refreshMailer()
}
const trustees = new TrusteeRepository(db, audit);

// Authentication. The scope id is still fixed at the process level, but
// the actor id now comes from the signed-in participant (or the bootstrap
// owner on a freshly installed Registry). Reindeer: FairPlay runs its
// own auth stack and is unaffected.
const participants = new ParticipantsRepo(db, audit);
const magicLinks = new MagicLinksRepo(db);
const sessions = new SessionsRepo(db);
const SESSION_SECRET = process.env.REINDEER_SESSION_SECRET
  || (process.env.NODE_ENV === 'production'
        ? (() => { throw new Error('REINDEER_SESSION_SECRET is required in production.'); })()
        : (console.warn('REINDEER_SESSION_SECRET not set — using an ephemeral secret. Sessions will not survive a restart.'),
           crypto.randomBytes(32).toString('base64url')));

const BASE_URL = process.env.REINDEER_BASE_URL
  || (process.env.RENDER ? `https://${process.env.RENDER_SERVICE_NAME}.onrender.com` : `http://localhost:${process.env.PORT || 3210}`);
const auth = new AuthService({
  participants, magicLinks, sessions,
  mailer: process.env.REINDEER_MAILER_OFF ? null : (msg) => mailer.send(msg),
  linkBaseUrl: BASE_URL,
});

const resolveScope = (req) => ({
  scopeType: SCOPE_TYPE.INVENTORY,
  scopeId: SCOPE_ID,
  actorId: req?.participant?.participant_id || 'owner',
  permissions: { canEdit: true, canDelete: true, canExport: true },
});

// Two-Output Delivery Model (Registry v2). Additive — leaves existing
// single-bundle delivery path unchanged.
const heirs = new HeirsRepo(db, audit);
const willsCaretakers = new WillsCaretakersRepo(db, audit);
const addendumVersions = new AddendumVersionsRepo(db, audit);
const memorandum = new MemorandumRepo(db, audit);
const reminderPrefs = new ReminderPrefsRepo(db);

const delivery = new DeliveryService({
  db, audit, itemRepo, mediaStore, scopeMediaStore, registry, trustees, mailer,
  storageDir: path.join(DATA_DIR, 'packages'),
  ownerName: OWNER_NAME || 'the owner',
  baseUrl: BASE_URL,
});
const twoOutputs = new TwoOutputsService({
  db, audit, itemRepo, mediaStore, scopeMediaStore, registry,
  heirs, willsCaretakers, addendumVersions, trustees,
  storageDir: path.join(DATA_DIR, 'two-outputs'),
  ownerName: OWNER_NAME || 'the owner',
  estateId: SCOPE_ID,
  mailer,
});

const app = express();
app.locals.db = db;
app.use(express.json({ limit: '60mb' }));

// Session attach BEFORE any /api route so downstream handlers can see req.participant.
app.use(attachSession({ auth, sessionSecret: SESSION_SECRET }));

// Auth routes are public — they are the entry point for an unauthenticated visitor.
// mailerConfigured is true when the mailer is a real SMTP transport (not the console fallback).
app.use('/api', createAuthRouter({
  auth, sessionSecret: SESSION_SECRET,
  mailerConfigured: !process.env.REINDEER_MAILER_OFF && mailer.isReal,
}));

// Email settings — get current SMTP config (password masked)
app.get('/api/email-settings', (req, res) => {
  const settings = getSmtpSettingsFromDb(db);
  if (!settings) {
    return res.json({ configured: false });
  }
  res.json({
    configured: true,
    host: settings.host,
    port: settings.port,
    secure: Boolean(settings.secure),
    user: settings.user,
    from_addr: settings.from_addr,
    has_password: Boolean(settings.pass),
    // Never return the actual password
  });
});

// Email settings — save SMTP config
app.put('/api/email-settings', (req, res) => {
  const { host, port, secure, user, pass, from_addr } = req.body || {};
  if (!host) return res.status(400).json({ error: 'SMTP host is required' });
  saveSmtpSettingsToDb(db, { host, port, secure, user, pass, from_addr });
  refreshMailer();
  res.json({ ok: true, message: 'Email settings saved' });
});

// Email settings — clear (SMTP no longer needed; emails go through the owner's email app)
app.delete('/api/email-settings', (req, res) => {
  saveSmtpSettingsToDb(db, { host: '', port: 587, secure: false, user: '', pass: '', from_addr: '' });
  refreshMailer();
  res.json({ ok: true, message: 'Email settings cleared' });
});

// Email settings — verify connection
app.post('/api/email-settings/verify', async (req, res) => {
  // Use current settings or test with provided ones
  const testConfig = req.body?.host ? req.body : getSmtpSettingsFromDb(db);
  if (!testConfig || !testConfig.host) {
    return res.json({ ok: false, error: 'No email settings configured' });
  }
  const testMailer = createMailerFromConfig(testConfig, {}, '/tmp/reindeer-test');
  const result = await testMailer.verify();
  res.json(result);
});

// Mailer status endpoint — lets the UI and operator check email configuration.
// Public so it works before auth (useful for setup wizards).
app.get('/api/mailer-status', async (req, res) => {
  if (process.env.REINDEER_MAILER_OFF) {
    return res.json({ configured: false, real: false, describe: 'Email disabled (REINDEER_MAILER_OFF)' });
  }
  const status = {
    configured: mailer.isReal,
    real: mailer.isReal,
    describe: mailer.describe,
  };
  // If SMTP is configured, also verify the connection
  if (mailer.isReal) {
    const verify = await mailer.verify();
    status.verified = verify.ok;
    if (!verify.ok) status.error = verify.error;
  }
  res.json(status);
});

// Health check stays public so uptime probes work without a cookie.
app.get('/api/health', (req, res) => res.json({
  ok: true, app: 'reindeer-registry', scope: SCOPE_ID, data_dir: DATA_DIR,
  mailer: mailer.describe, base_url: BASE_URL,
  vision: vision.constructor.name === 'MockVisionProvider' ? 'mock (no API key set)' : `live — ${vision.constructor.name}`,
  videoCapture: isVideoCaptureEnabled(),
  media: mediaStore.tally(resolveScope(req) || { scopeType: SCOPE_TYPE.INVENTORY, scopeId: SCOPE_ID, actorId: 'health' }),
}));

// Stripe webhook stub (public endpoint — no auth required)
// Must be before authRequired so Stripe server-to-server calls aren't blocked.
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  // When Stripe is configured, this handles:
  //   invoice.paid -> set status=active, extend subscription_expires_at
  //   customer.subscription.updated -> update subscription status
  //   customer.subscription.deleted -> set status=expired
  console.log('[Stripe webhook] Received event:', req.headers['stripe-signature'] || 'no signature');
  res.status(200).json({ received: true });
});

// Every other /api route requires a real session (or the bootstrap-owner shortcut).
app.use('/api', authRequired);

// License enforcement gate — no-op while FEATURE_FLAGS.licenseKeys is false.
// Mounted after authRequired so the session is resolved before we check license.
app.use(requireLicenseForWrite);
app.use(requireSubscriptionForWrite);

app.use('/api', createScopeSummaryRouter({ registry, participants, resolveScope }));
app.use('/api', createHouseholdLinkRouter({ registry, participants, auth, resolveScope }));
app.use('/api', createMemorandumRouter({ memorandum, registry, participants, resolveScope }));
app.use('/api', createRemindersRouter({ reminderPrefs, resolveScope }));
app.use('/api', createIntakeRouter({ itemRepo, mediaStore, scopeMediaStore, registry, vision, duplicates, audit, resolveScope }));
app.use('/api', createExecutionRouter({ db, scopeMediaStore, audit, resolveScope }));
app.use('/api', createPeopleRouter({ people, audit, resolveScope }));
app.use('/api', createSitesRouter({ sites, registry, resolveScope, db, audit }));
app.use('/api', createPrintRouter({ itemRepo, resolveScope, ownerName: OWNER_NAME }));
app.use('/api', createDeliveryRouter({ delivery, trustees, resolveScope }));
app.use('/api/two-outputs', createTwoOutputsRouter({ heirs, willsCaretakers, twoOutputs, addendumVersions, resolveScope }));
app.use('/', createLinkRouter({ delivery }));

// --- Export to Reindeer: FairPlay -----------------------------------------
app.get('/api/export/bundle', async (req, res, next) => {
  try {
    const ctx = resolveScope(req);
    // addendumVersions + people are passed so the exchange envelope can
    // carry frozen memoranda (item_ids only, owner name for grouping,
    // never recipient identity). Living owners are silently excluded.
    const { buffer, fileName, manifest } = await writeBundle({
      itemRepo, mediaStore, scopeMediaStore, registry, ctx,
      addendumVersions, people,
      query: { review_state: req.query.review_state || 'kept' },
      source: { app: 'reindeer-registry', app_version: '0.1.0', inventory_id: SCOPE_ID, owner_name: OWNER_NAME },
    });
    res.setHeader('content-type', 'application/zip');
    res.setHeader('content-disposition', `attachment; filename="${fileName}"`);
    res.setHeader('x-reindeer-batch', manifest.batch_id);
    res.send(buffer);
  } catch (e) { next(e); }
});

app.get('/api/export/csv', async (req, res, next) => {
  try {
    const ctx = resolveScope(req);
    const { envelope } = await writeBundle({
      itemRepo, mediaStore, registry, ctx,
      addendumVersions, people,
      query: { review_state: req.query.review_state || 'kept' },
      source: { app: 'reindeer-registry', app_version: '0.1.0', inventory_id: SCOPE_ID },
    });
    const { toCsv } = await import('@reindeer/exchange');
    res.setHeader('content-type', 'text/csv');
    res.setHeader('content-disposition', 'attachment; filename="reindeer-registry.csv"');
    res.send(toCsv(envelope));
  } catch (e) { next(e); }
});

// --- Trustee action: mark owner deceased & freeze their memorandum --------
//
// Registry is a preparation tool; it cannot know a death without being
// told. The trustee (or, in couple mode, the surviving co-owner acting as
// trustee) uses this endpoint to freeze the latest signed memorandum for
// a specific owner. After freezing:
//   • further electronic signings for that owner are rejected;
//   • the frozen row travels in every subsequent export bundle;
//   • the paper the trustee holds remains the operative record.
app.post('/api/two-outputs/freeze', express.json(), async (req, res, next) => {
  try {
    // The actor identity comes from resolveScope() (server-managed session),
    // NEVER from req.body — that was the impersonation hole and must not
    // return. ownerParticipantId below is a TARGET id (whose memorandum to
    // freeze), not an identity claim. frozenByParticipantId is metadata
    // recorded in the audit trail and does not grant any permission.
    const ctx = resolveScope(req);
    const { ownerParticipantId, frozenByParticipantId = null, frozenNote = '' } = req.body || {};
    if (!ownerParticipantId) {
      return res.status(400).json({ error: 'ownerParticipantId is required.' });
    }
    const row = addendumVersions.freezeLatest(
      { ownerParticipantId, frozenByParticipantId, frozenNote },
      ctx,
    );
    if (!row) {
      return res.status(404).json({
        error: 'This owner has no signed memorandum to freeze. A memorandum must be signed before it can be frozen.',
      });
    }
    res.json({
      ok: true,
      version_id: row.version_id,
      version_number: row.version_number,
      frozen_at: row.frozen_at,
      already_frozen: !!(row.frozen_at && row.frozen_by_participant_id !== frozenByParticipantId && frozenByParticipantId != null),
    });
  } catch (e) { next(e); }
});

// --- Subscription endpoints ----------------------------------------------

app.get('/api/subscription/status', (req, res) => {
  const scopeId = req.session?.scopeId || process.env.REINDEER_SCOPE_ID || "inventory-default";
  try {
    const sub = db.prepare("SELECT status, subscription_expires_at, license_key FROM estate_subscriptions WHERE scope_id = ?").get(scopeId);
    if (!sub) {
      return res.json({ status: "active", expires_at: null, plan: "trial" });
    }
    res.json({ status: sub.status, expires_at: sub.subscription_expires_at, plan: sub.license_key ? "license" : "subscription" });
  } catch (e) {
    res.json({ status: "active", expires_at: null, plan: "trial" });
  }
});

// List all license keys for this estate (owner only)
app.get('/api/admin/licenses', (req, res) => {
  if (!req.session || (req.session.role !== "owner" && req.session.role !== "bootstrap-owner")) {
    return res.status(403).json({ error: "Owner access required" });
  }
  const scopeId = req.session?.scopeId || process.env.REINDEER_SCOPE_ID || "inventory-default";
  try {
    const rows = db.prepare(
      "SELECT license_key, license_expires_at, trustee_account_id, license_pool_slots, status, created_at, updated_at FROM estate_subscriptions WHERE scope_id = ? ORDER BY created_at DESC"
    ).all(scopeId);
    res.json({ licenses: rows, scope_id: scopeId });
  } catch (e) {
    res.json({ licenses: [] });
  }
});

// Generate the attorney/trustee letter as printable HTML
app.get('/api/admin/license-letter', (req, res) => {
  if (!req.session || (req.session.role !== "owner" && req.session.role !== "bootstrap-owner")) {
    return res.status(403).json({ error: "Owner access required" });
  }
  const scopeId = req.session?.scopeId || process.env.REINDEER_SCOPE_ID || "inventory-default";
  const ownerName = req.session?.ownerName || process.env.REINDEER_OWNER_NAME || 'The Estate Owner';
  try {
    const sub = db.prepare(
      "SELECT license_key, license_expires_at, trustee_account_id, license_pool_slots FROM estate_subscriptions WHERE scope_id = ? ORDER BY created_at DESC LIMIT 1"
    ).get(scopeId);
    if (!sub) return res.status(404).json({ error: "No license key found. Generate one first." });

    const expires = new Date(sub.license_expires_at).toLocaleDateString('en-US', { dateStyle: 'long' });
    const today = new Date().toLocaleDateString('en-US', { dateStyle: 'long' });
    const slots = sub.license_pool_slots || 0;

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
      <title>Estate License Letter — ${ownerName}</title>
      <style>
        @page { margin: 1in; }
        body { font-family: Georgia, 'Times New Roman', serif; font-size: 11pt; line-height: 1.5; color: #1a1a1a; max-width: 6.5in; margin: 0 auto; }
        .privilege-bar { border: 2px solid #2d4a2e; padding: 8px 16px; text-align: center; margin-bottom: 24px; font-size: 9pt; letter-spacing: 1px; }
        .privilege-bar .line1 { font-weight: bold; color: #2d4a2e; }
        .privilege-bar .line2 { font-size: 8pt; color: #555; margin-top: 2px; }
        .date { margin-bottom: 24px; }
        h1 { font-size: 13pt; margin: 0 0 8px; }
        h2 { font-size: 11pt; margin: 24px 0 8px; color: #2d4a2e; }
        .key-box { border: 1.5px solid #2d4a2e; padding: 16px; margin: 16px 0; background: #f7faf7; }
        .key-box .label { font-size: 9pt; color: #666; text-transform: uppercase; letter-spacing: 1px; }
        .key-box .key { font-family: 'Courier New', monospace; font-size: 14pt; font-weight: bold; color: #1a1a1a; margin-top: 4px; word-break: break-all; }
        .key-meta { display: flex; gap: 32px; margin-top: 8px; font-size: 9pt; color: #666; }
        .instructions { margin: 16px 0; }
        .instructions ol { padding-left: 20px; }
        .instructions li { margin-bottom: 8px; }
        .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #ccc; font-size: 8pt; color: #888; }
        .not-probate { margin: 16px 0; padding: 8px 12px; background: #fff8f0; border-left: 3px solid #b8860b; font-size: 9pt; }
        @media print { .no-print { display: none; } body { max-width: none; } }
      </style></head><body>

      <div class="privilege-bar">
        <div class="line1">ATTORNEY-CLIENT PRIVILEGED · WORK PRODUCT</div>
        <div class="line2">PRIVILEGED AND CONFIDENTIAL — NOT FOR PROBATE FILING — NOT FOR PUBLIC RECORD</div>
      </div>

      <div class="date">${today}</div>

      <h1>Reindeer Estate License Key</h1>
      <p>This letter accompanies the personal property memorandum prepared for <b>${ownerName}</b>. It contains the license key required to access the estate's digital records in Reindeer: FairPlay.</p>

      <div class="not-probate">
        <b>Important:</b> This document is protected by attorney-client privilege and is attorney work product. It is NOT part of the probate estate inventory and must NOT be filed with any court. Keep this letter with the estate planning documents and deliver it privately to the trustee or personal representative.
      </div>

      <h2>License Key</h2>
      <div class="key-box">
        <div class="label">Estate License Key</div>
        <div class="key">${sub.license_key}</div>
        <div class="key-meta">
          <span>Valid through: <b>${expires}</b></span>
          ${slots > 0 ? `<span>Pool slots: <b>${slots}</b></span>` : ''}
        </div>
      </div>

      <h2>Instructions for the Trustee or Personal Representative</h2>
      <div class="instructions">
        <ol>
          <li>You will receive a <b>.reindeer file</b> containing the estate inventory. This file may come from the attorney holding the will, or directly from the estate owner's stored copies.</li>
          <li>Go to <b>Reindeer: FairPlay</b> at the web address provided with the estate documents.</li>
          <li>Use the <b>Import from Registry</b> option and select the .reindeer file.</li>
          <li>When prompted, enter the license key shown above. This activates the estate for full read and write access.</li>
          <li>Once imported, you can review the full inventory, see the owner's wishes about who should receive each item, and begin the distribution process.</li>
          <li>If the license has expired, you can renew it by purchasing a trustee extension. Contact the estate's attorney or visit the Reindeer website.</li>
        </ol>
      </div>

      <h2>Safe Keeping</h2>
      <p>Keep this letter with the original will and estate planning documents. Do not file it with the court. The license key and the .reindeer file should be stored together but delivered privately to the trustee — not through any public probate process.</p>

      <div class="footer">
        Generated by Reindeer: Registry on ${today}. This document is privileged and confidential. It is attorney work product and is not discoverable in probate proceedings. Do not include this letter in any public filing.
      </div>

      <div class="no-print" style="margin-top:24px;text-align:center">
        <button onclick="window.print()" style="padding:8px 24px;font-size:11pt;cursor:pointer;background:#2d4a2e;color:white;border:none;border-radius:4px">Print this letter</button>
      </div>
      </body></html>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (e) {
    res.status(500).json({ error: "Failed to generate letter", detail: e.message });
  }
});

// License key generation (owner/admin only)
app.post('/api/admin/generate-license', (req, res) => {
  // Check owner auth
  if (!req.session || (req.session.role !== "owner" && req.session.role !== "bootstrap-owner")) {
    return res.status(403).json({ error: "Owner access required" });
  }
  const { duration_days = 90, trustee_account_id = null, license_pool_slots = 0 } = req.body || {};

  const licenseKey = crypto.randomUUID();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + duration_days * 86400000).toISOString();
  const scopeId = req.session?.scopeId || process.env.REINDEER_SCOPE_ID || "inventory-default";
  try {
    db.prepare(`
      INSERT INTO estate_subscriptions (scope_id, status, license_key, license_expires_at, trustee_account_id, license_pool_slots, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_id) DO UPDATE SET license_key = ?, license_expires_at = ?, trustee_account_id = ?, license_pool_slots = ?, updated_at = ?
    `).run(scopeId, "active", licenseKey, expiresAt, trustee_account_id, license_pool_slots, now, now, licenseKey, expiresAt, trustee_account_id, license_pool_slots, now);
    db.prepare("INSERT INTO estate_access_log (scope_id, event, details, created_at) VALUES (?, ?, ?, ?)").run(
      scopeId, "license_activated", JSON.stringify({ duration_days, trustee_account_id }), now
    );
    res.json({ license_key: licenseKey, expires_at: expiresAt, slots: license_pool_slots });
  } catch (e) {
    res.status(500).json({ error: "Failed to generate license key", detail: e.message });
  }
});

// ─── Admin: Feature flag status & runtime toggle ──────────────
//
// These endpoints let a Reindeer Corp admin inspect and flip feature
// flags at runtime before client distribution. The flags persist in
// the database (estate_settings table) so they survive restarts.
//
// Only the owner can toggle flags — this is a Reindeer Corp admin
// function, not a client feature.

// Create the estate_settings table if it doesn't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS estate_settings (
    scope_id  TEXT NOT NULL,
    key       TEXT NOT NULL,
    value     TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (scope_id, key)
  );
`);

// GET /api/admin/feature-flags — current flag state
app.get('/api/admin/feature-flags', (req, res) => {
  if (!req.session || (req.session.role !== "owner" && req.session.role !== "bootstrap-owner")) {
    return res.status(403).json({ error: "Owner access required" });
  }
  const scopeId = req.session?.scopeId || process.env.REINDEER_SCOPE_ID || "inventory-default";

  // Read any overrides from the DB
  const overrides = db.prepare('SELECT key, value FROM estate_settings WHERE scope_id = ?').all(scopeId);
  const overrideMap = {};
  for (const row of overrides) overrideMap[row.key] = row.value;

  res.json({
    flags: {
      heirVisibility: overrideMap.heirVisibility !== undefined
        ? overrideMap.heirVisibility === 'true'
        : REGISTRY_FLAGS.heirVisibility,
      subscriptionGate: overrideMap.subscriptionGate !== undefined
        ? overrideMap.subscriptionGate === 'true'
        : REGISTRY_FLAGS.subscriptionGate,
      multiEstate: overrideMap.multiEstate !== undefined
        ? overrideMap.multiEstate === 'true'
        : REGISTRY_FLAGS.multiEstate,
      passwordLogin: overrideMap.passwordLogin !== undefined
        ? overrideMap.passwordLogin === 'true'
        : REGISTRY_FLAGS.passwordLogin,
      licenseKeys: overrideMap.licenseKeys !== undefined
        ? overrideMap.licenseKeys === 'true'
        : REGISTRY_FLAGS.licenseKeys,
      encryption: overrideMap.encryption !== undefined
        ? overrideMap.encryption === 'true'
        : REGISTRY_FLAGS.encryption,
      videoCapture: overrideMap.videoCapture !== undefined
        ? overrideMap.videoCapture === 'true'
        : REGISTRY_FLAGS.videoCapture,
    },
    effective: {
      heirVisibility: isHeirVisibilityEnabled(),
      subscriptionGate: isSubscriptionGateEnabled(),
      videoCapture: isVideoCaptureEnabled(),
    },
  });
});

// POST /api/admin/feature-flags — toggle a flag at runtime
app.post('/api/admin/feature-flags', (req, res) => {
  if (!req.session || (req.session.role !== "owner" && req.session.role !== "bootstrap-owner")) {
    return res.status(403).json({ error: "Owner access required" });
  }
  const scopeId = req.session?.scopeId || process.env.REINDEER_SCOPE_ID || "inventory-default";
  const { flag, value } = req.body || {};

  const allowedFlags = ['heirVisibility', 'subscriptionGate', 'multiEstate', 'passwordLogin', 'licenseKeys', 'encryption', 'videoCapture'];
  if (!allowedFlags.includes(flag)) {
    return res.status(400).json({ error: `Unknown flag: ${flag}. Allowed: ${allowedFlags.join(', ')}` });
  }
  if (typeof value !== 'boolean') {
    return res.status(400).json({ error: 'value must be a boolean' });
  }

  const now = new Date().toISOString();
  db.prepare('INSERT INTO estate_settings (scope_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(scope_id, key) DO UPDATE SET value = ?, updated_at = ?')
    .run(scopeId, flag, String(value), now, String(value), now);

  // Update the in-memory flag so the change takes effect immediately
  REGISTRY_FLAGS[flag] = value;

  // Audit log
  db.prepare("INSERT INTO estate_access_log (scope_id, event, details, created_at) VALUES (?, ?, ?, ?)").run(
    scopeId, 'feature_flag_toggled', JSON.stringify({ flag, value }), now
  );

  res.json({ ok: true, flag, value, message: `${flag} is now ${value ? 'ON' : 'OFF'}` });
});

app.use(express.static(path.join(__dirname, '..', 'client')));
app.use(reindeerErrorHandler);

const PORT = process.env.PORT || 3210;
app.listen(PORT, () => {
  console.log(`Reindeer Registry running on http://localhost:${PORT}`);
  console.log(`Data: ${DATA_DIR}`);
  console.log(`Vision: ${vision.constructor.name === 'MockVisionProvider' ? 'mock provider (no REINDEER_VISION_KEY or OPENAI_API_KEY set)' : `live — ${vision.constructor.name}`}`);
  // Email status logged by refreshMailer()
});

export { app, db, itemRepo, mediaStore, scopeMediaStore, registry, audit, duplicates, trustees, delivery, resolveScope };
