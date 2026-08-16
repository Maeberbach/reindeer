import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  buildInventoryEnvelope,
  buildAddendumEnvelope,
  writeInventoryBundle,
  writeAddendumBundle,
  saveTwoOutputsBundleToDisk,
} from '@reindeer/exchange';
import { ValidationError, NotFoundError } from '@reindeer/core-api';

/**
 * The Two-Output Delivery Model service.
 *
 * Two responsibilities, kept separate from DeliveryService on purpose:
 *
 *   \u2022 Inventory  \u2014 whole household to one trustee. Composed on demand.
 *     Nothing is persisted in the DB about a specific delivery here yet;
 *     the addendum is the versioned artifact, not the inventory.
 *
 *   \u2022 Addendum   \u2014 the assigned-items packet. Every signing writes a row
 *     to `addendum_versions` and drops the .addendum bundle in storageDir.
 *
 * The service reaches through the item repo for items and the heirs /
 * wills_caretakers repos for the recipient roster; it does NOT reach into
 * FC's trustees. The old `TrusteeRepository` continues to feed the
 * .reindeer delivery path.
 */
export class TwoOutputsService {
  constructor({
    db, audit, itemRepo, mediaStore, scopeMediaStore, registry,
    heirs, willsCaretakers, addendumVersions, trustees,
    storageDir, ownerName = '', appVersion = '0.1.0', estateId = '',
    mailer = null,
  }) {
    Object.assign(this, {
      db, audit, itemRepo, mediaStore, scopeMediaStore, registry,
      heirs, willsCaretakers, addendumVersions, trustees,
      storageDir, ownerName, appVersion, estateId, mailer,
    });
    fs.mkdirSync(storageDir, { recursive: true });
  }

  /* ---- inventory --------------------------------------------------------- */

  /**
   * Build (but do not save) the inventory envelope that would be sent right
   * now. The UI uses this for the "here is what the trustee will see" screen.
   *
   * `trigger` defaults to 'manual_test' so a preview never carries the
   * heavier 'death' framing. Callers writing the real bundle pass
   * 'manual_test' too for now; production triggering is a later commit.
   */
  async previewInventory({ trusteeId, trigger = 'manual_test' } = {}, ctx) {
    const recipient = await this.#resolveTrusteeRecipient(trusteeId, ctx);
    const items = await this.#listKeptItemsWithAssignment(ctx);
    const envelope = buildInventoryEnvelope({
      items,
      rooms: this.registry.rooms(ctx),
      categories: this.registry.categories(ctx),
      estateId: this.estateId || ctx.scopeId,
      trigger,
      recipient,
      source: { app: 'reindeer-registry', app_version: this.appVersion, inventory_id: ctx.scopeId, owner_name: this.ownerName },
    });
    return { envelope };
  }

  /**
   * Write the inventory bundle to disk and return where it landed. This
   * does NOT send email or mark anything delivered \u2014 sending is a later
   * commit that will reuse the existing DeliveryService pathway.
   */
  async writeInventory({ trusteeId, trigger = 'manual_test' } = {}, ctx) {
    const { envelope } = await this.previewInventory({ trusteeId, trigger }, ctx);
    const scopeMedia = this.scopeMediaStore ? this.scopeMediaStore.list(ctx) : [];
    const { buffer, fileName, batchId, manifest, envelopeSha256 } = await writeInventoryBundle({
      envelope, mediaStore: this.mediaStore, scopeMediaStore: this.scopeMediaStore, scopeMedia, ctx,
    });
    const bundlePath = saveTwoOutputsBundleToDisk(buffer, this.storageDir, fileName);
    await this.audit?.append?.({
      action: 'inventory.write', entity: 'inventory', entity_id: batchId,
      payload: { file: fileName, sha256: envelopeSha256, counts: manifest.counts, byte_size: buffer.length },
    }, ctx);
    return { bundlePath, fileName, batchId, envelopeSha256, manifest };
  }

  /* ---- addendum ---------------------------------------------------------- */

