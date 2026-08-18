import { DuplicateDetector } from '@reindeer-legacy/core-api';
import { ulid } from '@reindeer-legacy/core-data';

const normalize = (s) => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Token overlap, 0..1. Cheap, explainable, and good enough to shortlist. */
export function titleSimilarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  // Containment: "Grandpa's watch" vs "Grandpa's pocket watch". This rule lives
  // in FairPlay's matcher too (apps/reindeer-fair-play/server/duplicates/
  // match.ts) and is mirrored here on purpose — the whole suite must agree on
  // what a duplicate is, or an item's status changes depending on which app is
  // looking at it. Guarded against short strings so "pin" does not swallow
  // "pincushion".
  if (na.length > 4 && nb.length > 4 && (na.includes(nb) || nb.includes(na))) return 0.9;
  const ta = new Set(na.split(' ').filter(Boolean));
  const tb = new Set(nb.split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.max(ta.size, tb.size);
}

/**
 * Nothing is ever auto-deleted. This only proposes groups; a person always
 * chooses keep-new, keep-catalog, keep-both, delete-both, or replace-photo.
 */
export class SimpleDuplicateDetector extends DuplicateDetector {
  constructor(db, itemRepo, audit, { threshold = 0.72 } = {}) {
    super();
    Object.assign(this, { db, itemRepo, audit, threshold });
  }

  /**
   * Count likely duplicates WITHOUT recording anything.
   *
   * The registry's job is to get things documented. A duplicate review is
   * offered, never compelled: recording groups at save time would put an
   * outstanding task in front of an owner who is mid-walkthrough and just
   * wants the shelf written down. This returns a number so the interface can
   * mention it once and move on. The owner can review here whenever they like,
   * or leave it entirely to the captain in Reindeer: FairPlay
   * Choice, which runs the same rule.
   */
  async previewBatch(candidateItemIds, ctx) {
    const catalog = this.db.prepare(
      "SELECT item_id, title, identifiers FROM items WHERE scope_id = ? AND review_state IN ('kept','draft')",
    ).all(ctx.scopeId);
    const seen = new Set();
    for (const id of candidateItemIds) {
      const cand = catalog.find((c) => c.item_id === id);
      if (!cand) continue;
      for (const other of catalog) {
        if (other.item_id === id) continue;
        if (this.#serialMatch(cand, other) || titleSimilarity(cand.title, other.title) >= this.threshold) {
          seen.add([id, other.item_id].sort().join('|'));
        }
      }
    }
    return seen.size;
  }

  async scanBatch(candidateItemIds, ctx) {
    const groups = [];
    const catalog = this.db.prepare(
      "SELECT item_id, title, identifiers FROM items WHERE scope_id = ? AND review_state IN ('kept','draft')",
    ).all(ctx.scopeId);

    for (const id of candidateItemIds) {
      const cand = catalog.find((c) => c.item_id === id);
      if (!cand) continue;
      for (const other of catalog) {
        if (other.item_id === id) continue;
        const score = titleSimilarity(cand.title, other.title);
        const serialMatch = this.#serialMatch(cand, other);
        if (serialMatch || score >= this.threshold) {
          groups.push(await this.#record([id, other.item_id], serialMatch ? 'serial_match' : 'title_similarity', serialMatch ? 1 : score, ctx));
        }
      }
    }
    return dedupeGroups(groups);
  }

  async scanCatalog(ctx) {
    const rows = this.db.prepare(
      "SELECT item_id, title, identifiers FROM items WHERE scope_id = ? AND review_state IN ('kept','draft')",
    ).all(ctx.scopeId);
    const groups = [];
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const score = titleSimilarity(rows[i].title, rows[j].title);
        const serialMatch = this.#serialMatch(rows[i], rows[j]);
        if (serialMatch || score >= this.threshold) {
          groups.push(await this.#record([rows[i].item_id, rows[j].item_id], serialMatch ? 'serial_match' : 'title_similarity', serialMatch ? 1 : score, ctx));
        }
      }
    }
    // Identical photo bytes are a certain duplicate.
    const photoDupes = this.db.prepare(`
      SELECT sha256, GROUP_CONCAT(DISTINCT item_id) ids, COUNT(DISTINCT item_id) n
      FROM item_photos WHERE scope_id = ? AND sha256 IS NOT NULL
      GROUP BY sha256 HAVING n > 1
    `).all(ctx.scopeId);
    for (const p of photoDupes) {
      groups.push(await this.#record(p.ids.split(','), 'identical_photo', 1, ctx));
    }
    return dedupeGroups(groups);
  }

  #serialMatch(a, b) {
    try {
      const ia = JSON.parse(a.identifiers || '{}');
      const ib = JSON.parse(b.identifiers || '{}');
      return Boolean(ia.serial && ib.serial && String(ia.serial).trim() === String(ib.serial).trim());
    } catch { return false; }
  }

  async #record(itemIds, reason, score, ctx) {
    const groupId = ulid();
    const tx = this.db.transaction(() => {
      this.db.prepare('INSERT INTO duplicate_groups (group_id, scope_id, reason, score, state, created_at) VALUES (?,?,?,?,?,?)')
        .run(groupId, ctx.scopeId, reason, score, 'open', new Date().toISOString());
      const m = this.db.prepare('INSERT OR IGNORE INTO duplicate_members (group_id, item_id, side) VALUES (?,?,?)');
      itemIds.forEach((id, i) => m.run(groupId, id, i === 0 ? 'candidate' : 'catalog'));
    });
    tx();
    return { group_id: groupId, reason, score, item_ids: itemIds };
  }

  /** Resolution actions. Every destructive branch is audited. */
  async resolve(groupId, action, ctx) {
    const members = this.db.prepare('SELECT * FROM duplicate_members WHERE group_id = ?').all(groupId);
    const [candidate, catalogItem] = [members.find((m) => m.side === 'candidate'), members.find((m) => m.side === 'catalog')];

    switch (action) {
      case 'keep_new':
        if (catalogItem) await this.itemRepo.remove(catalogItem.item_id, `duplicate of ${candidate?.item_id}`, ctx);
        break;
      case 'keep_catalog':
        if (candidate) await this.itemRepo.remove(candidate.item_id, `duplicate of ${catalogItem?.item_id}`, ctx);
        break;
      case 'keep_both':
        break;
      case 'delete_both':
        for (const m of members) await this.itemRepo.remove(m.item_id, 'duplicate resolution: delete both', ctx);
        break;
      default:
        throw new Error(`Unknown duplicate action: ${action}`);
    }

    this.db.prepare("UPDATE duplicate_groups SET state = 'resolved' WHERE group_id = ? AND scope_id = ?").run(groupId, ctx.scopeId);
    await this.audit.append({ action: 'duplicate.resolve', entity: 'duplicate_group', entity_id: groupId, payload: { action } }, ctx);
    return { group_id: groupId, action, state: 'resolved' };
  }
}

function dedupeGroups(groups) {
  const seen = new Set();
  return groups.filter((g) => {
    const key = [...g.item_ids].sort().join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
