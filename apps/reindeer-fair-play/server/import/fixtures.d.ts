/**
 * Hand-written ambient types for the packages `server/import/selftest.mts`
 * uses ONLY to build a real fixture inventory and a real .reindeer bundle to
 * import against (mirrors `scripts/roundtrip-test.mjs`). These packages are
 * plain ESM JavaScript with no type declarations of their own.
 *
 * This is deliberately loose (many `any`s) — it exists so `npm run check`
 * can type-check the self-test, not to fully model these packages' surface.
 * See `exchange.d.ts` for the precise, production-relevant declaration of
 * `@reindeer/exchange/reader`, which importService.ts actually depends
 * on.
 */

declare module "@reindeer/core-api" {
  export const SCOPE_TYPE: { INVENTORY: string; ESTATE: string; [k: string]: string };
  export function makeScopeCtx(args: { scopeType: string; scopeId: string; actorId?: string | null }): any;
  export const DEFAULT_ROOMS: string[];
  export const DEFAULT_CATEGORIES: string[];
  export const ORIGIN_APP: Record<string, string>;
}

declare module "@reindeer/core-data" {
  export function openDb(path: string): any;
  export function ulid(): string;
  export function defaultDataDir(): string;
  export const MIGRATIONS: any[];

  export class SqliteAuditLog {
    constructor(db: any);
  }

  export class SqliteItemRepository {
    constructor(db: any, audit?: SqliteAuditLog);
    create(fields: Record<string, any>, ctx: any): Promise<any>;
    get(itemId: string, ctx: any): Promise<any>;
    list(query: Record<string, any>, ctx: any): Promise<any[]>;
  }

  export class FsMediaStore {
    constructor(db: any, dir: string);
    put(data: Buffer, meta: Record<string, any>, ctx: any): Promise<any>;
  }

  export class ScopeMediaStore {
    constructor(db: any, dir: string);
    put(data: Buffer, meta: Record<string, any>, ctx: any): Promise<any>;
  }

  export class Registry {
    constructor(db: any, audit?: SqliteAuditLog);
    ensureScope(args: { scopeId: string; scopeType: string; name: string }): any;
    resolveRoom(name: string, ctx: any): { room_id: string; name: string };
    resolveCategory(name: string, ctx: any): { category_id: string; name: string };
  }
}

declare module "@reindeer/exchange" {
  export function buildEnvelope(...args: any[]): any;
  export function parseEnvelope(...args: any[]): any;
  export const EXCHANGE_FORMAT: string;
  export const EXCHANGE_VERSION: string;
  export function toCsv(...args: any[]): string;
  export const CSV_COLUMNS: string[];
  export function zipSync(...args: any[]): Buffer;
  export function unzipSync(...args: any[]): Map<string, Buffer>;
  export function crc32(...args: any[]): number;

  export function writeBundle(args: {
    itemRepo: any;
    mediaStore: any;
    scopeMediaStore?: any;
    registry: any;
    ctx: any;
    query?: Record<string, any>;
    source: { app: string; app_version: string; inventory_id: string; owner_name?: string };
  }): Promise<{ buffer: Buffer; envelope: any }>;

  export function readBundle(buffer: Buffer): {
    envelope: any;
    manifest: any;
    files: Map<string, Buffer>;
    problems: string[];
  };

  export function saveBundleToDisk(buffer: Buffer, dir: string, fileName: string): string;
  export function importBundle(...args: any[]): Promise<any>;
  export function applyRecipientSuggestion(...args: any[]): Promise<any>;
}
