const VERSION = 'skippy-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Network-only: canister + proxy both require live network, no offline caching needed.
// The SW exists purely to satisfy the PWA installability requirement on Android Chrome.
self.addEventListener('fetch', (e) => {
  e.respondWith(
    fetch(e.request).catch(() => new Response('Skippy requires a network connection.', { status: 503 }))
  );
});
