/* SlimeWatch service worker — app-shell cache only.

   Served UNGATED by the Worker at /sw.js (no-cache, Service-Worker-Allowed: /).
   build.mjs fills in the build id and the static asset list, so every deploy that
   changes the page changes this file, which is what makes browsers install
   the new version (and the page show its "Updated" toast).

   What it does:
     /                navigation, NETWORK-FIRST: online you always get the live
                      page (and a lapsed session still gets the Worker's 302 to
                      /login); offline you get the last good shell.
     manifest, icons  cache-first (they are versioned by this cache's name).
   What it never touches: /api/* (catalog, debrid, resolve, live), /login,
   /logout, and every cross-origin request (TMDB images, Torrentio, HLS and
   debrid media, provider embeds). Those go straight to the network, uncached. */

const VERSION = '__BUILD_ID__';
const CACHE = 'slimewatch-shell-' + VERSION;
const SHELL = '/';
const STATIC_ASSETS = __STATIC_ASSETS__;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(STATIC_ASSETS);   // ungated: these can't bounce to /login
    await cacheShell(cache);             // best effort; skipped when signed out
  })());
  // No skipWaiting() here: an update waits until the page's "Updated — tap to
  // reload" toast asks for it (message below), so nothing swaps mid-film.
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k.startsWith('slimewatch-shell-') && k !== CACHE) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

/* Only ever store a real 200 for "/" — never the login page that a missing or
   stale cookie is redirected to (redirect:'manual' makes that an
   opaqueredirect, which fails the checks below). */
const cacheable = (res) => res && res.ok && res.type === 'basic' && !res.redirected;

async function cacheShell(cache) {
  try {
    const res = await fetch(SHELL, { credentials: 'same-origin', redirect: 'manual', cache: 'no-store' });
    if (cacheable(res)) await cache.put(SHELL, res);
  } catch (_) {}
}

async function shellNetworkFirst(request) {
  try {
    const res = await fetch(request);   // navigations are redirect:'manual' — a 302 passes through untouched
    if (cacheable(res)) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(SHELL, copy)).catch(() => {});
    }
    return res;
  } catch (err) {
    const cached = await caches.match(SHELL);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const hit = await caches.match(request, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {}); }
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const p = url.pathname;
  if (p.startsWith('/api/') || p === '/login' || p === '/logout' || p === '/sw.js') return;
  if (req.mode === 'navigate') {
    if (p === SHELL) event.respondWith(shellNetworkFirst(req));
    return;
  }
  if (STATIC_ASSETS.includes(p)) event.respondWith(cacheFirst(req));
});
