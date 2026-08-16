/**
 * Ports — the seams between shared logic and app-specific implementations.
 *
 * These are documented base classes rather than TypeScript interfaces so the
 * monorepo runs with no build step. Each method throws until implemented,
 * which makes a missing implementation fail loudly at wiring time instead of
 * silently returning undefined at runtime.
 */

const unimplemented = (cls, method) => {
  throw new Error(`${cls}.${method}() is not implemented`);
};

export class ItemRepository {
  async create(_item, _ctx) { unimplemented('ItemRepository', 'create'); }
  async update(_id, _patch, _ctx) { unimplemented('ItemRepository', 'update'); }
  async get(_id, _ctx) { unimplemented('ItemRepository', 'get'); }
  async list(_query, _ctx) { unimplemented('ItemRepository', 'list'); }
  async remove(_id, _reason, _ctx) { unimplemented('ItemRepository', 'remove'); }
  async markExported(_ids, _batchId, _ctx) { unimplemented('ItemRepository', 'markExported'); }
  async markPrinted(_ids, _ctx) { unimplemented('ItemRepository', 'markPrinted'); }
}

export class MediaStore {
  async put(_buffer, _meta, _ctx) { unimplemented('MediaStore', 'put'); }
  async getPath(_photoId, _ctx) { unimplemented('MediaStore', 'getPath'); }
  async listForItem(_itemId, _ctx) { unimplemented('MediaStore', 'listForItem'); }
  async remove(_photoId, _ctx) { unimplemented('MediaStore', 'remove'); }
}

/**
 * VisionProvider is the single seam for AI. Swapping the mock for the real
 * Reindeer: FairPlay vision pipeline is a one-line change at wiring time.
 * detectItems() must return Detection[]:
 *   { label, category_hint, room_hint, confidence, bbox: [x,y,w,h] (0..1),
 *     value_estimate_cents, identifiers, high_value_cue, frame_index }
 */
export class VisionProvider {
  async detectItems(_images, _opts) { unimplemented('VisionProvider', 'detectItems'); }
  async describeItem(_image, _opts) { unimplemented('VisionProvider', 'describeItem'); }
}

export class DuplicateDetector {
  async scanBatch(_detections, _ctx) { unimplemented('DuplicateDetector', 'scanBatch'); }
  async scanCatalog(_ctx) { unimplemented('DuplicateDetector', 'scanCatalog'); }
}

export class PrintRenderer {
  async renderItemSheet(_itemId, _profile, _ctx) { unimplemented('PrintRenderer', 'renderItemSheet'); }
  async renderReport(_query, _profile, _ctx) { unimplemented('PrintRenderer', 'renderReport'); }
}

export class ExportWriter {
  async writeExchange(_query, _opts, _ctx) { unimplemented('ExportWriter', 'writeExchange'); }
}

export class AuditLog {
  async append(_entry, _ctx) { unimplemented('AuditLog', 'append'); }
  async verify(_ctx) { unimplemented('AuditLog', 'verify'); }
  async list(_query, _ctx) { unimplemented('AuditLog', 'list'); }
}
