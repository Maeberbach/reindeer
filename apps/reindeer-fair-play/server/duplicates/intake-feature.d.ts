/**
 * The intake feature is plain ESM JavaScript with no build step, so TypeScript
 * needs this shim to reference its duplicate matcher. Kept minimal on purpose:
 * only the parity test imports from here.
 */
declare module "@reindeer-legacy/intake-feature/src/duplicates.js" {
  export function titleSimilarity(a: string, b: string): number;
}
