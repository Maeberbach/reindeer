# Reindeer Legacy — Integration Spec

**Product line:** Reindeer Registry (capture + print, sold separately) · Reindeer: FairPlay / Legacy Distribution (allocation game)
**Shared foundation:** `legacy-core` extracted from the existing Reindeer: FairPlay intake engine
**Stack assumption:** Node/Express + SQLite + browser client, same as the current Reindeer: FairPlay build
**Status:** Draft for review — no code moved yet

---

## 0. The problem this product line exists to solve

The most common source of conflict in estate personal-property distribution is not money. It is **undocumented and unassigned items** — belongings nobody wrote down, promises nobody recorded, and items that cannot be found when heirs go looking for them. The result is a distribution that one or more heirs experience as unfair, and the damage outlasts the estate.

Practitioners consistently report that fights over tangible personal property are rarely about market value. Sentimental items — a mother's necklace, a father's watch, photograph albums, the tools in the garage — generate longer and harder disputes than bank accounts, because the usual remedy of selling the asset and splitting the proceeds satisfies nobody ([Flournoy McLain](https://www.dallasestatelaw.com/blog/2023/02/why-sentimental-items-often-cause-estate-disputes/)). The underlying argument is about recognition — who was loved more, whose memories count ([The Walls Law Group](https://www.wallslawnc.com/legal-articles/the-inheritance-your-kids-will-actually-fight-over-its-not-the-money)). Low-value objects routinely stall settlement and drive up cost ([Don Shaw Law](https://donshawlaw.com/estate-battles-over-personal-property-distribution/)), and the pattern holds even in high-profile estates, where Robin Williams' family litigated for months over which personal items went to whom ([The New York Times](https://www.nytimes.com/2015/04/04/your-money/when-heirs-fight-over-assets-with-sentimental-value.html)). Where the will is silent on personal effects, conflict is the default outcome ([Vela & Del Fierro](https://www.vdflaw.com/blog/2025/06/addressing-sentimental-items-during-the-probate-process/)), and blended families face the sharpest version of it ([SB Estate Planning & Elder Law](https://www.sbelderlaw.com/family-feudswhen-heirs-fight-over-assets-with-sentimental-value-sb-estate-planning-and-elder-law/)).

### The five failure modes

| Failure mode | What actually happens | What it produces |
|---|---|---|
| **Undocumented** | The item was never written down anywhere. It exists only in memory. | No shared record of what the estate even contained. |
| **Unassigned** | The item was documented but no intent was recorded. | Every heir supplies their own answer, and each believes it. |
| **Absent when looked for** | The item was expected but is gone — sold, gifted, lost, discarded, or quietly taken. | Suspicion between heirs, often permanent. |
| **Promised** | An oral promise was made and remembered differently, or by more than one person. | Competing sincere claims with no way to adjudicate. |
| **"Unfair"** | Distribution was procedurally opaque. | Even a mathematically even split is rejected as unfair. |

The standard advice — keep a separate written list of personal property for distribution — is sound and almost never completed. It is tedious, it is easy to defer, and it produces nothing satisfying along the way. **The core product thesis is that the list gets finished only if creating it is fast, photo-driven, and rewarding on its own terms**, and that the owner does it while alive, while they still remember which grandparent the watch came from.

### How each failure mode maps to a requirement

These are the acceptance criteria for the product line, not background color.

- **Undocumented → capture must be near-frictionless.** Photo-first, AI-drafted titles, video walkthrough of a whole room, batch intake. If capture takes longer than roughly ten seconds per item, the inventory does not get finished and none of the rest matters.
- **Unassigned → intent is a first-class field, captured at the moment of capture.** The intended-recipient field appears in the guided flow, not buried in a settings screen, and remains optional so it never blocks documentation.
- **Absent when looked for → the record is timestamped, photographic, and immutable in its history.** Photos, dates, location tags, and quantity establish that the item existed and where it was kept. Edits and deletions land in the hash-chained audit trail. Printed reports carry a date stamp so a family can compare a later reality against a known earlier baseline — the goal is dissolving suspicion, not accusing anyone.
- **Promised → the promise is recorded in the owner's own voice while they are alive.** The story field plus voice input converts an oral promise into a dated, attributable record. Because the field is explicitly non-binding, it does the emotional work of a promise without pretending to legal effect.
- **"Unfair" → the process must be visible, not merely even.** This is the responsibility of the downstream app: private ranking, parallel rounds, cumulative loss compensation, bounded envy review, and a full assignment ledger in the final PDF. Fairness perception comes from a procedure everyone can see, plus a record of the owner's stated wishes that no heir has to take on another heir's word.

### The division of labor

**Reindeer Registry eliminates the first four failure modes before death.** **Reindeer: FairPlay eliminates the fifth after it.** That is the reason the two apps belong in one product line even though they are sold separately — each one is materially weaker alone. An inventory with no fair division process still ends in argument; a fair division process run over an incomplete catalog divides only what somebody happened to remember.

---

## 1. Why extract instead of rewrite

The intake path in Reindeer: FairPlay is already proven: manual add, quick add, single-photo add, AI batch photo intake with bounding boxes and padded crops, video keyframe extraction with cross-frame grouping, duplicate detection and side-by-side resolution, room/category tagging with a preset picker and custom fallback, and high-value screening. That is the entire feature surface Reindeer Registry needs. Rebuilding it would fork two copies of the same AI prompt, schema, and duplicate logic.

What must **not** cross the boundary is anything that assumes a division game exists: heirs, ranking windows, priority order, conflict counters, envy review, bidding, equalization ledger, and the distribution PDF. Reindeer Registry has one optional heir-ish concept — a free-text **intended recipient** — and no game at all.

---

## 2. Repository layout

Single repo, workspaces. Both apps stay independently buildable and independently sellable.

```
legacy/
├── package.json                      # npm workspaces root
├── packages/
│   ├── legacy-core-api/              # contracts only, zero runtime deps
│   │   ├── src/
│   │   │   ├── models/               # ItemRecord, PhotoAsset, ItemClassification,
│   │   │   │                         # ItemNote, RoomRef, CategoryRef, RecipientHint
│   │   │   ├── ports/                # ItemRepository, MediaStore, VisionProvider,
│   │   │   │                         # DuplicateDetector, ExportWriter, PrintRenderer
│   │   │   ├── schema/               # JSON Schema + zod validators
│   │   │   └── errors/
│   │   └── package.json
│   │
│   ├── legacy-core-data/             # SQLite implementation of the ports
│   │   ├── src/
│   │   │   ├── db/                   # connection, transactional migrations, FKs
│   │   │   ├── migrations/           # 0001_core_items.sql, 0002_media.sql, ...
│   │   │   ├── repositories/
│   │   │   ├── media/                # padded crop writer, thumbnail sizes, OS data paths
│   │   │   └── audit/                # hash-chained audit records (shared)
│   │   └── package.json
│   │
│   ├── legacy-intake-feature/        # the reused engine
│   │   ├── src/
│   │   │   ├── server/               # /api/intake routes, mountable Express router
│   │   │   ├── vision/               # prompt templates, bbox parsing, confidence scoring
│   │   │   ├── video/                # keyframe extraction contract, 8–10 frame cap,
│   │   │   │                         # cross-frame grouping → quantity
│   │   │   ├── duplicates/           # detection + resolution state machine
│   │   │   └── client/               # framework-agnostic capture/review components
│   │   └── package.json
│   │
│   ├── legacy-print-feature/         # first-class, not an export button
│   │   ├── src/
│   │   │   ├── templates/            # item-sheet, room-report, category-report,
│   │   │   │                         # recipient-list, full-inventory
│   │   │   ├── render/               # HTML → PDF pipeline, print CSS
│   │   │   └── profiles/             # PrintProfile presets (letter/A4, photo size, density)
│   │   └── package.json
│   │
│   └── legacy-exchange/              # the integration contract between the two apps
│       ├── src/
│       │   ├── v1/envelope.ts        # ReindeerExchange v1 JSON
│       │   ├── v1/csv.ts             # flat CSV projection
│       │   ├── bundle.ts             # .legacy zip (manifest + media + checksums)
│       │   └── migrate/              # version upgraders
│       └── package.json
│
└── apps/
    ├── legacy-registry/             # NEW — capture, document, print, export
    │   ├── server/                   # Express shell, mounts intake + print routers
    │   ├── client/                   # elder-friendly guided capture UI
    │   └── data/                     # inventory.db
    │
    └── fair-choice/           # EXISTING — rewired, not rewritten
        ├── server/                   # game routes stay here
        ├── client/
        └── data/                     # estate.db
```

Rule of thumb: `apps/*` may depend on any `packages/*`. `packages/*` may depend only on `legacy-core-api`. Nothing in `packages/` may import from `apps/`.

---

## 3. Shared item schema

One canonical `ItemRecord`. Distribution-only fields live in a separate table keyed by item id, so Reindeer Registry never carries dead columns.

### Core table — `items` (both apps)

| Field | Type | Notes |
|---|---|---|
| `item_id` | ULID | stable across export/import |
| `origin_app` | enum | `inventory` \| `distribution` |
| `origin_item_id` | text | source id when imported |
| `title` | text | AI-drafted, user-editable |
| `category_id` | FK | from shared category registry |
| `room_id` | FK | preset picker + custom fallback |
| `description` | text | |
| `story` | text | sentimental history, voice-to-text allowed |
| `quantity` | int | set by cross-frame grouping |
| `condition` | enum | new / good / fair / poor / unknown |
| `identifiers` | json | brand, model, serial, marks, signatures |
| `value_estimate_cents` | int | integer money, resale-anchored |
| `value_basis` | enum | `ai_estimate` \| `owner` \| `appraisal` \| `unknown` |
| `high_value_flag` | bool | threshold or cue-word triggered |
| `ai_confidence` | real | 0–1 |
| `review_state` | enum | `draft` \| `kept` \| `rejected` \| `duplicate_pending` |
| `print_state` | enum | `unprinted` \| `printed` \| `stale` |
| `export_state` | enum | `never` \| `exported` \| `changed_since_export` |
| `created_at` / `updated_at` | ts | |

### `item_photos`

`photo_id`, `item_id`, `role` (`primary` \| `detail` \| `serial` \| `provenance`), `crop_bbox`, `source_media_id`, `source_frame_index`, `path`, `thumb_path`.

### `recipient_hints` — Inventory-side, optional

`item_id`, `recipient_name`, `relationship`, `alternate_name`, `owner_note`, `is_binding` (always `false`).

> This is deliberately free text, not an heir record. Reindeer Registry is a documentation tool, not a legal instrument — the intended-recipient field carries a persistent "wishes only, not a will" disclaimer and prints as such.

### Distribution-only tables (stay in Reindeer: FairPlay)

`heirs`, `rankings`, `priority_orders`, `conflict_counters`, `bids`, `equalization_ledger`, `envy_reviews`, `receipts`. On import, `recipient_hints.recipient_name` is offered as a *suggestion* to map onto a real heir, never auto-applied.

---

## 4. Port interfaces

```ts
// legacy-core-api/ports
interface ItemRepository {
  create(item: NewItemRecord, ctx: ScopeCtx): Promise<ItemRecord>;
  update(id: ItemId, patch: Partial<ItemRecord>, ctx: ScopeCtx): Promise<ItemRecord>;
  get(id: ItemId, ctx: ScopeCtx): Promise<ItemRecord | null>;
  list(q: ItemQuery, ctx: ScopeCtx): Promise<Page<ItemRecord>>;   // room/category/state filters
  markExported(ids: ItemId[], batch: ExportBatchId, ctx: ScopeCtx): Promise<void>;
}

interface VisionProvider {
  detectItems(input: ImageInput[], opts: DetectOpts): Promise<Detection[]>; // bbox + label + confidence + value hint
}

interface DuplicateDetector {
  scanBatch(candidates: Detection[], ctx: ScopeCtx): Promise<DuplicateGroup[]>;
  scanCatalog(ctx: ScopeCtx): Promise<DuplicateGroup[]>;
}

interface PrintRenderer {
  renderItemSheet(id: ItemId, profile: PrintProfile): Promise<PdfBuffer>;
  renderReport(q: ItemQuery, profile: PrintProfile): Promise<PdfBuffer>;
}

interface ExportWriter {
  writeExchange(q: ItemQuery, opts: ExchangeOpts): Promise<ExchangeBundle>;
}
```

`ScopeCtx` is the generalization of the existing estate-scoped query guard: `{ scopeType: 'estate' | 'inventory', scopeId, actorId, permissions }`. Reindeer: FairPlay passes `estate`; Reindeer Registry passes `inventory`. Every repository call keeps the scope filter that already prevents cross-estate leakage.

---

## 5. The integration contract — ReindeerExchange v1

Three transport formats, one payload model.

**A. `.legacy` bundle (recommended path)** — a zip containing `manifest.json`, `items.json`, `media/`, and `checksums.txt`. Preserves photos, crops, quantities, and identifiers. This is what "export to Legacy Distribution" produces.

**B. `items.csv`** — flat projection for spreadsheets and attorney review. One row per item; photos referenced by filename only.

**C. Print PDF** — human handoff, never machine-imported.

```json
{
  "format": "legacy-exchange",
  "version": "1.0",
  "generated_at": "2026-08-04T20:00:00Z",
  "source": { "app": "legacy-registry", "app_version": "1.0.0", "inventory_id": "01J..." },
  "rooms":      [{ "id": "r_kitchen", "name": "Kitchen", "is_custom": false }],
  "categories": [{ "id": "c_jewelry", "name": "Jewelry", "is_custom": false }],
  "items": [{
    "item_id": "01JBX...",
    "title": "Hamilton pocket watch",
    "category_id": "c_jewelry",
    "room_id": "r_bedroom",
    "description": "Gold-tone case, engraved back",
    "story": "Grandfather carried it on the railroad.",
    "quantity": 1,
    "condition": "good",
    "identifiers": { "brand": "Hamilton", "serial": "992B" },
    "value_estimate_cents": 45000,
    "value_basis": "ai_estimate",
    "high_value_flag": true,
    "ai_confidence": 0.82,
    "photos": [{ "role": "primary", "file": "media/01JBX_1.jpg", "crop_bbox": [0.11,0.20,0.62,0.74] }],
    "recipient_hint": { "recipient_name": "Susan", "relationship": "daughter", "is_binding": false }
  }],
  "disclaimer": "Owner wishes only. Not a will, codicil, or personal property memorandum."
}
```

### Import behavior in Reindeer: FairPlay

1. Land everything in the existing **Intake queue** as `review_state = draft` — nothing enters a live game silently.
2. Respect the existing **fair round locking** rule: if a game has started, imported items are queued, not injected into the active pool.
3. Run the existing **duplicate scan** against the estate catalog and route hits to side-by-side resolution.
4. Map rooms and categories by name; unmatched names land in a mapping screen, never auto-created.
5. Show `recipient_hint` to the administrator as a non-binding suggestion, with an explicit "apply as heir preference" action.
6. Re-import of the same `item_id` updates rather than duplicates, and is logged in the hash-chained audit trail.

---

## 6. Reindeer Registry app surface

Capture-first, elderly-friendly, following the earlier UX rules: one primary action per screen, 44–48px targets, 16px+ body text, icons paired with text, reassurance copy.

**Guided capture flow:** Photo → Confirm name → Add story (voice optional) → Room → Category → Intended recipient (optional) → Save. Every step skippable except the photo, with "You can change this later" on each screen.

**Screens:** Home (Add item · My items · Print · Send to Distribution), Capture, Review queue (newest-first, Keep/Reject, retake/remove photo), Item detail, Room and category browse, Print center, Export.

**Print outputs** (all dated and page-numbered):
- Single item sheet — large photo, title, room, category, identifiers, story, intended recipient, value note
- Room report and category report — grid or list density
- Intended-recipient list — grouped by named person
- Full inventory summary — cover page, counts, totals, disclaimer footer

**Not in this app:** ranking, drafting, conflicts, bidding, equalization, envy review, heir accounts, receipts.

---

## 7. Migration sequence

Each step ships independently; Reindeer: FairPlay stays runnable throughout.

1. **Audit and tag.** Walk the current intake code and mark every file `shared`, `distribution-only`, or `tangled`. Output a one-page inventory of tangled call sites.
2. **Stand up workspaces.** Add the root `package.json` and empty packages. No logic moves yet.
3. **Lift contracts.** Move item models, validators, and the export schema into `legacy-core-api`. Reindeer: FairPlay imports them; behavior unchanged. Run the existing critical-path tests here as the first gate.
4. **Lift data.** Move repositories, media handling, and audit chaining into `legacy-core-data` behind `ScopeCtx`. Generalize the estate-scope guard to a scope guard.
5. **Lift intake.** Move capture routes, the vision prompt, bbox/crop handling, video keyframe grouping, and duplicate logic into `legacy-intake-feature` as a mountable router plus client components.
6. **Add print.** Build `legacy-print-feature` from the existing PDF report machinery, generalized to templates and `PrintProfile`.
7. **Build the shell.** Create `apps/reindeer-registry` — thin Express server mounting intake + print, plus the guided elder-friendly client. No new domain logic.
8. **Wire exchange.** Implement `legacy-exchange` v1 writer in Inventory and reader in Distribution's Intake queue. Test round-trip: capture 20 items with photos → export bundle → import → verify photos, quantities, rooms, categories, and audit entries.
9. **Split builds.** Separate version numbers, separate installers, separate licensing hooks (kept disabled per current testing posture).

**Gate between 5 and 6:** re-run the Reindeer: FairPlay automated critical-path tests and one full simulation run. The refactor is only safe if the practice game still produces identical results.

---

## 8. Open decisions

- **Story storage** — voice notes kept as audio, or transcribed and discarded? Discarding keeps the media footprint aligned with the existing video posture.
- **Same-machine shortcut** — when both apps run on the user's local machine, offer a direct database-to-database import in addition to the bundle file?
- **Print of high-value amounts** — Reindeer: FairPlay hides dollar values from heirs; Reindeer Registry is single-owner, so values can print. Confirm the printed report defaults to showing or hiding estimates.
- **License boundary** — sold separately implies two license keys; confirm whether owning both unlocks a bundled import path.
- **Trademark** — "Reindeer Registry" needs the same clearance step still pending for Reindeer: FairPlay.

---

## 9. Naming in the product line

| Product | One-line description |
|---|---|
| **Reindeer Registry** | Photograph important belongings, let AI draft the details, print item sheets, and export a structured inventory. |
| **Reindeer: FairPlay** (Legacy Distribution) | Run a fair family process to rank, draft, and finalize who receives each item. |
| **Reindeer Legacy** | Both, together — document first, divide later. |
