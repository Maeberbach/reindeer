import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ulid } from '@reindeer/core-data';
import {
  parseTypedEnvelope,
  ENVELOPE_TYPE_INVENTORY,
  ENVELOPE_TYPE_ADDENDUM,
  TYPED_ENVELOPE_VERSION,
} from './v1/typed-envelopes.js';
import { zipSync, unzipSync } from './zip.js';

/**
 * Two-Output bundle writer/reader.
 *
 * Two new bundle formats live beside the existing `.reindeer` bundle:
 *
 *   \u2022 reindeer-exchange-inventory-bundle v1.0  \u2014  the trustee's copy of
 *     everything the owner ever added. One recipient. All photos travel.
 *     No voice. No per-item assignments.
 *
 *   \u2022 reindeer-exchange-addendum-bundle  v1.0  \u2014  the assigned-items packet
 *     sent to the wills caretaker and the trustee on every signing.
 *     Versioned. Close-up photos required (or listed in gaps). Voice
 *     message optional. Envelope carries owner signature evidence.
 *
 * The existing `bundle.js` writeBundle / readBundle path is untouched \u2014
 * this file is additive. Callers who want the old .reindeer shape keep
 * using writeBundle; callers who want the new two-output shapes use
 * writeInventoryBundle or writeAddendumBundle.
 */

const INVENTORY_MANIFEST_FORMAT = 'reindeer-exchange-inventory-bundle';
const ADDENDUM_MANIFEST_FORMAT = 'reindeer-exchange-addendum-bundle';
const MANIFEST_VERSION = '1.0';
const INVENTORY_FILE_EXT = '.inventory';
const ADDENDUM_FILE_EXT = '.addendum';

export const INVENTORY_BUNDLE_FORMAT = INVENTORY_MANIFEST_FORMAT;
export const ADDENDUM_BUNDLE_FORMAT = ADDENDUM_MANIFEST_FORMAT;
export const TWO_OUTPUTS_BUNDLE_VERSION = MANIFEST_VERSION;

/**
 * Cover text placed as README.txt at the top of every bundle. The trustee
 * or attorney opening the zip sees this before anything else.
 *
 * The three-point statement is the user’s exact copy from the commit 4
 * decision: Registry is a preparation tool, not a legal document; the
 * paper the owner handed you is what governs; the owner could have
 * replaced or amended this memorandum at any time — on paper, with or
 * without the app.
 */
