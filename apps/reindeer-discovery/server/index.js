import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { openDb, defaultDataDir, SqliteItemRepository, FsMediaStore, ScopeMediaStore, Registry } from '@reindeer-legacy/core-data';
import { SCOPE_TYPE } from '@reindeer-legacy/core-api';

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

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'client')));

// Health check
app.get('/api/health', (req, res) => res.json({
  ok: true, app: 'reindeer-discovery', scope: SCOPE_ID,
  data_dir: DATA_DIR,
}));

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
  const { invite_token, name } = req.body || {};
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
  const { room, category, search } = req.query;
  let sql = `SELECT i.item_id, i.title, i.description, i.story, i.room_id, i.category_id,
                    i.review_state, i.owner_important_comment,
                    r.name as room_name, c.name as category_name
               FROM items i
               LEFT JOIN rooms r ON i.room_id = r.room_id
               LEFT JOIN categories c ON i.category_id = c.category_id
              WHERE i.scope_id = ? AND i.review_state = 'kept'`;
  const params = [SCOPE_ID];

  if (room) { sql += ` AND r.name = ?`; params.push(room); }
  if (category) { sql += ` AND c.name = ?`; params.push(category); }
  if (search) {
    sql += ` AND (i.title LIKE ? OR i.description LIKE ? OR i.story LIKE ? OR i.owner_important_comment LIKE ?)`;
    const pat = `%${search}%`;
    params.push(pat, pat, pat, pat);
  }

  sql += ` ORDER BY i.created_at DESC`;
  const items = db.prepare(sql).all(...params);

  for (const item of items) {
    const photos = db.prepare('SELECT photo_id, file_name, media_kind FROM item_photos WHERE item_id = ? AND media_kind = ? ORDER BY created_at LIMIT 1').all(item.item_id, 'photo');
    item.photo_url = photos.length > 0 ? `/api/items/${item.item_id}/photo` : null;
  }

  res.json({ items });
});

// ─── Items: single item detail ────────────────────────────────
app.get('/api/items/:itemId', heirSession, (req, res) => {
  const item = db.prepare(`SELECT i.item_id, i.title, i.description, i.story, i.room_id, i.category_id,
                                 i.review_state, i.owner_important_comment,
                                 r.name as room_name, c.name as category_name
                          FROM items i
                          LEFT JOIN rooms r ON i.room_id = r.room_id
                          LEFT JOIN categories c ON i.category_id = c.category_id
                          WHERE i.item_id = ? AND i.scope_id = ?`).get(req.params.itemId, SCOPE_ID);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  const photos = db.prepare('SELECT photo_id, file_name, media_kind, label FROM item_photos WHERE item_id = ? ORDER BY created_at').all(item.item_id);
  item.photos = photos.map(p => ({ ...p, url: `/api/items/${item.item_id}/photo/${p.photo_id}` }));

  res.json({ item });
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

const PORT = process.env.PORT || 3220;
app.listen(PORT, () => console.log(`Reindeer: Discovery listening on :${PORT}`));
