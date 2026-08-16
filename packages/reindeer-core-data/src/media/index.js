import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MediaStore, PHOTO_ROLE, MEDIA_KIND, mediaKindFor } from '@reindeer/core-api';

const EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
  'audio/webm': 'weba', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
};
const extFor = (mime) => EXT[mime] ?? (mime?.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '');
import { ulid } from '../db/index.js';

/**
 * Filesystem media store.
 *
 * Cropping happens in the browser on a canvas before upload — the same
 * approach the existing video keyframe pipeline uses — so the server needs no
 * native image dependency and raw source photos never have to be retained.
 */
export class FsMediaStore extends MediaStore {
  constructor(db, rootDir) {
    super();
    this.db = db;
    this.rootDir = rootDir;
    fs.mkdirSync(rootDir, { recursive: true });
  }

  scopeDir(ctx) {
    const d = path.join(this.rootDir, ctx.scopeId);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  /**
   * Stores a photo, a video, or a voice recording. Video and audio are kept
   * whole — the owner's voice telling the story is the point, so it is never
   * transcoded away or discarded after keyframing.
   */
  async put(buffer, meta, ctx) {
    const photoId = ulid();
    const mime = meta.mime_type || 'image/jpeg';
    const kind = meta.media_kind || mediaKindFor(mime);
    const fileName = `${photoId}.${extFor(mime)}`;
    const full = path.join(this.scopeDir(ctx), fileName);
    fs.writeFileSync(full, buffer);
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

    this.db.prepare(`
      INSERT INTO item_photos (photo_id, item_id, scope_id, role, crop_bbox, source_media_id,
        source_frame_index, file_name, mime_type, byte_size, sha256, created_at,
        media_kind, duration_ms, transcript, transcript_source, label, retain_original)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(photoId, meta.item_id, ctx.scopeId, meta.role || defaultRole(kind),
      meta.crop_bbox ? JSON.stringify(meta.crop_bbox) : null,
      meta.source_media_id ?? null, meta.source_frame_index ?? null,
      fileName, mime, buffer.length, sha256, new Date().toISOString(),
      kind, meta.duration_ms ?? null, meta.transcript ?? '', meta.transcript_source ?? null,
      meta.label ?? '', meta.retain_original === false ? 0 : 1);

    return { photo_id: photoId, file_name: fileName, sha256, byte_size: buffer.length, media_kind: kind };
  }

  async getPath(photoId, ctx) {
    const row = this.db.prepare('SELECT * FROM item_photos WHERE photo_id = ? AND scope_id = ?').get(photoId, ctx.scopeId);
    if (!row) return null;
    return path.join(this.scopeDir(ctx), row.file_name);
  }

  async listForItem(itemId, ctx) {
    return this.db.prepare('SELECT * FROM item_photos WHERE item_id = ? AND scope_id = ?').all(itemId, ctx.scopeId);
  }

  async remove(photoId, ctx) {
    const p = await this.getPath(photoId, ctx);
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
    this.db.prepare('DELETE FROM item_photos WHERE photo_id = ? AND scope_id = ?').run(photoId, ctx.scopeId);
    return { deleted: true };
  }

  /** Attach or replace a transcript for a recording. */
  async setTranscript(photoId, text, source, ctx) {
    this.db.prepare('UPDATE item_photos SET transcript = ?, transcript_source = ? WHERE photo_id = ? AND scope_id = ?')
      .run(text ?? '', source ?? 'manual', photoId, ctx.scopeId);
    return this.db.prepare('SELECT * FROM item_photos WHERE photo_id = ?').get(photoId);
  }

  /** Counts by kind, used for delivery sizing and the trustee cover sheet. */
  tally(ctx) {
    const rows = this.db.prepare(`
      SELECT media_kind, COUNT(*) n, COALESCE(SUM(byte_size),0) bytes
      FROM item_photos WHERE scope_id = ? GROUP BY media_kind
    `).all(ctx.scopeId);
    const scope = this.db.prepare(`
      SELECT media_kind, COUNT(*) n, COALESCE(SUM(byte_size),0) bytes
      FROM scope_media WHERE scope_id = ? GROUP BY media_kind
    `).all(ctx.scopeId);
    const out = { photo: { n: 0, bytes: 0 }, video: { n: 0, bytes: 0 }, audio: { n: 0, bytes: 0 } };
    for (const r of [...rows, ...scope]) {
      const slot = out[r.media_kind] ?? (out[r.media_kind] = { n: 0, bytes: 0 });
      slot.n += r.n; slot.bytes += r.bytes;
    }
    out.total_bytes = out.photo.bytes + out.video.bytes + out.audio.bytes;
    return out;
  }
}

function defaultRole(kind) {
  if (kind === MEDIA_KIND.AUDIO) return 'item_story';
  if (kind === MEDIA_KIND.VIDEO) return 'item_walkaround';
  return PHOTO_ROLE.PRIMARY;
}

/**
 * Recordings that belong to the inventory as a whole rather than to one
 * object: a room walkthrough, or the owner speaking to the whole family.
 */
export class ScopeMediaStore {
  constructor(db, rootDir) {
    this.db = db;
    this.rootDir = rootDir;
    fs.mkdirSync(rootDir, { recursive: true });
  }

  scopeDir(ctx) {
    const d = path.join(this.rootDir, ctx.scopeId, '_scope');
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  async put(buffer, meta, ctx) {
    const mediaId = ulid();
    const mime = meta.mime_type || 'video/mp4';
    const kind = meta.media_kind || mediaKindFor(mime);
    const fileName = `${mediaId}.${extFor(mime)}`;
    fs.writeFileSync(path.join(this.scopeDir(ctx), fileName), buffer);
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    this.db.prepare(`
      INSERT INTO scope_media (media_id, scope_id, media_kind, title, file_name, mime_type,
        byte_size, duration_ms, transcript, sha256, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(mediaId, ctx.scopeId, kind, meta.title ?? '', fileName, mime,
      buffer.length, meta.duration_ms ?? null, meta.transcript ?? '', sha256, new Date().toISOString());
    return { media_id: mediaId, file_name: fileName, sha256, byte_size: buffer.length, media_kind: kind };
  }

  list(ctx) {
    return this.db.prepare('SELECT * FROM scope_media WHERE scope_id = ? ORDER BY created_at').all(ctx.scopeId);
  }

  getPath(mediaId, ctx) {
    const row = this.db.prepare('SELECT * FROM scope_media WHERE media_id = ? AND scope_id = ?').get(mediaId, ctx.scopeId);
    return row ? path.join(this.scopeDir(ctx), row.file_name) : null;
  }

  async remove(mediaId, ctx) {
    const p = this.getPath(mediaId, ctx);
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
    this.db.prepare('DELETE FROM scope_media WHERE media_id = ? AND scope_id = ?').run(mediaId, ctx.scopeId);
    return { deleted: true };
  }
}
