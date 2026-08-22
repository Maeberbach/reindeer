import express from 'express';
import {
  LegacyError, REVIEW_STATE, PHOTO_ROLE, makeScopeCtx,
  MEDIA_KIND, MEDIA_ACCEPT, RECORDING_ROLE, mediaKindFor, DEFAULT_CATEGORIES,
} from '@reindeer-legacy/core-api';
import { screenHighValue } from '../vision/index.js';

/**
 * Mountable intake router. Both app shells mount this at /api — the only
 * difference is the scope they resolve and which permissions they grant.
 *
 * deps: { itemRepo, mediaStore, scopeMediaStore, registry, vision, duplicates, audit, resolveScope }
 */
export function createIntakeRouter(deps) {
  const r = express.Router();
  const { itemRepo, mediaStore, scopeMediaStore, registry, vision, duplicates, audit, resolveScope } = deps;

  const ctxOf = (req) => makeScopeCtx(resolveScope(req));
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  // ---- registry -----------------------------------------------------------
  r.get('/registry', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    res.json({
      rooms: registry.rooms(ctx),
      categories: registry.categories(ctx),
      more_rooms: registry.moreRooms(ctx),
      more_categories: registry.moreCategories(ctx),
      // The list Registry currently seeds. An inventory made before a change
      // still holds the names it was given, so the client needs to know which
      // of them are today's list in order to keep the buttons short. The old
      // names stay valid on every item that already uses one.
      starter_categories: DEFAULT_CATEGORIES,
    });
  }));

  r.post('/rooms', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    // `is_custom: false` marks a room taken off the offered list rather than
    // invented, so it is not shown back to the owner as one of theirs.
    res.json(registry.resolveRoom(req.body.name, ctx, { isCustom: req.body.is_custom !== false, siteId: req.body.site_id || null }));
  }));

  r.post('/categories', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    // `is_custom: false` marks a category pulled off the silent list rather
    // than invented, so it is not shown back to the owner as one of theirs.
    res.json(registry.resolveCategory(req.body.name, ctx, { isCustom: req.body.is_custom !== false }));
  }));

  // ---- walking the house --------------------------------------------------
  // The room, not the item, is the unit of work. These three routes are the
  // whole of it: where am I, this room is finished, I want back into that room.
  r.get('/walkthrough', wrap(async (req, res) => {
    res.json(registry.walkthrough(ctxOf(req)));
  }));

  // Rooms for a specific site (or all rooms if no site_id)
  r.get('/rooms', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const siteId = req.query.site_id || null;
    res.json(registry.rooms(ctx, siteId));
  }));

  // More rooms available to add for a specific site
  r.get('/more-rooms', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const siteId = req.query.site_id || null;
    res.json(registry.moreRooms(ctx, siteId));
  }));

  r.post('/rooms/:roomId/state', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const room = await registry.setRoomState(req.params.roomId, req.body.state, ctx, {
      documented: req.body.documented === true,
    });
    // Return the whole walk, not just the room: the client's next screen is
    // always "what is left", so this saves it a second round trip on a phone
    // that may be on one bar of signal.
    res.json({ room, walkthrough: registry.walkthrough(ctx) });
  }));

  // ---- items --------------------------------------------------------------
  r.get('/items', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const q = {
      review_state: req.query.review_state,
      room_id: req.query.room_id,
      category_id: req.query.category_id,
      search: req.query.search,
      high_value_only: req.query.high_value_only === 'true',
      // Owner's own "this matters" mark. Kept as a distinct query flag from
      // high_value_only on purpose — a FairPlay caller that wants the
      // computed high-value set should never inadvertently pick up items the
      // owner flagged but FairPlay's estimator did not agree with.
      owner_high_value_only: req.query.owner_high_value_only === 'true',
      tentative_high_value_only: req.query.tentative_high_value_only === 'true',
      has_recipient: req.query.has_recipient === undefined ? undefined : req.query.has_recipient === 'true',
      recipient_name: req.query.recipient_name,
      site_id: req.query.site_id || null,
    };
    res.json(await itemRepo.list(q, ctx));
  }));

  r.get('/items/:id', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const item = await itemRepo.get(req.params.id, ctx);
    if (!item) throw new LegacyError('That item was not found.', 'NOT_FOUND', 404);
    res.json(item);
  }));

  r.post('/items', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const body = { ...req.body };
    // Helpers cannot designate items — strip any recipient hint from the
    // request body. They CAN flag items as important (tentative), but
    // assigning items to specific people is owner/co-owner only.
    if (req.participant?.role === 'assistant' && body.recipient_hint) {
      delete body.recipient_hint;
    }
    if (body.room_name) body.room_id = registry.resolveRoom(body.room_name, ctx, { siteId: body.site_id })?.room_id;
    if (body.category_name) body.category_id = registry.resolveCategory(body.category_name, ctx)?.category_id;
    // The registry captures value estimates to help owners understand their
    // here by design — FairPlay sets it from its own AI estimate against the
    // threshold the captain chooses.
    body.high_value_flag = false;
    // The owner's own "this matters" mark, in contrast, IS set here — that is
    // the whole point of the field. It arrives from the client via req.body
    // and is validated in the repository / schema (four allowed reason
    // values). The reason is coerced to '' when the flag is false, so a stale
    // form submission cannot silently attach a reason word to an unflagged
    // item. See docs/decisions/2026-08-06-important-flag.md.
    //
    // The owner-authored comment (owner_important_comment) also arrives via
    // req.body and passes through to the validator, which trims it, enforces
    // a 500-character cap, auto-flags the item when the comment is non-empty,
    // and clears the comment when the flag is false. That comment prints on
    // paper verbatim, per the owner's direction in
    // docs/decisions/2026-08-06-important-comment.md — Registry does not
    // shape the owner's own words. FairPlay does its own appraisal work
    // separately if the owner chooses to use it.
    res.status(201).json(await itemRepo.create(body, ctx));
  }));

  r.patch('/items/:id', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const patch = { ...req.body };
    if (patch.room_name !== undefined) patch.room_id = registry.resolveRoom(patch.room_name, ctx, { siteId: patch.site_id })?.room_id ?? null;
    if (patch.category_name !== undefined) patch.category_id = registry.resolveCategory(patch.category_name, ctx)?.category_id ?? null;
    res.json(await itemRepo.update(req.params.id, patch, ctx));
  }));

  r.delete('/items/:id', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    res.json(await itemRepo.remove(req.params.id, req.query.reason ?? '', ctx));
  }));

  // ---- addendum-side assignment (Two-Output Delivery Model) ---------------
  // Assign or unassign an heir. Body: { heir_id: string | null }.
  r.patch('/items/:id/assign', wrap(async (req, res) => {
    if (req.participant?.role === 'assistant') {
      return res.status(403).json({ error: 'Helpers cannot assign items to people. Only the owner or co-owner can do that.' });
    }
    const ctx = ctxOf(req);
    const heirId = req.body?.heir_id ?? null;
    res.json(await itemRepo.assignHeir(req.params.id, heirId, ctx));
  }));

  // Attach a close-up photo. Body: { photo_id: string | null }.
  r.patch('/items/:id/closeup', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const photoId = req.body?.photo_id ?? null;
    res.json(await itemRepo.setCloseupPhoto(req.params.id, photoId, ctx));
  }));

  // ---- photos -------------------------------------------------------------
  // Body is the already-cropped image, cropped in the browser on a canvas.
  r.post('/items/:id/photos', express.raw({ type: '*/*', limit: '25mb' }), wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const meta = {
      item_id: req.params.id,
      role: req.query.role || PHOTO_ROLE.PRIMARY,
      mime_type: req.get('content-type') || 'image/jpeg',
      crop_bbox: req.query.bbox ? JSON.parse(req.query.bbox) : null,
      source_media_id: req.query.source_media_id ?? null,
      source_frame_index: req.query.frame_index ? Number(req.query.frame_index) : null,
    };
    const saved = await mediaStore.put(req.body, meta, ctx);
    await audit.append({ action: 'photo.add', entity: 'item', entity_id: req.params.id, payload: { photo_id: saved.photo_id, role: meta.role } }, ctx);
    res.status(201).json(saved);
  }));

  r.get('/photos/:photoId', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const p = await mediaStore.getPath(req.params.photoId, ctx);
    if (!p) return res.status(404).end();
    res.sendFile(p);
  }));

  // ---- video and voice ------------------------------------------------------
  // A video walkaround of one object, or the owner saying out loud why the
  // thing matters. Both are stored whole and travel with the item.
  r.post('/items/:id/recordings', express.raw({ type: '*/*', limit: '400mb' }), wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const mime = req.get('content-type') || 'audio/webm';
    const kind = mediaKindFor(mime);
    if (kind === MEDIA_KIND.PHOTO) {
      throw new LegacyError('That file is not a video or a voice recording.', 'BAD_MEDIA_KIND', 400);
    }
    if (!MEDIA_ACCEPT[kind].includes(mime)) {
      throw new LegacyError(`This app cannot read ${mime} files yet. Try recording again in the app.`, 'UNSUPPORTED_MEDIA', 415);
    }
    const saved = await mediaStore.put(req.body, {
      item_id: req.params.id,
      media_kind: kind,
      role: req.query.role || (kind === MEDIA_KIND.AUDIO ? RECORDING_ROLE.ITEM_STORY : RECORDING_ROLE.ITEM_WALKAROUND),
      mime_type: mime,
      duration_ms: req.query.duration_ms ? Number(req.query.duration_ms) : null,
      transcript: req.query.transcript ? decodeURIComponent(req.query.transcript) : '',
      transcript_source: req.query.transcript ? 'speech_recognition' : null,
      label: req.query.label ? decodeURIComponent(req.query.label) : '',
    }, ctx);
    await audit.append({
      action: 'recording.add', entity: 'item', entity_id: req.params.id,
      payload: { photo_id: saved.photo_id, kind, byte_size: saved.byte_size },
    }, ctx);
    res.status(201).json(saved);
  }));

  // A written record of what was said, so the words survive even if the
  // audio format someday does not.
  r.put('/recordings/:photoId/transcript', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const row = await mediaStore.setTranscript(req.params.photoId, req.body?.transcript ?? '', req.body?.source ?? 'manual', ctx);
    if (!row) return res.status(404).json({ error: 'That recording was not found.' });
    await audit.append({ action: 'recording.transcript', entity: 'photo', entity_id: req.params.photoId }, ctx);
    res.json(row);
  }));

  // Recordings that belong to the whole inventory: a room walkthrough, or one
  // message to the entire family.
  r.get('/scope-media', wrap(async (req, res) => {
    if (!scopeMediaStore) return res.json({ media: [] });
    res.json({ media: scopeMediaStore.list(ctxOf(req)) });
  }));

  r.post('/scope-media', express.raw({ type: '*/*', limit: '800mb' }), wrap(async (req, res) => {
    if (!scopeMediaStore) throw new LegacyError('This app does not store whole-inventory recordings.', 'NO_SCOPE_MEDIA', 501);
    const ctx = ctxOf(req);
    const mime = req.get('content-type') || 'video/mp4';
    const saved = await scopeMediaStore.put(req.body, {
      media_kind: mediaKindFor(mime),
      mime_type: mime,
      title: req.query.title ? decodeURIComponent(req.query.title) : '',
      duration_ms: req.query.duration_ms ? Number(req.query.duration_ms) : null,
      transcript: req.query.transcript ? decodeURIComponent(req.query.transcript) : '',
    }, ctx);
    await audit.append({ action: 'scope_media.add', entity: 'scope_media', entity_id: saved.media_id, payload: { kind: saved.media_kind } }, ctx);
    res.status(201).json(saved);
  }));

  r.get('/scope-media/:mediaId', wrap(async (req, res) => {
    const p = scopeMediaStore?.getPath(req.params.mediaId, ctxOf(req));
    if (!p) return res.status(404).end();
    res.sendFile(p);
  }));

  r.delete('/scope-media/:mediaId', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    await audit.append({ action: 'scope_media.remove', entity: 'scope_media', entity_id: req.params.mediaId }, ctx);
    res.json(await scopeMediaStore.remove(req.params.mediaId, ctx));
  }));

  r.delete('/photos/:photoId', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    await audit.append({ action: 'photo.remove', entity: 'photo', entity_id: req.params.photoId }, ctx);
    res.json(await mediaStore.remove(req.params.photoId, ctx));
  }));

  // ---- AI detection -------------------------------------------------------
  // Accepts stills or extracted video keyframes. The browser caps frames at
  // the configured max (default 4, admin can raise to 8) and discards the raw
  // video; only crops are ever stored.
  r.post('/intake/detect', express.json({ limit: '60mb' }), wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const maxFrames = typeof deps.maxFrames === 'function' ? deps.maxFrames() : (deps.maxFrames ?? 4);
    const images = (req.body.images ?? []).slice(0, maxFrames).map((img, i) => ({
      media_id: img.media_id ?? `m${i}`,
      frame_index: img.frame_index ?? i,
      buffer: Buffer.from((img.data_url ?? img.data ?? '').split(',').pop() ?? '', 'base64'),
    }));
    if (!images.length) throw new LegacyError('No photos were received.', 'NO_IMAGES', 400);
    const detections = await vision.detectItems(images, { room_hint: req.body.room_hint });
    await audit.append({ action: 'intake.detect', entity: 'batch', entity_id: null, payload: { images: images.length, detections: detections.length } }, ctx);
    // Tell the client whether a real model looked at the photo. The mock is a
    // deterministic stand-in that picks from a fixed catalogue by image hash;
    // its labels and values mean nothing about the actual object, and the app
    // must never present them as if they did.
    res.json({ detections, vision_mode: vision?.constructor?.name === 'MockVisionProvider' ? 'mock' : 'live' });
  }));

  // ---- Phase 2: Exact identification (Google Cloud Vision Web Detection) ----
  // Takes a cropped close-up of a single item and runs Web Detection to find
  // exact product matches. This is the "Google Lens" experience — it returns
  // best-guess labels, matching pages, and similar images from Google's web
  // index. Only available with the GoogleVisionProvider.
  r.post('/intake/identify', express.json({ limit: '60mb' }), wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const dataUrl = req.body.data_url ?? req.body.data ?? '';
    const buffer = Buffer.from(dataUrl.split(',').pop() ?? '', 'base64');
    if (!buffer.length) throw new LegacyError('No image was received.', 'NO_IMAGE', 400);

    const result = await vision.describeItem(
      { buffer, media_id: req.body.media_id ?? null },
      { hint: req.body.hint ?? null, room_hint: req.body.room_hint ?? null }
    );

    await audit.append({
      action: 'intake.identify',
      entity: 'item',
      entity_id: req.body.item_id ?? null,
      payload: {
        web_match: result.web_match ?? false,
        best_guess: result.title ?? null,
        confidence: result.confidence ?? 0,
      },
    }, ctx);

    res.json(result);
  }));

  // Commit accepted detections as draft items for review.
  r.post('/intake/commit', express.json({ limit: '60mb' }), wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const created = [];
    for (const d of req.body.detections ?? []) {
      // AI tentative flag evaluation (server-side, for batch room intake):
      // Registry doesn't value items, but the vision model can still flag
      // based on rarity (appraisal_suggested), maker marks, category, or
      // low confidence. These queue for owner review, same as helper flags.
      let aiTentative = false;
      let aiTentativeReason = '';
      if (d.appraisal_suggested) {
        aiTentative = true;
        aiTentativeReason = 'AI flagged: may warrant professional appraisal';
      } else if (d.maker_identified) {
        aiTentative = true;
        aiTentativeReason = 'AI flagged: brand or maker mark visible';
      } else {
        const cat = (d.category_hint || '').toLowerCase();
        const flaggedCats = ['jewelry', 'jewellery', 'art', 'painting', 'sculpture',
          'antique', 'collectible', 'firearm', 'firearms', 'gun', 'coins', 'coin',
          'silver', 'gold', 'watch', 'watches', 'instrument', 'rug', 'tapestry'];
        if (flaggedCats.some((c) => cat.includes(c))) {
          aiTentative = true;
          aiTentativeReason = 'AI flagged: ' + cat + ' \u2014 worth a closer look';
        } else if (d.confidence != null && d.confidence < 0.45) {
          aiTentative = true;
          aiTentativeReason = 'AI flagged: low confidence identification';
        }
      }
      const item = await itemRepo.create({
        title: d.label,
        category_id: d.category_hint ? registry.resolveCategory(d.category_hint, ctx)?.category_id : null,
        room_id: d.room_hint ? registry.resolveRoom(d.room_hint, ctx)?.room_id : null,
        quantity: d.quantity ?? 1,
        identifiers: d.identifiers ?? {},
        // AI value estimates are captured and stored as advisory metadata.
      // They are visible to the owner in the app and transfer to the fiduciary
      // on export, but are NOT printed on the memorandum (probate complications
      // in many states). The owner's own value_estimate_cents, if they set one,
      // is also kept in the DB but excluded from print. Value_basis stays
      // 'unknown' for AI estimates — the owner can override with their own.
        value_estimate_cents: null,
        value_basis: 'unknown',
        // The AI's suggested value range is stored as metadata so the owner
        // can see it on the review screen. It is advisory only — the registry
        // never treats it as authoritative. The owner's own value_estimate_cents
        // (if they set one) is what prints. See docs/decisions/2026-08-20-ai-value-display.md
        ai_value_suggestion: d.value_suggestion ?? null,
        ai_value_unknown_reason: d.value_unknown_reason ?? null,
        // Never set by the registry. FairPlay's job.
        high_value_flag: false,
        // Bulk intake never decides what matters to the owner — that mark is
        // only ever set by the owner from the review step. Detections land as
        // "not flagged, no reason" and the owner can flip the flag from there.
        owner_high_value: false,
        owner_high_value_reason: '',
        // AI-sourced tentative flag: queued for owner review during room
        // completion. Not a permanent mark — the owner confirms or dismisses.
        tentative_high_value: aiTentative,
        tentative_high_value_source: aiTentative ? 'ai' : '',
        tentative_high_value_reason: aiTentativeReason,
        // Bulk intake also never writes the owner's comment. A comment is a
        // deliberate authorial act; a walkthrough detection is not. The
        // owner opens the item and writes anything they want to write.
        owner_important_comment: '',
        ai_confidence: d.confidence ?? null,
        review_state: REVIEW_STATE.DRAFT,
        // Tag the item with the active site so reports can group by location.
        // The client passes this from the geosyncing state (cap.siteId or
        // activeSiteId). Falls back to null for legacy items without a site.
        site_id: d.site_id ?? null,
      }, ctx);
      if (d.crop_data_url) {
        await mediaStore.put(Buffer.from(d.crop_data_url.split(',').pop(), 'base64'), {
          item_id: item.item_id, role: PHOTO_ROLE.PRIMARY, mime_type: 'image/jpeg',
          crop_bbox: d.bbox ?? null, source_media_id: d.source_media_id ?? null,
          source_frame_index: d.frame_index ?? null,
        }, ctx);
      }
      created.push(item.item_id);
    }
    // Count possible duplicates, but record nothing. Saving must never hand the
    // owner a mandatory review — the goal is to get things documented. The
    // review is offered on request via /intake/duplicates/scan, and the
    // captain can also do it later in Reindeer: FairPlay.
    const possibleDuplicates = created.length ? await duplicates.previewBatch(created, ctx) : 0;
    res.status(201).json({ created, possible_duplicates: possibleDuplicates });
  }));

  // ---- review + duplicates ------------------------------------------------
  r.post('/items/:id/keep', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    res.json(await itemRepo.update(req.params.id, { review_state: REVIEW_STATE.KEPT }, ctx));
  }));

  r.post('/items/:id/reject', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    res.json(await itemRepo.update(req.params.id, { review_state: REVIEW_STATE.REJECTED }, ctx));
  }));

  // ---- tentative high-value: owner review endpoints -----------------------
  // Confirm: promote a tentative flag to a permanent owner_high_value.
  // The helper's tentative reason becomes the owner_high_value_reason.
  r.post('/items/:id/confirm-important', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    const item = await itemRepo.get(req.params.id, ctx);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const reason = item.tentative_high_value_reason || '';
    res.json(await itemRepo.update(req.params.id, {
      owner_high_value: true,
      owner_high_value_reason: reason,
      tentative_high_value: false,
      tentative_high_value_source: '',
      tentative_high_value_reason: '',
      review_state: REVIEW_STATE.KEPT,
    }, ctx));
  }));

  // Dismiss: remove the tentative flag without promoting.
  r.post('/items/:id/dismiss-important', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    res.json(await itemRepo.update(req.params.id, {
      tentative_high_value: false,
      tentative_high_value_source: '',
      tentative_high_value_reason: '',
    }, ctx));
  }));

  r.get('/duplicates/scan', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    res.json({ groups: await duplicates.scanCatalog(ctx) });
  }));

  r.post('/duplicates/:groupId/resolve', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    res.json(await duplicates.resolve(req.params.groupId, req.body.action, ctx));
  }));

  // ---- audit --------------------------------------------------------------
  r.get('/audit', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    res.json({ entries: await audit.list({ limit: Number(req.query.limit) || 100 }, ctx) });
  }));

  r.get('/audit/verify', wrap(async (req, res) => {
    const ctx = ctxOf(req);
    res.json(await audit.verify(ctx));
  }));

  return r;
}

/** Shared error handler so both apps return the same plain-language shape. */
export function legacyErrorHandler(err, _req, res, _next) {
  const status = err.status ?? 500;
  if (status >= 500) console.error(err);
  // Only expose specific error details for client errors (4xx).
  // For 500s, return a generic message so internal stack traces and
  // DB errors don't leak to the client.
  const isClientError = status >= 400 && status < 500;
  res.status(status).json({
    error: isClientError ? (err.message || 'Bad Request') : 'Something went wrong.',
    code: isClientError ? (err.code ?? 'CLIENT_ERROR') : 'INTERNAL',
    details: isClientError ? (err.details ?? null) : null,
  });
}
