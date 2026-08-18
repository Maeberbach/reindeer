/**
 * The real work behind an inventory import.
 *
 * A ReindeerExchange bundle from Reindeer Registry never lands
 * directly in the live item pool. It lands in staging (`import_batches` +
 * `staged_items` + `staged_media`), and only an explicit Personal
 * Representative approval turns a staged row into a real `items` row.
 *
 * The six rules from shared/schema.ts (`IMPORT_RULES`) are enforced here:
 *   1. Everything lands in staging as a draft.
 *   2. A locked round queues rather than injects — approval is refused,
 *      not the import itself.
 *   3. Rooms/categories map by name; unmatched names are reported, never
 *      invented.
 *   4. `recipient_hint` (a structured recipient the owner set in Registry)
 *      and detected-then-PR-confirmed owner assignments in the Important
 *      comment both mark the imported item as `status = 'owner_assigned'`
 *      at approve time. Owner-assigned items are copied out of the ranked
 *      pool and NEVER written to `rankings` or `picks`. They print on the
 *      trustee packet with an [ASSIGNED] mark for the family record. See
 *      docs/handoffs/2026-08-07-trustee-report-owner-comments-and-fc-preassignment.md.
 *   5. Re-importing the same `origin_item_id` supersedes the older staged
 *      draft (or updates the live item) instead of duplicating.
 *   6. Every import, approval, and rejection records who and when.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { eq, and, desc } from "drizzle-orm";
import { readBundle } from "@reindeer/exchange/reader";
import type { ExchangeItem, ExchangeEnvelope } from "@reindeer/exchange/reader";
import { db, storage } from "../storage";
import { looksLikeSameThing } from "../duplicates/match";
import {
  detectOwnerAssignment,
  type OwnerAssignmentCandidate,
} from "./detectOwnerAssignment";
import {
  importBatches,
  stagedItems,
  stagedMedia,
  itemMedia,
  items,
  type ImportBatch,
  type StagedItem,
  type StagedMedia,
  type ItemMedia,
  type Item,
} from "@shared/schema";

/* ------------------------------------------------------------------ */
/* UPLOAD_DIR                                                          */
/* ------------------------------------------------------------------ */
/**
 * Prefer the app's own upload root so imported media and hand-uploaded
 * media live under the same tree and are servable through the same
 * `/uploads` static route. `server/routes.ts` exports `UPLOAD_DIR`; if
 * importing it here ever creates a circular import (routes.ts importing
 * this module back), fall back to an independently-computed directory that
 * honors the SAME env var so both paths agree in practice.
 */
let UPLOAD_DIR: string;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ({ UPLOAD_DIR } = require("../routes") as { UPLOAD_DIR: string });
} catch {
  UPLOAD_DIR = process.env.REINDEER_FAIR_PLAY_UPLOAD_DIR ?? path.resolve("uploads");
}
if (!UPLOAD_DIR) {
  UPLOAD_DIR = process.env.REINDEER_FAIR_PLAY_UPLOAD_DIR ?? path.resolve("uploads");
}
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const IMPORTS_SUBDIR = "imports";

/** Phases where a round (primary or secondary draft) is actively under way. */
const LOCKED_PHASES = new Set(["draft", "secondary_draft"]);

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

function nowMs(): number {
  return Date.now();
}

function safeSegment(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200) || "file";
}

/**
 * "Possible duplicate" detection at the import boundary.
 *
 * This used to carry its own private rule, which was stronger than the standing
 * scan and weaker than the registry's. All three now share
 * `server/duplicates/match.ts` so an item's duplicate status does not depend on
 * which door it came through.
 */
function isCloseNameMatch(a: string, b: string, aIds?: unknown, bIds?: unknown): boolean {
  return looksLikeSameThing({ name: a, identifiers: aIds }, { name: b, identifiers: bIds }).matched;
}

/**
 * (session_id, batch_id) is unique on import_batches. Re-sending the exact
 * same export (same manifest batch_id) must still be accepted as a new
 * staging attempt, so suffix with an attempt counter until the id is free.
 */
async function mintUniqueBatchId(sessionId: number, exportedBatchId: string): Promise<string> {
  let candidate = exportedBatchId;
  let attempt = 1;
  while (
    db
      .select()
      .from(importBatches)
      .where(and(eq(importBatches.sessionId, sessionId), eq(importBatches.batchId, candidate)))
      .get()
  ) {
    attempt += 1;
    candidate = `${exportedBatchId}-r${attempt}`;
  }
  return candidate;
}

