import { Router } from 'express';

/**
 * Sites routes — multi-location support for estates with more than one
 * property or off-site storage. The home/primary site is auto-created when
 * the scope is first accessed; additional sites are added by the owner
 * either through the home screen or when the offsite geosyncing warning
 * prompts them during capture.
 *
 * Match radius: 274 meters (300 yards). Locations farther apart than this
 * are treated as likely different sites, and the capture flow prompts the
 * owner to register the new location.
 */
export function createSitesRouter({ sites, resolveScope }) {
  const r = Router();

  // List all sites for the estate
  r.get('/sites', (req, res, next) => {
    try {
      const ctx = resolveScope(req);
      sites.ensurePrimary(ctx);
      const list = sites.list(ctx);
      res.json(list);
    } catch (e) { next(e); }
  });

  // Match GPS coordinates to a registered site
  r.post('/sites/match', (req, res, next) => {
    try {
      const ctx = resolveScope(req);
      const { lat, lon } = req.body || {};
      if (lat == null || lon == null) {
        return res.json({ matched: false, site: null, is_new_site: false });
      }
      const match = sites.matchByCoords(ctx, lat, lon);
      if (match) {
        return res.json({ matched: true, site: match, is_new_site: false });
      }
      // No match — check if this is likely a new site (>300 yards from all known sites)
      const near = sites.nearestByCoords(ctx, lat, lon);
      const isNew = sites.isLikelyNewSite(ctx, lat, lon);
      return res.json({
        matched: false,
        site: null,
        is_new_site: isNew,
        nearest: near ? { name: near.site.name, distance_m: Math.round(near.distance_m), distance_yards: Math.round(near.distance_m * 1.0936) } : null,
      });
    } catch (e) { next(e); }
  });

  // Create a new site
  r.post('/sites', (req, res, next) => {
    try {
      const ctx = resolveScope(req);
      const { name, kind = 'other', address = '', lat = null, lon = null, radius_m } = req.body || {};
      if (!name || !name.trim()) {
        return res.status(400).json({ error: 'A name is required for the site.' });
      }
      // Default radius 274m (300 yards) unless specified
      const site = sites.create(ctx, {
        name: name.trim(),
        kind,
        address,
        lat,
        lon,
        radius_m: radius_m ?? 274,
      });
      res.status(201).json(site);
    } catch (e) { next(e); }
  });

  // Update a site (rename, set GPS, change radius)
  r.patch('/sites/:siteId', (req, res, next) => {
    try {
      const ctx = resolveScope(req);
      const updated = sites.update(ctx, req.params.siteId, req.body || {});
      if (!updated) return res.status(404).json({ error: 'Site not found.' });
      res.json(updated);
    } catch (e) { next(e); }
  });

  // Delete a non-primary site — retag items to primary first if requested
  r.delete('/sites/:siteId', (req, res, next) => {
    try {
      const ctx = resolveScope(req);
      // Retag items to primary if requested
      if (req.body?.retag_to_primary) {
        sites.retagItems(ctx, req.params.siteId);
      }
      const ok = sites.delete(ctx, req.params.siteId);
      if (!ok) return res.status(400).json({ error: 'Cannot delete the primary home site, or site not found.' });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // Retag items from a site to the primary/home site
  r.post('/sites/:siteId/retag', (req, res, next) => {
    try {
      const ctx = resolveScope(req);
      sites.retagItems(ctx, req.params.siteId);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  return r;
}