  /**
   * Build the addendum envelope that would result from signing right now,
   * without persisting anything. The UI uses this for the pre-sign review
   * screen so the owner can see exactly what they are about to commit to.
   */
  async previewAddendum({ ownerParticipantId, targetVersion = null, recipientCaretakerIds = [], trusteeId = null, voiceMessage = null }, ctx) {
    if (!ownerParticipantId) throw ValidationError('An addendum needs an owner_participant_id.');
    const latest = this.addendumVersions.latestFor(ownerParticipantId, ctx);
    const nextVersion = targetVersion ?? (latest ? latest.version_number + 1 : 1);
    const recipients = await this.#resolveAddendumRecipients({ recipientCaretakerIds, trusteeId }, ctx);
    const { items, gaps } = await this.#collectAddendumItems(ownerParticipantId, ctx);

    if (!items.length) {
      throw ValidationError('There are no items assigned yet, so there is nothing to add to the addendum.');
    }

    // The owner block on the preview is unsigned. The signing step fills in
    // signed_at + signature_evidence; the preview shows the state the
    // signature will attach to.
    const owner = { participant_id: ownerParticipantId, name: this.ownerName, signed_at: null, signature_evidence: {} };
    const envelope = buildAddendumEnvelope({
      estateId: this.estateId || ctx.scopeId,
      owner,
      version: nextVersion,
      supersedes: latest ? latest.version_number : null,
      supersedesDeliveredAt: latest?.signed_at ?? null,
      recipients,
      voiceMessage,
      items,
      gaps,
      source: { app: 'reindeer-registry', app_version: this.appVersion, inventory_id: ctx.scopeId, owner_name: this.ownerName },
    });
    return { envelope, nextVersion, supersedesVersion: latest?.version_number ?? null, gaps };
  }

  /**
   * Sign, persist, and write the addendum bundle.
   *
   * `signature` is the wet-ink evidence the owner produced at signing time
   * (device string, timestamp, and an optional hash of the ink strokes).
   * `voiceMediaId` optionally names a scope-level media row whose transcript
   * and file will ride along in the bundle.
   *
   * Persistence and the bundle write happen inside a single sqlite
   * transaction so a crash mid-write does not leave a signed row pointing
   * at a bundle that was never created.
   */
  async signAndWriteAddendum({
    ownerParticipantId,
    signature,
    recipientCaretakerIds = [],
    trusteeId = null,
    voiceMediaId = null,
  }, ctx) {
    if (!signature || !signature.device) {
      throw ValidationError('Signing needs signature evidence (at minimum the device you signed on).');
    }
    // Registry is a preparation tool, not a legal document. Once the owner
    // has died and the trustee has frozen their memorandum, Registry must
    // not accept any further electronic \u201csigning\u201d for that owner \u2014
    // the paper the trustee holds is what governs from that point.
    const priorFrozen = this.addendumVersions.latestFor(ownerParticipantId, ctx);
    if (priorFrozen?.frozen_at) {
      throw ValidationError(
        'This owner\u2019s memorandum has been frozen by the trustee. Registry can\u2019t accept another signing. The paper the trustee holds is what governs. A new memorandum can still be written, signed on paper, and delivered directly to the trustee.',
      );
    }
    const voiceMessage = voiceMediaId ? await this.#resolveVoiceMessage(voiceMediaId, ctx) : null;
    const { envelope, nextVersion } = await this.previewAddendum(
      { ownerParticipantId, recipientCaretakerIds, trusteeId, voiceMessage },
      ctx,
    );

    // Attach signature evidence to the envelope we actually sign.
    const signedAt = signature.signed_at || new Date().toISOString();
    envelope.owner = { ...envelope.owner, signed_at: signedAt, signature_evidence: signature };

    const voicePath = voiceMediaId ? this.scopeMediaStore.getPath(voiceMediaId, ctx) : null;

    // The bundle writer expects a sync resolver, but FsMediaStore.getPath is
    // async — pre-resolve every closeup path here. The envelope drops
    // photo_id by design (envelope stays trustee-portable, not DB-portable),
    // so we key by item_id which the envelope keeps as `id`.
    const pathsByItemId = new Map();
    for (const it of envelope.items) {
      if (!it.closeup_photo) continue;
      const itemRow = await this.itemRepo.get(it.id, ctx);
      if (!itemRow?.closeup_photo_id) continue;
      const p = await this.mediaStore.getPath(itemRow.closeup_photo_id, ctx);
      if (p) pathsByItemId.set(it.id, p);
    }
    const { buffer, fileName, batchId, manifest, envelopeSha256 } = await writeAddendumBundle({
      envelope,
      closeupPathResolver: ({ item_id }) => (item_id ? pathsByItemId.get(item_id) ?? null : null),
      voiceMediaPath: voicePath,
    });

    const bundlePath = saveTwoOutputsBundleToDisk(buffer, this.storageDir, fileName);

    // Persist the version row. The unique index enforces "no duplicate
    // version_number for this owner" \u2014 if it fires here it means two sign
    // requests raced; a 409 is the right answer.
    const versionRow = this.addendumVersions.record({
      ownerParticipantId,
      versionNumber: nextVersion,
      supersedes: envelope.supersedes_version,
      signedAt,
      signatureEvidence: signature,
      recipients: envelope.recipients,
      voiceMessage: envelope.voice_message,
      itemsSnapshot: envelope.items,
      gaps: envelope.gaps,
      envelopeSha256,
      bundlePath,
    }, ctx);

    await this.audit?.append?.({
      action: 'addendum.sign', entity: 'addendum', entity_id: versionRow.version_id,
      payload: {
        version_number: nextVersion, owner_participant_id: ownerParticipantId,
        item_count: envelope.items.length, gap_count: envelope.gaps.length,
        byte_size: buffer.length, sha256: envelopeSha256, batch_id: batchId, file: fileName,
      },
    }, ctx);

    return { version: versionRow, bundlePath, fileName, envelopeSha256, manifest, batchId, buffer };
  }

