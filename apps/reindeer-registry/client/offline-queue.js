/* ------------------------------------------------------- the offline queue
 *
 * Not every owner has internet at home, and the ones who do not are exactly the
 * ones who most need this to work anyway. So a capture is written to the device
 * first and the network is treated as a bonus that may arrive later, possibly at
 * a solicitor's or trust office days afterwards.
 *
 * IndexedDB, not localStorage: a room recording is tens of megabytes of binary
 * and localStorage is a ~5MB string store that only holds text.
 *
 * This lives in its own file for one practical reason. The in-thread preview
 * runs inside a sandboxed iframe where IndexedDB is unavailable, so the preview
 * build swaps this file for offline-queue-unavailable.js. Everything here is
 * therefore optional by construction: app.js must cope with `available()` being
 * false, which it must do anyway for a browser with storage switched off.
 */
(function () {
  const QUEUE_DB = 'reindeer-wishes-queue';
  const QUEUE_STORE = 'pending';

  function idbOpen() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('no-idb'));
      const req = window.indexedDB.open(QUEUE_DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(QUEUE_STORE)) {
          db.createObjectStore(QUEUE_STORE, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('idb-open-failed'));
    });
  }

  window.LegacyOfflineQueue = {
    /** Can this device hold a recording back for later? */
    async available() {
      try {
        const db = await idbOpen();
        db.close();
        return true;
      } catch {
        return false;
      }
    },

    async add(record) {
      const db = await idbOpen();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(QUEUE_STORE, 'readwrite');
        const req = tx
          .objectStore(QUEUE_STORE)
          .add({ ...record, queued_at: new Date().toISOString() });
        req.onsuccess = () => resolve(req.result);
        tx.onerror = () => reject(tx.error);
      });
    },

    /** Everything still waiting. Returns [] rather than throwing: a badge that
     *  cannot be drawn must not take the screen down with it. */
    async all() {
      try {
        const db = await idbOpen();
        return await new Promise((resolve, reject) => {
          const req = db.transaction(QUEUE_STORE, 'readonly').objectStore(QUEUE_STORE).getAll();
          req.onsuccess = () => resolve(req.result ?? []);
          req.onerror = () => reject(req.error);
        });
      } catch {
        return [];
      }
    },

    async remove(id) {
      const db = await idbOpen();
      return new Promise((resolve) => {
        const tx = db.transaction(QUEUE_STORE, 'readwrite');
        tx.objectStore(QUEUE_STORE).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    },
  };
})();
