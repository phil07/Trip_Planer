// Trip Planer PWA – Service Worker (Build v212: bei jedem Release mitziehen, sonst erkennt der Browser kein SW-Update)
importScripts('version.js'); // sets self.APP_VERSION – single source of truth
importScripts('features/reminders-sw.js'); // Erinnerungen vor Stationswechseln (Periodic Sync)
const CACHE = 'trip-planer-' + self.APP_VERSION;
const PRECACHE = ['./', './index.html', './style.css', './app.js', './version.js', './manifest.json',
  './icons/icon-192.svg', './icons/icon-512.svg', './icons/icon-192-v2.png', './icons/icon-512-v2.png',
  './icons/icon-192-maskable-v2.png', './icons/icon-512-maskable-v2.png',
  './vendor/leaflet/leaflet.js', './vendor/leaflet/leaflet.css', './vendor/leaflet/images/layers.png',
  './vendor/leaflet/images/layers-2x.png', './vendor/leaflet/images/marker-icon.png',
  './vendor/leaflet/images/marker-icon-2x.png', './vendor/leaflet/images/marker-shadow.png',
  './features/calendar.js', './features/calendar.css', './features/taxicard.js', './features/taxicard.css',
  './features/share.js', './features/share.css', './vendor/qrcode-generator/qrcode.js', './features/weather.js',
  './features/weather.css', './features/transit.js', './features/transit.css', './features/emergency.js',
  './features/emergency.css', './features/splitcosts.js', './features/splitcosts.css', './features/openinghours.js',
  './features/openinghours.css', './features/documents.js', './features/documents.css', './features/journalplus.js',
  './features/journalplus.css', './features/reminders.js', './features/reminders.css', './features/reminders-sw.js',
  './features/packcategories.css', './datenschutz', './nutzungsbedingungen', './impressum'];
const TILE_CACHE = 'trip-planer-tiles';
const TILE_CACHE_MAX = 300;
// Fremd-Hosts, deren Dateien (versioniert, CSS/Fonts) offline aus dem Cache kommen dürfen.
const CDN_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

// ─── INSTALL ──────────────────────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c =>
      c.addAll(PRECACHE.map(u => new Request(u, { cache: 'reload' })))
        .catch(err => console.warn('SW precache failed (install continues):', err))
    )
  );
  // Kein auto-skipWaiting – Nutzer tippt Update-Toast → SKIP_WAITING
});

// ─── MESSAGE ──────────────────────────────────────────────────────────────────
self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

// ─── ACTIVATE ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE && k !== TILE_CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ─── PERIODIC BACKGROUND SYNC ─────────────────────────────────────────────────
// Wird von Chrome auf Android ausgelöst, wenn die App im Hintergrund ist und
// WLAN/Strom vorhanden. Voraussetzung: periodicSync.register() im Client +
// Notification-Berechtigung für Push-Benachrichtigungen.
self.addEventListener('periodicsync', e => {
  if (e.tag === 'check-update') {
    e.waitUntil(checkForUpdates());
  }
});

async function checkForUpdates() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (clients.some(c => c.visibilityState === 'visible')) return; // App sichtbar → dort erscheint der Update-Hinweis
  try {
    // Versionsdatei vom Server holen (ungecacht)
    const res = await fetch('./version.js?nocache=' + Date.now(), { cache: 'no-store' });
    const text = await res.text();
    const m = text.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
    if (!m) return;
    const serverVersion = m[1];
    if (serverVersion !== self.APP_VERSION) {
      // Neue Version verfügbar → Push-Benachrichtigung anzeigen
      await self.registration.showNotification('Trip Planer – Update verfügbar', {
        body: 'Version ' + serverVersion + ' ist verfügbar. Tippe zum Aktualisieren.',
        icon: './icons/icon-192-v2.png',
        badge: './icons/icon-192-v2.png',
        tag: 'app-update',
        renotify: false,
        data: { url: './?action=update', version: serverVersion },
        actions: [
          { action: 'update', title: 'Jetzt aktualisieren' },
          { action: 'dismiss', title: 'Später' }
        ]
      });
    }
  } catch (e) {
    // TypeError = normaler Fetch-Fehler (offline) – kein Log-Rauschen.
    if (!(e instanceof TypeError)) console.warn('SW update check failed:', e);
  }
}