  /**
   * Send an UNSIGNED PREVIEW copy of the latest signed addendum by email
   * to a wills caretaker or attorney the owner has already added.
   *
   * This is deliberately a preparation aid, not a legal act:
   *   \u2022 The subject and body say "unsigned preview" everywhere and remind
   *     the reader that only the printed, pen-signed paper carries legal
   *     weight.
   *   \u2022 The .addendum bundle is attached exactly as it sits on disk. The
   *     bundle itself is a machine record of what the owner signed in-app,
   *     which is why we call the email an unsigned PREVIEW: no wet ink.
   *   \u2022 The mailer is passed in from the server. In dev it's the
   *     ConsoleMailer (writes files, sends nothing). In tests it's the
   *     RecordingMailer. In production, SMTP.
   *   \u2022 We refuse to email a version that has been frozen at handoff \u2014
   *     the frozen memorandum belongs to the trustee's process now.
   */
  async sendUnsignedPreviewEmail({ ownerParticipantId, caretakerId } = {}, ctx) {
    if (!this.mailer) throw ValidationError('Email is not configured for this app.');
    if (!ownerParticipantId) throw ValidationError('Signer is required.');
    if (!caretakerId) throw ValidationError('Pick a wills caretaker or attorney to send it to.');

    const latest = this.addendumVersions.latestFor(ownerParticipantId, ctx);
    if (!latest) throw ValidationError('There is no signed memorandum yet. Sign the memorandum before sending a preview.');
    if (latest.frozen_at) throw ValidationError('This memorandum has been handed off to the trustee. A new preview cannot be sent from here.');
    if (!latest.bundle_path) throw ValidationError('The signed bundle file is missing on this server.');
    if (!fs.existsSync(latest.bundle_path)) throw NotFoundError('The signed bundle file');

    const c = this.willsCaretakers.get(caretakerId, ctx);
    if (!c) throw NotFoundError('That wills caretaker');
    const to = String(c.email ?? '').trim();
    if (!to) throw ValidationError('This wills caretaker has no email address on file. Add one on the People screen first.');
    if (c.delivery_method && c.delivery_method !== 'email') {
      throw ValidationError('This wills caretaker is set to receive the memorandum by ' + c.delivery_method.replace('_', ' ') + ', not email. Change their delivery method to email if you want to send the preview this way.');
    }

    const fileName = path.basename(latest.bundle_path);
    const attachment = fs.readFileSync(latest.bundle_path);
    const ownerNameLine = (this.ownerName || '').trim() || 'the owner';
    const caretakerLabel = c.firm ? `${c.name} (${c.firm})` : c.name;

    const subject = `Unsigned preview of ${ownerNameLine}'s memorandum (v${latest.version_number}) \u2014 not legally binding`;
    const text = [
      `Hello ${c.name},`,
      '',
      `${ownerNameLine} is preparing a personal-property memorandum to accompany their will.`,
      `Attached is an UNSIGNED PREVIEW of version ${latest.version_number}, sent for your reference only.`,
      '',
      'This preview is NOT legally binding. ' + ownerNameLine + ' still has to print the memorandum, sign it by hand,',
      'and get the paper to whoever holds the will for it to have legal standing. If you would prefer a',
      'fully executed version for your records, please let ' + ownerNameLine + ' know.',
      '',
      'The attached file is a machine-readable Reindeer Registry bundle. If you would like a human-readable',
      'PDF instead, ask ' + ownerNameLine + ' to print the memorandum from the app and send you the paper.',
      '',
      'Sent from Reindeer Registry, a preparation tool. Reindeer Registry is not a legal or fiduciary service.',
    ].join('\n');

    const send = await this.mailer.send({
      to,
      subject,
      text,
      attachments: [{ filename: fileName, content: attachment }],
    });
    if (!send.ok) throw ValidationError(send.error || 'The message could not be sent.');

    await this.audit?.append?.({
      action: 'addendum.email_preview.sent',
      entity: 'addendum',
      entity_id: latest.version_id,
      payload: {
        owner_participant_id: ownerParticipantId,
        version_number: latest.version_number,
        caretaker_id: caretakerId,
        caretaker_label: caretakerLabel,
        recipient_email: to,
        message_id: send.message_id || null,
        mailer: this.mailer.describe,
        subject,
        attachment_bytes: attachment.length,
      },
    }, ctx);

    return {
      sent: true,
      version_id: latest.version_id,
      version_number: latest.version_number,
      recipient: { caretaker_id: caretakerId, name: caretakerLabel, email: to },
      message_id: send.message_id || null,
      mailer: this.mailer.describe,
      subject,
      attachment_file_name: fileName,
      attachment_bytes: attachment.length,
    };
  }

