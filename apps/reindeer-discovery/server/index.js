import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { openDb, defaultDataDir, SqliteItemRepository, FsMediaStore, ScopeMediaStore, Registry } from '@reindeer/core-data';
import { SCOPE_TYPE } from '@reindeer/core-api';
import { isSubscriptionGateEnabled, isHeirVisibilityEnabled } from './featureFlags.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Same DB as Registry — Discovery reads the inventory and adds heir tables.
const DATA_DIR = process.env.REINDEER_INVENTORY_DIR || defaultDataDir('ReindeerRegistry');
const SCOPE_ID = process.env.REINDEER_SCOPE_ID || 'inventory-default';

const db = openDb(path.join(DATA_DIR, 'inventory.db'), {
  estateId: SCOPE_ID,
  encrypt: false,
});

// Discovery-specific tables (additive — never touch existing tables)
db.exec(`
  CREATE TABLE IF NOT EXISTS discovery_heirs (
    heir_id      TEXT PRIMARY KEY,
    scope_id     TEXT NOT NULL,
    name         TEXT NOT NULL,
    email        TEXT NOT NULL DEFAULT '',
    relationship TEXT NOT NULL DEFAULT '',
    invite_token  TEXT NOT NULL DEFAULT '',
    session_token TEXT,
    review_state TEXT NOT NULL DEFAULT 'exploring',
    locked_at    TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_discovery_heirs_scope ON discovery_heirs(scope_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_discovery_heirs_invite ON discovery_heirs(invite_token) WHERE invite_token != '';
  CREATE UNIQUE INDEX IF NOT EXISTS idx_discovery_heirs_session ON discovery_heirs(session_token) WHERE session_token IS NOT NULL;

  CREATE TABLE IF NOT EXISTS discovery_interests (
    interest_id  TEXT PRIMARY KEY,
    heir_id      TEXT NOT NULL REFERENCES discovery_heirs(heir_id) ON DELETE CASCADE,
    item_id      TEXT NOT NULL,
    scope_id     TEXT NOT NULL,
    reaction     TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_discovery_interests_heir ON discovery_interests(heir_id);
  CREATE INDEX IF NOT EXISTS idx_discovery_interests_item ON discovery_interests(item_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_discovery_interests_pair ON discovery_interests(heir_id, item_id);

  CREATE TABLE IF NOT EXISTS discovery_rankings (
    heir_id      TEXT NOT NULL REFERENCES discovery_heirs(heir_id) ON DELETE CASCADE,
    item_id      TEXT NOT NULL,
    rank_position INTEGER NOT NULL,
    updated_at   TEXT NOT NULL,
    PRIMARY KEY (heir_id, item_id)
  );
  CREATE INDEX IF NOT EXISTS idx_discovery_rankings_heir ON discovery_rankings(heir_id);

  CREATE TABLE IF NOT EXISTS discovery_looking_for (
    request_id   TEXT PRIMARY KEY,
    heir_id      TEXT NOT NULL REFERENCES discovery_heirs(heir_id) ON DELETE CASCADE,
    scope_id     TEXT NOT NULL,
    description  TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'open',
    matched_item_id TEXT,
    created_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_discovery_looking_for_scope ON discovery_looking_for(scope_id, status);

  CREATE TABLE IF NOT EXISTS estate_subscriptions (
    scope_id               TEXT PRIMARY KEY,
    status                 TEXT NOT NULL DEFAULT 'active',
    subscription_expires_at TEXT,
    stripe_customer_id     TEXT,
    stripe_subscription_id TEXT,
    license_key            TEXT,
    license_expires_at     TEXT,
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL
  );
`);

const itemRepo = new SqliteItemRepository(db, null);
const mediaStore = new FsMediaStore(db, path.join(DATA_DIR, 'media'));
const scopeMediaStore = new ScopeMediaStore(db, path.join(DATA_DIR, 'media'));
const registry = new Registry(db, null);

registry.ensureScope({
  scopeId: SCOPE_ID, scopeType: SCOPE_TYPE.INVENTORY,
  name: 'Reindeer Registry', ownerName: '',
});

const SESSION_SECRET = process.env.REINDEER_DISCOVERY_SESSION_SECRET
  || (process.env.NODE_ENV === 'production'
    ? (() => { throw new Error('REINDEER_DISCOVERY_SESSION_SECRET is required in production.'); })()
    : crypto.randomBytes(32).toString('base64url'));

// Owner passcode — set via env var, defaults to a dev code
const OWNER_CODE = process.env.REINDEER_DISCOVERY_OWNER_CODE || 'reindeer';

// ─── Owner session tokens (in-memory) ─────────────────────────
const ownerSessions = new Map();

function createOwnerSession() {
  const token = crypto.randomBytes(32).toString('base64url');
  ownerSessions.set(token, { created: new Date() });
  return token;
}

function isOwnerSession(token) {
  if (!token) return false;
  const session = ownerSessions.get(token);
  if (!session) return false;
  if (Date.now() - session.created.getTime() > 24 * 60 * 60 * 1000) {
    ownerSessions.delete(token);
    return false;
  }
  return true;
}

// ─── Middleware ───────────────────────────────────────────────
function heirSession(req, res, next) {
  const token = req.headers['x-heir-token'] || req.cookies?.heir_token;
  if (!token) { req.heir = null; return next(); }
  const heir = db.prepare('SELECT * FROM discovery_heirs WHERE session_token = ?').get(token);
  req.heir = heir || null;
  next();
}

