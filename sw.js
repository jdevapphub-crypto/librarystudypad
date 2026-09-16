/* =====================================================
   StudyPad-Library — Service Worker
   Joheliv: Jason's Labs, South Africa, 2026
===================================================== */

const CACHE_VERSION = 'v1';
const SHELL_CACHE   = `studypad-library-shell-${CACHE_VERSION}`;
const ASSETS_CACHE  = `studypad-library-assets-${CACHE_VERSION}`;
const DATA_CACHE    = `studypad-library-data-${CACHE_VERSION}`;
const IMAGES_CACHE  = `studypad-library-images-${CACHE_VERSION}`;

/* =====================================================
   APP SHELL — precached on install
   Adjust these paths to match your real file names.
===================================================== */
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './offline.html',
  './styles/main.css',
  './scripts/app.js',
  './scripts/library.js',
  './scripts/search.js',
  './assets/logo.svg',
  './assets/icon-192.png',
  './assets/icon-512.png'
];

/* =====================================================
   LIMITS — prevent cache bloat
===================================================== */
const MAX_DATA_ENTRIES   = 100;   // JSON / API responses
const MAX_IMAGE_ENTRIES  = 60;    // book covers, thumbnails
const MAX_ASSET_ENTRIES  = 80;    // CSS, JS, fonts

/* =====================================================
   INSTALL
===================================================== */
self.addEventListener('install', (event) => {
  console.log('[Library SW] Installing…');

  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => {
        // addAll fails if any single file fails — use individual adds
        return Promise.all(
          APP_SHELL.map((url) =>
            cache.add(url).catch((err) =>
              console.warn('[Library SW] Precache skipped:', url, err)
            )
          )
        );
      })
      .then(() => self.skipWaiting())
  );
});

/* =====================================================
   ACTIVATE — clean up old versions
===================================================== */
self.addEventListener('activate', (event) => {
  console.log('[Library SW] Activating…');

  const CURRENT_CACHES = [
    SHELL_CACHE,
    ASSETS_CACHE,
    DATA_CACHE,
    IMAGES_CACHE
  ];

  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => !CURRENT_CACHES.includes(key))
            .map((key) => {
              console.log('[Library SW] Deleting old cache:', key);
              return caches.delete(key);
            })
        )
      )
      .then(() => self.clients.claim())
  );
});

/* =====================================================
   FETCH — route requests to the right strategy
===================================================== */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle GET
  if (request.method !== 'GET') return;

  // Skip non-http(s)
  if (!url.protocol.startsWith('http')) return;

  // Skip browser extensions / devtools
  if (url.protocol === 'chrome-extension:') return;

  // 1. Document navigations → app shell fallback
  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  // 2. Library API / JSON data → network first, cache fallback
  if (isApiRequest(url, request)) {
    event.respondWith(handleData(request, DATA_CACHE, MAX_DATA_ENTRIES));
    return;
  }

  // 3. Images (covers, thumbnails) → cache first, then network
  if (request.destination === 'image' || isImageUrl(url)) {
    event.respondWith(handleImage(request));
    return;
  }

  // 4. CSS / JS / fonts → stale-while-revalidate
  if (isStaticAsset(url, request)) {
    event.respondWith(handleAsset(request));
    return;
  }

  // 5. Everything else → network first, cache fallback
  event.respondWith(handleData(request, DATA_CACHE, MAX_DATA_ENTRIES));
});

/* =====================================================
   STRATEGY 1 — Navigation (network first, shell fallback)
===================================================== */
async function handleNavigation(request) {
  try {
    const fresh = await fetch(request);

    // Cache a copy of the HTML for offline use
    const cache = await caches.open(SHELL_CACHE);
    cache.put(request, fresh.clone());

    return fresh;
  } catch (err) {
    // Offline — serve cached page or fallback shell
    const cached = await caches.match(request);
    if (cached) return cached;

    const shell = await caches.match('./index.html');
    if (shell) return shell;

    const offline = await caches.match('./offline.html');
    if (offline) return offline;

    return new Response(
      '<h1>StudyPad-Library is offline</h1><p>Reconnect to continue browsing.</p>',
      { headers: { 'Content-Type': 'text/html' }, status: 503 }
    );
  }
}