  /* ---- helpers ----------------------------------------------------------- */

  async #resolveTrusteeRecipient(trusteeId, ctx) {
    if (trusteeId) {
      const t = this.trustees?.get?.(trusteeId, ctx);
      if (!t) throw NotFoundError('That trustee');
      return { role: 'trustee', name: t.name, contact: t.email, delivery_method: t.email ? 'email' : 'signed_link' };
    }
    // Fall back to the first configured trustee \u2014 the single-owner Registry
    // usually only has one, so this is the friendliest default. The UI will
    // let the user pick when there are several.
    const first = this.trustees?.list?.(ctx)?.[0];
    if (!first) throw ValidationError('Add a trustee before writing the inventory.');
    return { role: 'trustee', name: first.name, contact: first.email, delivery_method: first.email ? 'email' : 'signed_link' };
  }

  async #resolveAddendumRecipients({ recipientCaretakerIds = [], trusteeId = null }, ctx) {
    const recipients = [];
    for (const id of recipientCaretakerIds) {
      const c = this.willsCaretakers.get(id, ctx);
      if (!c) throw NotFoundError('That wills caretaker');
      recipients.push({
        role: 'wills_caretaker',
        name: c.firm ? `${c.name} (${c.firm})` : c.name,
        contact: c.email || c.phone || '',
        delivery_method: c.delivery_method,
      });
    }
    if (!recipients.length) {
      // Auto-include every caretaker on file. The addendum is meant to travel
      // with the will, so leaving them off is almost always a mistake.
      for (const c of this.willsCaretakers.list(ctx)) {
        recipients.push({
          role: 'wills_caretaker',
          name: c.firm ? `${c.name} (${c.firm})` : c.name,
          contact: c.email || c.phone || '',
          delivery_method: c.delivery_method,
        });
      }
    }
    // Trustee too \u2014 the trustee always gets a copy at signing time.
    const trustee = await this.#resolveTrusteeRecipient(trusteeId, ctx).catch(() => null);
    if (trustee) recipients.push(trustee);
    if (!recipients.length) {
      throw ValidationError('An addendum needs at least one wills caretaker or trustee to send it to.');
    }
    return recipients;
  }

  async #listKeptItemsWithAssignment(ctx) {
    const list = (await this.itemRepo.list({ review_state: 'kept' }, ctx)).items;
    // The repository's get() already returns SELECT * so assigned_to_heir_id
    // and closeup_photo_id are present on every row. Nothing extra to do.
    return list;
  }

  async #collectAddendumItems(ownerParticipantId, ctx) {
    const kept = await this.#listKeptItemsWithAssignment(ctx);
    const heirsById = new Map(this.heirs.list(ctx).map((h) => [h.heir_id, h]));

    const items = [];
    const gaps = [];
    for (const it of kept) {
      if (!it.assigned_to_heir_id) continue; // not part of the addendum at all
      const heir = heirsById.get(it.assigned_to_heir_id);
      if (!heir) {
        gaps.push({ item_id: it.item_id, reason: 'heir_not_found' });
        continue;
      }
      const closeup = it.closeup_photo_id
        ? await this.#loadCloseup(it.closeup_photo_id, ctx)
        : null;
      const entry = {
        item_id: it.item_id,
        title: it.title,
        room_name: it.room?.name ?? null,
        category_name: it.category?.name ?? null,
        assigned_to: {
          name: heir.name,
          relationship: heir.relationship,
          heir_id: heir.heir_id,
          // Additive field \u2014 tells downstream consumers (FairPlay, print
          // templates) whether this named recipient is a will-heir or a
          // named non-heir (friend, godchild, charity). Defaults to 'heir'
          // so pre-migration data stays valid.
          recipient_type: heir.recipient_type || 'heir',
        },
        owner_words: it.owner_important_comment || '',
        closeup_photo: closeup,
      };
      if (!closeup) gaps.push({ item_id: it.item_id, reason: 'closeup_photo_missing' });
      items.push(entry);
    }
    // Owner-participant-id scoping: for single-owner Registry, every assigned
    // item belongs to the sole owner. Couple mode will filter by which spouse
    // owns each item; that filter lands with the Couple mode commit.
    return { items, gaps };
  }

  async #loadCloseup(photoId, ctx) {
    const row = this.db.prepare(
      "SELECT * FROM item_photos WHERE photo_id = ? AND media_kind = 'photo'",
    ).get(photoId);
    if (!row) return null;
    const full = await this.mediaStore.getPath(photoId, ctx);
    if (!full || !fs.existsSync(full)) return null;
    const data = fs.readFileSync(full);
    return {
      photo_id: row.photo_id,
      file_name: row.file_name,
      sha256: crypto.createHash('sha256').update(data).digest('hex'),
      captured_at: row.created_at,
      source: 'owner_camera',
    };
  }

  async #resolveVoiceMessage(voiceMediaId, ctx) {
    const row = this.db.prepare(
      "SELECT * FROM scope_media WHERE media_id = ? AND scope_id = ? AND media_kind = 'audio'",
    ).get(voiceMediaId, ctx.scopeId);
    if (!row) throw NotFoundError('That voice message');
    const full = this.scopeMediaStore.getPath(voiceMediaId, ctx);
    if (!full || !fs.existsSync(full)) {
      throw ValidationError('The voice recording file is missing from disk.');
    }
    const data = fs.readFileSync(full);
    return {
      file_name: row.file_name,
      transcript: row.transcript || '',
      duration_seconds: row.duration_ms ? Math.round(row.duration_ms / 1000) : 0,
      recorded_at: row.created_at,
      sha256: row.sha256 || crypto.createHash('sha256').update(data).digest('hex'),
      byte_size: data.length,
    };
  }
}