function heirRequired(req, res, next) {
  if (!req.heir) return res.status(401).json({ error: 'Authentication required' });
  next();
}

function ownerAuth(req, res, next) {
  const token = req.headers['x-owner-token'];
  if (!isOwnerSession(token)) return res.status(401).json({ error: 'Owner authentication required' });
  next();
}

/**
 * Strip private fields from an item when heir visibility restrictions are ON.
 * When the flag is OFF (testing mode), the raw item is returned as-is.
 * The owner (via ownerAuth) always sees everything regardless of the flag.
 */
function filterItemForHeir(item) {
  if (!isHeirVisibilityEnabled()) return item;
  // Remove fields heirs must never see
  const {
    value_estimate_cents, value_basis,
    recipient_hint, recipient_name, recipient_relationship, owner_note,
    owner_high_value, owner_high_value_reason,
    ownership_tag, ai_confidence,
    ...heirVisible
  } = item;
  return heirVisible;
}

// ─── Subscription gate middleware ─────────────────────────────
//
// Blocks write requests (POST/PUT/PATCH/DELETE) when the estate's
// subscription is expired or locked. Returns 402 Payment Required.
// No-op when the subscriptionGate feature flag is off, so existing
// functionality is unaffected until the flag is explicitly enabled.
function requireSubscriptionForWrite(req, res, next) {
  if (!isSubscriptionGateEnabled()) return next();

  const method = req.method.toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return next();

  const sub = db.prepare('SELECT status, subscription_expires_at FROM estate_subscriptions WHERE scope_id = ?').get(SCOPE_ID);

  // No subscription record yet — treat as active (grace period).
  if (!sub) return next();

  // Check explicit status values that should block writes.
  if (sub.status === 'expired' || sub.status === 'locked' || sub.status === 'cancelled') {
    return res.status(402).json({ error: 'Estate subscription is not active. Write access is restricted.' });
  }

  // Check expiry timestamp — block if the subscription has lapsed.
  if (sub.subscription_expires_at) {
    const expiresAt = new Date(sub.subscription_expires_at);
    if (!isNaN(expiresAt.getTime()) && expiresAt.getTime() < Date.now()) {
      return res.status(402).json({ error: 'Estate subscription has expired. Write access is restricted.' });
    }
  }

  next();
}

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'client')));

// Health check
app.get('/api/health', (req, res) => res.json({
  ok: true, app: 'reindeer-discovery', scope: SCOPE_ID,
  data_dir: DATA_DIR,
}));

// ─── Sites: list all sites for this estate ─────────────────────
app.get('/api/sites', heirSession, (req, res) => {
  const sites = db.prepare(`SELECT site_id, name, type, address, latitude, longitude
                           FROM sites WHERE scope_id = ? ORDER BY
                           CASE WHEN type = 'primary' THEN 0 ELSE 1 END, name`).all(SCOPE_ID);
  res.json({ sites });
});

// ─── Owner auth ───────────────────────────────────────────────
app.post('/api/owner/login', (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Passcode required' });
  if (code !== OWNER_CODE) return res.status(403).json({ error: 'Invalid passcode' });
  const token = createOwnerSession();
  res.json({ token, ok: true });
});

app.post('/api/owner/logout', (req, res) => {
  const token = req.headers['x-owner-token'];
  if (token) ownerSessions.delete(token);
  res.json({ ok: true });
});

