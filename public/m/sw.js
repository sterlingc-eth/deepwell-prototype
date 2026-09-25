/* DeepWell Mobile service worker (scope /m/).
 * - The /m/ page: network-first so a deploy is picked up right away, but if
 *   the network hasn't answered in 3 s (weak signal) the last good copy is
 *   shown instead of a blank screen; it still refreshes in the background.
 * - /assets/*: content-hashed and immutable, so cache-first; the cache is
 *   trimmed so old builds don't pile up on the phone.
 * - Never touches /api/*: customer data is never cached on the device. */
const CACHE = 'dw-mobile-v2';
const SHELL = '/m/';
const NAV_TIMEOUT_MS = 3000;
const MAX_ASSETS = 60;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.add(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

async function trimAssets() {
  const cache = await caches.open(CACHE);
  const keys = (await cache.keys()).filter((r) => new URL(r.url).pathname.startsWith('/assets/'));
  for (const req of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(req);
}

function navigate(event) {
  const network = fetch(event.request).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      event.waitUntil(caches.open(CACHE).then((c) => c.put(SHELL, copy)));
    }
    return res;
  });
  event.waitUntil(network.catch(() => {}));
  // A server error (5xx) also falls back to the last good page when there is one.
  const good = network.then((res) => (res.ok ? res : caches.match(SHELL).then((hit) => hit || res)));
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, NAV_TIMEOUT_MS);
  }).then(() => caches.match(SHELL));
  return Promise.race([good, timeout.then((hit) => hit || good)])
    .catch(() => caches.match(SHELL).then((r) => r || Response.error()))
    .finally(() => clearTimeout(timer));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(navigate(event));
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              event.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)).then(trimAssets));
            }
            return res;
          })
      )
    );
  }
});
