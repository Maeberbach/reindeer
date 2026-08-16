import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCOPE_TYPE } from '@reindeer-legacy/core-api';
import { openDb, defaultDataDir, SqliteAuditLog, SqliteItemRepository, FsMediaStore, ScopeMediaStore, Registry, PeopleRepo, HeirsRepo, WillsCaretakersRepo, AddendumVersionsRepo, ParticipantsRepo, MagicLinksRepo, SessionsRepo, MemorandumRepo, ReminderPrefsRepo } from '@reindeer-legacy/core-data';
import { AuthService } from './auth/service.js';
import { attachSession, authRequired } from './auth/middleware.js';
import { createAuthRouter } from './auth/router.js';
import { createScopeSummaryRouter } from './routes/scopeSummary.js';
import { createHouseholdLinkRouter } from './routes/householdLink.js';
import { createMemorandumRouter } from './routes/memorandum.js';
import { createRemindersRouter } from './routes/reminders.js';
import crypto from 'node:crypto';
import { createIntakeRouter, createExecutionRouter, createPeopleRouter, legacyErrorHandler, MockVisionProvider, HttpVisionProvider, AnthropicVisionProvider, OpenAIVisionProvider, SimpleDuplicateDetector } from '@reindeer-legacy/intake-feature';
import { createPrintRouter } from '@reindeer-legacy/print-feature';
import { writeBundle } from '@reindeer-legacy/exchange';
import { TrusteeRepository, DeliveryService, createDeliveryRouter, createLinkRouter, mailerFromEnv, TwoOutputsService, createTwoOutputsRouter } from '@reindeer-legacy/delivery';
import { requireLicenseForWrite } from './licenseMiddleware.js';
import { FEATURE_FLAGS as REGISTRY_FLAGS } from './featureFlags.js';

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
  const key = process.env.REINDEER_VISION_KEY || process.env.OPENAI_API_KEY;
  if (!key) return new MockVisionProvider();
  const protocol = process.env.REINDEER_VISION_PROTOCOL || 'openai';
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

// Email. Falls back to a console mailer that writes messages to disk, so a
// development machine can never send real mail to a real trustee by accident.
// Any user configures their own email server via REINDEER_SMTP_* env vars.
const mailer = mailerFromEnv(process.env, path.join(DATA_DIR, 'outbox'));
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

// Two-Output Delivery Model (Registry v2). Additive — leaves the legacy
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
app.use(express.json({ limit: '60mb' }));

// Session attach BEFORE any /api route so downstream handlers can see req.participant.
app.use(attachSession({ auth, sessionSecret: SESSION_SECRET }));

// Auth routes are public — they are the entry point for an unauthenticated visitor.
// mailerConfigured is true when the mailer is a real SMTP transport (not the console fallback).
app.use('/api', createAuthRouter({
  auth, sessionSecret: SESSION_SECRET,
  mailerConfigured: !process.env.REINDEER_MAILER_OFF && mailer.isReal,
}));

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
  media: mediaStore.tally(resolveScope(req) || { scopeType: SCOPE_TYPE.INVENTORY, scopeId: SCOPE_ID, actorId: 'health' }),
}));

// Every other /api route requires a real session (or the bootstrap-owner shortcut).
app.use('/api', authRequired);

// License enforcement gate — no-op while FEATURE_FLAGS.licenseKeys is false.
// Mounted after authRequired so the session is resolved before we check license.
app.use(requireLicenseForWrite);

app.use('/api', createScopeSummaryRouter({ registry, participants, resolveScope }));
app.use('/api', createHouseholdLinkRouter({ registry, participants, auth, resolveScope }));
app.use('/api', createMemorandumRouter({ memorandum, registry, participants, resolveScope }));
app.use('/api', createRemindersRouter({ reminderPrefs, resolveScope }));
app.use('/api', createIntakeRouter({ itemRepo, mediaStore, scopeMediaStore, registry, vision, duplicates, audit, resolveScope }));
app.use('/api', createExecutionRouter({ db, scopeMediaStore, audit, resolveScope }));
app.use('/api', createPeopleRouter({ people, audit, resolveScope }));
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
    res.setHeader('x-legacy-batch', manifest.batch_id);
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
    const { toCsv } = await import('@reindeer-legacy/exchange');
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

app.use(express.static(path.join(__dirname, '..', 'client')));
app.use(legacyErrorHandler);

const PORT = process.env.PORT || 3210;
app.listen(PORT, () => {
  console.log(`Reindeer Registry running on http://localhost:${PORT}`);
  console.log(`Data: ${DATA_DIR}`);
  console.log(`Vision: ${vision.constructor.name === 'MockVisionProvider' ? 'mock provider (no REINDEER_VISION_KEY or OPENAI_API_KEY set)' : `live — ${vision.constructor.name}`}`);
  console.log(`Email: ${mailer.describe}`);
});

export { app, db, itemRepo, mediaStore, scopeMediaStore, registry, audit, duplicates, trustees, delivery, resolveScope };