// ─── Heir auth: join via invite link ──────────────────────────
app.post('/api/heirs/join', (req, res) => {
  const { invite_token, name, direct_code } = req.body || {};

  // Direct access mode: owner can join as an heir without invite token
  if (!invite_token && direct_code) {
    if (direct_code !== OWNER_CODE) return res.status(403).json({ error: 'Invalid passcode' });
    const heirName = name || 'Owner';
    // Find or create an heir record for the owner
    let heir = db.prepare("SELECT * FROM discovery_heirs WHERE scope_id = ? AND name = 'Owner'").get(SCOPE_ID);
    if (!heir) {
      const heirId = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare('INSERT INTO discovery_heirs (heir_id, scope_id, name, email, relationship, invite_token, review_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(heirId, SCOPE_ID, heirName, '', 'Owner', crypto.randomBytes(16).toString('base64url'), 'exploring', now, now);
      heir = db.prepare('SELECT * FROM discovery_heirs WHERE heir_id = ?').get(heirId);
    }
    if (heir.review_state === 'locked') return res.status(403).json({ error: 'Review already completed' });
    const sessionToken = crypto.randomBytes(32).toString('base64url');
    db.prepare('UPDATE discovery_heirs SET name = COALESCE(?, name), session_token = ?, updated_at = ? WHERE heir_id = ?')
      .run(name || heirName, sessionToken, new Date().toISOString(), heir.heir_id);
    return res.json({ heir_id: heir.heir_id, session_token: sessionToken, name: heir.name, review_state: heir.review_state });
  }

  if (!invite_token) return res.status(400).json({ error: 'Invite token required' });
  const heir = db.prepare('SELECT * FROM discovery_heirs WHERE invite_token = ?').get(invite_token);
  if (!heir) return res.status(404).json({ error: 'Invalid invite' });
  if (heir.review_state === 'locked') return res.status(403).json({ error: 'Review already completed' });

  const sessionToken = crypto.randomBytes(32).toString('base64url');
  db.prepare('UPDATE discovery_heirs SET name = COALESCE(?, name), session_token = ?, updated_at = ? WHERE heir_id = ?')
    .run(name || heir.name || 'Heir', sessionToken, new Date().toISOString(), heir.heir_id);

  res.json({ heir_id: heir.heir_id, session_token: sessionToken, name: heir.name, review_state: heir.review_state });
});

// ─── Get current heir ─────────────────────────────────────────
app.get('/api/heirs/me', heirSession, (req, res) => {
  if (!req.heir) return res.json({ authenticated: false });
  res.json({
    authenticated: true,
    heir_id: req.heir.heir_id,
    name: req.heir.name,
    relationship: req.heir.relationship,
    review_state: req.heir.review_state,
    locked_at: req.heir.locked_at,
  });
});

// ─── Owner: list heirs (with invite tokens) ──────────────────
app.get('/api/heirs', ownerAuth, (req, res) => {
  const heirs = db.prepare('SELECT heir_id, name, relationship, email, invite_token, review_state, locked_at, created_at FROM discovery_heirs WHERE scope_id = ? ORDER BY created_at').all(SCOPE_ID);
  res.json({ heirs });
});

// ─── Owner: invite an heir ────────────────────────────────────
app.post('/api/heirs/invite', ownerAuth, (req, res) => {
  const { name, email, relationship } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name required' });
  const heirId = crypto.randomUUID();
  const inviteToken = crypto.randomBytes(16).toString('base64url');
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO discovery_heirs (heir_id, scope_id, name, email, relationship, invite_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(heirId, SCOPE_ID, name, email || '', relationship || '', inviteToken, now, now);
  res.json({ heir_id: heirId, invite_token: inviteToken, name });
});

// ─── Owner: remove an heir ────────────────────────────────────
app.delete('/api/heirs/:heirId', ownerAuth, (req, res) => {
  const { heirId } = req.params;
  const heir = db.prepare('SELECT * FROM discovery_heirs WHERE heir_id = ? AND scope_id = ?').get(heirId, SCOPE_ID);
  if (!heir) return res.status(404).json({ error: 'Heir not found' });
  db.prepare('DELETE FROM discovery_heirs WHERE heir_id = ?').run(heirId);
  res.json({ ok: true });
});

// ─── Items: list all (for heir browsing) ──────────────────────
app.get('/api/items', heirSession, (req, res) => {
  const { room, category, search, site_id } = req.query;
  let sql = `SELECT i.item_id, i.title, i.description, i.story, i.room_id, i.category_id,
                    i.review_state, i.owner_important_comment, i.site_id, i.site_name,
                    r.name as room_name, c.name as category_name
               FROM items i
               LEFT JOIN rooms r ON i.room_id = r.room_id
               LEFT JOIN categories c ON i.category_id = c.category_id
              WHERE i.scope_id = ? AND i.review_state = 'kept'`;
  const params = [SCOPE_ID];

  if (room) { sql += ` AND r.name = ?`; params.push(room); }
  if (category) { sql += ` AND c.name = ?`; params.push(category); }
  if (site_id) { sql += ` AND COALESCE(i.site_id, '') = ?`; params.push(site_id); }
  if (search) {
    sql += ` AND (i.title LIKE ? OR i.description LIKE ? OR i.story LIKE ? OR i.owner_important_comment LIKE ?)`;
    const pat = `%${search}%`;
    params.push(pat, pat, pat, pat);
  }

  sql += ` ORDER BY i.created_at DESC`;
  let items = db.prepare(sql).all(...params);

  for (const item of items) {
    const photos = db.prepare('SELECT photo_id, file_name, media_kind FROM item_photos WHERE item_id = ? AND media_kind = ? ORDER BY created_at LIMIT 1').all(item.item_id, 'photo');
    item.photo_url = photos.length > 0 ? `/api/items/${item.item_id}/photo` : null;
  }

  // Apply heir visibility filtering (strips private fields when flag is on)
  items = items.map(filterItemForHeir);

  res.json({ items });
});

// ─── Items: single item detail ────────────────────────────────
app.get('/api/items/:itemId', heirSession, (req, res) => {
  const item = db.prepare(`SELECT i.item_id, i.title, i.description, i.story, i.room_id, i.category_id,
                                 i.review_state, i.owner_important_comment, i.site_id, i.site_name,
                                 r.name as room_name, c.name as category_name
                          FROM items i
                          LEFT JOIN rooms r ON i.room_id = r.room_id
                          LEFT JOIN categories c ON i.category_id = c.category_id
                          WHERE i.item_id = ? AND i.scope_id = ?`).get(req.params.itemId, SCOPE_ID);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  const photos = db.prepare('SELECT photo_id, file_name, media_kind, label FROM item_photos WHERE item_id = ? ORDER BY created_at').all(item.item_id);
  item.photos = photos.map(p => ({ ...p, url: `/api/items/${item.item_id}/photo/${p.photo_id}` }));

  // Apply heir visibility filtering
  const filteredItem = filterItemForHeir(item);

  res.json({ item: filteredItem });
});

// ─── Item photo ────────────────────────────────────────────────
app.get('/api/items/:itemId/photo', (req, res) => {
  const photo = db.prepare('SELECT file_name FROM item_photos WHERE item_id = ? AND media_kind = ? ORDER BY created_at LIMIT 1').get(req.params.itemId, 'photo');
  if (!photo) return res.status(404).send('No photo');
  try {
    const buf = mediaStore.read(photo.file_name);
    res.setHeader('content-type', 'image/jpeg');
    res.send(buf);
  } catch { res.status(404).send('Photo not found'); }
});

app.get('/api/items/:itemId/photo/:photoId', (req, res) => {
  const photo = db.prepare('SELECT file_name FROM item_photos WHERE item_id = ? AND photo_id = ?').get(req.params.itemId, req.params.photoId);
  if (!photo) return res.status(404).send('No photo');
  try {
    const buf = mediaStore.read(photo.file_name);
    res.setHeader('content-type', 'image/jpeg');
    res.send(buf);
  } catch { res.status(404).send('Photo not found'); }
});

// ─── Rooms and categories (for browsing) ─────────────────────
app.get('/api/rooms', heirSession, (req, res) => {
  const rooms = db.prepare(`SELECT r.name, r.room_id, COUNT(i.item_id) as item_count
                           FROM rooms r LEFT JOIN items i ON r.room_id = i.room_id AND i.review_state = 'kept'
                           WHERE r.scope_id = ? GROUP BY r.room_id ORDER BY r.sort_order`).all(SCOPE_ID);
  res.json({ rooms });
});

app.get('/api/categories', heirSession, (req, res) => {
  const cats = db.prepare(`SELECT c.name, c.category_id, COUNT(i.item_id) as item_count
                          FROM categories c LEFT JOIN items i ON c.category_id = i.category_id AND i.review_state = 'kept'
                          WHERE c.scope_id = ? GROUP BY c.category_id ORDER BY c.sort_order`).all(SCOPE_ID);
  res.json({ categories });
});

// ─── Subscription gate (no-op while flag is off) ──────────────
app.use(requireSubscriptionForWrite);

// ─── Heir interest (swipe reactions) ──────────────────────────
app.post('/api/interest', heirSession, heirRequired, (req, res) => {
  const { item_id, reaction } = req.body || {};
  if (!item_id || !['high', 'medium', 'low'].includes(reaction))
    return res.status(400).json({ error: 'item_id and reaction (high|medium|low) required' });
  if (req.heir.review_state === 'locked')
    return res.status(403).json({ error: 'Your review is locked. You cannot change reactions.' });

  const now = new Date().toISOString();
  db.prepare(`INSERT INTO discovery_interests (interest_id, heir_id, item_id, scope_id, reaction, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(heir_id, item_id) DO UPDATE SET reaction = excluded.reaction, updated_at = excluded.updated_at`)
    .run(crypto.randomUUID(), req.heir.heir_id, item_id, SCOPE_ID, reaction, now, now);
  res.json({ ok: true, reaction });
});

// ─── Heir: get all interests ──────────────────────────────────
app.get('/api/interests', heirSession, heirRequired, (req, res) => {
  const interests = db.prepare(`SELECT i.item_id, i.reaction, i.updated_at,
                                       itm.title, itm.description
                                FROM discovery_interests i
                                JOIN items itm ON i.item_id = itm.item_id
                                WHERE i.heir_id = ? AND i.reaction != 'low'
                                ORDER BY i.updated_at DESC`).all(req.heir.heir_id);
  res.json({ interests });
});

// ─── Heir: save ranking (drag-and-drop order) ─────────────────
app.post('/api/rankings', heirSession, heirRequired, (req, res) => {
  const { rankings } = req.body || {};
  if (!Array.isArray(rankings)) return res.status(400).json({ error: 'rankings array required' });
  if (req.heir.review_state === 'locked')
    return res.status(403).json({ error: 'Your review is locked.' });

  const now = new Date().toISOString();
  const insert = db.prepare(`INSERT INTO discovery_rankings (heir_id, item_id, rank_position, updated_at) VALUES (?, ?, ?, ?)
                             ON CONFLICT(heir_id, item_id) DO UPDATE SET rank_position = excluded.rank_position, updated_at = excluded.updated_at`);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM discovery_rankings WHERE heir_id = ?').run(req.heir.heir_id);
    rankings.forEach((item_id, idx) => insert.run(req.heir.heir_id, item_id, idx, now));
  });
  tx();
  res.json({ ok: true, count: rankings.length });
});

