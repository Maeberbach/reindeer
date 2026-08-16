import { ulid } from '../db/index.js';

/**
 * Signed addendum versions.
 *
 * The table has an audit-log character: every signing writes a new row, and
 * old rows are never mutated. `supersedes_version` records the version this
 * signing replaces; a reader looking at the trustee's file can walk the chain
 * backwards to see the whole history of the owner's choices.
 *
 * In Couple mode, each spouse gets a separate version stream keyed on
 * `owner_participant_id`. The UNIQUE(scope_id, owner_participant_id,
 * version_number) index enforces that stream separation.
 */
export class AddendumVersionsRepo {
  constructor(db, audit = null) { this.db = db; this.audit = audit; }

  list(ctx, ownerParticipantId = null) {
    if (ownerParticipantId != null) {
      return this.db.prepare(
        `SELECT * FROM addendum_versions
          WHERE scope_id = ? AND owner_participant_id = ?
          ORDER BY version_number DESC`,
      ).all(ctx.scopeId, ownerParticipantId).map(shape);
    }
    return this.db.prepare(
      `SELECT * FROM addendum_versions
        WHERE scope_id = ?
        ORDER BY owner_participant_id, version_number DESC`,
    ).all(ctx.scopeId).map(shape);
  }

  get(versionId, ctx) {
    const row = this.db.prepare(
      'SELECT * FROM addendum_versions WHERE version_id = ? AND scope_id = ?',
    ).get(versionId, ctx.scopeId);
    return row ? shape(row) : null;
  }

  /**
   * The latest version for an owner \u2014 null when none have been signed yet.
   * The next signing must be one higher.
   */
  latestFor(ownerParticipantId, ctx) {
    const row = this.db.prepare(
      `SELECT * FROM addendum_versions
        WHERE scope_id = ? AND owner_participant_id = ?
        ORDER BY version_number DESC LIMIT 1`,
    ).get(ctx.scopeId, ownerParticipantId);
    return row ? shape(row) : null;
  }

  /**
   * Record a signed version. Everything about the bundle that the trustee
   * or a court might one day ask about lives here: the signature evidence,
   * the recipient list at signing time, the items snapshot, and the
   * SHA-256 of the envelope.json inside the bundle.
   */
  record({
    ownerParticipantId,
    versionNumber,
    supersedes = null,
    signedAt,
    signatureEvidence = {},
    recipients = [],
    voiceMessage = null,
    itemsSnapshot = [],
    gaps = [],
    envelopeSha256 = '',
    bundlePath = '',
  }, ctx) {
    if (!ownerParticipantId) {
      throw Object.assign(new Error('An addendum needs an owner participant id.'), { status: 400 });
    }
    if (!Number.isInteger(versionNumber) || versionNumber < 1) {
      throw Object.assign(new Error('version_number must be a positive integer.'), { status: 400 });
    }
    if (supersedes != null && (!Number.isInteger(supersedes) || supersedes >= versionNumber)) {
      throw Object.assign(new Error('supersedes must be a prior version_number.'), { status: 400 });
    }
    const versionId = ulid();
    const now = new Date().toISOString();
    try {
      this.db.prepare(
        `INSERT INTO addendum_versions
           (version_id, scope_id, owner_participant_id, version_number, supersedes_version,
            signed_at, signature_evidence, recipients, voice_message, items_snapshot, gaps,
            envelope_sha256, bundle_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        versionId, ctx.scopeId, ownerParticipantId, versionNumber, supersedes,
        signedAt || now,
        JSON.stringify(signatureEvidence),
        JSON.stringify(recipients),
        voiceMessage ? JSON.stringify(voiceMessage) : null,
        JSON.stringify(itemsSnapshot),
        JSON.stringify(gaps),
        envelopeSha256, bundlePath, now,
      );
    } catch (e) {
      if (String(e.message).includes('UNIQUE constraint failed')) {
        throw Object.assign(
          new Error(`Addendum version ${versionNumber} for this owner already exists.`),
          { status: 409 },
        );
      }
      throw e;
    }
    this.audit?.append?.({
      action: 'addendum.record', entity: 'addendum', entity_id: versionId,
      payload: { version_number: versionNumber, owner_participant_id: ownerParticipantId },
    }, ctx);
    return this.get(versionId, ctx);
  }

  /**
   * Freeze the latest signed version for an owner. Called by the trustee
   * action \u201cmark owner deceased\u201d in Registry \u2014 after this point,
   * new signings for that owner are rejected, and the frozen row is what
   * travels with every death-triggered export.
   *
   * Registry never guesses a death. Only an explicit trustee (or the app
   * owner acting as trustee for a spouse) may set this. See the freeze
   * router action in apps/reindeer-registry.
   *
   * Idempotent: refreezing a row is a no-op. Attempting to freeze when
   * there is no signed version returns null so the caller can respond
   * with a friendly message.
   */
  freezeLatest({ ownerParticipantId, frozenAt = null, frozenByParticipantId = null, frozenNote = '' }, ctx) {
    const latest = this.latestFor(ownerParticipantId, ctx);
    if (!latest) return null;
    if (latest.frozen_at) return latest; // idempotent
    const stamp = frozenAt || new Date().toISOString();
    this.db.prepare(
      `UPDATE addendum_versions
          SET frozen_at = ?, frozen_by_participant_id = ?, frozen_note = ?
        WHERE version_id = ? AND scope_id = ?`,
    ).run(stamp, frozenByParticipantId, frozenNote || '', latest.version_id, ctx.scopeId);
    this.audit?.append?.({
      action: 'addendum.freeze', entity: 'addendum', entity_id: latest.version_id,
      payload: {
        version_number: latest.version_number,
        owner_participant_id: ownerParticipantId,
        frozen_by_participant_id: frozenByParticipantId,
      },
    }, ctx);
    return this.get(latest.version_id, ctx);
  }

  /**
   * All frozen memoranda for the current scope, one per owner, in the
   * order they were frozen. Used by the export path to snapshot every
   * memorandum on record into the outgoing bundle.
   *
   * A memorandum only appears here after `freezeLatest` marks the owner
   * deceased. Living owners' signings are excluded from exports \u2014 Fair
   * Choice must never see a memorandum that could still change.
   */
  listFrozen(ctx) {
    return this.db.prepare(
      `SELECT * FROM addendum_versions
         WHERE scope_id = ? AND frozen_at IS NOT NULL
         ORDER BY frozen_at ASC`,
    ).all(ctx.scopeId).map(shape);
  }
}

function shape(row) {
  return {
    version_id: row.version_id,
    owner_participant_id: row.owner_participant_id,
    version_number: row.version_number,
    supersedes_version: row.supersedes_version,
    signed_at: row.signed_at,
    signature_evidence: parseJson(row.signature_evidence, {}),
    recipients: parseJson(row.recipients, []),
    voice_message: row.voice_message ? parseJson(row.voice_message, null) : null,
    items_snapshot: parseJson(row.items_snapshot, []),
    gaps: parseJson(row.gaps, []),
    envelope_sha256: row.envelope_sha256 || '',
    bundle_path: row.bundle_path || '',
    created_at: row.created_at,
    // Death-freeze fields (migration 12). null until the trustee marks the
    // owner deceased through the freeze action.
    frozen_at: row.frozen_at ?? null,
    frozen_by_participant_id: row.frozen_by_participant_id ?? null,
    frozen_note: row.frozen_note ?? '',
  };
}

function parseJson(v, fallback) {
  if (v == null) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}
