/* ============================================================
   Claytec CRM — Service Worker (PWA-Offline)
   - App-Shell (HTML/CSS/JS + CDN-Bibliotheken) wird vorgecacht
     → App startet auch ohne Netz.
   - Kartenkacheln werden zur Laufzeit gecacht (stale-while-revalidate)
     → bereits besuchte Gebiete sind offline sichtbar.
   - Geocoding (Nominatim) wird NIE gecacht (Live-Daten, datensparsam).
   Cache-Version bei jedem Update hochzählen (passt zu ?v= in index.html).
   ============================================================ */
var VERSION = '20260723d';
var APP_CACHE = 'claytec-crm-app-' + VERSION;
var TILE_CACHE = 'claytec-crm-tiles-v1';
var TILE_LIMIT = 600; // max. gecachte Kartenkacheln

var APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './style.css?v=' + VERSION,
  './storage.js?v=' + VERSION,
  './db-indexeddb.js?v=' + VERSION,
  './supabase-client.js?v=' + VERSION,
  './sync.js?v=' + VERSION,
  './import.js?v=' + VERSION,
  './activities.js?v=' + VERSION,
  './contact-detail.js?v=' + VERSION,
  './agenda.js?v=' + VERSION,
  './dashboard.js?v=' + VERSION,
  './geocoding.js?v=' + VERSION,
  './map.js?v=' + VERSION,
  './speech.js?v=' + VERSION,
  './settings.js?v=' + VERSION,
  './projects.js?v=' + VERSION,
  './network.js?v=' + VERSION,
  './regions.js?v=' + VERSION,
  './excel-ablage.js?v=' + VERSION,
  './vcard.js?v=' + VERSION,
  './email-parser.js?v=' + VERSION,
  './werbemittel.js?v=' + VERSION,
  './yosima-farbtoene.js?v=' + VERSION,
  './muster.js?v=' + VERSION,
  './app.js?v=' + VERSION,
  './icon.svg',
  'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(APP_CACHE).then(function (cache) {
      // einzeln cachen, damit ein einzelner CDN-Fehler nicht alles abbricht
      return Promise.all(APP_SHELL.map(function (url) {
        return cache.add(new Request(url, { cache: 'reload' })).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== APP_CACHE && k !== TILE_CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function trimTileCache() {
  caches.open(TILE_CACHE).then(function (cache) {
    cache.keys().then(function (keys) {
      if (keys.length > TILE_LIMIT) {
        for (var i = 0; i < keys.length - TILE_LIMIT; i++) cache.delete(keys[i]);
      }
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  // Geocoding: niemals cachen, immer Netz
  if (url.hostname.indexOf('nominatim') !== -1) {
    return; // Browser-Standardverhalten (Netz)
  }

  // Kartenkacheln: stale-while-revalidate in eigenem Cache
  if (/tile\.openstreetmap\.org$/.test(url.hostname)) {
    e.respondWith(
      caches.open(TILE_CACHE).then(function (cache) {
        return cache.match(req).then(function (cached) {
          var network = fetch(req).then(function (res) {
            if (res && res.status === 200) { cache.put(req, res.clone()); trimTileCache(); }
            return res;
          }).catch(function () { return cached; });
          return cached || network;
        });
      })
    );
    return;
  }

  // App-Shell & sonstige GETs: cache-first, dann Netz
  e.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) return cached;
      return fetch(req).then(function (res) {
        return res;
      }).catch(function () {
        // Offline-Fallback: bei Navigationsanfragen die App-Shell liefern
        if (req.mode === 'navigate') return caches.match('./index.html');
      });
    })
  );
});
