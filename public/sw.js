// Faseela service worker (review F-14): small app-shell precache, bounded image cache.
// CACHE_VERSION and the ?v= of the code files below are written by scripts/version-assets.cjs on every build:
// a cached file only ever answers for the build it belongs to, so page and code cannot drift apart.
const CACHE_VERSION = 'b1ebbee9b3c2d';
const SHELL_CACHE = `faseela-shell-${CACHE_VERSION}`;
const IMAGE_CACHE = `faseela-images-${CACHE_VERSION}`;
const IMAGE_CACHE_LIMIT = 40;

const SHELL_ASSETS = [
  './',
  './index.html',
  './app.js?v=1ebbee9b3c2d',
  './events.js?v=1ebbee9b3c2d',
  './assistant-knowledge.js?v=1ebbee9b3c2d',
  './shop.js?v=1ebbee9b3c2d',
  './manifest.json',
  './assets/tailwind.css?v=1ebbee9b3c2d',
  './fonts/fonts.css',
  './fonts/cairo-arabic-wght-normal.woff2',
  './fonts/cairo-latin-wght-normal.woff2',
  './vendor/lucide.min.js',
  './supabase-client.mjs?v=1ebbee9b3c2d',
  './images/faseela-olive-tree-logo.svg',
  './images/icon-192.png'
];

const OFFLINE_HTML = '<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>فسيلة</title><body style="font-family:Cairo,sans-serif;text-align:center;padding:4rem 2rem;background:#f5f0e8;color:#2c3e2d"><h1>فسيلة — وضع عدم الاتصال</h1><p>لا يوجد اتصال بالإنترنت. يرجى المحاولة لاحقاً.</p><p style="color:#57534e;font-size:.9rem">Faseela — you are offline.</p></body></html>';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .catch((error) => console.warn('[sw] shell precache incomplete:', error && error.message))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== SHELL_CACHE && n !== IMAGE_CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

async function trimCache(name, limit) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - limit; i += 1) await cache.delete(keys[i]);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Never intercept cross-origin traffic (Supabase API, Realtime, auth redirects, uploads).
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request, { cache: 'no-cache' })
        .then((response) => {
          if (response.ok) caches.open(SHELL_CACHE).then((cache) => cache.put('./index.html', response.clone()));
          return response;
        })
        .catch(async () => (await caches.match('./index.html'))
          || new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))
    );
    return;
  }

  if (url.pathname.includes('/images/')) {
    // Cache-first for images, bounded so the device storage stays small.
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(IMAGE_CACHE).then((cache) => cache.put(request, copy)).then(() => trimCache(IMAGE_CACHE, IMAGE_CACHE_LIMIT));
        }
        return response;
      }))
    );
    return;
  }

  // Code and styles: network-first, so a new deploy is visible on the first load (no second
  // reload needed). The cached copy is only an offline fallback.
  event.respondWith(
    // cache: 'no-cache' revalidates with the server (cheap 304) instead of trusting the HTTP cache.
    fetch(request, { cache: 'no-cache' })
      .then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => (await caches.match(request)) || new Response('', { status: 504 }))
  );
});