/* =====================================================
   STRATEGY 2 — Data / API (network first, cache fallback)
===================================================== */
async function handleData(request, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);

  try {
    const fresh = await fetch(request);

    // Only cache successful JSON-ish responses
    if (fresh && fresh.status === 200) {
      cache.put(request, fresh.clone());
      trimCache(cacheName, maxEntries);
    }

    return fresh;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) {
      console.log('[Library SW] Serving cached data for:', request.url);
      return cached;
    }

    return new Response(
      JSON.stringify({
        error: 'offline',
        message: 'Data unavailable offline. Please reconnect.'
      }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}

/* =====================================================
   STRATEGY 3 — Images (cache first, then network)
===================================================== */
async function handleImage(request) {
  const cache = await caches.open(IMAGES_CACHE);
  const cached = await cache.match(request);

  if (cached) return cached;

  try {
    const fresh = await fetch(request);

    if (fresh && fresh.status === 200 && fresh.type !== 'opaque') {
      cache.put(request, fresh.clone());
      trimCache(IMAGES_CACHE, MAX_IMAGE_ENTRIES);
    } else if (fresh && fresh.type === 'opaque') {
      // Opaque (cross-origin) — still safe to cache
      cache.put(request, fresh.clone());
      trimCache(IMAGES_CACHE, MAX_IMAGE_ENTRIES);
    }

    return fresh;
  } catch (err) {
    // Return a transparent placeholder if image fails
    return new Response('', { status: 408 });
  }
}

/* =====================================================
   STRATEGY 4 — Static assets (stale-while-revalidate)
===================================================== */
async function handleAsset(request) {
  const cache = await caches.open(ASSETS_CACHE);
  const cached = await cache.match(request);

  // Kick off background update
  const fetchPromise = fetch(request)
    .then((fresh) => {
      if (fresh && fresh.status === 200) {
        cache.put(request, fresh.clone());
        trimCache(ASSETS_CACHE, MAX_ASSET_ENTRIES);
      }
      return fresh;
    })
    .catch(() => null);

  // Serve cached immediately; fallback to network
  return cached || fetchPromise || new Response('', { status: 408 });
}

/* =====================================================
   HELPERS
===================================================== */
function isApiRequest(url, request) {
  const accept = request.headers.get('accept') || '';
  return (
    url.pathname.startsWith('/api/') ||
    url.hostname.includes('workers.dev') ||
    accept.includes('application/json')
  );
}

function isImageUrl(url) {
  return /\.(png|jpe?g|gif|webp|svg|avif|ico|bmp)$/i.test(url.pathname);
}

function isStaticAsset(url, request) {
  if (request.destination === 'style' ||
      request.destination === 'script' ||
      request.destination === 'font') {
    return true;
  }
  return /\.(css|js|mjs|woff2?|ttf|otf|eot)$/i.test(url.pathname);
}

/* Trim cache to a max number of entries (LRU-ish) */
async function trimCache(cacheName, maxItems) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();

  if (keys.length <= maxItems) return;

  // Delete oldest entries
  const toDelete = keys.slice(0, keys.length - maxItems);
  await Promise.all(toDelete.map((key) => cache.delete(key)));
}

/* =====================================================
   MESSAGES — allow the page to trigger updates
===================================================== */
self.addEventListener('message', (event) => {
  if (!event.data) return;

  switch (event.data.type) {
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;

    case 'CLEAR_CACHES':
      event.waitUntil(
        caches.keys().then((keys) =>
          Promise.all(keys.map((key) => caches.delete(key)))
        ).then(() => {
          if (event.source && event.source.postMessage) {
            event.source.postMessage({ type: 'CACHES_CLEARED' });
          }
        })
      );
      break;

    case 'CACHE_URLS':
      event.waitUntil(
        caches.open(SHELL_CACHE).then((cache) =>
          cache.addAll(event.data.urls || []).catch(() => {})
        )
      );
      break;
  }
});

/* =====================================================
   BACKGROUND SYNC — queue library saves offline
===================================================== */
self.addEventListener('sync', (event) => {
  if (event.tag === 'library-sync') {
    console.log('[Library SW] Background sync:', event.tag);
    // Future: POST queued library actions to your backend
  }
});

/* =====================================================
   PUSH NOTIFICATIONS — new books / updates
===================================================== */
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload = {};
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'StudyPad-Library', body: event.data.text() };
  }

  const options = {
    body: payload.body || 'New content available in your library.',
    icon: './assets/icon-192.png',
    badge: './assets/icon-192.png',
    vibrate: [100, 50, 100],
    tag: payload.tag || 'library-update',
    data: { url: payload.url || '/' }
  };

  event.waitUntil(
    self.registration.showNotification(
      payload.title || 'StudyPad-Library',
      options
    )
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';
  event.waitUntil(clients.openWindow(target));
});

/* =====================================================
   PERIODIC SYNC — refresh library catalog in background
   (Chrome only, requires permission from page)
===================================================== */
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'library-refresh') {
    event.waitUntil(refreshCatalog());
  }
});

async function refreshCatalog() {
  try {
    const cache = await caches.open(DATA_CACHE);
    const response = await fetch('/api/library/catalog', { cache: 'no-store' });
    if (response.ok) {
      await cache.put('/api/library/catalog', response.clone());
    }
  } catch (err) {
    console.warn('[Library SW] Catalog refresh failed:', err);
  }
}
