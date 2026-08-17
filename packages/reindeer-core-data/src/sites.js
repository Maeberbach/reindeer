import { ulid } from './db/index.js';

/**
 * Sites registry — authorized locations where items can be added.
 *
 * The home/primary site is auto-created with the scope. Additional sites
 * (storage unit, second home, vacation home) are added by the owner
 * through the settings or the offsite warning flow. Each site has
 * optional GPS coordinates for geosyncing.
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

  create(ctx, { name, kind = 'other', lat = null, lon = null, radius_m = 100 }) {
    const siteId = ulid();
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO sites (site_id, scope_id, name, kind, lat, lon, radius_m, is_primary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(siteId, ctx.scopeId, name, kind, lat, lon, radius_m, now);
    this.audit?.append?.({
      action: 'site.create', entity: 'site', entity_id: siteId,
      payload: { name, kind },
    }, ctx);
    return this.get(ctx, siteId);
  }

  update(ctx, siteId, { name, lat, lon, radius_m } = {}) {
    const existing = this.get(ctx, siteId);
    if (!existing) return null;
    const merged = {
      name: name ?? existing.name,
      lat: lat !== undefined ? lat : existing.lat,
      lon: lon !== undefined ? lon : existing.lon,
      radius_m: radius_m ?? existing.radius_m,
    };
    this.db.prepare(
      `UPDATE sites SET name = ?, lat = ?, lon = ?, radius_m = ? WHERE site_id = ? AND scope_id = ?`,
    ).run(merged.name, merged.lat, merged.lon, merged.radius_m, siteId, ctx.scopeId);
    return this.get(ctx, siteId);
  }

  delete(ctx, siteId) {
    const existing = this.get(ctx, siteId);
    if (!existing || existing.is_primary) return false; // cannot delete primary
    this.db.prepare(
      'DELETE FROM sites WHERE site_id = ? AND scope_id = ?',
    ).run(siteId, ctx.scopeId);
    this.audit?.append?.({
      action: 'site.delete', entity: 'site', entity_id: siteId,
      payload: { name: existing.name },
    }, ctx);
    return true;
  }

  /**
   * Match a GPS coordinate to the nearest site within its radius.
   * Uses the haversine formula for distance. Returns null if no site
   * is within range.
   */
  matchByCoords(ctx, lat, lon) {
    const sites = this.list(ctx);
    for (const s of sites) {
      if (s.lat == null || s.lon == null) continue;
      const dist = haversineMeters(lat, lon, s.lat, s.lon);
      if (dist <= s.radius_m) return s;
    }
    return null;
  }

  /**
   * Ensure the scope has a primary "Home" site. Called on scope creation
   * or on first access if missing.
   */
  ensurePrimary(ctx) {
    const existing = this.db.prepare(
      'SELECT * FROM sites WHERE scope_id = ? AND is_primary = 1',
    ).get(ctx.scopeId);
    if (existing) return existing;
    const siteId = ulid();
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO sites (site_id, scope_id, name, kind, lat, lon, radius_m, is_primary, created_at)
       VALUES (?, ?, 'Home', 'home', NULL, NULL, 200, 1, ?)`,
    ).run(siteId, ctx.scopeId, now);
    return this.get(ctx, siteId);
  }
}

/**
 * Haversine formula — distance between two lat/lon points in meters.
 */
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // earth radius in meters
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
