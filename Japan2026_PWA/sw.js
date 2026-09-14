// Japan 2026 PWA – Service Worker
const CACHE = 'japan2026-v20';
const OFFLINE_ASSETS = [
  './',
  './index.html',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js',
  'https://maps.wikimedia.org/osm-intl/5/27/13.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => {
      // Pre-cache shell assets; network assets cached on first use
      return c.addAll(['./index.html']).catch(() => {});
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Don't cache Wikipedia/OSM API calls – always needs live data
  const isApi = url.hostname.includes('wikipedia.org') ||
                url.hostname.includes('wikimedia.org') ||
                url.hostname.includes('nominatim.openstreetmap.org') ||
                url.hostname.includes('opentripmap.com') ||
                url.hostname.includes('overpass-api.de') ||
                url.hostname.includes('translate.googleapis.com') ||
                url.hostname.includes('maps.googleapis.com');

  if (isApi) {
    // Network-only for API calls
    e.respondWith(fetch(e.request).catch(() => new Response('', { status: 503 })));
    return;
  }

  // Map tiles: cache-first with network fallback
  if (url.hostname.includes('wikimedia.org') || url.hostname.includes('openstreetmap.org')) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(resp => {
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return resp;
        }).catch(() => new Response('', { status: 503 }));
      })
    );
    return;
  }

  // App shell + CDN assets: cache-first
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(resp => {
        if (resp.ok && e.request.method === 'GET') {
          const clone = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return resp;
      }).catch(() => {
        // Offline fallback: return cached index.html
        return caches.match('./index.html');
      });
    })
  );
});
