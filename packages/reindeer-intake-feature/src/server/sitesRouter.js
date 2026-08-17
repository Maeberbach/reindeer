import express from 'express';
import { makeScopeCtx, ReindeerError } from '@reindeer/core-api';

/**
 * Mountable sites router. Provides CRUD for authorized inventory sites
 * and a geosyncing endpoint that matches device GPS to a known site.
 */
export function createSitesRouter(deps) {
  const r = express.Router();
  const { sites, resolveScope } = deps;

  const ctxOf = (req) => makeScopeCtx(resolveScope(req));
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  // Ensure primary site exists on first access
  r.use(wrap(async (req, res, next) => {
    const ctx = ctxOf(req);
    sites.ensurePrimary(ctx);
    next();
  }));

  // List all sites
  r.get('/sites', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    res.json(sites.list(ctx));
  }));

  // Create a new site — seeds default rooms into it so the owner
  // starts with the usual living room, kitchen, bedroom, etc.
  r.post('/sites', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const { name, kind, lat, lon, radius_m } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Site name is required' });
    const site = sites.create(ctx, { name: name.trim(), kind: kind || 'other', lat, lon, radius_m });
    // Seed default rooms for this site
    if (deps.registry && deps.registry.seedDefaults) {
      deps.registry.seedDefaults(ctx.scopeId, site.site_id);
    }
    res.json(site);
  }));

  // Update a site
  r.patch('/sites/:siteId', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const updated = sites.update(ctx, req.params.siteId, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Site not found' });
    res.json(updated);
  }));

  // Delete a site (primary cannot be deleted)
  r.delete('/sites/:siteId', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const ok = sites.delete(ctx, req.params.siteId);
    if (!ok) return res.status(400).json({ error: 'Cannot delete this site' });
    res.json({ ok: true });
  }));

  // Geosync: match device GPS to a known site
  r.post('/sites/match', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const { lat, lon } = req.body || {};
    if (lat == null || lon == null) return res.status(400).json({ error: 'lat and lon are required' });
    const match = sites.matchByCoords(ctx, lat, lon);
    res.json({ matched: !!match, site: match || null });
  }));

  return r;
}
