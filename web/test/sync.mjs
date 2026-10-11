// Personal sync, end to end in node:
//   - the store's central updatedAt stamps + tombstones (state.js)
//   - the pure merge rules, in both directions (sync.js mergeData / validatePatch)
//   - the Worker's /api/state over a fake KV: 409 on a stale base, the 256 KB
//     cap, no-op writes skipped, device-only keys never stored, 503 unconfigured
//     (every request here is profile 'test': cookie + header; test/profiles.mjs
//     covers the profile rules themselves)
//   - the client engine on a fake clock + a fake network wired to the REAL
//     Worker handler: debounce, the progress throttle, 409 -> merge -> retry,
//     offline queue + online flush, other-tab writes never re-sent, two
//     devices converging (adds, removals, the further position, prefs)
// Run by check.mjs; returns the number of assertions, throws on the first failure.

import assert from 'node:assert/strict';
import { createStore, memoryStorage, toggleList, recordContinue, saveProgress, getPrefs, setPrefs, putReading,
  removeReading, PREF_DEFAULTS, TOMB_TTL_MS } from '../src/app/state.js';
import { mergeData, validatePatch, emptyData, createSync } from '../src/app/sync.js';
import { syncRoutes, MAX_STATE_BYTES } from '../src/worker/sync.js';
import { stateKey } from '../src/worker/profiles.js';
import worker from '../src/worker.js';

const T0 = Date.UTC(2026, 9, 11, 12, 0, 0);

/** A KV namespace that already knows the profile 'test' (state lives at state:test). */
function fakeKV() {
  const m = new Map([['profiles', JSON.stringify({ profiles: [{ id: 'test', name: 'Test', color: '#35C759', createdAt: 1, lastUsedAt: 1 }] })]]);
  return {
    m, puts: 0,
    async get(k, type) { const v = m.has(k) ? m.get(k) : null; return v == null ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { this.puts++; m.set(k, String(v)); },
    async delete(k) { m.delete(k); },
  };
}
const AS_TEST = { cookie: 'sw_profile=test', 'x-sw-profile': 'test' };
const STATE_KEY = stateKey('test');
const call = (env, method, path, body) => {
  const init = { method, headers: { ...AS_TEST } };
  if (body !== undefined) { init.body = typeof body === 'string' ? body : JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
  const req = new Request('https://watch.example' + path, init);
  return syncRoutes(req, env, new URL(req.url));
};

/** A fake clock + timer queue. tick(ms) runs every timer due, letting the async work each starts settle. */
function fakeTime(start = T0) {
  let now = start, seq = 0;
  const timers = new Map();
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };
  return {
    now: () => now,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + Math.max(0, ms || 0), fn }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    pending: () => timers.size,
    settle,
    async tick(ms) {
      const end = now + ms;
      await settle();
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); now = Math.max(now, due[1].at);
        due[1].fn(); await settle();
      }
      now = end; await settle();
    },
  };
}

