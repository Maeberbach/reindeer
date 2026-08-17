/**
 * Hand-written ambient types for `@reindeer/exchange/reader`.
 *
 * The package is plain ESM JavaScript with no type declarations of its own.
 * This module only describes the DB-free surface Reindeer: FairPlay
 * actually imports (`readBundle`), shaped from:
 *   - packages/reindeer-exchange/src/bundle.js   (readBundle, writeBundle)
 *   - packages/reindeer-exchange/src/v1/envelope.js (buildEnvelope/parseEnvelope)
 *   - packages/reindeer-exchange/src/reader.js   (re-exports)
 *
 * Keep this in sync with the envelope shape if the exchange package changes.
 */
declare module "@reindeer/exchange/reader" {
  /** A photo attached to an item. */
  export interface ExchangePhoto {
    role?: string | null;
    file: string;
    crop_bbox?: [number, number, number, number] | null;
    sha256?: string | null;
    source_frame_index?: number | null;
  }

  /** A video walkaround or a voice recording attached to an item. */
  export interface ExchangeRecording {
    kind: "video" | "audio";
    role?: string | null;
    label?: string;
    file: string;
    mime_type?: string | null;
    duration_ms?: number | null;
    transcript?: string;
    transcript_source?: string | null;
    sha256?: string | null;
    byte_size?: number | null;
  }

  /** A whole-house/whole-room recording belonging to no single item. */
  export interface ExchangeScopeMedia {
    kind: "video" | "audio";
    title?: string | null;
    file: string;
    mime_type?: string | null;
    duration_ms?: number | null;
    transcript?: string;
    sha256?: string | null;
    byte_size?: number | null;
  }

  /** The owner's non-binding wish about who should receive the item. */
  export interface ExchangeRecipientHint {
    recipient_name: string;
    relationship?: string | null;
    alternate_name?: string | null;
    owner_note?: string | null;
    is_binding: false;
  }

  export interface ExchangeItem {
    item_id: string;
    title: string;
    category_id?: string | null;
    category_name?: string | null;
    room_id?: string | null;
    room_name?: string | null;
    /** Multi-site: which site this item belongs to. Null = primary/home. */
    site_id?: string | null;
    site_name?: string | null;
    description?: string | null;
    story?: string | null;
    quantity?: number | null;
    condition?: string | null;
    identifiers?: Record<string, unknown>;
    value_estimate_cents?: number | null;
    value_basis?: string | null;
    high_value_flag?: boolean;
    ai_confidence?: number | null;
    created_at?: string | null;
    updated_at?: string | null;
    photos: ExchangePhoto[];
    recordings: ExchangeRecording[];
    recipient_hint: ExchangeRecipientHint | null;
  }

  export interface ExchangeRoomRef {
    id: string;
    name: string;
    is_custom: boolean;
  }

  export interface ExchangeCategoryRef {
    id: string;
    name: string;
    is_custom: boolean;
  }

  export interface ExchangeCounts {
    items: number;
    photos: number;
    videos: number;
    audio: number;
    scope_media: number;
    with_recipient_hint: number;
    high_value: number;
  }

  export interface ExchangeSource {
    app: string;
    app_version?: string;
    inventory_id?: string;
    owner_name?: string;
    [key: string]: unknown;
  }

  export interface ExchangeEnvelope {
    format: "reindeer-exchange";
    version: string;
    generated_at: string;
    source: ExchangeSource;
    rooms: ExchangeRoomRef[];
    categories: ExchangeCategoryRef[];
    items: ExchangeItem[];
    scope_media: ExchangeScopeMedia[];
    counts: ExchangeCounts;
    disclaimer: string;
  }

  export interface ExchangeManifest {
    format: "reindeer-exchange-bundle";
    version: string;
    batch_id: string;
    created_at: string;
    source: ExchangeSource;
    counts: ExchangeCounts;
    total_media_bytes: number;
    files: string[];
  }

  export interface ReadBundleResult {
    envelope: ExchangeEnvelope;
    manifest: ExchangeManifest | null;
    files: Map<string, Buffer>;
    /** Checksum mismatches / missing files reported by the reader. */
    problems: string[];
  }

  export function readBundle(buffer: Buffer): ReadBundleResult;
  export function saveBundleToDisk(buffer: Buffer, dir: string, fileName: string): string;
}
