/* Static shell only. Private API responses are stored by the owner-scoped client.
   Production builds prepend self.__HUB_PRECACHE__ (see vite.config.ts) so every
   built asset is cached on install and lazy-loaded views work offline. */
const precache = self.__HUB_PRECACHE__ || { version: 'dev', files: [] };
const shellCache = `hub-shell-${precache.version}`;
const shellKey = '/index.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(shellCache);
      if (precache.files.length)
        await cache.addAll([shellKey, ...precache.files]);
      await self.skipWaiting();
    })(),
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (name.startsWith('hub-shell-') && name !== shellCache)
          await caches.delete(name);
      await self.clients.claim();
    })(),
  );
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
  const navigation = request.mode === 'navigate';
  if (
    !navigation &&
    !['/@vite/client', '/@react-refresh'].includes(url.pathname) &&
    !/\.(js|mjs|ts|tsx|css|svg|ico|woff2)(\?|$)/.test(url.pathname)
  )
    return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(shellCache);
      // Every view is served by the same app shell, so navigations share one key.
      const key = navigation ? shellKey : request;
      try {
        const response = await fetch(request);
        if (response.ok) await cache.put(key, response.clone());
        return response;
      } catch (error) {
        // Precached entries were fetched without the Origin header that module
        // scripts send; servers commonly answer with Vary: Origin.
        const cached = await cache.match(key, { ignoreVary: true });
        if (cached) return cached;
        throw error;
      }
    })(),
  );
});
