const CACHE_NAME = 'faseela-app-v5';
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './images/favicon.svg',
  './images/icon-192.png',
  './images/icon-512.png',
  './images/icon-1024.png',
  './images/apple-touch-icon.png',
  './images/tree_ancient_khodairi.jpg',
  './images/tree_sourani_idlib.jpg',
  './images/tree_qaisi_daraa.jpg',
  './images/tree_pistachio_ashouri.jpg',
  './images/tree_pistachio_batouri.jpg',
  './images/tree_pistachio_mork.jpg',
  './images/pistachio_clusters_macro.jpg',
  './images/tree_almond_farak.jpg',
  './images/tree_almond_homs.jpg',
  './images/tree_pomegranate_hourani.jpg',
  './images/tree_pomegranate_jabbi.jpg',
  './images/pomegranate_tree_daraa.jpg',
  './images/tree_walnut_barada.jpg',
  './images/tree_walnut_saydnaya.jpg',
  './images/walnut_tree_barada.jpg',
  './images/syrian_olive_oil_bottle.jpg',
  './images/olive_branches_macro.jpg',
  './images/olive_harvest_festival.jpg',
  './images/syrian_transfer_receipt.jpg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(CORE_ASSETS).catch(err => {
        console.warn('Some assets could not be cached immediately:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.filter(name => name !== CACHE_NAME).map(name => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  // Navigation requests — network first with offline fallback
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match('./index.html').then(r => r || new Response(
          '<html dir="rtl"><body style="font-family:Cairo,sans-serif;text-align:center;padding:4rem 2rem;background:#f5f0e8"><h1 style="color:#2c3e2d">فسيلة — وضع عدم الاتصال</h1><p style="color:#666">لا يوجد اتصال بالإنترنت. يرجى المحاولة لاحقاً.</p><p style="color:#999;font-size:0.85rem">Faseela — Offline Mode</p></body></html>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        )))
    );
    return;
  }

  // Other resources — stale-while-revalidate
  event.respondWith(
    caches.match(event.request).then(cachedResponse => {
      const fetchPromise = fetch(event.request).then(networkResponse => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => cachedResponse || new Response('', { status: 408 }));

      return cachedResponse || fetchPromise;
    })
  );
});
