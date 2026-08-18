/**
 * Reindeer Corporate Admin — standalone dashboard server.
 *
 * Serves the admin UI and proxies API calls to the three Reindeer apps
 * (Registry, FairPlay, Discovery) so there are zero CORS issues. The admin
 * key lives server-side in REINDEER_ADMIN_KEY — the browser never sees it.
 */
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ADMIN_KEY = process.env.REINDEER_ADMIN_KEY || '';
const SUPPORT_KEY = process.env.REINDEER_SUPPORT_KEY || '';

const APPS = {
  registry:  { url: 'https://reindeer-registry.onrender.com',    name: 'Registry',  desc: 'Estate inventory & item capture' },
  fairplay:  { url: 'https://reindeer-fair-play.onrender.com',   name: 'FairPlay',  desc: 'Estate distribution & fair division' },
  discovery: { url: 'https://reindeer-discovery.onrender.com',   name: 'Discovery', desc: 'Heir interest & early discovery' },
};

const PORT = process.env.PORT || 3230;
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'client')));

/* ─── Proxy helper ─────────────────────────────────────────── */
async function proxy(appKey, method, apiPath, body, res) {
  const target = APPS[appKey];
  if (!target) return res.status(400).json({ error: 'Unknown app' });

  const url = target.url + apiPath;
  const headers = {
    'Content-Type': 'application/json',
    'x-admin-key': ADMIN_KEY,
  };
  if (SUPPORT_KEY) headers['x-support-key'] = SUPPORT_KEY;

  try {
    const resp = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    res.status(resp.status).json(data);
  } catch (e) {
    res.status(502).json({ error: `Cannot reach ${target.name}: ${e.message}` });
  }
}

/* ─── Status endpoint ──────────────────────────────────────── */
app.get('/api/status', (req, res) => {
  res.json({
    adminKeyConfigured: ADMIN_KEY.length >= 16,
    supportKeyConfigured: SUPPORT_KEY.length >= 16,
    apps: Object.fromEntries(
      Object.entries(APPS).map(([k, v]) => [k, { name: v.name, url: v.url }])
    ),
  });
});

/* ─── Proxy routes ─────────────────────────────────────────── */
// GET /api/proxy/:app/*
app.get('/api/proxy/:app/*', (req, res) => {
  const { app: appKey } = req.params;
  const apiPath = '/' + req.params[0];
  proxy(appKey, 'GET', apiPath, null, res);
});

// POST /api/proxy/:app/*
app.post('/api/proxy/:app/*', (req, res) => {
  const { app: appKey } = req.params;
  const apiPath = '/' + req.params[0];
  proxy(appKey, 'POST', apiPath, req.body, res);
});

// DELETE /api/proxy/:app/*
app.delete('/api/proxy/:app/*', (req, res) => {
  const { app: appKey } = req.params;
  const apiPath = '/' + req.params[0];
  proxy(appKey, 'DELETE', apiPath, req.body, res);
});

app.listen(PORT, () => console.log(`Reindeer Corp Admin listening on :${PORT}`));
