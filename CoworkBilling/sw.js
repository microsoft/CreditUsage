/* sw.js - cache-first, versioned service worker for offline use. */
var CACHE_NAME = 'cowork-credits-v1.1';
var PRECACHE = [
    './',
    './index.html',
    './styles.css',
    './app.js',
    './demo-data.js',
    './lib/jszip.min.js',
    './lib/pptxgen.bundle.js',
    './lib/html2canvas.min.js',
    './lib/jspdf.umd.min.js'
];

self.addEventListener('install', function (event) {
    event.waitUntil(
        caches.open(CACHE_NAME).then(function (cache) {
            return cache.addAll(PRECACHE).catch(function () { /* tolerate missing entries */ });
        }).then(function () { return self.skipWaiting(); })
    );
});

self.addEventListener('activate', function (event) {
    event.waitUntil(
        caches.keys().then(function (keys) {
            return Promise.all(keys.map(function (k) {
                if (k !== CACHE_NAME) return caches.delete(k);
            }));
        }).then(function () { return self.clients.claim(); })
    );
});

self.addEventListener('fetch', function (event) {
    if (event.request.method !== 'GET') return;
    event.respondWith(
        caches.match(event.request).then(function (cached) {
            if (cached) return cached;
            return fetch(event.request).then(function (resp) {
                if (resp && resp.status === 200 && resp.type === 'basic') {
                    var copy = resp.clone();
                    caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, copy); });
                }
                return resp;
            }).catch(function () { return cached; });
        })
    );
});