app.get('/api/rankings', heirSession, heirRequired, (req, res) => {
  const rankings = db.prepare(`SELECT r.item_id, r.rank_position, itm.title
                              FROM discovery_rankings r JOIN items itm ON r.item_id = itm.item_id
                              WHERE r.heir_id = ? ORDER BY r.rank_position`).all(req.heir.heir_id);
  res.json({ rankings });
});

// ─── Heir: lock choices ───────────────────────────────────────
app.post('/api/lock', heirSession, heirRequired, (req, res) => {
  if (req.heir.review_state === 'locked')
    return res.json({ ok: true, already_locked: true });
  const now = new Date().toISOString();
  db.prepare('UPDATE discovery_heirs SET review_state = ?, locked_at = ?, updated_at = ? WHERE heir_id = ?')
    .run('locked', now, now, req.heir.heir_id);
  res.json({ ok: true, locked_at: now });
});

// ─── Owner: comparison report ────────────────────────────────
app.get('/api/compare', ownerAuth, (req, res) => {
  const heirs = db.prepare('SELECT heir_id, name, review_state, locked_at FROM discovery_heirs WHERE scope_id = ?').all(SCOPE_ID);
  const allLocked = heirs.length > 0 && heirs.every(h => h.review_state === 'locked');

  if (!allLocked) {
    return res.json({
      ready: false,
      heirs: heirs.map(h => ({ name: h.name, locked: h.review_state === 'locked' })),
      message: 'Waiting for all heirs to lock their choices.'
    });
  }

  const items = db.prepare(`SELECT i.item_id, i.title, i.description, i.story, i.owner_important_comment, r.name as room_name
                            FROM items i LEFT JOIN rooms r ON i.room_id = r.room_id
                            WHERE i.scope_id = ? AND i.review_state = 'kept'`).all(SCOPE_ID);

  const competitions = [];
  for (const item of items) {
    const interests = db.prepare(`SELECT i.reaction, h.name, h.heir_id
                                  FROM discovery_interests i JOIN discovery_heirs h ON i.heir_id = h.heir_id
                                  WHERE i.item_id = ? AND i.reaction != 'low'`).all(item.item_id);
    if (interests.length === 0) continue;
    const wants = interests.filter(i => i.reaction === 'high');
    const interested = interests.filter(i => i.reaction === 'medium');
    competitions.push({
      item_id: item.item_id,
      title: item.title,
      room: item.room_name,
      story: item.story,
      heir_count: interests.length,
      want_count: wants.length,
      interested_count: interested.length,
      contested: wants.length >= 2,
      heirs: interests.map(i => ({ name: i.name, reaction: i.reaction })),
    });
  }

  const totalItems = items.length;
  const itemsWithInterest = competitions.length;
  const noCompetition = competitions.filter(c => c.heir_count === 1).length;
  const someCompetition = competitions.filter(c => c.heir_count > 1 && c.want_count < 2).length;
  const highCompetition = competitions.filter(c => c.want_count >= 2).length;

  res.json({
    ready: true,
    summary: {
      total_items: totalItems,
      items_with_interest: itemsWithInterest,
      no_competition: noCompetition,
      some_competition: someCompetition,
      high_competition: highCompetition,
    },
    competitions: competitions.sort((a, b) => b.want_count - a.want_count || b.heir_count - a.heir_count),
  });
});

