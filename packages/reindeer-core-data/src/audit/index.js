import crypto from 'node:crypto';
import { AuditLog } from '@reindeer-legacy/core-api';

/**
 * Hash-chained audit log. Each row hashes the previous row's hash, so any
 * silent edit or deletion of history is detectable by verify().
 * This is what lets a printed inventory answer "was this item removed later?"
 */
export class SqliteAuditLog extends AuditLog {
  constructor(db) {
    super();
    this.db = db;
  }

  async append(entry, ctx) {
    const prev = this.db
      .prepare('SELECT hash FROM audit_log WHERE scope_id = ? ORDER BY seq DESC LIMIT 1')
      .get(ctx.scopeId);
    const prevHash = prev?.hash ?? 'GENESIS';
    const created_at = new Date().toISOString();
    const payload = JSON.stringify(entry.payload ?? {});
    const body = [
      ctx.scopeId, ctx.actorId, entry.action, entry.entity,
      entry.entity_id ?? '', payload, created_at, prevHash,
    ].join('\u0001');
    const hash = crypto.createHash('sha256').update(body).digest('hex');

    this.db.prepare(`
      INSERT INTO audit_log (scope_id, actor_id, action, entity, entity_id, payload, created_at, prev_hash, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(ctx.scopeId, ctx.actorId, entry.action, entry.entity,
      entry.entity_id ?? null, payload, created_at, prevHash, hash);

    return { hash, created_at };
  }

  async verify(ctx) {
    const rows = this.db
      .prepare('SELECT * FROM audit_log WHERE scope_id = ? ORDER BY seq ASC')
      .all(ctx.scopeId);
    let prevHash = 'GENESIS';
    for (const r of rows) {
      const body = [
        r.scope_id, r.actor_id, r.action, r.entity,
        r.entity_id ?? '', r.payload, r.created_at, prevHash,
      ].join('\u0001');
      const expected = crypto.createHash('sha256').update(body).digest('hex');
      if (r.prev_hash !== prevHash || r.hash !== expected) {
        return { ok: false, brokenAt: r.seq, count: rows.length };
      }
      prevHash = r.hash;
    }
    return { ok: true, count: rows.length, head: prevHash };
  }

  async list(query, ctx) {
    const limit = query?.limit ?? 200;
    return this.db
      .prepare('SELECT * FROM audit_log WHERE scope_id = ? ORDER BY seq DESC LIMIT ?')
      .all(ctx.scopeId, limit);
  }
}
