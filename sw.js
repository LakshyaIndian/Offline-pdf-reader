/**
 * sw.js — Service Worker for Offline PDF Reader
 * Caches the app shell so the UI works offline after first load.
 * PDF blobs are stored in IndexedDB (not cache), so they don't
 * need special service-worker handling.
 */

const CACHE_NAME = 'offline-pdf-reader-v1';

// Assets that form the "app shell" — must be available offline.
// Paths are relative to the service worker scope (repo root on GH Pages).
const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './db.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  // PDF.js CDN copies are cached at runtime (see fetch handler below),
  // but we pre-cache the worker script path reference in index.html.
];

// ── Install: pre-cache the app shell ────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  // Take control immediately without waiting for old SW to expire
  self.skipWaiting();
});

// ── Activate: delete old caches ──────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch: serve from cache, fall back to network ────────────────────────────
self.addEventListener('fetch', (event) => {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  // Skip cross-origin requests that aren't CDN assets we want to cache
  const url = new URL(event.request.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isPdfJsCDN =
    url.hostname === 'cdnjs.cloudflare.com' &&
    url.pathname.includes('pdf.js');

  if (!isSameOrigin && !isPdfJsCDN) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      // Not in cache — fetch from network and cache for next time
      return fetch(event.request)
        .then((response) => {
          // Only cache valid responses
          if (!response || response.status !== 200 || response.type === 'error') {
            return response;
          }
          const toCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, toCache));
          return response;
        })
        .catch(() => {
          // If offline and not cached, return a simple offline page for navigation
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
        });
    })
  );
});