// ─── PUSH (FCM / Web Push) ────────────────────────────────────────────────────
// Empfängt Push-Nachrichten vom Backend (z. B. Cloudflare Worker + FCM).
// Nur Ziele innerhalb der App zulassen – eine Push-Nachricht darf keine fremde Seite öffnen.
function safeAppUrl(u) {
  try {
    const url = new URL(typeof u === 'string' ? u : './', self.registration.scope);
    return url.href.startsWith(self.registration.scope) ? url.href : self.registration.scope;
  } catch (e) { return self.registration.scope; }
}
const pushText = (v, d, max) => typeof v === 'string' && v.trim() ? v.slice(0, max) : d;
self.addEventListener('push', e => {
  let raw = {};
  try { raw = e.data?.json() || {}; } catch (err) { console.error('SW push parse error:', err); }
  if (!raw || typeof raw !== 'object') raw = {};
  const data = {
    title: pushText(raw.title, 'Trip Planer', 80),
    body: pushText(raw.body, 'Neue Nachricht', 240),
    tag: pushText(raw.tag, 'push', 40),
    url: safeAppUrl(raw.url)
  };
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: './icons/icon-192-v2.png',
      badge: './icons/icon-192-v2.png',
      tag: data.tag,
      data: { url: data.url }
    })
  );
});

// ─── NOTIFICATION CLICK ───────────────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = safeAppUrl(e.notification.data?.url);
  if (e.action === 'dismiss') return;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const match = clients.find(c => c.url.startsWith(self.registration.scope));
      if (match) return match.navigate(url).catch(() => null).then(c => (c || match).focus());
      return self.clients.openWindow(url);
    })
  );
});

// ─── BACKGROUND SYNC ──────────────────────────────────────────────────────────
// 1. Periodic Sync: Alle 12 Stunden (min. 720 Minuten, Chrome-Enforcement)
//    → Prüft im Hintergrund auf neue Versionen.
// 2. Online-Trigger: Sofortiger Check beim Schalten ins Online-Zustand
//    → Nutzer hat wieder Internet → prüft sofort nach Updates.

// Online-Trigger: Sofortiger Update-Check beim Schalten ins Online-Zustand
// (Browser sendet 'online'-Event an alle Clients, wir nutzen Background Sync)
self.addEventListener('sync', e => {
  if (e.tag === 'check-online') {
    e.waitUntil(checkForUpdates());
  }
});

// ─── FETCH ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Network-only: Live-APIs
  const isApi = url.hostname.includes('wikipedia.org') ||
                url.hostname.includes('wikimedia.org') ||
                url.hostname.includes('nominatim.openstreetmap.org') ||
                url.hostname.includes('opentripmap.com') ||
                url.hostname.includes('overpass-api.de') ||
                url.hostname.includes('overpass.kumi.systems') ||
                url.hostname.includes('overpass.openstreetmap.ru') ||
                url.hostname.includes('translate.googleapis.com') ||
                url.hostname.includes('text.pollinations.ai') ||
                url.hostname.includes('maps.googleapis.com') ||
                url.hostname.includes('api.yelp.com') ||
                url.hostname.includes('hereapi.com') ||
                url.hostname.includes('api.mapbox.com') ||
                url.hostname.includes('api.geoapify.com') ||
                url.hostname.includes('api.frankfurter.dev') ||
                url.hostname.includes('api.open-meteo.com'); // Wetter: eigener localStorage-Cache in features/weather.js
  if (isApi) {
    e.respondWith(fetch(e.request).catch(() => new Response('', { status: 503 })));
    return;
  }

  // Network-only: eigene API des Workers (Kurzlinks) – nie cachen
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;

  // Network-only: Satellit/Topo (Kachel-Volumen/Lizenz)
  if (url.hostname.includes('arcgisonline.com') || url.hostname.includes('opentopomap.org')) {
    e.respondWith(fetch(e.request).catch(() => new Response('', { status: 503 })));
    return;
  }

  // Cache-first + network fallback: OSM-Kartenkacheln (eigener, versionsunabhängiger Cache)
  if (url.hostname.includes('wikimedia.org') || url.hostname.includes('openstreetmap.org') ||
      url.hostname.includes('openstreetmap.de')) {
    e.respondWith(
      caches.open(TILE_CACHE).then(tc => tc.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(resp => {
          if (resp.ok && !resp.redirected) {
            const copy = resp.clone();
            e.waitUntil(tc.put(e.request, copy).then(() => trimCache(tc, TILE_CACHE_MAX)));
          }
          return resp;
        }).catch(() => new Response('', { status: 503 }));
      }))
    );
    return;
  }

  // Cache-first nur für die eigenen App-Dateien und bekannte, feste CDN-Quellen.
  // Alles andere (fremde Skripte, unbekannte Hosts, Nicht-GET) geht ungecacht ans
  // Netz – eine einmal manipulierte Antwort kann sich so nicht im Cache festsetzen.
  // Bilder (z. B. Aktivitätsfotos) bleiben offline verfügbar; sie führen keinen Code aus.
  const cacheable = e.request.method === 'GET' &&
    (url.origin === self.location.origin || CDN_HOSTS.includes(url.hostname) || e.request.destination === 'image');
  if (!cacheable) return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(resp => {
        if (resp.ok && !resp.redirected) {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return resp;
      }).catch(() => e.request.mode === 'navigate'
        ? caches.match('./index.html').then(r => r || Response.error())
        : Response.error());
    })
  );
});

async function trimCache(cache, max) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}
