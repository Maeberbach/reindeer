/* --------------------------------------- the offline queue, when it cannot be
 *
 * A stand-in for offline-queue.js used by the preview build, because the
 * sandboxed preview iframe has no IndexedDB.
 *
 * It reports honestly that nothing can be held back, which is the same answer a
 * real browser gives when storage is switched off or the disk is full. It never
 * pretends to have saved something: `add` refuses, so the caller falls back to
 * telling the owner that this capture needs a connection right now. Silently
 * accepting a recording and dropping it would be the worst possible behaviour
 * for this app — the whole point is that the recording survives.
 */
(function () {
  window.LegacyOfflineQueue = {
    async available() {
      return false;
    },
    async add() {
      throw new Error('no-idb');
    },
    async all() {
      return [];
    },
    async remove() {
      /* nothing was ever stored */
    },
  };
})();