function jsonArray(v: unknown): string {
  return JSON.stringify(Array.isArray(v) ? v : []);
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* stageBundle                                                         */
/* ------------------------------------------------------------------ */

export type StageBundleInput = {
  fileName: string;
  actorId: number | null;
};

export type StageBundleResult = {
  batch: ImportBatch;
  stagedItems: StagedItem[];
  stagedMedia: StagedMedia[];
  importedRooms: string[];
  importedCategories: string[];
  unmatchedRooms: string[];
  unmatchedCategories: string[];
  problems: string[];
  arrivedDuringLockedRound: boolean;
};

/**
 * Extract one media file from the bundle's zip contents onto disk under
 * UPLOAD_DIR/imports/<batchId>/..., preserving the kind as a subfolder so
 * photos, video, and audio are easy to find and reason about on disk.
 * Returns the URL that should be stored (servable via /uploads).
 */
function extractMediaFile(
  batchId: string,
  kind: "photo" | "video" | "audio",
  zipPath: string,
  data: Buffer,
): string {
  const destDir = path.join(UPLOAD_DIR, IMPORTS_SUBDIR, safeSegment(batchId), kind);
  fs.mkdirSync(destDir, { recursive: true });
  const baseName = safeSegment(path.basename(zipPath));
  let destName = baseName;
  let destPath = path.join(destDir, destName);
  let n = 1;
  while (fs.existsSync(destPath)) {
    const ext = path.extname(baseName);
    const stem = baseName.slice(0, baseName.length - ext.length);
    destName = `${stem}-${n}${ext}`;
    destPath = path.join(destDir, destName);
    n++;
  }
  fs.writeFileSync(destPath, data);
  const rel = path.relative(UPLOAD_DIR, destPath).split(path.sep).join("/");
  return `/uploads/${rel}`;
}

/**
 * Read a bundle, verify it, and stage everything in it as drafts.
 * Never writes to the live `items` table.
 */
/**
 * The capture app was called "Reindeer Registry" before it became
 * "Reindeer Registry". Bundles written under the old name must still open —
 * a family's export from last year is not a file we get to reject.
 */
const IMPORT_SOURCE_ALIASES: Record<string, string> = {
  // Old ids, kept deliberately. A rename in our code must never make a
  // family's existing export unreadable.
  legacy_inventory: "reindeer_registry",
  "legacy-inventory": "reindeer_registry",
  "reindeer-inventory-memories": "reindeer_registry",
  legacy_inventory_memories: "reindeer_registry",
  "legacy-registry": "reindeer_registry",
};

export function normalizeSourceApp(app: string | null | undefined): string {
  if (!app) return "reindeer_registry";
  return IMPORT_SOURCE_ALIASES[app] ?? app;
}

export async function stageBundle(
  buffer: Buffer,
  { fileName, actorId }: StageBundleInput,
): Promise<StageBundleResult> {
  const session = await storage.getSession();
  const sessionId = session.id;

  let read: ReturnType<typeof readBundle>;
  try {
    read = readBundle(buffer);
  } catch (e: any) {
    throw Object.assign(new Error(`This bundle could not be read: ${e?.message ?? e}`), {
      status: 400,
    });
  }
  const { envelope, manifest, files, problems: readerProblems } = read;
  const problems = [...readerProblems];

  // Checksum failures must be surfaced, never silently swallowed. readBundle()
  // already ran the checksum pass; anything it found is in `problems`. We do
  // NOT abort the import on a checksum failure — the captain needs to see the
  // batch to decide what to do with it — but we do record it prominently.
  const hasChecksumFailure = problems.some((p) => /checksum mismatch/i.test(p));

  // The exporting app may legitimately re-send the exact same .reindeer file
  // (identical manifest batch_id) on a re-import. Since (session_id, batch_id)
  // is unique on import_batches, and staged media is filed on disk under a
  // folder named after batchId, each STAGING ATTEMPT needs its own unique
  // internal batch id even when the underlying export batch repeats. The
  // exporter's original batch id and the bundle's checksum are preserved
  // separately so a true re-import is still detectable (see origin_item_id
  // based supersede/update logic below, which is what the rules actually key
  // off of).
  const exportedBatchId: string = manifest?.batch_id ?? crypto.randomUUID();
  const bundleSha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const batchId = await mintUniqueBatchId(sessionId, exportedBatchId);

  const arrivedDuringLockedRound = LOCKED_PHASES.has(session.phase);

  // ---- room/category mapping: compare bundle names to this estate's own ----
  const [taxonomyRows, existingItems, participants] = await Promise.all([
    storage.listTaxonomy(),
    storage.listItems(),
    storage.listParticipants(),
  ]);
  // Detector uses participant first-names to boost signal when an owner's
  // Important comment mentions a real heir by name. We pass the full list;
  // detectOwnerAssignment tolerates duplicates and blank entries.
  const participantNames = participants.map((p) => p.name);
  const knownRooms = new Set(
    taxonomyRows.filter((t) => t.kind === "room").map((t) => t.label.toLowerCase().trim()),
  );
  const knownCategories = new Set(
    taxonomyRows.filter((t) => t.kind === "category").map((t) => t.label.toLowerCase().trim()),
  );
  // Rooms/categories already in use on real items count as "known" too, in
  // case the taxonomy table lags behind free-typed values on items.
  for (const it of existingItems) {
    if (it.room) knownRooms.add(it.room.toLowerCase().trim());
    if (it.category) knownCategories.add(it.category.toLowerCase().trim());
  }

  // ---- pour-over: create rooms + categories from the bundle in this estate's taxonomy ----
  //
  // The Registry bundle carries a top-level rooms[] and categories[] array.
  // Any label the estate doesn't already have is created now (enabled by
  // default) so the captain sees them immediately in Administration and
  // the room/category pickers pick them up without manual setup.
  // Item-level room_name / category_name values not in the top-level arrays
  // are also created (disabled) via ensureTaxonomyLabel below.
  const bundleRooms: Array<{ id: string; name: string; is_custom: boolean }> =
    Array.isArray((envelope as any).rooms) ? (envelope as any).rooms : [];
  const bundleCategories: Array<{ id: string; name: string; is_custom: boolean }> =
    Array.isArray((envelope as any).categories) ? (envelope as any).categories : [];

  const importedRooms: string[] = [];
  for (const r of bundleRooms) {
    const label = r.name?.trim();
    if (!label) continue;
    if (!knownRooms.has(label.toLowerCase())) {
      await storage.addTaxonomy("room", label, true);
      knownRooms.add(label.toLowerCase());
      importedRooms.push(label);
    }
  }
  const importedCategories: string[] = [];
  for (const c of bundleCategories) {
    const label = c.name?.trim();
    if (!label) continue;
    if (!knownCategories.has(label.toLowerCase())) {
      await storage.addTaxonomy("category", label, true);
      knownCategories.add(label.toLowerCase());
      importedCategories.push(label);
    }
  }

  const unmatchedRoomsSet = new Set<string>();
  const unmatchedCategoriesSet = new Set<string>();
  for (const it of envelope.items) {
    const roomName = it.room_name?.trim();
    if (roomName && !knownRooms.has(roomName.toLowerCase())) {
      unmatchedRoomsSet.add(roomName);
      // Item-level room not in the bundle's top-level rooms[] — create it
      // as a disabled custom row so the captain can enable it later.
      await storage.ensureTaxonomyLabel("room", roomName);
      knownRooms.add(roomName.toLowerCase());
    }
    const catName = it.category_name?.trim();
    if (catName && !knownCategories.has(catName.toLowerCase())) {
      unmatchedCategoriesSet.add(catName);
      await storage.ensureTaxonomyLabel("category", catName);
      knownCategories.add(catName.toLowerCase());
    }
  }
  const unmatchedRooms = Array.from(unmatchedRoomsSet).sort();
  const unmatchedCategories = Array.from(unmatchedCategoriesSet).sort();

  // Commit 4 \u2014 index the frozen memoranda travelling with this bundle.
  // A per-item lookup lets each staged row remember (a) that it is
  // memorandum-locked and (b) which deceased owner's list it came from
  // (for grouping in the UI). Older Registry exports omit the field
  // entirely; those bundles arrive with an empty map and the rest of the
  // importer behaves exactly as before commit 4.
  const lockedMemoranda: Array<{ owner_name: string; item_ids: string[] }> =
    Array.isArray((envelope as any).locked_memoranda) ? (envelope as any).locked_memoranda : [];
  const memorandumByItemId = new Map<string, string>();
  for (const mem of lockedMemoranda) {
    for (const id of mem.item_ids ?? []) {
      // If the same item somehow appears on more than one memorandum
      // (should not happen \u2014 memoranda are per-owner \u2014 but a defensive
      // choice avoids losing data), keep the first name we saw.
      if (!memorandumByItemId.has(id)) memorandumByItemId.set(id, mem.owner_name ?? "");
    }
  }

  const importedAt = nowMs();

  // ---- create the import_batches row ----
  const batchRow = db
    .insert(importBatches)
    .values({
      sessionId,
      batchId,
      sourceApp: normalizeSourceApp(envelope.source?.app),
      exchangeVersion: envelope.version ?? "",
      ownerName: envelope.source?.owner_name ?? "",
      fileName,
      bundleSha256,
      byteSize: buffer.length,
      exportedAt: envelope.generated_at ? Date.parse(envelope.generated_at) || null : null,
      itemCount: envelope.items.length,
      photoCount: envelope.counts?.photos ?? 0,
      videoCount: envelope.counts?.videos ?? 0,
      audioCount: envelope.counts?.audio ?? 0,
      scopeMediaCount: envelope.counts?.scope_media ?? 0,
      state: "staged",
      notes: [
        importedRooms.length || importedCategories.length
          ? `Imported ${importedRooms.length} room(s): ${importedRooms.join(", ") || "none"}. Imported ${importedCategories.length} category(s): ${importedCategories.join(", ") || "none"}.`
          : "",
        batchId === exportedBatchId ? "" : `Re-import of export batch ${exportedBatchId}.`,
      ].filter(Boolean).join(" "),
      unmatchedRooms: jsonArray(unmatchedRooms),
      unmatchedCategories: jsonArray(unmatchedCategories),
      problems: jsonArray(
        hasChecksumFailure ? [...problems, "One or more files failed checksum verification."] : problems,
      ),
      arrivedDuringLockedRound,
      importedAt,
      importedByParticipantId: actorId,
    })
    .returning()
    .get();

  const createdStagedItems: StagedItem[] = [];
  const createdStagedMedia: StagedMedia[] = [];

  // ---- supersede any earlier DRAFT staged row for the same origin_item_id ----
  // Rule 5: re-importing the same origin_item_id must not pile up staged
  // duplicates. We only touch rows still in 'draft' state — an already
  // approved/rejected row is history, not a duplicate to clean up.
  function supersedeExistingDrafts(originItemId: string): number | null {
    const priorDrafts = db
      .select()
      .from(stagedItems)
      .where(
        and(
          eq(stagedItems.sessionId, sessionId),
          eq(stagedItems.originItemId, originItemId),
          eq(stagedItems.state, "draft"),
        ),
      )
      .all();
    for (const prior of priorDrafts) {
      db.update(stagedItems)
        .set({ state: "superseded", reviewedAt: importedAt, reviewNote: "Superseded by a newer import." })
        .where(eq(stagedItems.id, prior.id))
        .run();
    }
    return priorDrafts.length > 0 ? priorDrafts[0].id : null;
  }

  for (const srcItem of envelope.items) {
    const supersedesStagedId = supersedeExistingDrafts(srcItem.item_id);

    // ---- arrivalKind detection ----
    const existingByOrigin = existingItems.find((i) => i.originItemId === srcItem.item_id);
    let arrivalKind: "new" | "updates_existing" | "possible_duplicate" = "new";
    let possibleDuplicateOf: number | null = null;
    if (existingByOrigin) {
      arrivalKind = "updates_existing";
    } else {
      const closeMatch = existingItems.find((i) =>
        isCloseNameMatch(i.name, srcItem.title, i.identifiers, srcItem.identifiers),
      );
      if (closeMatch) {
        arrivalKind = "possible_duplicate";
        possibleDuplicateOf = closeMatch.id;
      }
    }

    const mappingNotes: string[] = [];
    if (srcItem.room_name && unmatchedRoomsSet.has(srcItem.room_name)) {
      mappingNotes.push(`Room "${srcItem.room_name}" is not in this estate's taxonomy yet.`);
    }
    if (srcItem.category_name && unmatchedCategoriesSet.has(srcItem.category_name)) {
      mappingNotes.push(`Category "${srcItem.category_name}" is not in this estate's taxonomy yet.`);
    }

    const recipientHint = srcItem.recipient_hint?.recipient_name ?? "";
    const recipientHintNote = srcItem.recipient_hint
      ? [srcItem.recipient_hint.relationship, srcItem.recipient_hint.owner_note]
          .filter(Boolean)
          .join(" — ")
      : "";

    // Owner-assignment detection: when the structured hint is empty but the
    // Important comment carries language like "For Sarah", surface a
    // candidate for the captain to confirm at import review time. Only runs when
    // there is a comment AND no structured hint — a structured hint is
    // already the owner's explicit assignment and doesn't need detection.
    const ownerImportantComment: string =
      (srcItem as any).owner_important_comment ?? "";
    let detectedCandidates: OwnerAssignmentCandidate[] = [];
    if (recipientHint === "" && ownerImportantComment !== "") {
      detectedCandidates = detectOwnerAssignment(
        ownerImportantComment,
        participantNames,
      );
    }
    // The first candidate populates the staging row's detection fields;
    // additional candidates are joined into the same quote for the captain to
    // see. In practice one comment rarely produces multiple; the review UI
    // still lets the captain type any name explicitly.
    const primary = detectedCandidates[0];
    const detectedOwnerAssignmentName = primary?.name ?? "";
    const detectedOwnerAssignmentQuote = primary?.quote ?? "";
    const detectedOwnerAssignmentConfidence = primary?.confidence ?? "";
    const detectedOwnerAssignmentReview =
      detectedCandidates.length > 0 ? "pending" : "";

    const photoCount = srcItem.photos?.length ?? 0;
    const videoCount = srcItem.recordings?.filter((r) => r.kind === "video").length ?? 0;
    const audioCount = srcItem.recordings?.filter((r) => r.kind === "audio").length ?? 0;

    // Commit 4 \u2014 flag memorandum-locked items so the captain sees them in
    // review and, on approval, they land in the items table as unselectable
    // rows grouped under the deceased owner's name.
    const isLockedGift = !!(srcItem as any).is_locked_gift
      || memorandumByItemId.has(srcItem.item_id);
    const memorandumOwnerName = memorandumByItemId.get(srcItem.item_id) ?? "";

    const stagedRow = db
      .insert(stagedItems)
      .values({
        sessionId,
        importBatchRowId: batchRow.id,
        batchId,
        originItemId: srcItem.item_id,
        name: srcItem.title,
        room: srcItem.room_name ?? "",
        category: srcItem.category_name ?? null,
        notes: srcItem.description ?? "",
        inventoryStory: srcItem.story ?? "",
        siteId: (srcItem as any).site_id ?? null,
        siteName: (srcItem as any).site_name ?? "",
        // The owner's Registry "Important" comment travels through as
        // content. Default '' when the envelope pre-dates the field (older
        // Registry versions). See docs/decisions/2026-08-06-fc-honors-owner-important.md.
        ownerImportantComment,
        quantity: srcItem.quantity ?? 1,
        conditionNote: srcItem.condition ?? "",
        identifiers: JSON.stringify(srcItem.identifiers ?? {}),
        estimatedValue:
          typeof srcItem.value_estimate_cents === "number" ? srcItem.value_estimate_cents / 100 : null,
        valueSource: srcItem.value_basis ?? null,
        // The owner's Important flag (owner_high_value) is carried through to
        // FairPlay as metadata, but it does NOT auto-trigger appraisal.
        // Appraisal is determined by AI value estimation: if AI estimates
        // the item at >= 85% of the captain's threshold (default $3,000),
        // autoFlagAfterAiAnalysis flags it. The captain can also manually
        // flag any item. See docs/decisions/2026-08-06-fc-honors-owner-important.md.
        needsAppraisal: false,
        ownerHighValue: !!(srcItem as any).owner_high_value,
        ownerHighValueReason: (srcItem as any).owner_high_value_reason ?? "",
        isSentimental: false,
        recipientHint,
        recipientHintNote,
        detectedOwnerAssignmentName,
        detectedOwnerAssignmentQuote,
        detectedOwnerAssignmentConfidence,
        detectedOwnerAssignmentReview,
        detectedOwnerAssignmentReviewReason: "",
        lockedByMemorandum: isLockedGift,
        memorandumOwnerName,
        photoCount,
        videoCount,
        audioCount,
        state: "draft",
        appliedItemId: null,
        supersedesStagedId,
        arrivalKind,
        possibleDuplicateOf,
        mappingNotes: jsonArray(mappingNotes),
        reviewNote: "",
        createdAt: importedAt,
        reviewedAt: null,
        reviewedByParticipantId: null,
      })
      .returning()
      .get();
    createdStagedItems.push(stagedRow);

    // ---- media: photos ----
    for (const p of srcItem.photos ?? []) {
      const data = files.get(p.file);
      if (!data) {
        problems.push(`Missing photo file referenced by "${srcItem.title}": ${p.file}`);
        continue;
      }
      const url = extractMediaFile(batchId, "photo", p.file, data);
      const row = db
        .insert(stagedMedia)
        .values({
          sessionId,
          stagedItemId: stagedRow.id,
          batchId,
          kind: "photo",
          role: p.role ?? "",
          mimeType: "image/*",
          byteSize: data.length,
          durationMs: null,
          transcript: "",
          transcriptSource: null,
          label: "",
          url,
          isPrimary: (p.role ?? "") === "primary" || createdStagedMedia.filter((m) => m.stagedItemId === stagedRow.id).length === 0,
          isScopeMedia: false,
          createdAt: importedAt,
        })
        .returning()
        .get();
      createdStagedMedia.push(row);
    }

    // ---- media: video + audio recordings ----
    for (const r of srcItem.recordings ?? []) {
      const data = files.get(r.file);
      if (!data) {
        problems.push(`Missing ${r.kind} file referenced by "${srcItem.title}": ${r.file}`);
        continue;
      }
      const url = extractMediaFile(batchId, r.kind, r.file, data);
      const row = db
        .insert(stagedMedia)
        .values({
          sessionId,
          stagedItemId: stagedRow.id,
          batchId,
          kind: r.kind,
          role: r.role ?? "",
          mimeType: r.mime_type ?? "",
          byteSize: r.byte_size ?? data.length,
          durationMs: r.duration_ms ?? null,
          transcript: r.transcript ?? "",
          transcriptSource: r.transcript_source ?? null,
          label: r.label ?? "",
          url,
          isPrimary: false,
          isScopeMedia: false,
          createdAt: importedAt,
        })
        .returning()
        .get();
      createdStagedMedia.push(row);
    }
  }

  // ---- scope media: whole-house/whole-room recordings, not tied to an item ----
  for (const m of envelope.scope_media ?? []) {
    const data = files.get(m.file);
    if (!data) {
      problems.push(`Missing scope recording: ${m.file}`);
      continue;
    }
    const url = extractMediaFile(batchId, m.kind, m.file, data);
    const row = db
      .insert(stagedMedia)
      .values({
        sessionId,
        stagedItemId: null,
        batchId,
        kind: m.kind,
        role: "",
        mimeType: m.mime_type ?? "",
        byteSize: m.byte_size ?? data.length,
        durationMs: m.duration_ms ?? null,
        transcript: m.transcript ?? "",
        transcriptSource: null,
        label: m.title ?? "",
        url,
        isPrimary: false,
        isScopeMedia: true,
        createdAt: importedAt,
      })
      .returning()
      .get();
    createdStagedMedia.push(row);
  }

  // Persist any problems discovered while extracting media (missing files),
  // since these were not known when the batch row was first inserted.
  if (problems.length) {
    db.update(importBatches)
      .set({ problems: jsonArray(problems) })
      .where(eq(importBatches.id, batchRow.id))
      .run();
  }

  const finalBatch = db.select().from(importBatches).where(eq(importBatches.id, batchRow.id)).get()!;

  return {
    batch: finalBatch,
    stagedItems: createdStagedItems,
    stagedMedia: createdStagedMedia,
    importedRooms,
    importedCategories,
    unmatchedRooms,
    unmatchedCategories,
    problems,
    arrivedDuringLockedRound,
  };
}

/* ------------------------------------------------------------------ */
/* listing / reading                                                    */
/* ------------------------------------------------------------------ */

export async function listBatches(sessionId?: number): Promise<ImportBatch[]> {
  const sid = sessionId ?? (await storage.getSession()).id;
  return db
    .select()
    .from(importBatches)
    .where(eq(importBatches.sessionId, sid))
    .orderBy(desc(importBatches.importedAt))
    .all();
}

export type BatchDetail = {
  batch: ImportBatch;
  items: StagedItem[];
  media: StagedMedia[];
};

export async function getBatch(id: number): Promise<BatchDetail | null> {
  const batch = db.select().from(importBatches).where(eq(importBatches.id, id)).get();
  if (!batch) return null;
  const items_ = db
    .select()
    .from(stagedItems)
    .where(eq(stagedItems.importBatchRowId, id))
    .all();
  const media = db.select().from(stagedMedia).where(eq(stagedMedia.batchId, batch.batchId)).all();
  return { batch, items: items_, media };
}

export async function listStaged(
  sessionId?: number,
  opts?: { state?: string },
): Promise<StagedItem[]> {
  const sid = sessionId ?? (await storage.getSession()).id;
  const rows = db.select().from(stagedItems).where(eq(stagedItems.sessionId, sid)).all();
  return opts?.state ? rows.filter((r) => r.state === opts.state) : rows;
}

/* ------------------------------------------------------------------ */
/* approval / rejection                                                 */
/* ------------------------------------------------------------------ */

/** SHA-256 of the file a /uploads/... URL points at, or null if it is unreadable. */
function hashMediaFile(url: string): string | null {
  try {
    const rel = url.replace(/^\/uploads\//, "");
    const full = path.join(UPLOAD_DIR, rel);
    const data = fs.readFileSync(full);
    return crypto.createHash("sha256").update(data).digest("hex");
  } catch {
    return null;
  }
}

/** Content hashes of every item_media row already on `itemId`. */
function hashExistingMedia(itemId: number): string[] {
  const rows = db.select().from(itemMedia).where(eq(itemMedia.itemId, itemId)).all();
  return rows.map((r) => hashMediaFile(r.url)).filter((h): h is string => !!h);
}

function roundLockedError(): Error {
  return Object.assign(
    new Error(
      "This estate is in the middle of a draft round. New inventory cannot join the live pool until the round finishes — it stays safely in staging until then.",
    ),
    { status: 409 },
  );
}

async function assertRoundNotLocked(): Promise<void> {
  const session = await storage.getSession();
  if (LOCKED_PHASES.has(session.phase)) {
    throw roundLockedError();
  }
}

export type ApproveOverrides = {
  room?: string;
  category?: string | null;
  name?: string;
};

export type ApproveResult = {
  stagedItem: StagedItem;
  item: Item;
  media: ItemMedia[];
  wasUpdate: boolean;
};

/**
 * Turn one staged draft into a real item (or update the existing item it
 * refers to). Refuses outright if the round is locked — the caller must
 * wait for the round to finish. Copies media into item_media and sets a
 * primary photo/thumbnail so existing screens keep working. The
 * recipient_hint travels as advisory text on the item and nowhere else.
 */
export async function approveStaged(
  stagedItemId: number,
  actorId: number | null,
  overrides?: ApproveOverrides,
): Promise<ApproveResult> {
  await assertRoundNotLocked();

  const staged = db.select().from(stagedItems).where(eq(stagedItems.id, stagedItemId)).get();
  if (!staged) {
    throw Object.assign(new Error("That staged item was not found."), { status: 404 });
  }
  if (staged.state === "approved") {
    throw Object.assign(new Error("That item has already been approved."), { status: 409 });
  }
  if (staged.state === "rejected") {
    throw Object.assign(new Error("That item was rejected and cannot be approved without re-importing it."), {
      status: 409,
    });
  }
  if (staged.state === "superseded") {
    throw Object.assign(
      new Error("A newer import has replaced this staged item. Review the newer version instead."),
      { status: 409 },
    );
  }

  // Owner-assignment review gate: if the detector fired and the captain has
  // not yet confirmed or dismissed the candidate, refuse to approve. This
  // is what keeps a detected-but-unconfirmed "For Sarah" from silently
  // becoming an owner_assigned item without human sign-off. The reviewer
  // dismisses the detection to approve the item as available instead.
  if (staged.detectedOwnerAssignmentReview === "pending") {
    throw Object.assign(
      new Error(
        "This item's Important comment looks like an owner assignment. " +
          "Confirm or dismiss the detected recipient before approving.",
      ),
      { status: 409 },
    );
  }

  const reviewedAt = nowMs();
  const media = db
    .select()
    .from(stagedMedia)
    .where(eq(stagedMedia.stagedItemId, stagedItemId))
    .all();

  const name = overrides?.name ?? staged.name;
  const room = overrides?.room ?? staged.room;
  const category = overrides?.category !== undefined ? overrides.category : staged.category;

  const primaryPhoto = media.find((m) => m.kind === "photo" && m.isPrimary) ?? media.find((m) => m.kind === "photo");

  // ---- owner-assignment resolution ------------------------------------------
  //
  // Two paths lead an item to `status = 'owner_assigned'`:
  //
  //   a) The Registry envelope carried a structured recipient_hint. The
  //      owner used the app's built-in "who is this for?" field, which is
  //      an explicit statement. We honor it without needing PR review.
  //
  //   b) The staging detector found language like "For Sarah" inside the
  //      Important comment, the captain reviewed it and clicked Confirm, and
  //      the row was updated to `detected_owner_assignment_review =
  //      'confirmed'`. The PR is the accountable party in that case.
  //
  // The detector's raw "pending" state must NOT land as owner_assigned —
  // that would sneak an unconfirmed guess into the trustee ledger. The
  // batch-approval gate below refuses to approve any batch containing a
  // pending row, so this path only ever fires on confirmed candidates.
  //
  // See docs/handoffs/2026-08-07-trustee-report-owner-comments-and-fc-preassignment.md.
  const structuredHintAssignment = staged.recipientHint.trim() !== "";
  const confirmedDetectionAssignment =
    staged.detectedOwnerAssignmentReview === "confirmed" &&
    staged.detectedOwnerAssignmentName.trim() !== "";
  // Commit 4 \u2014 the memorandum path.
  //
  // Memorandum-locked items are always owner_assigned, without PR review
  // and without a name in the assignment (recipient identity lives only
  // on the paper the trustee holds). The deceased owner\u2019s name is used
  // as the GROUPING label in the UI (see memorandumOwnerName), not as a
  // recipient. The evidence field carries a neutral phrase suitable for
  // audit \u2014 never a recipient name.
  const memorandumAssignment = !!staged.lockedByMemorandum;
  const shouldMarkOwnerAssigned =
    memorandumAssignment || structuredHintAssignment || confirmedDetectionAssignment;

  // Precedence: memorandum wins. If a frozen memorandum lists this item,
  // that is a legal disposition and outranks any Registry recipient_hint
  // or detector guess that may have travelled alongside.
  const ownerAssignedName = memorandumAssignment
    ? "" // never a recipient name for memorandum-locked items
    : structuredHintAssignment
      ? staged.recipientHint
      : confirmedDetectionAssignment
        ? staged.detectedOwnerAssignmentName
        : "";
  const ownerAssignedSource: string = memorandumAssignment
    ? "memorandum"
    : shouldMarkOwnerAssigned
      ? structuredHintAssignment
        ? "recipient_hint"
        : "comment_detected"
      : "";
  const ownerAssignedEvidence: string = memorandumAssignment
    ? "Handled as a special gift under the will."
    : shouldMarkOwnerAssigned
      ? structuredHintAssignment
        ? staged.recipientHintNote
        : staged.detectedOwnerAssignmentQuote
      : "";

  // Best-effort participant resolution: case-insensitive first-name match
  // against the current heir roster. Left null when there is no match;
  // the captain can bind an heir later from the item detail screen without
  // affecting the item's owner_assigned status.
  // Memorandum-locked items intentionally never bind to a participant \u2014
  // the recipient is not in FC. Only the recipient_hint / comment_detected
  // paths do a name lookup.
  let ownerAssignedParticipantId: number | null = null;
  if (shouldMarkOwnerAssigned && ownerAssignedName && !memorandumAssignment) {
    const roster = await storage.listParticipants();
    const target = ownerAssignedName.trim().toLowerCase().split(/\s+/)[0];
    const match = roster.find(
      (p) => p.name.trim().toLowerCase().split(/\s+/)[0] === target,
    );
    ownerAssignedParticipantId = match?.id ?? null;
  }

  let item: Item;
  let wasUpdate = false;

  const existingByOrigin =
    staged.arrivalKind === "updates_existing"
      ? db.select().from(items).where(eq(items.originItemId, staged.originItemId)).get()
      : undefined;

  if (existingByOrigin) {
    wasUpdate = true;
    item = db
      .update(items)
      .set({
        name,
        room,
        category,
        notes: staged.notes,
        quantity: staged.quantity,
        conditionNote: staged.conditionNote,
        identifiers: staged.identifiers,
        inventoryStory: staged.inventoryStory,
        ownerImportantComment: staged.ownerImportantComment,
        recipientHint: staged.recipientHint,
        recipientHintNote: staged.recipientHintNote,
        needsAppraisal: staged.needsAppraisal,
        isSentimental: staged.isSentimental,
        estimatedValue: staged.estimatedValue,
        ownerHighValue: !!(staged as any).ownerHighValue,
        ownerHighValueReason: (staged as any).ownerHighValueReason ?? "",
        originApp: "reindeer_registry",
        originItemId: staged.originItemId,
        importBatchId: staged.batchId,
        siteId: staged.siteId,
        siteName: staged.siteName,
        // Owner-assignment fields land on the item exactly as computed
        // above. We DO NOT flip an already-awarded item back to
        // owner_assigned; only items still in `available` (the pool) are
        // moved into the owner_assigned bucket on a re-import. See guard
        // below
        ownerAssignedName,
        ownerAssignedParticipantId,
        ownerAssignedSource,
        ownerAssignedEvidence,
        // Commit 4 \u2014 propagate memorandum-lock through re-imports too.
        // A living owner\u2019s memorandum was NOT frozen at export time, so
        // items in that state won\u2019t have lockedByMemorandum on the
        // staged row. Once an owner dies and a frozen memorandum starts
        // travelling, a re-import flips those items into the locked group.
        lockedByMemorandum: !!staged.lockedByMemorandum,
        memorandumOwnerName: staged.memorandumOwnerName || "",
        ...(shouldMarkOwnerAssigned && existingByOrigin.status === "available"
          ? { status: "owner_assigned" as const }
          : {}),
        ...(primaryPhoto ? { photoUrl: primaryPhoto.url, thumbnailUrl: primaryPhoto.url } : {}),
      })
      .where(eq(items.id, existingByOrigin.id))
      .returning()
      .get();
  } else {
    item = await storage.createItem({
      name,
      room,
      category: category ?? null,
      notes: staged.notes,
      quantity: staged.quantity,
      conditionNote: staged.conditionNote,
      identifiers: staged.identifiers,
      inventoryStory: staged.inventoryStory,
      ownerImportantComment: staged.ownerImportantComment,
      recipientHint: staged.recipientHint,
      recipientHintNote: staged.recipientHintNote,
      needsAppraisal: staged.needsAppraisal,
      isSentimental: staged.isSentimental,
      estimatedValue: staged.estimatedValue,
      ownerHighValue: !!(staged as any).ownerHighValue,
      ownerHighValueReason: (staged as any).ownerHighValueReason ?? "",
      originApp: "reindeer_registry",
      originItemId: staged.originItemId,
      importBatchId: staged.batchId,
      siteId: staged.siteId,
      siteName: staged.siteName,
      // Owner-assignment lifts a new item straight into the
      // `owner_assigned` bucket, bypassing the ranked pool. Otherwise it
      // starts life in the pool as `available` like any other imported
      // item.
      status: shouldMarkOwnerAssigned ? "owner_assigned" : "available",
      ownerAssignedName,
      ownerAssignedParticipantId,
      ownerAssignedSource,
      ownerAssignedEvidence,
      lockedByMemorandum: !!staged.lockedByMemorandum,
      memorandumOwnerName: staged.memorandumOwnerName || "",
      photoUrl: primaryPhoto?.url ?? null,
      thumbnailUrl: primaryPhoto?.url ?? null,
    } as any);


  // Copy staged_media -> item_media. On an update via a re-import, the same
  // recording arrives again through a NEW batch folder, so its URL differs
  // even though the bytes are identical. Dedup by content hash (not URL) so
  // re-importing never piles up duplicate photos/recordings on the item.
  const alreadyOnItem = wasUpdate ? new Set(hashExistingMedia(item.id)) : new Set<string>();

  const copiedMedia: ItemMedia[] = [];
  for (const m of media) {
    const contentHash = hashMediaFile(m.url);
    if (contentHash && alreadyOnItem.has(contentHash)) continue;
    if (contentHash) alreadyOnItem.add(contentHash);
    const row = db
      .insert(itemMedia)
      .values({
        sessionId: staged.sessionId,
        itemId: item.id,
        kind: m.kind,
        role: m.role,
        mimeType: m.mimeType,
        byteSize: m.byteSize,
        durationMs: m.durationMs,
        transcript: m.transcript,
        label: m.label,
        url: m.url,
        isPrimary: m.isPrimary,
        originApp: "reindeer_registry",
        createdAt: reviewedAt,
      })
      .returning()
      .get();
    copiedMedia.push(row);
  }

  const updatedStaged = db
    .update(stagedItems)
    .set({
      state: "approved",
      appliedItemId: item.id,
      reviewedAt,
      reviewedByParticipantId: actorId,
    })
    .where(eq(stagedItems.id, stagedItemId))
    .returning()
    .get();

  return { stagedItem: updatedStaged, item, media: copiedMedia, wasUpdate };
}

export async function rejectStaged(
  stagedItemId: number,
  actorId: number | null,
  note: string,
): Promise<StagedItem> {
  const staged = db.select().from(stagedItems).where(eq(stagedItems.id, stagedItemId)).get();
  if (!staged) {
    throw Object.assign(new Error("That staged item was not found."), { status: 404 });
  }
  if (staged.state !== "draft") {
    throw Object.assign(new Error(`That item is already ${staged.state} and cannot be rejected.`), {
      status: 409,
    });
  }
  return db
    .update(stagedItems)
    .set({
      state: "rejected",
      reviewedAt: nowMs(),
      reviewedByParticipantId: actorId,
      reviewNote: note ?? "",
    })
    .where(eq(stagedItems.id, stagedItemId))
    .returning()
    .get();
}

/* ------------------------------------------------------------------ */
/* owner-assignment detection review                                    */
/* ------------------------------------------------------------------ */

export type ConfirmDetectionInput = {
  /**
   * Optional override for the resolved name. When omitted, the detector's
   * suggested name is used. Providing a name here is what lets the captain say
   * "the comment says 'For Sarah' but Sarah is a name-drop; the item is
   * really meant for Michael" during the review step.
   */
  name?: string;
};

/**
 * PR confirms that a detected owner-assignment candidate on a staged item
 * is real. Sets `detected_owner_assignment_review = 'confirmed'` and, when
 * an explicit name is supplied, overwrites the detector's suggestion. The
 * next call to approveStaged will pick this up and flip the item to
 * `owner_assigned`.
 */
export async function confirmDetectedAssignment(
  stagedItemId: number,
  actorId: number | null,
  input: ConfirmDetectionInput,
): Promise<StagedItem> {
  const staged = db.select().from(stagedItems).where(eq(stagedItems.id, stagedItemId)).get();
  if (!staged) {
    throw Object.assign(new Error("That staged item was not found."), { status: 404 });
  }
  if (staged.state !== "draft") {
    throw Object.assign(
      new Error("Only a draft staged item's detection can be confirmed."),
      { status: 409 },
    );
  }
  if (staged.detectedOwnerAssignmentReview === "") {
    throw Object.assign(
      new Error("This item has no detected owner-assignment to confirm."),
      { status: 409 },
    );
  }
  const finalName = (input.name ?? staged.detectedOwnerAssignmentName).trim();
  if (!finalName) {
    throw Object.assign(
      new Error("A recipient name is required to confirm this assignment."),
      { status: 400 },
    );
  }
  return db
    .update(stagedItems)
    .set({
      detectedOwnerAssignmentName: finalName,
      detectedOwnerAssignmentReview: "confirmed",
      detectedOwnerAssignmentReviewReason: "",
      reviewedAt: nowMs(),
      reviewedByParticipantId: actorId,
    })
    .where(eq(stagedItems.id, stagedItemId))
    .returning()
    .get();
}

export type DismissDetectionInput = {
  /**
   * Optional short reason the captain typed to explain the dismissal ("name-drop
   * only, not really meant for Sarah"). Stored on the staging row for the
   * audit trail; does not appear on the eventual item row.
   */
  reason?: string;
};

/**
 * PR dismisses a detected owner-assignment candidate. The item will still
 * be approvable as `available` (the ranked-draft pool) when the batch is
 * approved. The dismissal is recorded on the staging row for the audit
 * trail even after approval.
 */
export async function dismissDetectedAssignment(
  stagedItemId: number,
  actorId: number | null,
  input: DismissDetectionInput,
): Promise<StagedItem> {
  const staged = db.select().from(stagedItems).where(eq(stagedItems.id, stagedItemId)).get();
  if (!staged) {
    throw Object.assign(new Error("That staged item was not found."), { status: 404 });
  }
  if (staged.state !== "draft") {
    throw Object.assign(
      new Error("Only a draft staged item's detection can be dismissed."),
      { status: 409 },
    );
  }
  if (staged.detectedOwnerAssignmentReview === "") {
    throw Object.assign(
      new Error("This item has no detected owner-assignment to dismiss."),
      { status: 409 },
    );
  }
  return db
    .update(stagedItems)
    .set({
      detectedOwnerAssignmentReview: "dismissed",
      detectedOwnerAssignmentReviewReason: (input.reason ?? "").trim(),
      reviewedAt: nowMs(),
      reviewedByParticipantId: actorId,
    })
    .where(eq(stagedItems.id, stagedItemId))
    .returning()
    .get();
}

/* ------------------------------------------------------------------ */
/* batch-level operations                                               */
/* ------------------------------------------------------------------ */

export type ApproveBatchResult = {
  batch: ImportBatch;
  results: Array<
    | { stagedItemId: number; ok: true; itemId: number; wasUpdate: boolean }
    | { stagedItemId: number; ok: false; error: string }
  >;
};

export async function approveBatch(batchRowId: number, actorId: number | null): Promise<ApproveBatchResult> {
  // Round-lock check happens per item too, but we check once up front so we
  // can fail fast with the same plain-language message and touch nothing.
  await assertRoundNotLocked();

  const batch = db.select().from(importBatches).where(eq(importBatches.id, batchRowId)).get();
  if (!batch) {
    throw Object.assign(new Error("That import batch was not found."), { status: 404 });
  }
  const drafts = db
    .select()
    .from(stagedItems)
    .where(and(eq(stagedItems.importBatchRowId, batchRowId), eq(stagedItems.state, "draft")))
    .all();

  // Batch-level owner-assignment gate: block bulk approval when any draft
  // still has a pending detection. Bulk approval is a convenience path;
  // per-item approval will surface the same error message from
  // approveStaged, but stopping here means the captain fixes reviews first
  // instead of getting a partial batch with a mix of success and errors.
  const pendingReviewCount = drafts.filter(
    (d) => d.detectedOwnerAssignmentReview === "pending",
  ).length;
  if (pendingReviewCount > 0) {
    throw Object.assign(
      new Error(
        `${pendingReviewCount} item${pendingReviewCount === 1 ? " needs" : "s need"} an ` +
          `owner-assignment review before this batch can be approved. Review the flagged item(s) first.`,
      ),
      { status: 409 },
    );
  }

  const results: ApproveBatchResult["results"] = [];
  for (const draft of drafts) {
    try {
      const { item, wasUpdate } = await approveStaged(draft.id, actorId);
      results.push({ stagedItemId: draft.id, ok: true, itemId: item.id, wasUpdate });
    } catch (e: any) {
      results.push({ stagedItemId: draft.id, ok: false, error: e?.message ?? String(e) });
    }
  }

  const allStagedForBatch = db
    .select()
    .from(stagedItems)
    .where(eq(stagedItems.importBatchRowId, batchRowId))
    .all();
  const anyApproved = allStagedForBatch.some((s) => s.state === "approved");
  const anyDraftLeft = allStagedForBatch.some((s) => s.state === "draft");
  const newState = anyDraftLeft ? (anyApproved ? "partially_applied" : "staged") : "applied";

  const updatedBatch = db
    .update(importBatches)
    .set({ state: newState })
    .where(eq(importBatches.id, batchRowId))
    .returning()
    .get();

  return { batch: updatedBatch, results };
}

export async function discardBatch(batchRowId: number, actorId: number | null): Promise<ImportBatch> {
  const batch = db.select().from(importBatches).where(eq(importBatches.id, batchRowId)).get();
  if (!batch) {
    throw Object.assign(new Error("That import batch was not found."), { status: 404 });
  }
  const reviewedAt = nowMs();
  const drafts = db
    .select()
    .from(stagedItems)
    .where(and(eq(stagedItems.importBatchRowId, batchRowId), eq(stagedItems.state, "draft")))
    .all();
  for (const d of drafts) {
    db.update(stagedItems)
      .set({
        state: "rejected",
        reviewedAt,
        reviewedByParticipantId: actorId,
        reviewNote: "Batch discarded.",
      })
      .where(eq(stagedItems.id, d.id))
      .run();
  }
  return db
    .update(importBatches)
    .set({ state: "discarded" })
    .where(eq(importBatches.id, batchRowId))
    .returning()
    .get();
}