// ─── Looking For requests ─────────────────────────────────────
app.post('/api/looking-for', heirSession, heirRequired, (req, res) => {
  const { description } = req.body || {};
  if (!description) return res.status(400).json({ error: 'Description required' });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const search = `%${description}%`;
  const match = db.prepare(`SELECT item_id FROM items WHERE scope_id = ? AND review_state = 'kept'
                            AND (title LIKE ? OR description LIKE ? OR story LIKE ?)
                            LIMIT 1`).get(SCOPE_ID, search, search, search);

  const status = match ? 'found' : 'not_in_inventory';
  db.prepare(`INSERT INTO discovery_looking_for (request_id, heir_id, scope_id, description, status, matched_item_id, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, req.heir.heir_id, SCOPE_ID, description, status, match?.item_id || null, now);

  res.json({ request_id: id, status, matched_item_id: match?.item_id || null });
});

app.get('/api/looking-for', ownerAuth, (req, res) => {
  const requests = db.prepare(`SELECT l.*, h.name as heir_name
                               FROM discovery_looking_for l JOIN discovery_heirs h ON l.heir_id = h.heir_id
                               WHERE l.scope_id = ? ORDER BY l.created_at DESC`).all(SCOPE_ID);
  res.json({ requests });
});

// ─── Natural language search ─────────────────────
app.post('/api/search', heirSession, async (req, res) => {
  const { query } = req.body || {};
  if (!query) return res.status(400).json({ error: 'Query required' });

  const pat = `%${query}%`;
  const items = db.prepare(`SELECT i.item_id, i.title, i.description, i.story,
                                   i.owner_important_comment,
                                   r.name as room_name,
                                   c.name as category_name
                            FROM items i
                            LEFT JOIN rooms r ON i.room_id = r.room_id
                            LEFT JOIN categories c ON i.category_id = c.category_id
                            WHERE i.scope_id = ? AND i.review_state = 'kept'
                            AND (i.title LIKE ? OR i.description LIKE ? OR i.story LIKE ?
                                 OR i.owner_important_comment LIKE ? OR r.name LIKE ?
                                 OR c.name LIKE ?)
                            ORDER BY i.created_at DESC`).all(SCOPE_ID, pat, pat, pat, pat, pat, pat);

  for (const item of items) {
    const photo = db.prepare('SELECT file_name FROM item_photos WHERE item_id = ? AND media_kind = ? ORDER BY created_at LIMIT 1').get(item.item_id, 'photo');
    item.photo_url = photo ? `/api/items/${item.item_id}/photo` : null;
  }

  res.json({ items, query });
});

// ─── Stats summary ────────────────────────────────────────────
app.get('/api/stats', heirSession, (req, res) => {
  const itemCount = db.prepare('SELECT COUNT(*) c FROM items WHERE scope_id = ? AND review_state = ?').get(SCOPE_ID, 'kept').c;
  const roomCount = db.prepare('SELECT COUNT(*) c FROM rooms WHERE scope_id = ?').get(SCOPE_ID).c;
  const photoCount = db.prepare('SELECT COUNT(*) c FROM item_photos WHERE media_kind = ?').get('photo').c;

  let heirStats = { reviewed: 0, interested: 0, locked: 0 };
  if (req.heir) {
    heirStats.reviewed = db.prepare('SELECT COUNT(*) c FROM discovery_interests WHERE heir_id = ?').get(req.heir.heir_id).c;
    heirStats.interested = db.prepare("SELECT COUNT(*) c FROM discovery_interests WHERE heir_id = ? AND reaction != 'low'").get(req.heir.heir_id).c;
    heirStats.locked = req.heir.review_state === 'locked' ? 1 : 0;
  }

  res.json({ items: itemCount, rooms: roomCount, photos: photoCount, ...heirStats });
});

// ─── Owner: dashboard stats ───────────────────────────────────
app.get('/api/owner/stats', ownerAuth, (req, res) => {
  const heirCount = db.prepare('SELECT COUNT(*) c FROM discovery_heirs WHERE scope_id = ?').get(SCOPE_ID).c;
  const lockedCount = db.prepare("SELECT COUNT(*) c FROM discovery_heirs WHERE scope_id = ? AND review_state = 'locked'").get(SCOPE_ID).c;
  const itemCount = db.prepare("SELECT COUNT(*) c FROM items WHERE scope_id = ? AND review_state = 'kept'").get(SCOPE_ID).c;
  const interestCount = db.prepare('SELECT COUNT(*) c FROM discovery_interests WHERE scope_id = ?').get(SCOPE_ID).c;
  const contestedCount = db.prepare(`SELECT COUNT(DISTINCT di.item_id) c
    FROM discovery_interests di
    WHERE di.scope_id = ? AND di.reaction = 'high'
    AND (SELECT COUNT(*) FROM discovery_interests di2 WHERE di2.item_id = di.item_id AND di2.reaction = 'high') >= 2
  `).get(SCOPE_ID).c;
  const lookingForCount = db.prepare("SELECT COUNT(*) c FROM discovery_looking_for WHERE scope_id = ? AND status = 'open'").get(SCOPE_ID).c;

  res.json({
    heirs: heirCount,
    locked: lockedCount,
    items: itemCount,
    interests: interestCount,
    contested: contestedCount,
    looking_for: lookingForCount,
  });
});

// ─── Subscription status ─────────────────────────────────────
app.get('/api/subscription/status', (req, res) => {
  const sub = db.prepare('SELECT status, subscription_expires_at FROM estate_subscriptions WHERE scope_id = ?').get(SCOPE_ID);
  if (!sub) return res.json({ status: 'active', expires_at: null });
  res.json({ status: sub.status, expires_at: sub.subscription_expires_at });
});

const PORT = process.env.PORT || 3220;
app.listen(PORT, () => console.log(`Reindeer: Discovery listening on :${PORT}`));

// ─── Owner: import .reindeer bundle ───────────────────────────
//
// Accepts a .reindeer bundle (zip) from Registry or any compatible source.
// Parses it with @reindeer/exchange, loads items/rooms/categories/photos
// into Discovery's database. Re-importing the same item_id updates in place.
app.post('/api/owner/import', ownerAuth, express.raw({ type: 'application/octet-stream', limit: '800mb' }), async (req, res) => {
  try {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ message: 'No bundle bytes received.' });
    }
    // Try to use @reindeer/exchange if available, otherwise manual parse
    let envelope, files, problems;
    try {
      const exchange = await import('@reindeer/exchange');
      const result = exchange.readBundle(req.body);
      envelope = result.envelope;
      files = result.files;
      problems = result.problems;
    } catch (importErr) {
      return res.status(501).json({ 
        message: 'Bundle import requires @reindeer/exchange package. Use "Load Sample Data" instead, or install the exchange package.' 
      });
    }

    const ctx = { scopeId: SCOPE_ID, actorId: 'owner' };
    const result = { created: 0, updated: 0, rooms: 0, categories: 0, photos: 0, problems: [...problems] };

    // Map rooms by name (create if missing)
    const roomByName = new Map();
    for (const r of envelope.rooms || []) {
      let room = db.prepare('SELECT * FROM rooms WHERE scope_id = ? AND name = ?').get(SCOPE_ID, r.name);
      if (!room) {
        const roomId = r.id || crypto.randomUUID();
        db.prepare('INSERT INTO rooms (room_id, scope_id, name, is_custom, walkthrough_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(roomId, SCOPE_ID, r.name, r.is_custom ? 1 : 0, 'started', new Date().toISOString(), new Date().toISOString());
        room = db.prepare('SELECT * FROM rooms WHERE room_id = ?').get(roomId);
      }
      roomByName.set(r.name.toLowerCase(), room);
      result.rooms++;
    }

    // Map categories by name (create if missing)
    const catByName = new Map();
    for (const c of envelope.categories || []) {
      let cat = db.prepare('SELECT * FROM categories WHERE scope_id = ? AND name = ?').get(SCOPE_ID, c.name);
      if (!cat) {
        const catId = c.id || crypto.randomUUID();
        db.prepare('INSERT INTO categories (category_id, scope_id, name, is_custom, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(catId, SCOPE_ID, c.name, c.is_custom ? 1 : 0, new Date().toISOString(), new Date().toISOString());
        cat = db.prepare('SELECT * FROM categories WHERE category_id = ?').get(catId);
      }
      catByName.set(c.name.toLowerCase(), cat);
      result.categories++;
    }

    // Insert/update items
    for (const src of envelope.items || []) {
      const existing = db.prepare('SELECT * FROM items WHERE item_id = ? AND scope_id = ?').get(src.item_id, SCOPE_ID);
      const room = src.room_name ? roomByName.get(src.room_name.toLowerCase()) : null;
      const cat = src.category_name ? catByName.get(src.category_name.toLowerCase()) : null;

      const now = new Date().toISOString();
      if (existing) {
        db.prepare(`UPDATE items SET title=?, category_id=?, room_id=?, description=?, story=?, quantity=?, condition=?,
          value_estimate_cents=?, value_basis=?, high_value_flag=?, owner_high_value=?, owner_high_value_reason=?,
          owner_important_comment=?, review_state='kept', updated_at=? WHERE item_id=? AND scope_id=?`)
          .run(src.title, cat?.category_id || null, room?.room_id || null, src.description || '', src.story || '',
               src.quantity || 1, src.condition || 'unknown', src.value_estimate_cents || null, src.value_basis || 'unknown',
               src.high_value_flag ? 1 : 0, src.owner_high_value ? 1 : 0, src.owner_high_value_reason || '',
               src.owner_important_comment || '', now, src.item_id, SCOPE_ID);
        result.updated++;
      } else {
        db.prepare(`INSERT INTO items (item_id, scope_id, origin_app, origin_item_id, title, category_id, room_id,
          description, story, quantity, condition, identifiers, value_estimate_cents, value_basis,
          high_value_flag, owner_high_value, owner_high_value_reason, owner_important_comment, ownership_tag,
          ai_confidence, review_state, print_state, export_state, created_at, updated_at)
          VALUES (?, ?, 'inventory', ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, NULL, 'kept', 'unprinted', 'never', ?, ?)`)
          .run(src.item_id, SCOPE_ID, src.origin_item_id || src.item_id, src.title, cat?.category_id || null,
               room?.room_id || null, src.description || '', src.story || '', src.quantity || 1,
               src.condition || 'unknown', src.value_estimate_cents || null, src.value_basis || 'unknown',
               src.high_value_flag ? 1 : 0, src.owner_high_value ? 1 : 0, src.owner_high_value_reason || '',
               src.owner_important_comment || '', '', now, now);
        result.created++;
      }

      // Import photos
      for (const p of src.photos || []) {
        const photoData = files.get(p.file);
        if (!photoData) { result.problems.push(`Missing photo ${p.file}`); continue; }
        const photoId = crypto.randomUUID();
        const fileName = `${photoId}_${p.file.split('/').pop()}`;

        // Save photo to media store
        const mediaDir = path.join(DATA_DIR, 'media');
        const fs = await import('node:fs');
        fs.mkdirSync(mediaDir, { recursive: true });
        fs.writeFileSync(path.join(mediaDir, fileName), photoData);

        db.prepare(`INSERT OR REPLACE INTO item_photos (photo_id, item_id, scope_id, role, crop_bbox, file_name, mime_type, byte_size, sha256, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(photoId, src.item_id, SCOPE_ID, p.role || 'primary', p.crop_bbox || null, fileName,
               'image/jpeg', photoData.length, p.sha256 || null, now);
        result.photos++;
      }
    }

    res.json(result);
  } catch (e) {
    console.error('Import error:', e);
    res.status(500).json({ message: e.message || 'Import failed' });
  }
});

