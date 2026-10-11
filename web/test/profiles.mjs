// Profiles ("Who's watching?"), end to end in node:
//   - the Worker's /api/profiles over a fake KV: list, create (validation, dedupe,
//     the 12-name cap, colours, ids), select (the sw_profile cookie), delete with
//     the typed-name confirmation (and its state key), the one-time legacy
//     migration to "Shared"
//   - /api/state keyed by profile: 428 without one, the header/cookie guard,
//     a deleted profile refused, two profiles' data isolated
//   - the client controller (src/app/profiles.js createProfiles) driving the REAL
//     sync engine against the REAL Worker through a cookie jar: the switch flow
//     (flush -> select -> reset -> pull), the first-pick "bring this browser's
//     history?" choice both ways, per-profile queues, a profile deleted or
//     switched under a running engine
//   - the picker's markup (every data-act registered, names escaped)
// Run by check.mjs; returns the number of assertions, throws on the first failure.

import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import {
  profilesRoutes, cleanName, sameName, stateKey, PROFILES_KEY, LEGACY_STATE_KEY, PROFILE_COLORS, SHARED_COLOR, MAX_PROFILES,
} from '../src/worker/profiles.js';
import { syncRoutes } from '../src/worker/sync.js';
import { createStore, memoryStorage, toggleList, recordContinue, setPrefs } from '../src/app/state.js';
import { createSync } from '../src/app/sync.js';
import { createProfiles, pickerHTML, profileInitial, labelColor, profileColor, hasLocalHistory } from '../src/app/profiles.js';
import { actionNames } from '../src/app/ui/actions.js';

const T0 = Date.UTC(2026, 9, 11, 12, 0, 0);

