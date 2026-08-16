/**
 * Format-only entry point.
 *
 * Reindeer: FairPlay needs to READ a ReindeerExchange bundle, but it must not
 * pull in the inventory app's SQLite repositories to do it. This entry exports
 * the file format and nothing that touches a database.
 */
export { parseEnvelope, EXCHANGE_FORMAT, EXCHANGE_VERSION } from './v1/envelope.js';
export { CSV_COLUMNS } from './v1/csv.js';
export { unzipSync, crc32 } from './zip.js';
export { readBundle, saveBundleToDisk } from './bundle.js';
