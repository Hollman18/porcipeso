'use strict';
/* PorciPeso — service worker.
   Cache-first para el shell estático; red directa para /api y /ws. */
const CACHE = 'porcipeso-shell-v5'; // v5: co-branding ELEIA + botón PDF
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;                    // POSTs a la API: red
  if (url.origin !== location.origin) return;                // externos: red
  if (url.pathname.includes('/api/') || url.pathname.includes('/ws')) return; // datos vivos: red
  e.respondWith(
    caches.match(e.request, { ignoreSearch: url.pathname.endsWith('.html') || url.pathname.endsWith('/') })
      .then((hit) => hit || fetch(e.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      }))
      .catch(() => caches.match('./index.html'))
  );
});
