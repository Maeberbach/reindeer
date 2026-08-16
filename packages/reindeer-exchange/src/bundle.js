import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ulid } from '@reindeer-legacy/core-data';
import { buildEnvelope, parseEnvelope } from './v1/envelope.js';
import { toCsv } from './v1/csv.js';
import { zipSync, unzipSync } from './zip.js';

/**
 * Writes a .reindeer bundle: manifest + items.json + items.csv + media + checksums.
 * This is the file the owner hands to the estate administrator.
 */
export async function writeBundle({
  itemRepo, mediaStore, scopeMediaStore, registry, query, source, ctx,
  // Optional: when the Registry export runs on a death-triggered bundle,
  // the caller passes these two repos so the export can freeze the
  // memoranda into the envelope. Older callers (tests, dev exports) omit
  // them and get an envelope with no locked_memoranda \u2014 exactly the
  // behaviour before commit 4.
  addendumVersions = null,
  people = null,
}) {
  const { items } = await itemRepo.list(query ?? { review_state: 'kept' }, ctx);
  const scopeMedia = scopeMediaStore ? scopeMediaStore.list(ctx) : [];

  // Assemble the frozen memoranda that travel with this export. Only rows
  // marked frozen_at (trustee action after death) are included \u2014 living
  // owners' signings never leak into a FairPlay bundle.
  const lockedMemoranda = [];
  if (addendumVersions?.listFrozen) {
    for (const row of addendumVersions.listFrozen(ctx)) {
      const ownerName = safeOwnerName(people, row.owner_participant_id, ctx);
      const itemIds = Array.isArray(row.items_snapshot)
        ? row.items_snapshot.map((it) => it?.id).filter(Boolean)
        : [];
      lockedMemoranda.push({
        owner_name: ownerName,
        signed_at: row.signed_at,
        version_number: row.version_number,
        item_ids: itemIds,
      });
    }
  }

  const envelope = buildEnvelope({
    items,
    rooms: registry.rooms(ctx),
    categories: registry.categories(ctx),
    scopeMedia,
    source,
    lockedMemoranda,
  });

  const entries = [];
  const checksums = [];

  const itemsJson = Buffer.from(JSON.stringify(envelope, null, 2), 'utf8');
  entries.push({ name: 'items.json', data: itemsJson });
  entries.push({ name: 'items.csv', data: Buffer.from(toCsv(envelope), 'utf8') });

  // Photos, video walkarounds, and voice recordings all travel in the bundle.
  for (const item of items) {
    for (const p of item.media ?? item.photos ?? []) {
      const full = await mediaStore.getPath(p.photo_id, ctx);
      if (!full || !fs.existsSync(full)) continue;
      const data = fs.readFileSync(full);
      entries.push({ name: `media/${p.file_name}`, data });
      checksums.push(`${crypto.createHash('sha256').update(data).digest('hex')}  media/${p.file_name}`);
    }
  }
  for (const m of scopeMedia) {
    const full = scopeMediaStore.getPath(m.media_id, ctx);
    if (!full || !fs.existsSync(full)) continue;
    const data = fs.readFileSync(full);
    entries.push({ name: `media/_scope/${m.file_name}`, data });
    checksums.push(`${crypto.createHash('sha256').update(data).digest('hex')}  media/_scope/${m.file_name}`);
  }

  // A plain-text transcript index, so the trustee can read what was said
  // without playing a single file.
  const transcriptText = buildTranscriptIndex(items, scopeMedia, source);
  entries.push({ name: 'transcripts.txt', data: Buffer.from(transcriptText, 'utf8') });
  checksums.push(`${crypto.createHash('sha256').update(itemsJson).digest('hex')}  items.json`);

  const batchId = ulid();
  const manifest = {
    format: 'legacy-exchange-bundle',
    version: '1.0',
    batch_id: batchId,
    created_at: new Date().toISOString(),
    source,
    counts: envelope.counts,
    total_media_bytes: entries.filter((e) => e.name.startsWith('media/')).reduce((s, e) => s + e.data.length, 0),
    files: entries.map((e) => e.name),
  };
  entries.unshift({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });
  entries.push({ name: 'checksums.txt', data: Buffer.from(checksums.join('\n'), 'utf8') });

  const buffer = zipSync(entries);
  await itemRepo.markExported(items.map((i) => i.item_id), batchId, ctx);
  return { buffer, batchId, manifest, envelope, fileName: `reindeer-registry-${batchId.slice(0, 10)}.reindeer` };
}

