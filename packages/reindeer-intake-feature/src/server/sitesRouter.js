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

  // Retag items from one site to another (or to primary site).
  // Body: { target_site_id?: string } — if omitted, retags to primary.
  // Used when items were accidentally entered at an offsite location
  // and need to be moved to the home inventory.
  r.post('/sites/:siteId/retag', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const sourceSiteId = req.params.siteId;
    const targetSiteId = req.body?.target_site_id || null;
    const allSites = sites.list(ctx);
    const primary = allSites.find((s) => s.is_primary);
    const target = targetSiteId
      ? allSites.find((s) => s.site_id === targetSiteId)
      : primary;
    if (!target) return res.status(400).json({ error: 'No target site available' });
    const db = deps.db;
    const result = db.prepare(
      `UPDATE items SET site_id = ?, site_name = ? WHERE site_id = ? AND scope_id = ?`,
    ).run(target.site_id, target.name, sourceSiteId, ctx.scopeId);
    deps.audit?.append?.({
      action: 'site.retag', entity: 'site', entity_id: sourceSiteId,
      payload: { moved: result.changes, target_site_id: target.site_id, target_name: target.name },
    }, ctx);
    res.json({ moved: result.changes, target_site_id: target.site_id, target_name: target.name });
  }));

  // Delete a site (primary cannot be deleted).
  // Optionally retag items to another site first by passing
  // { retag_to: siteId } in the body.
  r.delete('/sites/:siteId', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const retagTo = req.body?.retag_to || null;
    if (retagTo) {
      const allSites = sites.list(ctx);
      const target = allSites.find((s) => s.site_id === retagTo)
        || allSites.find((s) => s.is_primary);
      if (target && target.site_id !== req.params.siteId) {
        const db = deps.db;
        db.prepare(
          `UPDATE items SET site_id = ?, site_name = ? WHERE site_id = ? AND scope_id = ?`,
        ).run(target.site_id, target.name, req.params.siteId, ctx.scopeId);
      }
    }
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
