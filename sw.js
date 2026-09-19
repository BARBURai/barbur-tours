// Barbur Tours service worker.
//
// This lives in its own file on purpose. The app used to register its worker from a
// blob: URL built at runtime, which browsers reject as a worker script - the failure
// was swallowed by a .catch(()=>{}), so no worker was ever installed and nothing was
// ever cached. A worker script has to be a real same-origin URL.
const CACHE = 'barbur-tours-v14';

// Everything needed to open the app with no network. The Firebase modules are included
// because they are ES imports: without them index.html loads and then stalls.
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js',
  // Map libraries are vendored rather than loaded from a CDN precisely so they can be
  // cached here: an offline-first app cannot depend on a CDN being reachable.
  './vendor/maplibre-gl.mjs',
  './vendor/maplibre-gl-shared.mjs',
  './vendor/maplibre-gl-worker.mjs',
  './vendor/maplibre-gl.css',
  './vendor/pmtiles.js',
  './vendor/protomaps-themes-base.js'
];

const SHELL_FALLBACK = new URL('./index.html', self.location).href;

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      // One entry at a time: cache.addAll() rejects the whole install if any single
      // request fails, and a CDN hiccup then leaves us with no offline copy at all.
      .then(c => Promise.allSettled(SHELL.map(u => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function putInCache(req, res) {
  if (res && res.ok) {
    const c = await caches.open(CACHE);
    await c.put(req, res.clone());
  }
  return res;
}

async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  return putInCache(req, await fetch(req));
}

async function networkFirst(req, fallbackUrl) {
  try {
    return await putInCache(req, await fetch(req));
  } catch (err) {
    const hit = await caches.match(req) || (fallbackUrl && await caches.match(fallbackUrl));
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Firestore keeps its own IndexedDB cache and holds a long-lived listen channel.
  // Intercepting googleapis.com breaks both, so it is passed straight through.
  if (url.hostname.endsWith('googleapis.com')) return;

  // The basemap archive is read with HTTP Range requests, and the Cache API refuses to
  // store the 206 responses they produce. It is left alone: the map screen saves the
  // whole file to IndexedDB itself, which is what makes it available offline.
  if (url.pathname.endsWith('.pmtiles')) return;

  // The page itself: take a fresh copy when there is signal, fall back to the cached
  // shell so the app still opens without any.
  if (req.mode === 'navigate') {
    e.respondWith(networkFirst(req, SHELL_FALLBACK));
    return;
  }

  // Weather: a stale forecast is more useful than an empty panel.
  if (url.hostname.endsWith('open-meteo.com')) {
    e.respondWith(networkFirst(req));
    return;
  }

  // Our own assets and the version-pinned Firebase modules never change under the same
  // URL, so serving them from the cache is both correct and instant. A deploy changes
  // CACHE, which drops the old entries on activate.
  // Map label glyphs are fetched per character range as labels come into view, so they
  // accumulate in the cache while online and are then available offline.
  if (url.origin === self.location.origin ||
      url.hostname === 'www.gstatic.com' ||
      url.hostname === 'protomaps.github.io') {
    e.respondWith(cacheFirst(req));
  }
});
