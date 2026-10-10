/* Static shell only. Private API responses are stored by the owner-scoped client. */
const shellCache = 'hub-shell-v1';
self.addEventListener('install', () => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/') ||
    url.pathname === '/sw.js'
  )
    return;
  if (
    request.mode !== 'navigate' &&
    !['/@vite/client', '/@react-refresh'].includes(url.pathname) &&
    !/\.(js|mjs|ts|tsx|css|svg|ico)(\?|$)/.test(url.pathname)
  )
    return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(shellCache);
      try {
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
      } catch (error) {
        const cached = await cache.match(request);
        if (cached) return cached;
        throw error;
      }
    })(),
  );
});
