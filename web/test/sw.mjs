// Service-worker behaviour checks, run in node: the GENERATED /sw.js text is
// evaluated in a vm sandbox with a fake Cache Storage and a scriptable network,
// then driven through install / activate / fetch / message. Run by check.mjs.
//
// What must hold (see src/app/sw.js):
//   - /api/*, /login, /logout, /sw.js, cross-origin and non-GET: never intercepted
//   - "/" navigation: network-first; a real 200 refreshes the cached shell; a
//     302 to /login passes through untouched and is never cached; offline falls
//     back to the last good shell
//   - install precaches manifest + icons, and "/" only when it is a real 200
//   - activate drops older slimewatch-shell-* caches only
//   - SKIP_WAITING message -> skipWaiting()

import vm from 'node:vm';
import assert from 'node:assert/strict';

const ORIGIN = 'https://watch.example';
const abs = (u) => new URL(u, ORIGIN).href;

/** A Response-shaped stub (node's Response can't fake type/redirected). */
function res({ status = 200, type = 'basic', redirected = false, body = 'x', tag = '' } = {}) {
  const r = { status, ok: status >= 200 && status < 300, type, redirected, body, tag, clone: () => ({ ...r }) };
  return r;
}

function load(swText) {
  const listeners = {};
  const store = new Map();   // cache name -> Map(url -> response)
  const net = { handler: async () => res(), calls: [] };
  const caches = {
    async open(name) {
      if (!store.has(name)) store.set(name, new Map());
      const m = store.get(name);
      return {
        async addAll(urls) { for (const u of urls) { const r = await ctx.fetch(abs(u)); if (!r.ok) throw new TypeError('addAll: ' + r.status); m.set(abs(u), r); } },
        async put(req, r) { m.set(abs(typeof req === 'string' ? req : req.url), r); },
      };
    },
    async keys() { return [...store.keys()]; },
    async delete(n) { return store.delete(n); },
    async match(req, opts) {
      let url = abs(typeof req === 'string' ? req : req.url);
      if (opts && opts.ignoreSearch) url = url.split('?')[0];
      for (const m of store.values()) if (m.has(url)) return m.get(url).clone();
      return undefined;
    },
  };
  const self = {
    location: new URL(ORIGIN + '/sw.js'),
    addEventListener: (t, f) => { listeners[t] = f; },
    skipWaiting: () => { self.skipped = true; },
    clients: { claim: async () => { self.claimed = true; } },
  };
  const ctx = {
    self, caches, URL, console,
    fetch: async (req, init) => { const url = abs(typeof req === 'string' ? req : req.url); net.calls.push({ url, init }); return net.handler(url, init); },
  };
  vm.runInNewContext(swText, ctx);
  return { listeners, store, net, self };
}

/** Dispatch a fetch event; returns the respondWith promise, or null if not intercepted. */
function fetchEvent(sw, url, { mode = 'no-cors', method = 'GET' } = {}) {
  let p = null;
  sw.listeners.fetch({ request: { url: abs(url), mode, method }, respondWith: (x) => { p = Promise.resolve(x); } });
  return p;
}
async function lifecycle(sw, type, data) {
  let w = null;
  sw.listeners[type]({ data, waitUntil: (x) => { w = x; } });
  if (w) await w;
}