function buildTranscriptIndex(items, scopeMedia, source) {
  const lines = [
    `Recordings and transcripts — ${source?.owner_name ?? 'inventory'}`,
    `Generated ${new Date().toLocaleString()}`,
    '',
  ];
  for (const m of scopeMedia) {
    lines.push(`[${m.media_kind.toUpperCase()}] ${m.title || 'Untitled recording'}  (${m.file_name})`);
    lines.push(m.transcript ? indent(m.transcript) : '    (no transcript)');
    lines.push('');
  }
  for (const i of items) {
    const recs = (i.media ?? []).filter((p) => p.media_kind === 'video' || p.media_kind === 'audio');
    if (!recs.length) continue;
    lines.push(`${i.title}`);
    for (const r of recs) {
      lines.push(`  [${r.media_kind.toUpperCase()}] ${r.label || r.role}  (${r.file_name})`);
      lines.push(r.transcript ? indent(r.transcript, '    ') : '    (no transcript)');
    }
    lines.push('');
  }
  if (lines.length === 3) lines.push('No recordings were included in this package.');
  return lines.join('\n');
}

const indent = (s, pad = '  ') => s.split('\n').map((l) => pad + l).join('\n');

/**
 * Best-effort owner name lookup. Registry participants may be stored under
 * different shapes across code paths; this helper checks the two common
 * repo methods and falls back to a friendly placeholder rather than
 * exposing an internal ULID.
 *
 * FairPlay groups greyed items by owner name (the user's decision \u2014
 * no gender assumptions like Mom/Dad). If Registry cannot resolve the
 * name here, an empty string tells the FC importer to group under
 * \u201cUnknown owner\u201d, which is at least accurate.
 */
function safeOwnerName(people, participantId, ctx) {
  if (!people || !participantId) return '';
  try {
    if (typeof people.get === 'function') {
      const p = people.get(participantId, ctx);
      if (p?.name) return p.name;
    }
    if (typeof people.list === 'function') {
      const p = people.list(ctx)?.find((row) => row.participant_id === participantId);
      if (p?.name) return p.name;
    }
  } catch { /* fall through */ }
  return '';
}

export function readBundle(buffer) {
  const files = unzipSync(buffer);
  const itemsRaw = files.get('items.json');
  if (!itemsRaw) throw new Error('This bundle does not contain items.json');
  const envelope = parseEnvelope(itemsRaw.toString('utf8'));
  const manifest = files.has('manifest.json') ? JSON.parse(files.get('manifest.json').toString('utf8')) : null;

  // Verify photo checksums when present. A mismatch means a damaged transfer.
  const problems = [];
  const checks = files.get('checksums.txt')?.toString('utf8').split('\n').filter(Boolean) ?? [];
  for (const line of checks) {
    const [hash, name] = line.split(/\s+/);
    const data = files.get(name);
    if (!data) { problems.push(`Missing file: ${name}`); continue; }
    const actual = crypto.createHash('sha256').update(data).digest('hex');
    if (actual !== hash) problems.push(`Checksum mismatch: ${name}`);
  }

  return { envelope, manifest, files, problems };
}

export function saveBundleToDisk(buffer, dir, fileName) {
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, fileName);
  fs.writeFileSync(full, buffer);
  return full;
}