function buildCoverText(kind) {
  const bundleLabel =
    kind === 'inventory'
      ? 'This bundle is a copy of the owner’s personal-property inventory.'
      : 'This bundle is a copy of the owner’s signed memorandum of tangible personal property.';
  return [
    'ABOUT THIS BUNDLE',
    '',
    bundleLabel,
    '',
    'Please read this first.',
    '',
    '  1. Registry is a preparation tool, not a legal document.',
    '  2. The paper the owner handed you — or that is on file with',
    '     the will — is what governs.',
    '  3. The owner could replace or amend this memorandum at any',
    '     time, on paper, with or without this app. A newer paper',
    '     memorandum, if one exists, takes precedence over anything',
    '     in this bundle.',
    '',
    'The contents (envelope.json, manifest.json, checksums.txt, and',
    'the media/ folder) are provided so a family process, or Reindeer:',
    'FairPlay, can work from a faithful record of what the owner',
    'wrote down. Nothing in this bundle overrides the will or a',
    'signed paper memorandum.',
    '',
    'Reindeer Suite',
    '',
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* Inventory                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Pack an inventory bundle from an already-built inventory envelope.
 *
 * The envelope carries the item list; this function walks it, pulls every
 * referenced media file off disk, and zips the result. It never reads the
 * item repo directly \u2014 that's the caller's job. That separation lets a
 * later "trustee test" endpoint feed a filtered subset without touching the
 * writer.
 *
 * @param {object}   opts.envelope        \u2014 inventory envelope from buildInventoryEnvelope
 * @param {object}   opts.mediaStore      \u2014 FsMediaStore
 * @param {object}   [opts.scopeMediaStore] \u2014 optional ScopeMediaStore
 * @param {object[]} [opts.scopeMedia]    \u2014 scope-level media rows if not derivable
 * @param {object}   opts.ctx             \u2014 scope ctx
 * @returns {Promise<{ buffer, fileName, batchId, manifest }>}
 */
export async function writeInventoryBundle({ envelope, mediaStore, scopeMediaStore, scopeMedia = [], ctx }) {
  if (!envelope || envelope.envelope_type !== ENVELOPE_TYPE_INVENTORY) {
    throw Object.assign(
      new Error('writeInventoryBundle requires an inventory envelope built by buildInventoryEnvelope().'),
      { status: 400 },
    );
  }

  const entries = [];
  const checksums = [];

  const envelopeJson = Buffer.from(JSON.stringify(envelope, null, 2), 'utf8');
  entries.push({ name: 'envelope.json', data: envelopeJson });
  const envelopeSha = sha256(envelopeJson);
  checksums.push(`${envelopeSha}  envelope.json`);

  // README.txt — the cover letter. Trustee sees it before opening JSON.
  const readmeBuf = Buffer.from(buildCoverText('inventory'), 'utf8');
  entries.push({ name: 'README.txt', data: readmeBuf });
  checksums.push(`${sha256(readmeBuf)}  README.txt`);

  // Every photo, video walkaround, and voice recording attached to any item
  // travels with the inventory \u2014 that's the point of the trustee copy.
  for (const item of envelope.items ?? []) {
    for (const p of item.media ?? item.photos ?? []) {
      if (!p?.photo_id) continue;
      const full = await mediaStore.getPath(p.photo_id, ctx);
      if (!full || !fs.existsSync(full)) continue;
      const data = fs.readFileSync(full);
      const rel = `media/${p.file_name}`;
      entries.push({ name: rel, data });
      checksums.push(`${sha256(data)}  ${rel}`);
    }
  }

  // Scope-level owner recordings (walkarounds, general notes) go under
  // media/_scope/ so the trustee can find them separately from per-item
  // photos. Optional \u2014 the addendum handles owner voice; this is the older
  // "walk the room and talk" mode.
  const scopeRows = scopeMedia?.length ? scopeMedia
    : (scopeMediaStore && typeof scopeMediaStore.list === 'function' ? scopeMediaStore.list(ctx) : []);
  for (const m of scopeRows) {
    const full = scopeMediaStore.getPath(m.media_id, ctx);
    if (!full || !fs.existsSync(full)) continue;
    const data = fs.readFileSync(full);
    const rel = `media/_scope/${m.file_name}`;
    entries.push({ name: rel, data });
    checksums.push(`${sha256(data)}  ${rel}`);
  }

  const batchId = ulid();
  const manifest = {
    format: INVENTORY_MANIFEST_FORMAT,
    version: MANIFEST_VERSION,
    batch_id: batchId,
    created_at: new Date().toISOString(),
    envelope_type: ENVELOPE_TYPE_INVENTORY,
    envelope_version: TYPED_ENVELOPE_VERSION,
    envelope_sha256: envelopeSha,
    source: envelope.source ?? null,
    recipient: envelope.recipient ?? null,
    counts: envelope.counts ?? {},
    total_media_bytes: entries
      .filter((e) => e.name.startsWith('media/'))
      .reduce((s, e) => s + e.data.length, 0),
    files: entries.map((e) => e.name),
  };
  entries.unshift({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });
  entries.push({ name: 'checksums.txt', data: Buffer.from(checksums.join('\n'), 'utf8') });

  const buffer = zipSync(entries);
  const fileName = `reindeer-inventory-${batchId.slice(0, 10)}${INVENTORY_FILE_EXT}`;
  return { buffer, fileName, batchId, manifest, envelopeSha256: envelopeSha };
}

export function readInventoryBundle(buffer) {
  const files = unzipSync(buffer);
  const manifest = requireManifest(files, INVENTORY_MANIFEST_FORMAT);
  const envelopeRaw = requireFile(files, 'envelope.json');
  const envelope = parseTypedEnvelope(envelopeRaw.toString('utf8'));
  if (envelope.envelope_type !== ENVELOPE_TYPE_INVENTORY) {
    throw new Error(`Bundle manifest says inventory but envelope_type is "${envelope.envelope_type}".`);
  }
  const problems = verifyChecksums(files);
  return { envelope, manifest, files, problems };
}

/* -------------------------------------------------------------------------- */
/* Addendum                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Pack an addendum bundle from an already-built, signed addendum envelope.
 *
 * The envelope carries the assigned items + gaps + voice message metadata.
 * This function pulls the referenced close-up photos and voice media off
 * disk into `media/closeups/` and `media/voice/` respectively.
 *
 * Callers pass a `closeupPathResolver({ item_id, photo_id }) \u2192 string|null`
 * so we do not couple this writer to any particular media store shape.
 * `voiceMediaPath` is the absolute path to the owner's voice recording, or
 * null when there is no voice message.
 *
 * @param {object}   opts.envelope             \u2014 addendum envelope
 * @param {Function} opts.closeupPathResolver  \u2014 ({item_id, photo_id}) => string|null
 * @param {string|null} [opts.voiceMediaPath]
 * @returns {Promise<{ buffer, fileName, batchId, manifest, envelopeSha256 }>}
 */
export async function writeAddendumBundle({ envelope, closeupPathResolver, voiceMediaPath = null }) {
  if (!envelope || envelope.envelope_type !== ENVELOPE_TYPE_ADDENDUM) {
    throw Object.assign(
      new Error('writeAddendumBundle requires an addendum envelope built by buildAddendumEnvelope().'),
      { status: 400 },
    );
  }
  if (typeof closeupPathResolver !== 'function') {
    throw Object.assign(new Error('writeAddendumBundle requires a closeupPathResolver function.'), { status: 400 });
  }

  const entries = [];
  const checksums = [];

  const envelopeJson = Buffer.from(JSON.stringify(envelope, null, 2), 'utf8');
  entries.push({ name: 'envelope.json', data: envelopeJson });
  const envelopeSha = sha256(envelopeJson);
  checksums.push(`${envelopeSha}  envelope.json`);

  // README.txt — the cover letter. Trustee sees it before opening JSON.
  const readmeBuf = Buffer.from(buildCoverText('addendum'), 'utf8');
  entries.push({ name: 'README.txt', data: readmeBuf });
  checksums.push(`${sha256(readmeBuf)}  README.txt`);

  // Close-up photos. Each item with a closeup_photo reference gets its file
  // pulled from disk under media/closeups/. Items in the gaps array are
  // skipped without complaint \u2014 that's exactly what "gap" means.
  const missingCloseups = [];
  for (const item of envelope.items ?? []) {
    const closeup = item.closeup_photo;
    if (!closeup) continue;
    // Envelope items keep item_id under `id`; some callers pass raw DB rows
    // where it lives under `item_id`. Accept both so the resolver always
    // gets something useful to key on.
    const itemId = item.id ?? item.item_id ?? null;
    const photoId = closeup.photo_id ?? closeup.id ?? null;
    const fileName = closeup.file_name ?? (closeup.file ? path.basename(closeup.file) : null);
    const filePath = closeupPathResolver({ item_id: itemId, photo_id: photoId, file_name: fileName });
    if (!filePath || !fs.existsSync(filePath)) {
      missingCloseups.push({ item_id: itemId, file_name: fileName });
      continue;
    }
    const data = fs.readFileSync(filePath);
    const rel = `media/closeups/${itemId}${path.extname(fileName || '') || '.jpg'}`;
    entries.push({ name: rel, data });
    checksums.push(`${sha256(data)}  ${rel}`);
    // Rewrite the envelope's per-item pointer? No \u2014 the envelope was signed;
    // touching it would invalidate the signature. Instead the trustee reader
    // matches by item_id: photo file names inside media/closeups/ start with
    // the item_id, which is stable and referenced by the envelope.
  }

  // Voice message. The envelope carries the transcript and metadata; only
  // the audio file itself needs to be added to the bundle.
  if (envelope.voice_message && voiceMediaPath) {
    if (fs.existsSync(voiceMediaPath)) {
      const data = fs.readFileSync(voiceMediaPath);
      const declaredName = envelope.voice_message.file?.replace(/^media\//, '') ?? path.basename(voiceMediaPath);
      const rel = `media/${declaredName.startsWith('voice/') ? declaredName : `voice/${path.basename(voiceMediaPath)}`}`;
      entries.push({ name: rel, data });
      checksums.push(`${sha256(data)}  ${rel}`);
      // The declared voice checksum in the envelope should already match this
      // file (the app hashed it before signing). We verify anyway so a
      // trustee reader sees the mismatch immediately.
      if (envelope.voice_message.checksum && envelope.voice_message.checksum !== sha256(data)) {
        throw Object.assign(
          new Error('The signed envelope\u2019s voice_message.checksum does not match the audio file on disk.'),
          { status: 500 },
        );
      }
      // Transcript alongside for human readers.
      if (envelope.voice_message.transcript) {
        const t = Buffer.from(envelope.voice_message.transcript + '\n', 'utf8');
        entries.push({ name: 'voice-transcript.txt', data: t });
        checksums.push(`${sha256(t)}  voice-transcript.txt`);
      }
    } else if (envelope.voice_message.file) {
      throw Object.assign(
        new Error(`The signed envelope references a voice message but the audio file is not on disk: ${voiceMediaPath}`),
        { status: 500 },
      );
    }
  }

  const batchId = ulid();
  const manifest = {
    format: ADDENDUM_MANIFEST_FORMAT,
    version: MANIFEST_VERSION,
    batch_id: batchId,
    created_at: new Date().toISOString(),
    envelope_type: ENVELOPE_TYPE_ADDENDUM,
    envelope_version: TYPED_ENVELOPE_VERSION,
    envelope_sha256: envelopeSha,
    addendum_version: envelope.addendum_version,
    supersedes_version: envelope.supersedes_version ?? null,
    owner: envelope.owner ?? null,
    recipients: envelope.recipients ?? [],
    counts: envelope.counts ?? {},
    missing_closeups: missingCloseups,
    total_media_bytes: entries
      .filter((e) => e.name.startsWith('media/'))
      .reduce((s, e) => s + e.data.length, 0),
    files: entries.map((e) => e.name),
  };
  entries.unshift({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });
  entries.push({ name: 'checksums.txt', data: Buffer.from(checksums.join('\n'), 'utf8') });

  const buffer = zipSync(entries);
  const fileName = `reindeer-addendum-v${envelope.addendum_version}-${batchId.slice(0, 10)}${ADDENDUM_FILE_EXT}`;
  return { buffer, fileName, batchId, manifest, envelopeSha256: envelopeSha };
}

export function readAddendumBundle(buffer) {
  const files = unzipSync(buffer);
  const manifest = requireManifest(files, ADDENDUM_MANIFEST_FORMAT);
  const envelopeRaw = requireFile(files, 'envelope.json');
  const envelope = parseTypedEnvelope(envelopeRaw.toString('utf8'));
  if (envelope.envelope_type !== ENVELOPE_TYPE_ADDENDUM) {
    throw new Error(`Bundle manifest says addendum but envelope_type is "${envelope.envelope_type}".`);
  }
  const problems = verifyChecksums(files);
  return { envelope, manifest, files, problems };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function requireFile(files, name) {
  const buf = files.get(name);
  if (!buf) throw new Error(`Bundle is missing ${name}.`);
  return buf;
}

function requireManifest(files, expectedFormat) {
  const manifestRaw = files.get('manifest.json');
  if (!manifestRaw) throw new Error('Bundle is missing manifest.json.');
  const manifest = JSON.parse(manifestRaw.toString('utf8'));
  if (manifest.format !== expectedFormat) {
    throw new Error(`Expected manifest.format "${expectedFormat}", got "${manifest.format}".`);
  }
  if (manifest.version !== MANIFEST_VERSION) {
    throw new Error(`Bundle manifest version ${manifest.version} is not readable by this app (expected ${MANIFEST_VERSION}).`);
  }
  return manifest;
}

function verifyChecksums(files) {
  const problems = [];
  const checks = files.get('checksums.txt')?.toString('utf8').split('\n').filter(Boolean) ?? [];
  for (const line of checks) {
    const [hash, name] = line.split(/\s+/);
    const data = files.get(name);
    if (!data) { problems.push(`Missing file: ${name}`); continue; }
    if (sha256(data) !== hash) problems.push(`Checksum mismatch: ${name}`);
  }
  return problems;
}

export function saveBundleToDisk(buffer, dir, fileName) {
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, fileName);
  fs.writeFileSync(full, buffer);
  return full;
}
