import { ulid } from './db/index.js';

/**
 * Sites registry — authorized locations where items can be added.
 *
 * The home/primary site is auto-created with the scope. Additional sites
 * (storage unit, second home, vacation home) are added by the owner
 * through the settings or the offsite warning flow. Each site has
 * optional GPS coordinates for geosyncing. The default match radius
 * is 274 meters (300 yards) — locations farther apart than this are
 * treated as likely different sites.
 */
export class SitesRegistry {
  constructor(db, audit) {
    this.db = db;
    this.audit = audit;
  }

  list(ctx) {
    return this.db.prepare(
      'SELECT * FROM sites WHERE scope_id = ? ORDER BY is_primary DESC, created_at ASC',
    ).all(ctx.scopeId);
  }

  get(ctx, siteId) {
    return this.db.prepare(
      'SELECT * FROM sites WHERE site_id = ? AND scope_id = ?',
    ).get(siteId, ctx.scopeId);
  }

  create(ctx, { name, kind = 'other', address = '', lat = null, lon = null, radius_m = 274 }) {
    const siteId = ulid();
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO sites (site_id, scope_id, name, kind, address, lat, lon, radius_m, is_primary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(siteId, ctx.scopeId, name, kind, address, lat, lon, radius_m, now);
    this.audit?.append?.({
      action: 'site.create', entity: 'site', entity_id: siteId,
      payload: { name, kind, address },
    }, ctx);
    return this.get(ctx, siteId);
  }

  update(ctx, siteId, { name, address, lat, lon, radius_m } = {}) {
    const existing = this.get(ctx, siteId);
    if (!existing) return null;
    const merged = {
      name: name ?? existing.name,
      address: address !== undefined ? address : existing.address,
      lat: lat !== undefined ? lat : existing.lat,
      lon: lon !== undefined ? lon : existing.lon,
      radius_m: radius_m ?? existing.radius_m,
    };
    this.db.prepare(
      `UPDATE sites SET name = ?, address = ?, lat = ?, lon = ?, radius_m = ? WHERE site_id = ? AND scope_id = ?`,
    ).run(merged.name, merged.address, merged.lat, merged.lon, merged.radius_m, siteId, ctx.scopeId);
    return this.get(ctx, siteId);
  }

  delete(ctx, siteId) {
    const existing = this.get(ctx, siteId);
    if (!existing || existing.is_primary) return false;
    this.db.prepare(
      'DELETE FROM sites WHERE site_id = ? AND scope_id = ?',
    ).run(siteId, ctx.scopeId);
    this.audit?.append?.({
      action: 'site.delete', entity: 'site', entity_id: siteId,
      payload: { name: existing.name },
    }, ctx);
    return true;
  }

  matchByCoords(ctx, lat, lon) {
    const sites = this.list(ctx);
    for (const s of sites) {
      if (s.lat == null || s.lon == null) continue;
      const dist = haversineMeters(lat, lon, s.lat, s.lon);
      if (dist <= s.radius_m) return s;
    }
    return null;
  }

  nearestByCoords(ctx, lat, lon) {
    const sites = this.list(ctx);
    let nearest = null;
    let nearestDist = Infinity;
    for (const s of sites) {
      if (s.lat == null || s.lon == null) continue;
      const dist = haversineMeters(lat, lon, s.lat, s.lon);
      if (dist < nearestDist) { nearest = s; nearestDist = dist; }
    }
    return nearest ? { site: nearest, distance_m: nearestDist } : null;
  }

  isLikelyNewSite(ctx, lat, lon) {
    const match = this.matchByCoords(ctx, lat, lon);
    if (match) return false;
    const near = this.nearestByCoords(ctx, lat, lon);
    if (!near) return true;
    return near.distance_m > 274;
  }

  retagItems(ctx, fromSiteId) {
    const primary = this.ensurePrimary(ctx);
    this.db.prepare(
      'UPDATE items SET site_id = ? WHERE site_id = ? AND scope_id = ?',
    ).run(primary.site_id, fromSiteId, ctx.scopeId);
    this.audit?.append?.({
      action: 'site.retag', entity: 'site', entity_id: fromSiteId,
      payload: { retagged_to: primary.site_id },
    }, ctx);
    return primary;
  }

  ensurePrimary(ctx) {
    const existing = this.db.prepare(
      'SELECT * FROM sites WHERE scope_id = ? AND is_primary = 1',
    ).get(ctx.scopeId);
    if (existing) return existing;
    const siteId = ulid();
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO sites (site_id, scope_id, name, kind, lat, lon, radius_m, is_primary, created_at)
       VALUES (?, ?, 'Home', 'home', NULL, NULL, 274, 1, ?)`,
    ).run(siteId, ctx.scopeId, now);
    return this.get(ctx, siteId);
  }
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