export async function runSwChecks(swText) {
  let n = 0;
  const eq = (a, b, m) => { assert.deepEqual(a, b, m); n++; };
  const ok = (v, m) => { assert.ok(v, m); n++; };

  const version = (swText.match(/const VERSION = "([^"]+)"/) || [])[1];
  ok(version, 'sw.js carries a build VERSION');
  const CACHE = 'slimewatch-shell-' + version;
  const assets = JSON.parse(swText.match(/const STATIC_ASSETS = (\[[^\]]*\]);/)[1]);
  ok(assets.includes('/manifest.webmanifest') && assets.some(a => a.startsWith('/icons/')), 'precache list has manifest + icons');

  // ── install: signed in -> "/" cached; signed out -> "/" skipped, rest cached ──
  {
    const sw = load(swText);
    sw.net.handler = async (url) => res({ tag: url });
    await lifecycle(sw, 'install');
    const c = sw.store.get(CACHE);
    eq([...c.keys()].sort(), [...assets.map(abs), abs('/')].sort(), 'install precaches assets + shell');
    const shellCall = sw.net.calls.find(x => x.url === abs('/'));
    eq([shellCall.init.redirect, shellCall.init.credentials], ['manual', 'same-origin'], 'shell precache sends the cookie and does not follow redirects');
    ok(!sw.self.skipped, 'install does not skipWaiting (the page toast decides)');

    const out = load(swText);
    out.net.handler = async (url) => url === abs('/') ? res({ status: 0, type: 'opaqueredirect' }) : res();
    await lifecycle(out, 'install');
    ok(!out.store.get(CACHE).has(abs('/')), 'signed-out install never caches the login redirect as the shell');
  }

  // ── activate: only older shell caches are dropped ──
  {
    const sw = load(swText);
    for (const name of ['slimewatch-shell-old1', CACHE, 'someone-else']) sw.store.set(name, new Map());
    await lifecycle(sw, 'activate');
    eq([...sw.store.keys()].sort(), [CACHE, 'someone-else'].sort(), 'activate deletes stale shell caches only');
    ok(sw.self.claimed, 'activate claims clients');
  }

  // ── fetch routing ──
  {
    const sw = load(swText);
    sw.net.handler = async () => res({ tag: 'net' });
    for (const [url, opts, why] of [
      ['/api/tmdb/movie/1', {}, '/api/* is never intercepted'],
      ['/api/live/resolve?id=1', {}, 'live resolve passes through'],
      ['/login', { mode: 'navigate' }, '/login is never intercepted'],
      ['/logout', { mode: 'navigate' }, '/logout is never intercepted'],
      ['/sw.js', {}, '/sw.js itself is never intercepted'],
      ['https://image.tmdb.org/t/p/w342/x.jpg', {}, 'cross-origin passes through'],
      ['https://vidlink.pro/movie/1', { mode: 'navigate' }, 'cross-origin navigations (embeds) pass through'],
      ['/', { mode: 'navigate', method: 'POST' }, 'non-GET passes through'],
      ['/whatever', { mode: 'navigate' }, 'only "/" is treated as the shell'],
    ]) eq(fetchEvent(sw, url, opts), null, why);

    // network-first shell, online 200 -> served from network and cached
    let p = fetchEvent(sw, '/', { mode: 'navigate' });
    eq((await p).tag, 'net', 'online: "/" comes from the network');
    await new Promise(r => setTimeout(r, 0));
    ok(sw.store.get(CACHE) && sw.store.get(CACHE).has(abs('/')), 'a real 200 refreshes the cached shell');

    // signed out online: the 302 passes through, cache untouched
    sw.store.get(CACHE).set(abs('/'), res({ tag: 'old-shell' }));
    sw.net.handler = async () => res({ status: 0, type: 'opaqueredirect', tag: 'redirect' });
    p = fetchEvent(sw, '/?source=pwa', { mode: 'navigate' });
    eq((await p).tag, 'redirect', 'a lapsed session still gets the 302 to /login');
    await new Promise(r => setTimeout(r, 0));
    eq(sw.store.get(CACHE).get(abs('/')).tag, 'old-shell', 'the redirect is never cached');

    // offline -> last good shell
    sw.net.handler = async () => { throw new TypeError('offline'); };
    p = fetchEvent(sw, '/', { mode: 'navigate' });
    eq((await p).tag, 'old-shell', 'offline: the cached shell');

    // static: cache-first, no network when cached
    sw.store.get(CACHE).set(abs('/icons/icon-192.png'), res({ tag: 'cached-icon' }));
    const before = sw.net.calls.length;
    p = fetchEvent(sw, '/icons/icon-192.png');
    eq((await p).tag, 'cached-icon', 'icons are cache-first');
    eq(sw.net.calls.length, before, 'no network for a cached icon');

    // offline with nothing cached -> the navigation fails (browser shows its offline page)
    const empty = load(swText);
    empty.net.handler = async () => { throw new TypeError('offline'); };
    await assert.rejects(fetchEvent(empty, '/', { mode: 'navigate' })); n++;
  }

  // ── update handshake ──
  {
    const sw = load(swText);
    sw.listeners.message({ data: { type: 'SKIP_WAITING' } });
    ok(sw.self.skipped, 'SKIP_WAITING message activates the waiting worker');
  }
  return n;
}