function fakeKV(seed = {}) {
  const m = new Map(Object.entries(seed).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return {
    m, puts: 0, deletes: 0,
    async get(k, type) { const v = m.has(k) ? m.get(k) : null; return v == null ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { this.puts++; m.set(k, String(v)); },
    async delete(k) { this.deletes++; m.delete(k); },
    json(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; },
  };
}

/** Call a route module directly (behind-the-gate behaviour). */
function route(handler, env, method, path, { body, cookie, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (body !== undefined) h['content-type'] = 'application/json';
  const req = new Request('https://watch.example' + path, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return handler(req, env, new URL(req.url));
}
const P = (env, method, path, opts) => route(profilesRoutes, env, method, path, opts);
const S = (env, method, opts) => route(syncRoutes, env, method, '/api/state', opts);
const as = (id) => ({ cookie: 'sw_profile=' + id, headers: { 'x-sw-profile': id } });

/** A fake clock + timer queue (as in test/sync.mjs). */
function fakeTime(start = T0) {
  let now = start, seq = 0;
  const timers = new Map();
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
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

/** One browser: its own localStorage-backed store + cookie jar, the real sync
    engine and the real profiles controller, all talking to the real Worker. */
async function browser(env, time, { ls = memoryStorage(), jar = null } = {}) {
  if (!jar) {
    const r = await worker.fetch(new Request('https://w/login', { method: 'POST', body: new URLSearchParams({ password: env.SITE_PASSWORD }) }), env);
    const [k, v] = (r.headers.get('set-cookie') || '').split(';')[0].split('=');
    jar = new Map([[k, v]]);
  }
  const store = createStore(ls, undefined, { now: time.now });
  const log = [], refusals = [];
  const net = { online: true, failStatePuts: false };
  const doFetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    if (!net.online || (net.failStatePuts && method === 'PUT' && url === '/api/state')) throw new TypeError('Failed to fetch');
    const headers = { ...(init.headers || {}), cookie: [...jar].map(([k, v]) => k + '=' + v).join('; ') };
    log.push({ method, url, profile: headers['x-sw-profile'] || null, body: init.body ? JSON.parse(init.body) : null });
    const res = await worker.fetch(new Request('https://w' + url, { method, headers, body: init.body }), env);
    const sc = res.headers.get('set-cookie');
    if (sc) { const [k, v] = sc.split(';')[0].split('='); if (/max-age=0/i.test(sc)) jar.delete(k); else jar.set(k, v); }
    return res;
  };
  let engine = null;
  const sync = {
    start: (id) => {
      if (engine) engine.stop();
      engine = createSync({ store, fetch: doFetch, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
        isOnline: () => net.online, profile: id, onProfile: (k) => refusals.push(k) });
      return engine.start();
    },
    flush: () => (engine ? engine.flush() : Promise.resolve(true)),
    stop: () => { if (engine) engine.stop(); },
    status: () => (engine ? engine.status() : { state: 'off' }),
  };
  const ctl = createProfiles({ store, fetch: doFetch, sync });
  return { ls, jar, store, log, net, ctl, refusals, engine: () => engine, sync,
    since: (n) => log.slice(n).map(r => `${r.method} ${r.url}${r.profile ? ' @' + r.profile : ''}`) };
}

const ids = (arr) => arr.map(x => x.kind + ':' + x.id);
const it = (id) => ({ id, title: 'T' + id, poster_path: '/p' });

export async function runProfilesChecks() {
  let n = 0;
  const eq = (a, b, m) => { assert.deepEqual(a, b, m); n++; };
  const ok = (v, m) => { assert.ok(v, m); n++; };

  // ── 1. Pure helpers ────────────────────────────────────────────────────────
  eq([cleanName('  Mary ​  Ann '), cleanName(''), cleanName('   '), cleanName(7), cleanName('x'.repeat(25)), cleanName('x'.repeat(24))],
    ['Mary Ann', null, null, null, null, 'x'.repeat(24)], 'names: trimmed, invisible characters dropped, spaces collapsed, 1–24 characters');
  ok(sameName('  mary  ann', 'Mary Ann') && !sameName('Max', 'Maxx'), 'names compare ignoring case and spacing');
  eq([profileInitial('max'), profileInitial('  émile'), profileInitial('')], ['M', 'É', '?'], 'avatar initial');
  eq([labelColor('#35C759'), labelColor('#0A46E6'), labelColor('#FFC107')], ['#000', '#fff', '#000'], 'label colour: black on bright, white on dark (iOS rule)');
  eq([profileColor({ color: '#e50914' }), profileColor({ color: 'red;background:url(x)' }), profileColor(null)], ['#e50914', SHARED_COLOR, SHARED_COLOR], 'only a #rrggbb colour reaches a style attribute');

  // ── 2. /api/profiles CRUD ──────────────────────────────────────────────────
  {
    let r = await P({}, 'GET', '/api/profiles');
    eq([r.status, (await r.json()).error], [503, 'profiles-not-configured'], 'no STATE binding -> 503');
    const env = { STATE: fakeKV() };
    r = await P(env, 'GET', '/api/profiles');
    eq([r.status, await r.json(), env.STATE.puts], [200, { profiles: [], current: null }, 0], 'empty list; reading writes nothing');
    for (const [body, why] of [['{nope', 'bad JSON'], [{}, 'no name'], [{ name: '   ' }, 'blank'], [{ name: 42 }, 'not a string'], [{ name: 'x'.repeat(25) }, '25 characters']]) {
      r = await P(env, 'POST', '/api/profiles', { body });
      eq([r.status, (await r.json()).error], [400, 'bad-name'], 'create refused: ' + why);
    }
    r = await P(env, 'POST', '/api/profiles', { body: { name: '  Max ' } });
    let j = await r.json();
    eq([r.status, j.profile.name, j.profile.color, j.profiles.length], [201, 'Max', PROFILE_COLORS[0], 1], 'create: 201, trimmed name, first colour');
    ok(/^max-[a-z0-9]{5}$/.test(j.profile.id) && j.profile.createdAt > 0 && j.profile.lastUsedAt === 0, 'id = slug + short random suffix: ' + j.profile.id);
    const max = j.profile;
    r = await P(env, 'POST', '/api/profiles', { body: { name: 'MAX' } });
    j = await r.json();
    eq([r.status, j.error, j.profile.id], [409, 'name-taken', max.id], 'same name in another case -> 409 name-taken (with the existing profile)');
    r = await P(env, 'POST', '/api/profiles', { body: { name: 'Zoë Ångström!' } });
    ok(/^zoe-angstrom-[a-z0-9]{5}$/.test((await r.json()).profile.id), 'accents fold into the slug');
    r = await P(env, 'POST', '/api/profiles', { body: { name: '🍿' } });
    ok(/^p-[a-z0-9]{5}$/.test((await r.json()).profile.id), 'a name with no letters still gets an id');
    for (let i = 4; i <= MAX_PROFILES; i++) { r = await P(env, 'POST', '/api/profiles', { body: { name: 'Person ' + i } }); ok(r.status === 201, 'create #' + i); }
    r = await P(env, 'POST', '/api/profiles', { body: { name: 'Thirteen' } });
    eq([r.status, (await r.json()).error], [409, 'too-many'], `the ${MAX_PROFILES + 1}th name -> 409 too-many`);
    const all = env.STATE.json(PROFILES_KEY).profiles;
    eq(all.length, MAX_PROFILES, 'twelve stored, in one KV document');
    eq(new Set(all.slice(0, PROFILE_COLORS.length).map(p => p.color)).size, PROFILE_COLORS.length, 'the first ten get ten different colours');

    r = await P(env, 'POST', '/api/profiles/select', { body: { id: 'nobody-12345' } });
    eq([r.status, (await r.json()).error], [404, 'no-such-profile'], 'select: unknown id -> 404');
    r = await P(env, 'GET', '/api/profiles/select');
    eq(r.status, 405, 'select is POST only');
    r = await P(env, 'POST', '/api/profiles/select', { body: { id: max.id } });
    j = await r.json();
    const sc = r.headers.get('set-cookie') || '';
    eq([r.status, j.profile.id], [200, max.id], 'select -> 200 with the profile');
    ok(sc.startsWith('sw_profile=' + max.id + ';') && /HttpOnly/.test(sc) && /Secure/.test(sc) && /SameSite=Lax/.test(sc) && /Path=\//.test(sc) && /Max-Age=31536000/.test(sc) && !/Domain=/i.test(sc),
      'select sets sw_profile: HttpOnly, Secure, SameSite=Lax, a year, host-only');
    ok(env.STATE.json(PROFILES_KEY).profiles.find(p => p.id === max.id).lastUsedAt > 0, 'select stamps lastUsedAt');
    r = await P(env, 'GET', '/api/profiles', { cookie: 'sw_profile=' + max.id });
    eq((await r.json()).current, max.id, 'GET names the cookie\'s profile as current');
    r = await P(env, 'GET', '/api/profiles', { cookie: 'sw_profile=ghost-00000' });
    eq((await r.json()).current, null, '...but not a cookie for a profile that does not exist');

    // Delete: the typed name must match; the profile and its state go.
    env.STATE.m.set(stateKey(max.id), JSON.stringify({ rev: 1, updatedAt: 1, data: { list: [{ id: 1, kind: 'movie' }] } }));
    r = await P(env, 'DELETE', '/api/profiles/' + max.id);
    eq([r.status, (await r.json()).error], [400, 'confirm-mismatch'], 'delete without ?confirm -> 400');
    r = await P(env, 'DELETE', '/api/profiles/' + max.id + '?confirm=Maxwell');
    eq(r.status, 400, 'delete with the wrong name -> 400');
    ok(env.STATE.m.has(stateKey(max.id)), '...and nothing was deleted');
    r = await P(env, 'DELETE', '/api/profiles/nobody-12345?confirm=x');
    eq(r.status, 404, 'delete an unknown id -> 404');
    r = await P(env, 'GET', '/api/profiles/' + max.id);
    eq(r.status, 405, 'a profile URL only takes DELETE');
    r = await P(env, 'DELETE', '/api/profiles/' + max.id + '?confirm=%20max', { cookie: 'sw_profile=' + max.id });
    j = await r.json();
    eq([r.status, j.profiles.some(p => p.id === max.id), env.STATE.m.has(stateKey(max.id))], [200, false, false], 'delete with the name (any case) removes the profile AND its state');
    ok(/^sw_profile=;/.test(r.headers.get('set-cookie') || '') && /Max-Age=0/.test(r.headers.get('set-cookie')), 'deleting your own profile clears your cookie');
    const other = all[1];
    r = await P(env, 'DELETE', '/api/profiles/' + other.id + '?confirm=' + encodeURIComponent(other.name), { cookie: 'sw_profile=' + all[2].id });
    eq([r.status, r.headers.get('set-cookie')], [200, null], 'deleting someone else leaves your cookie alone');
    r = await P(env, 'POST', '/api/profiles', { body: { name: 'Max' } });
    eq(r.status, 201, 'a deleted name can be used again (space freed under the cap)');
    eq(await route(profilesRoutes, env, 'GET', '/api/profilesx'), null, 'other paths fall through');
  }

  // ── 3. Migration: the old shared state becomes "Shared" ──────────────────────
  {
    const legacy = { rev: 9, updatedAt: T0, data: { list: [{ id: 550, kind: 'movie', title: 'Fight Club', updatedAt: T0 }], continue: [], prefs: { subSize: 'L' }, reading: {}, tombs: {} } };
    const env = { STATE: fakeKV({ [LEGACY_STATE_KEY]: legacy }) };
    let r = await P(env, 'GET', '/api/profiles');
    let j = await r.json();
    eq(j.profiles.map(p => [p.id, p.name, p.color]), [['shared', 'Shared', SHARED_COLOR]], 'first read: a grey "Shared" profile');
    eq([env.STATE.json(stateKey('shared')), env.STATE.m.has(LEGACY_STATE_KEY)], [legacy, false], 'the legacy blob moved to state:shared, byte for byte');
    r = await P(env, 'GET', '/api/profiles');
    eq((await r.json()).profiles.length, 1, 'a second read does not migrate again');
    r = await S(env, 'GET', as('shared'));
    j = await r.json();
    eq([r.status, j.rev, ids(j.data.list), j.data.prefs], [200, 9, ['movie:550'], { subSize: 'L' }], 'Shared serves the old merged history');

    // Nothing worth keeping: no Shared, no write.
    const env2 = { STATE: fakeKV({ [LEGACY_STATE_KEY]: { rev: 3, updatedAt: 1, data: { list: [], continue: [], prefs: {}, reading: {}, tombs: { list: { 'movie:1': T0 } } } } }) };
    r = await P(env2, 'GET', '/api/profiles');
    eq([(await r.json()).profiles, env2.STATE.puts, env2.STATE.m.has(PROFILES_KEY)], [[], 0, false], 'an empty legacy state is not migrated');

    // Idempotent: a repeated migration (stale read elsewhere) never overwrites state:shared.
    const newer = { rev: 12, updatedAt: T0 + 5, data: { list: [{ id: 1, kind: 'tv', updatedAt: T0 + 5 }] } };
    const env3 = { STATE: fakeKV({ [LEGACY_STATE_KEY]: legacy, [stateKey('shared')]: newer }) };
    await P(env3, 'GET', '/api/profiles');
    eq(env3.STATE.json(stateKey('shared')), newer, 'an existing state:shared is kept');

    // Creating a name first migrates too.
    const env4 = { STATE: fakeKV({ [LEGACY_STATE_KEY]: legacy }) };
    r = await P(env4, 'POST', '/api/profiles', { body: { name: 'Ann' } });
    eq((await r.json()).profiles.map(p => p.name), ['Shared', 'Ann'], 'a create before any read still keeps the old history as Shared');
  }

  // ── 4. /api/state is per profile ─────────────────────────────────────────────
  {
    const env = { STATE: fakeKV() };
    const ann = (await (await P(env, 'POST', '/api/profiles', { body: { name: 'Ann' } })).json()).profile;
    const bob = (await (await P(env, 'POST', '/api/profiles', { body: { name: 'Bob' } })).json()).profile;
    let r = await S(env, 'GET');
    eq([r.status, (await r.json()).error], [428, 'no-profile'], 'no cookie -> 428 no-profile');
    r = await S(env, 'GET', { cookie: 'sw_profile=' + ann.id });
    eq(r.status, 428, 'a cookie without the page\'s x-sw-profile header (an old page) -> 428');
    r = await S(env, 'GET', { cookie: 'sw_profile=../../x', headers: { 'x-sw-profile': '../../x' } });
    eq(r.status, 428, 'a malformed cookie -> 428');
    r = await S(env, 'PUT', { cookie: 'sw_profile=' + bob.id, headers: { 'x-sw-profile': ann.id }, body: { baseRev: 0, patch: { list: [{ id: 1, kind: 'movie' }] } } });
    eq([r.status, (await r.json()).error, env.STATE.puts], [409, 'profile-mismatch', 2], 'the page holds Ann but the cookie says Bob -> 409 profile-mismatch, nothing written');
    r = await S(env, 'POST', as(ann.id));
    eq(r.status, 405, 'other methods -> 405');

    const A = { id: 1, kind: 'movie', title: 'Ann\'s', updatedAt: T0 }, B = { id: 2, kind: 'tv', title: 'Bob\'s', updatedAt: T0 };
    r = await S(env, 'PUT', { ...as(ann.id), body: { baseRev: 0, patch: { list: [A] } } });
    eq([r.status, (await r.json()).rev], [200, 1], 'Ann writes');
    r = await S(env, 'PUT', { ...as(bob.id), body: { baseRev: 0, patch: { list: [B] } } });
    eq([r.status, (await r.json()).rev], [200, 1], 'Bob writes, from his own rev 0');
    eq([ids((await (await S(env, 'GET', as(ann.id))).json()).data.list), ids((await (await S(env, 'GET', as(bob.id))).json()).data.list)],
      [['movie:1'], ['tv:2']], 'each profile reads only its own state');
    ok(env.STATE.m.has(stateKey(ann.id)) && env.STATE.m.has(stateKey(bob.id)) && !env.STATE.m.has(LEGACY_STATE_KEY), 'stored as state:<id>, never the old shared key');
    await P(env, 'DELETE', '/api/profiles/' + bob.id + '?confirm=bob');
    r = await S(env, 'GET', as(bob.id));
    eq([r.status, /^sw_profile=;/.test(r.headers.get('set-cookie') || '')], [428, true], 'a deleted profile -> 428, and its cookie is cleared');
    eq(ids((await (await S(env, 'GET', as(ann.id))).json()).data.list), ['movie:1'], 'Ann is untouched by Bob\'s deletion');

    // Through the real Worker: behind the password gate.
    const wenv = { SITE_PASSWORD: 'pw', SESSION_SECRET: 's', STATE: env.STATE };
    r = await worker.fetch(new Request('https://w/api/profiles', { redirect: 'manual' }), wenv);
    eq([r.status, r.headers.get('location')], [302, '/login'], '/api/profiles is gated');
  }

  // ── 5. The client: controller + real sync engine + real Worker ─────────────
  {
    const env = { SITE_PASSWORD: 'pw', SESSION_SECRET: 's', STATE: fakeKV() };
    const time = fakeTime();

    // First visit, nothing local: pick -> add a name -> it's selected, synced.
    const laptop = await browser(env, time);
    laptop.store.setState({ rdkey: 'RDSECRET' });
    eq(laptop.ctl.boot(), 'pick', 'no profile in this browser: the picker');
    eq(await laptop.ctl.list(), { profiles: [], current: null }, 'no names yet');
    const ann = (await laptop.ctl.create('Ann')).profile;
    eq((await laptop.ctl.create('ann')).error, 'name-taken', 'the controller passes the Worker\'s refusal through');
    let n0 = laptop.log.length;
    let r = await laptop.ctl.select(ann);
    await r.ready; await time.settle();
    eq([r.ok, r.switched, r.profile], [true, true, { id: ann.id, name: 'Ann', color: ann.color }], 'selected');
    eq(laptop.since(n0), ['POST /api/profiles/select', 'GET /api/state @' + ann.id], 'select, then pull as Ann');
    eq([laptop.jar.get('sw_profile'), laptop.store.getState().profile.id, laptop.engine().status().state], [ann.id, ann.id, 'synced'], 'cookie, local profile and engine agree');
    toggleList(it(1), laptop.store); await time.tick(1600);
    eq(laptop.log.at(-1).profile, ann.id, 'every /api/state request names the profile (x-sw-profile)');
    eq(ids(env.STATE.json(stateKey(ann.id)).data.list), ['movie:1'], 'Ann\'s list lands in state:<ann>');

    // Max exists with history of his own (from his phone).
    const phone = await browser(env, time);
    const max = (await phone.ctl.create('Max')).profile;
    r = await phone.ctl.select(max); await r.ready;
    toggleList(it(99), phone.store); await time.tick(1600);
    eq(ids(env.STATE.json(stateKey(max.id)).data.list), ['movie:99'], 'Max\'s list on the server');

    // Switch the laptop Ann -> Max with a change of Ann's still queued:
    // flush (as Ann) -> select -> reset -> pull (as Max).
    toggleList(it(2), laptop.store); await time.tick(200);
    ok(laptop.store.getState().sync.pending, 'Ann has a change waiting (debounce)');
    n0 = laptop.log.length;
    r = await laptop.ctl.select(max);
    await r.ready; await time.settle();
    eq(laptop.since(n0), ['PUT /api/state @' + ann.id, 'POST /api/profiles/select', 'GET /api/state @' + max.id], 'switch: flush Ann, select Max, pull Max');
    eq(ids(env.STATE.json(stateKey(ann.id)).data.list), ['movie:2', 'movie:1'], 'Ann\'s queued change reached Ann before the switch');
    eq(ids(laptop.store.getState().list), ['movie:99'], 'the laptop now shows only Max\'s list');
    eq(laptop.store.getState().tombs, {}, 'Ann\'s entries were cleared, not tombstoned');
    eq([laptop.store.getState().rdkey, laptop.store.getState().profile.name, laptop.jar.get('sw_profile')], ['RDSECRET', 'Max', max.id], 'the RD key stays (browser-wide); profile + cookie are Max');
    await time.tick(70000);
    ok(!env.STATE.json(stateKey(max.id)).data.list.some(x => x.id === 1 || x.id === 2), 'nothing of Ann\'s ever reaches Max');
    eq(ids(env.STATE.json(stateKey(ann.id)).data.list), ['movie:2', 'movie:1'], '...and Ann\'s server copy is intact');
    r = await laptop.ctl.select(ann); await r.ready; await time.settle();
    eq(ids(laptop.store.getState().list), ['movie:2', 'movie:1'], 'switching back brings Ann\'s list back');

    // Offline: the flush can't land -> { unsent }, nothing changes; forcing
    // while offline fails at select, still nothing changes; Ann's queue survives.
    laptop.net.online = false;
    toggleList(it(3), laptop.store); await time.tick(1600);
    n0 = laptop.log.length;
    r = await laptop.ctl.select(max);
    eq(r, { unsent: true }, 'unsent changes: the switch asks first');
    r = await laptop.ctl.select(max, { force: true });
    eq([r.error, laptop.store.getState().profile.id, laptop.jar.get('sw_profile'), laptop.log.length - n0], ['offline', ann.id, ann.id, 0], 'switch anyway while offline: refused, still Ann, nothing sent');
    ok(laptop.store.getState().sync.profile === ann.id && laptop.store.getState().sync.pending.keys.includes('list'), 'Ann\'s queue is still persisted, marked as Ann\'s');
    laptop.net.online = true;
    r = await laptop.ctl.select(max); await r.ready; await time.settle();
    ok(r.ok && env.STATE.json(stateKey(ann.id)).data.list.some(x => x.id === 3), 'back online: Ann\'s queued change flushed to Ann, then switched');
    ok(!env.STATE.json(stateKey(max.id)).data.list.some(x => x.id === 3), '...and not to Max');

    // Forced switch when the old profile's PUT can't land: its queue is dropped,
    // never sent as the new profile.
    toggleList(it(4), laptop.store); await time.tick(200);
    laptop.net.failStatePuts = true;
    eq(await laptop.ctl.select(ann), { unsent: true }, 'the flush failed');
    laptop.net.failStatePuts = false;
    r = await laptop.ctl.select(ann, { force: true }); await r.ready; await time.tick(70000);
    ok(!env.STATE.json(stateKey(ann.id)).data.list.some(x => x.id === 4) && !env.STATE.json(stateKey(max.id)).data.list.some(x => x.id === 4), 'Max\'s unsent change went nowhere (dropped, as the picker warns)');
    eq([laptop.store.getState().sync.profile, laptop.store.getState().sync.pending], [ann.id, undefined], 'the queue now is Ann\'s, and empty');

    // Queue isolation at the engine: a queue + rev left by another profile are dropped.
    {
      const s = createStore(memoryStorage(), undefined, { now: time.now });
      s.setState({ sync: { profile: 'other', rev: 41, pending: { keys: ['list', 'tombs'], prefKeys: [] } } }, { source: 'sync' });
      createSync({ store: s, fetch: async () => { throw new Error('unused'); }, profile: max.id });
      eq(s.getState().sync, { profile: max.id }, 'an engine for Max drops a queue + rev that belong to another profile');
      s.setState({ sync: { profile: max.id, rev: 5, pending: { keys: ['list'], prefKeys: [] } } }, { source: 'sync' });
      createSync({ store: s, fetch: async () => { throw new Error('unused'); }, profile: max.id });
      eq(s.getState().sync.pending.keys, ['list'], '...and keeps its own (a reload keeps the offline queue)');
    }

    // A profile deleted elsewhere while this browser is using it.
    const tablet = await browser(env, time);
    const zed = (await tablet.ctl.create('Zed')).profile;
    r = await tablet.ctl.select(zed); await r.ready;
    await (await P(env, 'DELETE', '/api/profiles/' + zed.id + '?confirm=Zed')).json();
    toggleList(it(7), tablet.store); await time.tick(1600);
    eq([tablet.refusals, tablet.engine().status().state, tablet.jar.has('sw_profile')], [['none'], 'no-profile', false], 'deleted elsewhere: 428 -> the engine stops and asks for the picker');
    const sent = tablet.log.length;
    toggleList(it(70), tablet.store); await time.tick(600000);
    ok(tablet.log.length === sent && !env.STATE.m.has(stateKey(zed.id)), 'no retries, no more PUTs, and the deleted profile is not resurrected');
    r = await tablet.ctl.select(ann); await r.ready; await time.settle();
    ok(r.ok && !tablet.store.getState().list.some(x => x.id === 7), 'picking another name drops the deleted one\'s leftovers');

    // Another tab switched this browser's cookie: the stale tab's write is refused.
    const tab2 = await browser(env, time, { jar: laptop.jar });   // same browser cookies
    r = await tab2.ctl.select(ann); await r.ready;
    r = await laptop.ctl.select(max); await r.ready; await time.settle();   // tab 1 switches the browser to Max
    toggleList(it(8), tab2.store); await time.tick(1600);
    eq([tab2.refusals, tab2.engine().status().state], [['mismatch'], 'profile-changed'], 'the tab still holding Ann is refused (profile-mismatch)');
    ok(!env.STATE.json(stateKey(max.id)).data.list.some(x => x.id === 8), '...so Ann\'s change never lands in Max');

    // Delete the current profile from this browser.
    const kiosk = await browser(env, time);
    const temp = (await kiosk.ctl.create('Temp')).profile;
    r = await kiosk.ctl.select(temp); await r.ready;
    toggleList(it(5), kiosk.store); await time.tick(1600);
    eq((await kiosk.ctl.remove(temp, 'Tmp')).error, 'confirm-mismatch', 'the wrong name is refused');
    eq(kiosk.store.getState().profile.id, temp.id, '...and nothing changed');
    r = await kiosk.ctl.remove(temp, 'temp');
    eq([r.ok, r.wasCurrent, kiosk.store.getState().profile, kiosk.store.getState().list, kiosk.jar.has('sw_profile'), kiosk.engine().status().state],
      [true, true, null, [], false, 'off'], 'deleting yourself empties this browser, clears the cookie and stops sync');
    ok(!env.STATE.m.has(stateKey(temp.id)) && kiosk.ctl.boot() === 'pick' && !hasLocalHistory(kiosk.store.getState()), '...its state is gone and the next boot asks who\'s watching (no import offer)');
  }

  // ── 6. First pick in a browser with history from before profiles ───────────
  {
    const env = { SITE_PASSWORD: 'pw', SESSION_SECRET: 's', STATE: fakeKV() };
    const time = fakeTime();
    const seed = await browser(env, time);
    const max = (await seed.ctl.create('Max')).profile;
    let r = await seed.ctl.select(max); await r.ready;
    toggleList(it(99), seed.store); setPrefs({ subSize: 'S' }, seed.store); await time.tick(1600);

    const legacy = () => {
      const ls = memoryStorage();
      ls.setItem('sw_list', JSON.stringify([{ id: 500, kind: 'movie', title: 'Old', updatedAt: T0 - 1000 }]));
      ls.setItem('sw_continue', JSON.stringify([{ id: 600, kind: 'tv', s: 1, e: 2, pos: 300, ts: T0 - 500, updatedAt: T0 - 500 }]));
      ls.setItem('sw_sync', JSON.stringify({ rev: 7, pending: { keys: ['list'], prefKeys: [] } }));   // the old shared-state queue
      ls.setItem('sw_rdkey', '"MYKEY"');
      return ls;
    };

    // Yes: merged into Max through the normal upload.
    const yes = await browser(env, time, { ls: legacy() });
    ok(hasLocalHistory(yes.store.getState()), 'pre-profile history detected');
    let n0 = yes.log.length;
    eq(await yes.ctl.select(max), { needsImport: true }, 'first pick asks "Bring this browser\'s history into Max?"');
    eq(yes.log.length, n0, '...before anything is sent');
    r = await yes.ctl.select(max, { importLocal: true }); await r.ready; await time.settle();
    eq(ids(yes.store.getState().list).sort(), ['movie:500', 'movie:99'], 'Yes: this browser shows its own + Max\'s list');
    const onServer = env.STATE.json(stateKey(max.id)).data;
    eq([ids(onServer.list).sort(), ids(onServer.continue)], [['movie:500', 'movie:99'], ['tv:600']], '...and uploaded what Max lacked (list + Continue Watching)');
    eq(yes.log.filter(x => x.method === 'PUT').map(x => [x.profile, x.body.baseRev]), [[max.id, 1]], 'one PUT, as Max, from Max\'s rev (not the old shared rev 7)');
    eq([yes.store.getState().prefs.subSize, yes.store.getState().rdkey], ['S', 'MYKEY'], 'Max\'s prefs apply; the RD key stays');

    // No: cleared, Max's own history only.
    const no = await browser(env, time, { ls: legacy() });
    no.ls.setItem('sw_list', JSON.stringify([{ id: 777, kind: 'movie', title: 'Someone else', updatedAt: T0 }])); no.store.reload();
    r = await no.ctl.select(max, { importLocal: false }); await r.ready; await time.tick(70000);
    eq(ids(no.store.getState().list).sort(), ['movie:500', 'movie:99'], 'No: only what Max has (here: his list after the Yes above)');
    ok(!env.STATE.json(stateKey(max.id)).data.list.some(x => x.id === 777) && !no.log.some(x => x.method === 'PUT'), 'nothing local was uploaded (no PUT at all)');
    eq([no.store.getState().rdkey, no.store.getState().tombs], ['MYKEY', {}], 'the RD key stays; no tombstones from clearing');
    eq(hasLocalHistory(no.store.getState()), false, 'never asked again once a profile is set');

    // A browser whose only local data is recent progress is offered the import too.
    const ls3 = memoryStorage();
    const s3 = createStore(ls3);
    recordContinue({ id: 1 }, 'movie', 1, 1, 10, s3);
    ok(hasLocalHistory(s3.getState()), 'Continue Watching alone counts as history');
  }

  // ── 7. The picker's markup ───────────────────────────────────────────────────
  {
    const profiles = [{ id: 'max-aaaaa', name: 'Max', color: '#35C759' }, { id: 'evil-bbbbb', name: '<img src=x>', color: 'url(javascript:1)' }];
    const base = { closable: true, profiles, adding: false, draft: '', confirm: '', target: null, note: '', error: '', busyText: '' };
    const states = [
      { ...base, mode: 'grid' }, { ...base, mode: 'grid', adding: true, draft: 'Jo' }, { ...base, mode: 'loading' },
      { ...base, mode: 'error', error: 'x' }, { ...base, mode: 'unconfigured' }, { ...base, mode: 'busy', target: profiles[0], busyText: 'Switching…' },
      { ...base, mode: 'import', target: profiles[0] }, { ...base, mode: 'delete', target: profiles[0] }, { ...base, mode: 'unsent', target: profiles[0] },
    ];
    const html = states.map(s => pickerHTML(s, profiles[0])).join('\n');
    for (const a of new Set([...html.matchAll(/data-act="([a-z-]+)"/g)].map(m => m[1]))) ok(actionNames().includes(a), `picker data-act="${a}" has a handler`);
    ok(html.includes("Who's watching?") && html.includes("Bring this browser's history into Max?") && html.includes('Add name'), 'picker copy');
    ok(!html.includes('<img src=x>') && html.includes('&lt;img src=x&gt;') && !html.includes('javascript:'), 'names escaped; a bad colour never reaches the style');
    const grid = pickerHTML({ ...base, mode: 'grid' }, profiles[0]);
    ok(/class="pick-tile cur"[\s\S]*?data-id="max-aaaaa"/.test(grid) && grid.includes('data-act="profile-menu"'), 'current profile marked; each tile has its ⋯ (delete) button');
    ok(pickerHTML({ ...base, mode: 'delete', target: profiles[0] }, null).includes('data-act="profile-delete" disabled'), 'Delete stays disabled until the name is typed');
    ok(!pickerHTML({ ...base, mode: 'delete', target: profiles[0], confirm: 'max' }, null).includes('data-act="profile-delete" disabled'), '...and enables once it matches');
    ok(!pickerHTML({ ...base, mode: 'grid', closable: false }, null).includes('profile-close'), 'a picker that must be answered has no Done');
    ok(!pickerHTML({ ...base, mode: 'grid', profiles: Array.from({ length: MAX_PROFILES }, (_, i) => ({ id: 'p-' + i, name: 'P' + i })) }, null).includes('profile-add'), 'no "Add name" at the cap');
  }

  return n;
}
