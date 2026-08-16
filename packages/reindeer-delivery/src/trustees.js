import { ulid } from '@reindeer-legacy/core-data';
import { ValidationError, NotFoundError } from '@reindeer-legacy/core-api';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Who receives the finished package. Usually one trustee and one backup. */
export class TrusteeRepository {
  constructor(db, audit) { this.db = db; this.audit = audit; }

  list(ctx) {
    return this.db.prepare('SELECT * FROM trustees WHERE scope_id = ? ORDER BY is_primary DESC, created_at')
      .all(ctx.scopeId);
  }

  get(id, ctx) {
    return this.db.prepare('SELECT * FROM trustees WHERE trustee_id = ? AND scope_id = ?').get(id, ctx.scopeId) ?? null;
  }

  async create(input, ctx) {
    const name = String(input.name ?? '').trim();
    const email = String(input.email ?? '').trim().toLowerCase();
    if (!name) throw ValidationError('Please enter the name of the person who will receive the package.');
    if (!EMAIL_RE.test(email)) throw ValidationError(`"${input.email}" does not look like an email address.`);

    const id = ulid();
    const isPrimary = input.is_primary ? 1 : (this.list(ctx).length === 0 ? 1 : 0);
    if (isPrimary) this.db.prepare('UPDATE trustees SET is_primary = 0 WHERE scope_id = ?').run(ctx.scopeId);
    this.db.prepare(`
      INSERT INTO trustees (trustee_id, scope_id, name, email, role, is_primary, note, created_at)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(id, ctx.scopeId, name, email, input.role ?? 'trustee', isPrimary, input.note ?? '', new Date().toISOString());
    await this.audit.append({ action: 'trustee.create', entity: 'trustee', entity_id: id, payload: { name, email } }, ctx);
    return this.get(id, ctx);
  }

  async update(id, patch, ctx) {
    const row = this.get(id, ctx);
    if (!row) throw NotFoundError('trustee', id);
    if (patch.email !== undefined && !EMAIL_RE.test(String(patch.email).trim().toLowerCase())) {
      throw ValidationError(`"${patch.email}" does not look like an email address.`);
    }
    if (patch.is_primary) this.db.prepare('UPDATE trustees SET is_primary = 0 WHERE scope_id = ?').run(ctx.scopeId);
    const next = {
      name: patch.name ?? row.name,
      email: (patch.email ?? row.email).trim().toLowerCase(),
      role: patch.role ?? row.role,
      is_primary: patch.is_primary ? 1 : row.is_primary,
      note: patch.note ?? row.note,
    };
    this.db.prepare('UPDATE trustees SET name=?, email=?, role=?, is_primary=?, note=? WHERE trustee_id=?')
      .run(next.name, next.email, next.role, next.is_primary, next.note, id);
    await this.audit.append({ action: 'trustee.update', entity: 'trustee', entity_id: id, payload: patch }, ctx);
    return this.get(id, ctx);
  }

  async remove(id, ctx) {
    const row = this.get(id, ctx);
    if (!row) throw NotFoundError('trustee', id);
    await this.audit.append({ action: 'trustee.delete', entity: 'trustee', entity_id: id, payload: { name: row.name, email: row.email } }, ctx);
    this.db.prepare('DELETE FROM trustees WHERE trustee_id = ?').run(id);
    return { deleted: true };
  }
}
