import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ulid } from '@reindeer-legacy/core-data';
import { writeBundle } from '@reindeer-legacy/exchange';
import { renderTrusteePacket, renderTrusteeEmail } from '@reindeer-legacy/print-feature';
import {
  DELIVERY_METHOD, DELIVERY_STATE, MAX_EMAIL_ATTACHMENT_BYTES,
  ValidationError, NotFoundError,
} from '@reindeer-legacy/core-api';

const LINK_TTL_DAYS = 30;

/**
 * Builds the trustee package and sends it.
 *
 * Preparing and sending are deliberately two steps. The owner sees exactly
 * what is in the package, how large it is, whether it will arrive attached or
 * as a link, and who it is going to — and then confirms. Nothing leaves the
 * app on one tap.
 */
export class DeliveryService {
  constructor({
    db, audit, itemRepo, mediaStore, scopeMediaStore, registry, trustees, mailer,
    storageDir, ownerName, appVersion = '0.1.0', baseUrl = '',
  }) {
    Object.assign(this, {
      db, audit, itemRepo, mediaStore, scopeMediaStore, registry, trustees, mailer,
      storageDir, ownerName, appVersion, baseUrl,
    });
    fs.mkdirSync(storageDir, { recursive: true });
  }

  /** Step one: build the package, store it, and report exactly what will be sent. */
  async prepare({ query, trusteeIds = [], forceLink = false }, ctx) {
    const recipients = trusteeIds.length
      ? trusteeIds.map((id) => {
        const t = this.trustees.get(id, ctx);
        if (!t) throw NotFoundError('trustee', id);
        return t;
      })
      : this.trustees.list(ctx);
    if (!recipients.length) throw ValidationError('Add the person who should receive the package before sending it.');

    const { buffer, batchId, manifest, envelope, fileName } = await writeBundle({
      itemRepo: this.itemRepo,
      mediaStore: this.mediaStore,
      scopeMediaStore: this.scopeMediaStore,
      registry: this.registry,
      query: query ?? { review_state: 'kept' },
      source: {
        app: 'reindeer-registry', app_version: this.appVersion,
        inventory_id: ctx.scopeId, owner_name: this.ownerName,
      },
      ctx,
    });
    if (!envelope.items.length) {
      throw ValidationError('There is nothing confirmed to send yet. Review your items first, then send the package.');
    }

    const bundleSha = crypto.createHash('sha256').update(buffer).digest('hex');
    const storedAs = path.join(this.storageDir, `${batchId}.reindeer`);
    fs.writeFileSync(storedAs, buffer);

    const tooBig = buffer.length > MAX_EMAIL_ATTACHMENT_BYTES;
    const method = (tooBig || forceLink) ? DELIVERY_METHOD.EMAIL_LINK : DELIVERY_METHOD.EMAIL_ATTACHMENT;
    const linkToken = method === DELIVERY_METHOD.EMAIL_LINK ? crypto.randomBytes(24).toString('base64url') : null;
    const expires = linkToken ? new Date(Date.now() + LINK_TTL_DAYS * 86400000).toISOString() : null;

    const deliveryId = ulid();
    const c = manifest.counts;
    this.db.prepare(`
      INSERT INTO deliveries (delivery_id, scope_id, batch_id, method, state, recipients,
        item_count, photo_count, video_count, audio_count, byte_size, file_name,
        bundle_sha256, link_token, link_expires_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(deliveryId, ctx.scopeId, batchId, method, DELIVERY_STATE.PREPARED,
      JSON.stringify(recipients.map((t) => ({ trustee_id: t.trustee_id, name: t.name, email: t.email }))),
      c.items ?? 0, c.photos ?? 0, c.videos ?? 0, c.audio ?? 0, buffer.length, fileName,
      bundleSha, linkToken, expires, new Date().toISOString());

    await this.audit.append({
      action: 'delivery.prepare', entity: 'delivery', entity_id: deliveryId,
      payload: { batch_id: batchId, method, counts: c, byte_size: buffer.length, recipients: recipients.map((t) => t.email) },
    }, ctx);

    const { items } = await this.itemRepo.list(query ?? { review_state: 'kept' }, ctx);
    /*
     * Slice A rebuild: the trustee cover sheet's Important section now
     * reads directly from the item flag (owner_high_value) and the
     * optional owner comment. No claims tables, no participants list.
     * householdMode still drives the copy variant (solo vs couple).
     */
    const scope = this.registry?.getScope ? this.registry.getScope(ctx) : null;
    const householdMode = scope?.household_mode || 'solo';

    const packetHtml = renderTrusteePacket({
      ownerName: this.ownerName,
      trustee: recipients[0],
      manifest, items,
      scopeMedia: this.scopeMediaStore ? this.scopeMediaStore.list(ctx) : [],
      delivery: { method, file_name: fileName, byte_size: buffer.length },
      bundleSha256: bundleSha,
      householdMode,
    });
    fs.writeFileSync(path.join(this.storageDir, `${batchId}-packet.html`), packetHtml);

    return {
      delivery_id: deliveryId,
      batch_id: batchId,
      method,
      why: tooBig
        ? `The package is ${mb(buffer.length)}, which is larger than most mail servers accept, so it will be sent as a secure download link that works for ${LINK_TTL_DAYS} days.`
        : `The package is ${mb(buffer.length)} and will be attached directly to the email.`,
      counts: c,
      byte_size: buffer.length,
      file_name: fileName,
      bundle_sha256: bundleSha,
      stored_as: storedAs,
      recipients: recipients.map((t) => ({ trustee_id: t.trustee_id, name: t.name, email: t.email })),
      download_url: linkToken ? this.linkUrl(linkToken) : null,
      link_expires_at: expires,
      packet_url: `/api/delivery/${deliveryId}/packet`,
      mailer: this.mailer.describe,
    };
  }

  /** Step two: send the prepared package. Requires an explicit confirmation. */
  async send(deliveryId, ctx, { confirmed = false } = {}) {
    if (!confirmed) throw ValidationError('The package was not sent because the send was not confirmed.');
    const d = this.getDelivery(deliveryId, ctx);
    if (!d) throw NotFoundError('delivery', deliveryId);
    if (d.state === DELIVERY_STATE.SENT) {
      return { already_sent: true, sent_at: d.sent_at, recipients: JSON.parse(d.recipients) };
    }

    const recipients = JSON.parse(d.recipients);
    const manifest = { counts: { items: d.item_count, photos: d.photo_count, videos: d.video_count, audio: d.audio_count }, batch_id: d.batch_id };
    const bundlePath = path.join(this.storageDir, `${d.batch_id}.reindeer`);
    const packetPath = path.join(this.storageDir, `${d.batch_id}-packet.html`);

    const { text, html, subject } = renderTrusteeEmail({
      ownerName: this.ownerName,
      trustee: recipients[0],
      manifest,
      delivery: { method: d.method, file_name: d.file_name, bundle_sha256: d.bundle_sha256 },
      downloadUrl: d.link_token ? this.linkUrl(d.link_token) : null,
      expiresAt: d.link_expires_at,
    });

    const attachments = [];
    if (fs.existsSync(packetPath)) {
      attachments.push({ filename: `cover-packet-${d.batch_id.slice(0, 8)}.html`, content: fs.readFileSync(packetPath) });
    }
    if (d.method === 'email_attachment' && fs.existsSync(bundlePath)) {
      attachments.push({ filename: d.file_name, content: fs.readFileSync(bundlePath) });
    }

    const result = await this.mailer.send({
      to: recipients.map((r) => r.email),
      subject, text, html, attachments,
    });

    const now = new Date().toISOString();
    if (result.ok) {
      this.db.prepare('UPDATE deliveries SET state=?, sent_at=?, error=? WHERE delivery_id=?')
        .run(DELIVERY_STATE.SENT, now, '', deliveryId);
      await this.audit.append({
        action: 'delivery.sent', entity: 'delivery', entity_id: deliveryId,
        payload: { batch_id: d.batch_id, method: d.method, to: recipients.map((r) => r.email), message_id: result.message_id },
      }, ctx);
      return { sent: true, sent_at: now, method: d.method, recipients, message_id: result.message_id, mailer: this.mailer.describe };
    }

    this.db.prepare('UPDATE deliveries SET state=?, error=? WHERE delivery_id=?')
      .run(DELIVERY_STATE.FAILED, result.error ?? 'unknown error', deliveryId);
    await this.audit.append({
      action: 'delivery.failed', entity: 'delivery', entity_id: deliveryId,
      payload: { batch_id: d.batch_id, error: result.error },
    }, ctx);
    return { sent: false, error: result.error, retry_hint: 'The package is still saved. Fix the mail settings and send it again — nothing has to be rebuilt.' };
  }

  /** Anyone holding the link can fetch the file; the token is the credential. */
  async resolveLink(token) {
    const d = this.db.prepare('SELECT * FROM deliveries WHERE link_token = ?').get(token);
    if (!d) return { ok: false, reason: 'not_found' };
    if (d.link_expires_at && new Date(d.link_expires_at) < new Date()) return { ok: false, reason: 'expired', expired_at: d.link_expires_at };
    const p = path.join(this.storageDir, `${d.batch_id}.reindeer`);
    if (!fs.existsSync(p)) return { ok: false, reason: 'missing_file' };
    this.db.prepare('UPDATE deliveries SET state=? WHERE delivery_id=? AND state=?')
      .run(DELIVERY_STATE.DOWNLOADED, d.delivery_id, DELIVERY_STATE.SENT);
    return { ok: true, path: p, file_name: d.file_name, delivery: d };
  }

  getDelivery(id, ctx) {
    return this.db.prepare('SELECT * FROM deliveries WHERE delivery_id = ? AND scope_id = ?').get(id, ctx.scopeId) ?? null;
  }

  history(ctx) {
    return this.db.prepare('SELECT * FROM deliveries WHERE scope_id = ? ORDER BY created_at DESC').all(ctx.scopeId)
      .map((d) => ({ ...d, recipients: JSON.parse(d.recipients) }));
  }

  packetPath(d) { return path.join(this.storageDir, `${d.batch_id}-packet.html`); }

  linkUrl(token) { return `${this.baseUrl.replace(/\/$/, '')}/d/${token}`; }
}

const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;