// ─── Owner: load sample data (for testing) ────────────────────
app.post('/api/owner/sample-data', ownerAuth, (req, res) => {
  const ctx = { scopeId: SCOPE_ID, actorId: 'owner' };
  const now = new Date().toISOString();

  const rooms = ['Living Room', 'Kitchen', 'Master Bedroom', 'Garage', 'Study', 'Dining Room'];
  const categories = ['Furniture', 'Artwork', 'Jewelry', 'Books', 'Tools', 'Kitchenware', 'Electronics', 'Collectibles'];

  // Create rooms
  const roomIds = {};
  for (const name of rooms) {
    let room = db.prepare('SELECT * FROM rooms WHERE scope_id = ? AND name = ?').get(SCOPE_ID, name);
    if (!room) {
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO rooms (room_id, scope_id, name, is_custom, walkthrough_state) VALUES (?, ?, ?, 0, ?)')
        .run(id, SCOPE_ID, name, 'started');
      room = db.prepare('SELECT * FROM rooms WHERE room_id = ?').get(id);
    }
    roomIds[name] = room.room_id;
  }

  // Create categories
  const catIds = {};
  for (const name of categories) {
    let cat = db.prepare('SELECT * FROM categories WHERE scope_id = ? AND name = ?').get(SCOPE_ID, name);
    if (!cat) {
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO categories (category_id, scope_id, name, is_custom) VALUES (?, ?, ?, 0)')
        .run(id, SCOPE_ID, name);
      cat = db.prepare('SELECT * FROM categories WHERE category_id = ?').get(id);
    }
    catIds[name] = cat.category_id;
  }

  const samples = [
    { title: 'Oak Grandfather Clock', room: 'Living Room', cat: 'Furniture', desc: 'Tall mahogany grandfather clock, family heirloom from 1890.', story: 'Grandpa Herman bought this in Germany before immigrating. It has chimed in the living room for four generations.' },
    { title: 'Wedding China Set', room: 'Dining Room', cat: 'Kitchenware', desc: '12-place setting of Lenox porcelain, gold trim.', story: 'Received as a wedding gift in 1972. Used every Thanksgiving and Christmas dinner.' },
    { title: 'Fishing Rod Collection', room: 'Garage', cat: 'Tools', desc: 'Five vintage bamboo fly rods in canvas case.', story: 'Uncle Fritz\'s collection. He taught everyone to fish with these on Lake Michigan.' },
    { title: 'Oil Painting - Alpine Scene', room: 'Living Room', cat: 'Artwork', desc: 'Original oil painting, 24x36, gilded frame.', story: 'Purchased on our honeymoon in Switzerland. The vendor said it was painted by a local artist in the 1950s.' },
    { title: 'Leather-Bound Encyclopedia Set', room: 'Study', cat: 'Books', desc: 'Complete 1958 Encyclopedia Britannica, 24 volumes.', story: 'Dad read these cover to cover. They sat on the study shelf as long as anyone can remember.' },
    { title: 'Pearl Necklace', room: 'Master Bedroom', cat: 'Jewelry', desc: 'Strand of cultured pearls with gold clasp.', story: 'Grandmother\'s graduation gift in 1945. Worn at every family wedding since.' },
    { title: 'Cast Iron Skillet', room: 'Kitchen', cat: 'Kitchenware', desc: 'Griswold #8 cast iron skillet, well-seasoned.', story: 'Great-grandma\'s skillet. Sunday breakfast was made in this every week for 60 years.' },
    { title: 'Vintage Record Player', room: 'Living Room', cat: 'Electronics', desc: 'Technics SL-1200 turntable with dust cover.', story: 'Dad\'s pride and joy. He played jazz records on it every Sunday morning.' },
    { title: 'Hand-Knitted Quilt', room: 'Master Bedroom', cat: 'Collectibles', desc: 'Patchwork quilt, queen size, hand-stitched.', story: 'Made by Great-Aunt Martha in the 1930s. Each square is from a different family member\'s clothing.' },
    { title: 'Antique Writing Desk', room: 'Study', cat: 'Furniture', desc: 'Roll-top oak desk with brass hardware.', story: 'The desk where every important family letter was written for three generations.' },
    { title: 'Silver Tea Service', room: 'Dining Room', cat: 'Kitchenware', desc: 'Five-piece silver plated tea set with tray.', story: 'Wedding gift from Aunt Mildred. Used for Easter tea every year.' },
    { title: 'Hand-Carved Chess Set', room: 'Study', cat: 'Collectibles', desc: 'Walnut and maple chess set, hand-carved pieces.', story: 'Carved by Grandpa during long winters. He taught everyone to play on this set.' },
    { title: 'Brass Compass', room: 'Study', cat: 'Collectibles', desc: 'Marine brass compass in wooden case.', story: 'Great-grandfather\'s compass from his days as a merchant sailor in the 1880s.' },
    { title: 'Crystal Decanter Set', room: 'Dining Room', cat: 'Collectibles', desc: 'Cut crystal decanter with six glasses.', story: 'Given as a retirement gift. Used for brandy after every family dinner.' },
    { title: 'Garden Tools Set', room: 'Garage', cat: 'Tools', desc: 'Vintage garden fork, spade, and pruners with wooden handles.', story: 'Grandma maintained her legendary rose garden with these tools for 40 years.' },
    { title: 'First Edition Hemingway', room: 'Study', cat: 'Books', desc: 'The Old Man and the Sea, first edition with dust jacket.', story: 'Found at a yard sale for $2. Dad knew it was special and kept it on the top shelf.' },
    { title: 'Persian Area Rug', room: 'Living Room', cat: 'Furniture', desc: 'Handwoven Persian rug, 9x12, deep reds and blues.', story: 'Bought on our trip to Istanbul. The merchant said it was made in Tabriz.' },
    { title: 'Vintage Camera', room: 'Study', cat: 'Collectibles', desc: 'Leica IIIc rangefinder camera with leather case.', story: 'Mom documented the entire family history with this camera from 1955 to 1990.' },
    { title: 'Copper Pot Set', room: 'Kitchen', cat: 'Kitchenware', desc: 'Set of three copper saucepans, tin-lined.', story: 'Brought from the old country. Grandma cooked every family meal with these.' },
    { title: 'Pocket Watch', room: 'Master Bedroom', cat: 'Jewelry', desc: 'Gold Waltham pocket watch with chain.', story: 'Great-grandfather carried this every day for 50 years. Still keeps perfect time.' },
  ];

  const result = { created: 0, updated: 0, skipped: 0, total: samples.length };
  for (const s of samples) {
    // Skip if an item with the same title already exists in this scope
    const existing = db.prepare('SELECT item_id FROM items WHERE scope_id = ? AND title = ?').get(SCOPE_ID, s.title);
    if (existing) { result.skipped++; continue; }
    const itemId = crypto.randomUUID();
    db.prepare(`INSERT INTO items (item_id, scope_id, origin_app, title, category_id, room_id,
      description, story, quantity, condition, identifiers, value_estimate_cents, value_basis,
      high_value_flag, owner_high_value, owner_high_value_reason, owner_important_comment, ownership_tag,
      ai_confidence, review_state, print_state, export_state, created_at, updated_at)
      VALUES (?, ?, 'inventory', ?, ?, ?, ?, ?, 1, 'good', '{}', NULL, 'unknown', 0, 0, '', '', 'mine', NULL, 'kept', 'unprinted', 'never', ?, ?)`)
      .run(itemId, SCOPE_ID, s.title, catIds[s.cat] || null, roomIds[s.room] || null,
           s.desc, s.story, now, now);
    result.created++;
  }

  res.json(result);
});