/** One browser: its own store + engine, talking to the shared Worker handler. */
function device(env, time, { online = true } = {}) {
  const ls = memoryStorage();
  const store = createStore(ls, undefined, { now: time.now });
  const log = [];
  const net = { online, down: false };
  const remote = [];
  const statuses = [];
  const engine = createSync({
    store, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
    isOnline: () => net.online,
    onRemote: (keys) => remote.push(keys),
    onStatus: (s) => statuses.push(s.state),
    fetch: async (url, init = {}) => {
      if (net.down || !net.online) throw new TypeError('Failed to fetch');
      log.push({ method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
      return call(env, init.method || 'GET', url, init.body);
    },
  });
  return { ls, store, engine, log, net, remote, statuses, puts: () => log.filter(r => r.method === 'PUT') };
}
const ids = (arr) => arr.map(x => x.kind + ':' + x.id);
const bare = (x) => { const { updatedAt, ...rest } = x; return rest; };

export async function runSyncChecks() {
  let n = 0;
  const eq = (a, b, m) => { assert.deepEqual(a, b, m); n++; };
  const ok = (v, m) => { assert.ok(v, m); n++; };

  // ── 1. The store stamps every changed entry and tombstones removals ───────────
  {
    let t = T0;
    const s = createStore(memoryStorage(), undefined, { now: () => t });
    const it = (id, title) => ({ id, title, poster_path: '/' + id });
    toggleList(it(1, 'One'), s);
    t += 10; toggleList(it(2, 'Two'), s);
    eq(s.getState().list.map(x => x.updatedAt), [T0 + 10, T0], 'each list entry stamped when added; untouched entries keep their stamp');
    t += 10; toggleList(it(1, 'One'), s);
    eq(ids(s.getState().list), ['movie:2'], 'removed');
    eq(s.getState().tombs, { list: { 'movie:1': T0 + 20 } }, 'the removal is a tombstone');
    t += 10; toggleList(it(1, 'One'), s);
    eq(s.getState().tombs, {}, 're-adding clears its tombstone');
    eq(s.getState().list[0].updatedAt, T0 + 30, '...and stamps it anew');

    // A writer that copies a stamped record and changes it gets a NEW stamp (saveProgress spreads the old record).
    recordContinue(it(5, 'Five'), 'movie', 1, 1, 0, s);
    t += 1000; saveProgress({ it: it(5), kind: 'movie', s: 1, e: 1 }, 600, 5400, s);
    eq(s.getState().continue[0].updatedAt, T0 + 1030, 'a changed record is restamped even though the writer kept the old updatedAt');
    t += 1000; s.setState({ continue: s.getState().continue.map(x => ({ ...x })) });
    eq(s.getState().continue[0].updatedAt, T0 + 1030, 'an identical rewrite keeps the stamp');

    // Legacy entries (written before sync existed) are left unstamped while unchanged.
    const ls = memoryStorage(); ls.setItem('sw_list', JSON.stringify([{ id: 9, kind: 'tv', title: 'Old' }]));
    const s2 = createStore(ls, undefined, { now: () => t });
    toggleList(it(3, 'Three'), s2);
    eq(s2.getState().list.map(x => x.updatedAt), [t, undefined], 'a legacy entry is not restamped by an unrelated write');

    // The sync layer's own writes pass through untouched.
    s2.setState({ list: [] }, { source: 'sync' });
    eq(s2.getState().tombs, {}, "source 'sync' never creates tombstones");
    s2.setState({ list: [{ id: 4, kind: 'movie', updatedAt: 5 }] }, { source: 'sync' });
    eq(s2.getState().list[0].updatedAt, 5, "source 'sync' keeps the server's stamps");

    // reading: a map, stamped + tombstoned per key; null resets tombstone everything.
    putReading('mangadex:abc', { title: 'A', chapter: 3 }, s);
    eq(s.getState().reading['mangadex:abc'].updatedAt, t, 'reading entries stamped');
    t += 5; removeReading('mangadex:abc', s);
    eq(s.getState().tombs.reading, { 'mangadex:abc': t }, 'reading removals tombstoned');
    t += 5; s.setState({ list: null });
    ok(s.getState().tombs.list['movie:2'] === t && s.getState().tombs.list['movie:1'] === t, 'clearing a list tombstones every entry');

    // Old tombstones are pruned on the next write.
    const s3 = createStore(memoryStorage(), undefined, { now: () => t });
    s3.setState({ tombs: { list: { 'movie:1': t - TOMB_TTL_MS - 1, 'movie:2': t - 1000 } } }, { source: 'sync' });
    toggleList(it(7, 'Seven'), s3);
    eq(s3.getState().tombs.list, { 'movie:2': t - 1000 }, 'tombstones past the TTL are dropped');

    // prefs helpers
    eq(getPrefs(s3), PREF_DEFAULTS, 'prefs default: English caption list, M, dub, no history');
    eq(getPrefs(s3).subLang, undefined, 'no automatic caption language by default (captions off)');
    setPrefs({ subSize: 'L', animeAudio: 'sub' }, s3);
    setPrefs({ subLangs: ['ja', 'en'] }, s3);
    eq(s3.getState().prefs, { subSize: 'L', animeAudio: 'sub', subLangs: ['ja', 'en'] }, 'setPrefs shallow-merges');
    setPrefs({ animeAudio: null }, s3);
    eq(getPrefs(s3).animeAudio, 'dub', 'null deletes a pref (falls back to the default)');
  }

  // ── 2. Merge rules (pure), both directions ─────────────────────────────────────
  {
    const NOW = 10000;   // stamps below are small numbers; tombstones prune relative to `now`
    const A = { id: 1, kind: 'movie', title: 'A' };
    const old = { ...A, title: 'A-old', updatedAt: 100 }, neu = { ...A, title: 'A-new', updatedAt: 200 };
    eq(mergeData({ list: [old] }, { list: [neu] }, { now: NOW }).list, [neu], 'newer entry wins (b newer)');
    eq(mergeData({ list: [neu] }, { list: [old] }, { now: NOW }).list, [neu], 'newer entry wins (a newer) — order of arguments is irrelevant');
    const tieA = { ...A, title: 'from-a', updatedAt: 100 }, tieB = { ...A, title: 'from-b', updatedAt: 100 };
    eq(mergeData({ list: [tieA] }, { list: [tieB] }, { now: NOW }).list[0].title, 'from-b', 'a tie goes to b (server on the client, the patch on the server)');

    const tomb = { list: { 'movie:1': 150 } };
    eq(mergeData({ list: [old] }, { tombs: tomb }, { now: NOW }).list, [], 'a tombstone removes an older entry (tomb from b)');
    eq(mergeData({ list: [old], tombs: tomb }, {}, { now: NOW }).list, [], '...(tomb from a)');
    eq(mergeData({ list: [neu] }, { tombs: tomb }, { now: NOW }).list, [neu], 're-added after the removal: the entry survives');
    eq(mergeData({ list: [{ ...A }] }, { tombs: tomb }, { now: NOW }).list, [], 'an unstamped (legacy) entry loses to any removal');
    eq(mergeData({ tombs: { list: { x: 5 } } }, { tombs: { list: { x: 9 }, rdkey: { y: 1 } } }, { now: NOW }).tombs, { list: { x: 9 } }, 'tombstones union at the latest time; unknown collections dropped');

    // continue: the same episode keeps the further position, whichever side wins.
    const c1 = { id: 5, kind: 'tv', s: 1, e: 2, pos: 900, ts: 100, updatedAt: 100 };
    const c2 = { id: 5, kind: 'tv', s: 1, e: 2, pos: 300, dur: 1400, ts: 200, updatedAt: 200 };
    eq(mergeData({ continue: [c1] }, { continue: [c2] }, { now: NOW }).continue, [{ ...c2, pos: 900 }], 'continue: newer record, further position (b newer)');
    eq(mergeData({ continue: [c2] }, { continue: [c1] }, { now: NOW }).continue, [{ ...c2, pos: 900 }], 'continue: newer record, further position (a newer)');
    const c3 = { ...c1, e: 3, pos: 10, updatedAt: 300, ts: 300 };
    eq(mergeData({ continue: [c3] }, { continue: [c2] }, { now: NOW }).continue, [c3], 'continue: a different episode is plain last-write-wins');

    // order + caps
    const many = Array.from({ length: 70 }, (_, i) => ({ id: i, kind: 'movie', updatedAt: 1000 + i }));
    const capped = mergeData({ list: many.slice(0, 35) }, { list: many.slice(35) }, { now: NOW }).list;
    eq([capped.length, capped[0].id, capped[59].id], [60, 69, 10], 'list: newest first, capped at 60 (SCHEMA.list.max)');
    const legacy = [{ id: 1, kind: 'tv' }, { id: 2, kind: 'tv' }, { id: 3, kind: 'tv' }];
    eq(ids(mergeData({ list: legacy }, emptyData(), { now: NOW }).list), ['tv:1', 'tv:2', 'tv:3'], 'unstamped entries keep their order');
    const conts = Array.from({ length: 30 }, (_, i) => ({ id: i, kind: 'movie', ts: i }));
    eq(mergeData({}, { continue: conts }, { now: NOW }).continue.map(x => x.id).slice(0, 3), [29, 28, 27], 'continue: most recently played first (ts)');
    eq(mergeData({}, { continue: conts }, { now: NOW }).continue.length, 24, 'continue capped at 24');
    const reading = Object.fromEntries(Array.from({ length: 320 }, (_, i) => ['src:' + i, { ch: 1, updatedAt: i }]));
    const r = mergeData({}, { reading }, { now: NOW }).reading;
    eq([Object.keys(r).length, Object.keys(r)[0]], [300, 'src:319'], 'reading: newest 300 kept');

    // prefs
    eq(mergeData({ prefs: { a: 1, b: 2 } }, { prefs: { b: 3, c: null } }, { now: NOW }).prefs, { a: 1, b: 3 }, 'prefs: shallow merge, b over a');
    eq(mergeData({ prefs: { a: 1, c: 4 } }, { prefs: { c: null } }, { now: NOW }).prefs, { a: 1 }, 'prefs: null in b deletes');
    eq(mergeData({ prefs: { size: 'L' } }, { prefs: { size: 'S', x: 1 } }, { now: NOW, keepPrefs: ['size'] }).prefs, { size: 'L', x: 1 }, 'prefs: unsent local edits (keepPrefs) win');
    eq(Object.keys(mergeData({ rdkey: 'secret', installHint: 'x' }, {}, { now: NOW })).sort(), ['continue', 'list', 'prefs', 'reading', 'tombs'], 'device-only keys never appear in synced data');

    // validatePatch
    eq(validatePatch({ list: [{ id: 1, kind: 'movie' }, { title: 'no id' }, 7], rdkey: 'K', sync: { rev: 9 } }).patch, { list: [{ id: 1, kind: 'movie' }] }, 'patch: entries without an id and device-only keys dropped');
    eq(validatePatch({ list: {} }).error, 'bad-list', 'patch: wrong type refused');
    eq(validatePatch(null).error, 'bad-patch', 'patch: not an object');
    eq(validatePatch({ tombs: { list: { a: 1, b: 'x' }, other: { c: 1 } } }).patch, { tombs: { list: { a: 1 } } }, 'patch: tombstones sanitised');
  }

  // ── 3. The Worker's /api/state ────────────────────────────────────────────────
  {
    let r = await call({}, 'GET', '/api/state');
    eq([r.status, (await r.json()).error], [503, 'sync-not-configured'], 'no STATE binding -> 503 sync-not-configured');
    const env = { STATE: fakeKV() };
    r = await call(env, 'GET', '/api/state');
    eq(await r.json(), { rev: 0, updatedAt: 0, data: emptyData() }, 'empty state is rev 0');
    const item = { id: 550, kind: 'movie', title: 'Fight Club', updatedAt: T0 };
    r = await call(env, 'PUT', '/api/state', { baseRev: 0, patch: { list: [item], prefs: { captionSize: 'L' }, rdkey: 'NEVER' } });
    let j = await r.json();
    eq([r.status, j.rev, j.data.list, j.data.prefs], [200, 1, [item], { captionSize: 'L' }], 'PUT merges and bumps rev');
    ok(!env.STATE.m.get(STATE_KEY).includes('NEVER'), 'device-only keys are never stored');
    r = await call(env, 'PUT', '/api/state', { baseRev: 0, patch: { list: [] } });
    j = await r.json();
    eq([r.status, j.error, j.rev, j.data.list], [409, 'stale', 1, [item]], 'stale baseRev -> 409 with the current state');
    const puts = env.STATE.puts;
    r = await call(env, 'PUT', '/api/state', { baseRev: 1, patch: { list: [item] } });
    eq([r.status, (await r.json()).rev, env.STATE.puts], [200, 1, puts], 'a no-op PUT keeps the rev and writes nothing');
    r = await call(env, 'PUT', '/api/state', { baseRev: 1, patch: { tombs: { list: { 'movie:550': T0 + 1 } } } });
    j = await r.json();
    eq([j.rev, j.data.list], [2, []], 'a tombstone in the patch removes the entry server-side');
    r = await call(env, 'PUT', '/api/state', '{nope');
    eq(r.status, 400, 'bad JSON -> 400');
    r = await call(env, 'PUT', '/api/state', { baseRev: 2, patch: { list: 'x' } });
    eq([r.status, (await r.json()).error], [400, 'bad-list'], 'bad patch -> 400');
    r = await call(env, 'PUT', '/api/state', { baseRev: 2, patch: { prefs: { blob: 'x'.repeat(MAX_STATE_BYTES) } } });
    eq([r.status, (await r.json()).error], [413, 'too-large'], 'over 256 KB -> 413');
    r = await call(env, 'PUT', '/api/state', { baseRev: 2, patch: { prefs: { a: 'x'.repeat(90000), b: 'y'.repeat(90000), c: 'z'.repeat(90000) } } });
    eq(r.status, 413, 'a merged state over 256 KB is refused too');
    r = await call(env, 'POST', '/api/state', {});
    eq(r.status, 405, 'other methods -> 405');
    eq(await syncRoutes(new Request('https://w/api/statefoo'), env, new URL('https://w/api/statefoo')), null, 'other paths fall through');

    // /api/state/health: build + extractor reachability (global fetch stubbed).
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (u) => { ok(String(u) === 'https://x.example/health', 'health pings EXTRACTOR_BASE/health'); return new Response('ok'); };
      r = await call({ EXTRACTOR_BASE: 'https://x.example/', STATE: env.STATE }, 'GET', '/api/state/health');
      j = await r.json();
      eq([j.sync, j.ask, j.extractor.ok, j.extractor.base, typeof j.build], [true, false, true, 'https://x.example', 'string'], 'health reports build, sync, ask and a reachable extractor');
      globalThis.fetch = async () => { throw new TypeError('down'); };
      j = await (await call({ EXTRACTOR_BASE: 'https://x.example' }, 'GET', '/api/state/health')).json();
      eq([j.extractor.ok, j.extractor.error, j.sync], [false, 'unreachable', false], 'health reports an unreachable extractor');
      globalThis.fetch = async () => new Response('{"draining":true}', { status: 503 });
      j = await (await call({ EXTRACTOR_BASE: 'https://x.example' }, 'GET', '/api/state/health')).json();
      eq([j.extractor.ok, j.extractor.error], [false, 'draining'], 'health reports a draining extractor');
    } finally { globalThis.fetch = realFetch; }

    // Through the real Worker: behind the password gate.
    const wenv = { SITE_PASSWORD: 'pw', SESSION_SECRET: 's', STATE: fakeKV() };
    r = await worker.fetch(new Request('https://w/api/state', { redirect: 'manual' }), wenv);
    eq([r.status, r.headers.get('location')], [302, '/login'], '/api/state is gated');
    r = await worker.fetch(new Request('https://w/login', { method: 'POST', body: new URLSearchParams({ password: 'pw' }) }), wenv);
    const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    r = await worker.fetch(new Request('https://w/api/state', { headers: { cookie } }), wenv);
    eq([r.status, (await r.json()).error], [428, 'no-profile'], '/api/state behind the gate wants a profile');
    r = await worker.fetch(new Request('https://w/api/state', { headers: { cookie: cookie + '; sw_profile=test', 'x-sw-profile': 'test' } }), wenv);
    eq([r.status, (await r.json()).rev], [200, 0], '/api/state answers behind the gate, as that profile');
    r = await worker.fetch(new Request('https://w/api/ask', { method: 'POST', headers: { cookie }, body: '{}' }), wenv);
    eq(r.status, 503, '/api/ask is routed (503 without SLIME_TOKEN)');
  }

  // ── 4. The client engine against the real handler ────────────────────────────
  {
    const env = { STATE: fakeKV() };
    const time = fakeTime();
    const laptop = device(env, time);
    // The laptop has history from before sync existed.
    laptop.ls.setItem('sw_list', JSON.stringify([{ id: 1, kind: 'movie', title: 'Legacy' }]));
    laptop.store.reload();
    laptop.ls.setItem('sw_rdkey', '"RDSECRET"'); laptop.store.reload('sw_rdkey');
    await laptop.engine.start(); await time.settle();
    eq(laptop.log.map(r => r.method), ['GET', 'PUT'], 'boot: pull, then upload what the server lacks');
    eq(laptop.puts()[0].body.baseRev, 0, 'the first PUT is based on rev 0');
    ok(!JSON.stringify(laptop.puts()[0].body).includes('RDSECRET'), 'the RD key never leaves the browser');
    eq(laptop.engine.status().state, 'synced', 'synced after boot');
    eq(laptop.store.getState().sync.rev, 1, 'rev kept in the device-only sync key');

    // Debounce: three quick changes -> one PUT 1.5 s after the last.
    const it = (id) => ({ id, title: 'T' + id, poster_path: '/p' });
    toggleList(it(2), laptop.store); await time.tick(500);
    toggleList(it(3), laptop.store); await time.tick(500);
    toggleList(it(4), laptop.store); await time.tick(1000);
    eq(laptop.puts().length, 1, 'nothing sent while changes keep coming');
    eq(laptop.engine.status().state, 'pending', 'status: pending');
    await time.tick(600);
    eq(laptop.puts().length, 2, 'one PUT once 1.5 s pass quietly');
    eq(Object.keys(laptop.puts()[1].body.patch).sort(), ['list', 'tombs'], 'only the changed key (+ tombstones) is sent');

    // A second device boots and gets everything.
    const phone = device(env, time);
    toggleList(it(50), phone.store);   // something the phone had on its own
    await phone.engine.start(); await time.settle();
    eq(ids(phone.store.getState().list).sort(), ['movie:1', 'movie:2', 'movie:3', 'movie:4', 'movie:50'].sort(), 'phone: merged the laptop\'s list with its own');
    ok(phone.remote.some(k => k.includes('list')), 'phone: a remote change to the list asks for a refresh');
    eq(phone.puts().length, 1, 'phone uploaded what the server lacked');

    // Laptop removes an item; the phone must not resurrect it.
    await time.tick(31000);
    toggleList(it(2), laptop.store);      // remove
    await time.tick(1600);
    phone.engine.visible(); await time.tick(10);
    ok(!ids(phone.store.getState().list).includes('movie:2'), 'a removal on the laptop reaches the phone');
    toggleList(it(60), phone.store); await time.tick(1600);
    await laptop.engine.syncNow(); await time.settle();
    ok(!ids(laptop.store.getState().list).includes('movie:2') && ids(laptop.store.getState().list).includes('movie:60'), 'and is not resurrected by the phone\'s next upload');

    // 409: the phone writes while the laptop's rev is stale -> laptop merges and retries.
    toggleList(it(70), phone.store); await time.tick(1600);
    const before = laptop.log.length;
    toggleList(it(80), laptop.store); await time.tick(1600);
    const tail = laptop.log.slice(before).map(r => r.method);
    eq(tail, ['PUT', 'PUT'], '409 -> merged and resent (no extra GET needed: the 409 carries the state)');
    eq(laptop.engine.status().state, 'synced', 'synced after the retry');
    ok(ids(laptop.store.getState().list).includes('movie:70') && ids(laptop.store.getState().list).includes('movie:80'), 'laptop has both writes');
    await phone.engine.syncNow(); await time.settle();
    eq(ids(phone.store.getState().list), ids(laptop.store.getState().list), 'both devices converge on the same list, same order');

    // Progress: position ticks are throttled to one PUT a minute; a new title is not.
    recordContinue(it(9), 'movie', 1, 1, 0, laptop.store); await time.tick(1600);
    const p0 = laptop.puts().length;
    for (let i = 1; i <= 8; i++) { saveProgress({ it: it(9), kind: 'movie', s: 1, e: 1 }, i * 5, 5400, laptop.store); await time.tick(5000); }
    eq(laptop.puts().length, p0, 'position ticks within a minute of the last PUT are held');
    await time.tick(20000);
    eq(laptop.puts().length, p0 + 1, '...and sent together once the minute is up');
    eq(laptop.puts().at(-1).body.patch.continue[0].pos, 40, 'with the latest position');
    // ...the phone, having played further on the same episode, keeps its position.
    phone.engine.visible(); await time.tick(10);
    const phoneRec = phone.store.getState().continue[0];
    saveProgress({ it: it(9), kind: 'movie', s: 1, e: 1 }, 3000, 5400, phone.store);
    await phone.engine.hidden(); await time.settle();
    eq(phone.puts().at(-1).body.patch.continue[0].pos, 3000, 'tab hidden: queued progress is sent at once');
    saveProgress({ it: it(9), kind: 'movie', s: 1, e: 1 }, 45, 5400, laptop.store);
    await laptop.engine.hidden(); await time.tick(10);   // 409 (the phone wrote first) -> merge -> resend
    eq(laptop.engine.status().state, 'synced', 'laptop synced after its own 409 round');
    eq(laptop.store.getState().continue[0].pos, 3000, 'the further position on the same episode wins on both devices');
    ok(phoneRec && phoneRec.id === 9, 'phone saw the laptop\'s new Continue Watching title');

    // Prefs: only changed keys travel; the other device picks them up.
    setPrefs({ subSize: 'L' }, laptop.store); await time.tick(1600);
    eq(laptop.puts().at(-1).body.patch, { prefs: { subSize: 'L' } }, 'a pref change sends only that key');
    setPrefs({ animeAudio: 'dub' }, phone.store);
    await phone.engine.hidden(); await time.tick(10);
    eq([getPrefs(phone.store).subSize, getPrefs(phone.store).animeAudio], ['L', 'dub'], 'phone: laptop\'s caption size + its own audio pref');
    await laptop.engine.syncNow(); await time.settle();
    eq(getPrefs(laptop.store).animeAudio, 'dub', 'laptop: phone\'s audio pref');
    // Captions turned off on the phone (subLang deleted) stay off on the laptop — not resurrected.
    setPrefs({ subLang: 'en' }, laptop.store); await laptop.engine.hidden(); await time.tick(10);
    await phone.engine.syncNow(); await time.settle();
    eq(phone.store.getState().prefs.subLang, 'en', 'phone: automatic captions on (from the laptop)');
    setPrefs({ subLang: null }, phone.store); await phone.engine.hidden(); await time.tick(10);
    eq(phone.puts().at(-1).body.patch, { prefs: { subLang: null } }, 'a deleted pref travels as null');
    await laptop.engine.syncNow(); await time.settle();
    eq(laptop.store.getState().prefs.subLang, undefined, 'laptop: the deletion arrives instead of being pushed back');
    eq(laptop.puts().at(-1).body.patch.prefs, { subLang: 'en' }, '(and the laptop did not re-send it)');

    // Another tab's write (source 'storage') is never re-sent from this tab.
    const p1 = laptop.puts().length;
    laptop.ls.setItem('sw_list', JSON.stringify([{ id: 999, kind: 'movie', updatedAt: time.now() }]));
    laptop.store.reload('sw_list'); await time.tick(70000);
    eq(laptop.puts().length, p1, "a change from another tab (source 'storage') is not PUT again");

    // Offline: queued, then flushed when the browser is back online.
    laptop.net.online = false;
    toggleList(it(90), laptop.store); await time.tick(5000);
    eq([laptop.puts().length, laptop.engine.status().state], [p1, 'offline'], 'offline: nothing sent, status offline');
    eq(laptop.store.getState().sync.pending.keys.includes('list'), true, 'the queue survives a reload (persisted in the sync key)');
    laptop.net.online = true;
    await laptop.engine.online(); await time.settle();
    eq([laptop.puts().length, laptop.engine.status().state], [p1 + 1, 'synced'], 'back online: pulled, then flushed');
    eq(laptop.store.getState().sync.pending, undefined, 'queue cleared once it landed');

    // A network failure mid-flight keeps the change and retries later.
    laptop.net.down = true;
    toggleList(it(91), laptop.store); await time.tick(1600);
    eq(laptop.engine.status().state, 'offline', 'unreachable server reads as offline');
    laptop.net.down = false;
    await time.tick(16000);
    ok(laptop.puts().at(-1).body.patch.list.some(x => x.id === 91), 'retried after the backoff');
    eq(laptop.engine.status().state, 'synced', 'synced after the retry');
  }

  // ── 5. Unconfigured or signed out: stay local, quietly ─────────────────────────
  {
    const time = fakeTime();
    const d = device({}, time);
    toggleList({ id: 1, title: 'x', poster_path: '/p' }, d.store);
    await d.engine.start(); await time.tick(5000);
    toggleList({ id: 2, title: 'y', poster_path: '/p' }, d.store); await time.tick(5000);
    eq([d.engine.status().state, d.log.length], ['local', 1], '503: one GET, then silently local — no PUTs, no retries');
    eq(d.store.getState().list.length, 2, 'the app keeps working locally');

    const t2 = fakeTime();
    const store = createStore(memoryStorage(), undefined, { now: t2.now });
    const e = createSync({ store, now: t2.now, setTimer: t2.setTimer, clearTimer: t2.clearTimer,
      fetch: async () => new Response('<!doctype html><title>login</title>', { headers: { 'content-type': 'text/html' } }) });
    await e.start(); await t2.settle();
    eq(e.status().state, 'signed-out', 'a login bounce stops sync (and never redirects a background request)');
    eq(t2.pending(), 0, 'no retry timers left behind');
  }

  return n;
}
