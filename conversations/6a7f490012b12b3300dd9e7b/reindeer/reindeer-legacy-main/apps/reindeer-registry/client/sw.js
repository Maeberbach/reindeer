/*
 * Offline shell for Reindeer: Registry.
 *
 * The reason this exists: not every owner has internet where the things are.
 * Someone may walk their house with no signal at all and only reach a connection
 * days later at a relative's, or at their trust officer's or solicitor's office.
 * Without a service worker the app is simply a blank page in that house, so the
 * shell is cached on first visit and served from the device thereafter.
 *
 * What is deliberately NOT done here:
 *
 * - API responses are never cached. A stale item list shown as if current would
 *   be worse than an honest failure, because the owner would believe things were
 *   recorded that were not. Reads fail and the app copes.
 * - Uploads are never replayed by the service worker. Recordings are queued in
 *   IndexedDB by the page and sent only when the owner presses send. Video is
 *   large and phone data plans are not free; that is the owner's decision.
 */

const CACHE = 'reindeer-registry-shell-v3';

// The shell only. Enough to open the app, walk the house and queue recordings.
const SHELL = ['./', './index.html', './app.js', './styles.css', './manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // addAll is all-or-nothing, and one missing file would leave the owner with
      // no offline app at all, so each entry is allowed to fail on its own.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never serve the API from cache. See the note above: a plausible-looking
  // stale inventory is a worse outcome than a visible error.
  if (url.pathname.startsWith('/api/')) return;

  // Cross-origin requests are left entirely alone.
  if (url.origin !== self.location.origin) return;

  /*
   * Network first, cache as the safety net.
   *
   * This way an owner who does have internet always gets the current build —
   * which matters because updates are pushed to the hosted app — while an owner
   * with none still gets a working app from the device.
   */
  event.respondWith((async () => {
    try {
      const fresh = await fetch(request);
      if (fresh && fresh.ok && fresh.type === 'basic') {
        const cache = await caches.open(CACHE);
        cache.put(request, fresh.clone());
      }
      return fresh;
    } catch {
      const hit = await caches.match(request, { ignoreSearch: true });
      if (hit) return hit;
      // A navigation with nothing cached for it still lands on the app shell
      // rather than a browser error page.
      if (request.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      throw new Error('offline and not cached');
    }
  })());
});
