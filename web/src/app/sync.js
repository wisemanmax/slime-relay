/* Personal sync: the owner's My List, Continue Watching, prefs and reading
   progress follow them between browsers (the apps use iCloud; the web keeps
   one copy in the Worker's KV — see src/worker/sync.js).

   Two halves in one file:
   1. the PURE merge rules (mergeData, validatePatch …) — the Worker imports
      these too, so the client and server merge identically;
   2. the client engine (createSync / initSync): pull on boot, merge, push
      changes back debounced, retry on 409, queue while offline.

   Merge rules (mergeData(a, b) — `b` wins ties):
   - list / continue / reading are merged ENTRY BY ENTRY, last write wins on
     each entry's `updatedAt` (state.js stamps it on every local write).
   - a tombstone (`tombs[key][entryId] = deletedAt`) beats any entry stamped at
     or before it: removals sync instead of being resurrected.
   - continue: the same episode keeps the further position (two devices that
     both played it never rewind each other).
   - each collection is re-sorted newest first and capped at SCHEMA[key].max.
   - prefs are shallow-merged (`b` over `a`; a null in `b` deletes the key); a
     client adopting the server's copy keeps only its own unsent pref edits.
   Device-only keys (rdkey, installHint, sync) are never part of the data. */

import { SCHEMA, SYNCED_KEYS, itemId, itemEntries, stampOf, pruneTombs, appStore } from './state.js';
import { loginBounce } from './api.js';

export const SYNC_PATH = '/api/state';
const ITEM_KEYS = SYNCED_KEYS.filter(k => SCHEMA[k].items);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
export const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The synced part of a store snapshot (or of anything shaped like one). */
export const syncedData = (s) => Object.fromEntries(SYNCED_KEYS.map(k => [k, s && s[k] !== undefined ? s[k] : clone(SCHEMA[k].def)]));
export const emptyData = () => syncedData({});

// ── 1. Pure merge ─────────────────────────────────────────────────────────────

/** The further-watched version of the same episode wins its position. */
function keepFurther(win, lose) {
  if (!isObj(win) || !isObj(lose) || win.s !== lose.s || win.e !== lose.e) return win;
  if (!((Number(lose.pos) || 0) > (Number(win.pos) || 0))) return win;
  const out = { ...win, pos: lose.pos };
  if (out.dur == null && lose.dur != null) out.dur = lose.dur;
  return out;
}

/** Newest first: an entry's own stamp, or a continue record's play time. */
const recency = (x) => Math.max(stampOf(x), isObj(x) ? Number(x.ts) || 0 : 0);

function mergeItems(key, a, b, tomb) {
  const spec = SCHEMA[key];
  const byId = new Map(), order = [];
  // b first, so on equal recency b's order is kept (the stable sort below).
  for (const [id, x] of itemEntries(spec.items, b)) if (!byId.has(id)) { byId.set(id, x); order.push(id); }
  for (const [id, x] of itemEntries(spec.items, a)) {
    if (!byId.has(id)) { byId.set(id, x); order.push(id); continue; }
    const bx = byId.get(id);
    let win = stampOf(x) > stampOf(bx) ? x : bx;
    if (key === 'continue') win = keepFurther(win, win === x ? bx : x);
    byId.set(id, win);
  }
  const kept = order.map((id, i) => ({ id, x: byId.get(id), i }))
    .filter(e => !(Number(tomb[e.id]) >= stampOf(e.x)))
    .sort((p, q) => (recency(q.x) - recency(p.x)) || (p.i - q.i))
    .slice(0, spec.max || Infinity);
  return spec.items === 'array' ? kept.map(e => e.x) : Object.fromEntries(kept.map(e => [e.id, e.x]));
}

function mergePrefs(a, b, keep, fromB) {
  const out = fromB ? {} : { ...(isObj(a) ? a : {}) };
  for (const [k, v] of Object.entries(isObj(b) ? b : {})) { if (v === null) delete out[k]; else out[k] = v; }
  for (const k of keep || []) { if (isObj(a) && Object.hasOwn(a, k)) out[k] = a[k]; else delete out[k]; }
  return out;
}

/** Merge two synced-data objects (`b` wins ties). Keys missing from `b` keep
    `a`'s value (b's tombstones still apply). opts.now prunes old tombstones;
    opts.keepPrefs lists pref keys where `a` wins (the client's unsent edits);
    opts.prefsFromB makes b's prefs the base instead of a union, so a pref
    deleted elsewhere is deleted here too (the client adopting a server copy). */
export function mergeData(a, b, opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  a = isObj(a) ? a : {}; b = isObj(b) ? b : {};
  const tombs = {};
  for (const src of [a.tombs, b.tombs]) {
    for (const [k, t] of Object.entries(isObj(src) ? src : {})) {
      if (!ITEM_KEYS.includes(k) || !isObj(t)) continue;
      const d = tombs[k] || (tombs[k] = {});
      for (const [id, at] of Object.entries(t)) if (Number.isFinite(at) && !(d[id] >= at)) d[id] = at;
    }
  }
  const out = { tombs: pruneTombs(tombs, now) };
  for (const k of SYNCED_KEYS) {
    if (k === 'tombs') continue;
    if (k === 'prefs') out.prefs = mergePrefs(a.prefs, b.prefs, opts.keepPrefs, !!opts.prefsFromB);
    else if (SCHEMA[k].items) out[k] = mergeItems(k, a[k], b[k], out.tombs[k] || {});
    else out[k] = b[k] !== undefined ? b[k] : (a[k] !== undefined ? a[k] : clone(SCHEMA[k].def));
  }
  return out;
}

/** Check a PUT patch's shape (server side). -> { patch } with only synced keys
    and well-formed entries, or { error }. Device-only keys are dropped. */
export function validatePatch(patch) {
  if (!isObj(patch)) return { error: 'bad-patch' };
  const out = {};
  for (const k of SYNCED_KEYS) {
    if (!Object.hasOwn(patch, k)) continue;
    const v = patch[k], items = SCHEMA[k].items;
    if (items === 'array') {
      if (!Array.isArray(v)) return { error: 'bad-' + k };
      out[k] = v.filter(x => itemId(x) != null).slice(0, 500);
    } else {
      if (!isObj(v)) return { error: 'bad-' + k };
      if (Object.keys(v).length > (k === 'prefs' ? 100 : 2000)) return { error: 'too-many-' + k };
      out[k] = v;
    }
  }
  if (out.tombs) {
    const t = {};
    for (const k of ITEM_KEYS) {
      if (!isObj(out.tombs[k])) continue;
      t[k] = Object.fromEntries(Object.entries(out.tombs[k]).filter(([, at]) => Number.isFinite(at)));
    }
    out.tombs = t;
  }
  return { patch: out };
}

// ── 2. Client engine ──────────────────────────────────────────────────────────

/** Did this change only move progress along (same titles, same episodes)?
    Those are throttled harder: playback writes the position every 5 s. */
function minorChange(key, a, b) {
  if (key === 'continue') {
    const before = new Map(itemEntries('array', a)), after = itemEntries('array', b);
    return before.size === after.length && after.every(([id, x]) => { const y = before.get(id); return !!y && y.s === x.s && y.e === x.e; });
  }
  if (key === 'reading') {
    const ka = Object.keys(isObj(a) ? a : {}), kb = Object.keys(isObj(b) ? b : {});
    return ka.length === kb.length && kb.every(k => ka.includes(k));
  }
  return false;
}
const diffKeys = (a, b) => {
  a = isObj(a) ? a : {}; b = isObj(b) ? b : {};
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => !sameValue(a[k], b[k]));
};

/** The sync engine over a store ({getState, setState, subscribe}). Everything
    it touches is injected, so test/sync.mjs runs it against a fake clock, a
    fake network and the real Worker handler. Status states:
      off · connecting · synced · pending (changes waiting) · syncing ·
      offline (queued until back online) · local (sync not set up — stays
      local, silently) · signed-out · error (retrying) */
export function createSync({
  store, fetch: doFetch, now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t),
  isOnline = () => true, onRemote = () => {}, onStatus = () => {},
  debounceMs = 1500,      // quiet time after a change before it is sent
  maxWaitMs = 10000,      // ...but never hold a real change longer than this
  minorGapMs = 60000,     // progress-only changes: at most one PUT per minute (KV writes are metered)
  retryMs = 15000, maxRetryMs = 300000,
} = {}) {
  let status = { state: 'off', at: 0, detail: '' };
  const setStatus = (state, detail = '') => {
    status = { ...status, state, detail };
    if (state === 'synced') status.at = now();
    try { onStatus(status); } catch {}
  };

  const meta = () => store.getState().sync || {};
  const saved = meta().pending || {};
  const pending = { keys: new Set(saved.keys || []), prefKeys: new Set(saved.prefKeys || []), minor: false, since: 0 };
  let sending = null;              // the batch on the wire (still persisted until it lands)
  let seen = syncedData(store.getState());
  let timer = null, retryTimer = null, inflight = null, again = false;
  let started = false, ready = false, disabled = false;
  let lastPushAt = 0, lastPullAt = 0, conflicts = 0, failures = 0, unsub = null;

  const rev = () => Number(meta().rev) || 0;
  function saveMeta(patch) {
    const cur = meta(), next = { ...cur, ...patch };
    if (!sameValue(cur, next)) store.setState({ sync: next }, { source: 'sync' });
  }
  function persistPending() {
    const keys = new Set([...pending.keys, ...(sending ? sending.keys : [])]);
    const prefKeys = new Set([...pending.prefKeys, ...(sending ? sending.prefKeys : [])]);
    saveMeta({ pending: keys.size ? { keys: [...keys], prefKeys: [...prefKeys] } : undefined });
  }

  function disable(state) {
    disabled = true; ready = true;
    if (timer) { clearTimer(timer); timer = null; }
    if (retryTimer) { clearTimer(retryTimer); retryTimer = null; }
    setStatus(state);
  }

  function markDirty(keys, prefKeys, minor) {
    keys = keys.filter(k => k !== 'prefs' || prefKeys.length);
    if (!keys.length) return;
    const wasEmpty = !pending.keys.size;
    for (const k of keys) pending.keys.add(k);
    if (keys.some(k => ITEM_KEYS.includes(k))) pending.keys.add('tombs');
    for (const k of prefKeys) pending.prefKeys.add(k);
    pending.minor = wasEmpty ? minor : pending.minor && minor;
    if (wasEmpty) pending.since = now();
    persistPending();
    if (status.state === 'synced') setStatus('pending');
    schedule();
  }

  function schedule(delay) {
    if (disabled || !ready || !pending.keys.size) return;
    if (delay == null) {
      const t = now();
      let at = t + debounceMs;
      if (pending.minor && lastPushAt) at = Math.max(at, lastPushAt + minorGapMs);
      else if (!pending.minor && pending.since) at = Math.min(at, pending.since + maxWaitMs);
      delay = Math.max(0, at - t);
    }
    if (timer) clearTimer(timer);
    timer = setTimer(() => { timer = null; push(); }, delay);
  }

  function retryLater(fn) {
    failures++;
    const delay = Math.min(retryMs * 2 ** (failures - 1), maxRetryMs);
    if (retryTimer) clearTimer(retryTimer);
    retryTimer = setTimer(() => { retryTimer = null; if (!disabled && isOnline()) fn(); }, delay);
  }

  /** Merge the server's state into the store. With `markDiff`, whatever the
      merge kept that the server lacks is queued for upload. */
  function adopt(server, markDiff) {
    const data = isObj(server && server.data) ? server.data : {};
    const local = syncedData(store.getState());
    // Prefs: the server's copy is the truth for every key we have no unsent
    // edit to (so a pref removed elsewhere goes here too) — except against a
    // server that has never been written, where everything local is news.
    const merged = mergeData(local, data, { now: now(), keepPrefs: [...pending.prefKeys], prefsFromB: Number(server.rev) > 0 });
    saveMeta({ rev: Number(server.rev) || 0 });
    const changed = SYNCED_KEYS.filter(k => !sameValue(merged[k], local[k]));
    if (changed.length) {
      store.setState(Object.fromEntries(changed.map(k => [k, merged[k]])), { source: 'sync' });
      const shown = changed.filter(k => k !== 'tombs');
      if (shown.length) { try { onRemote(shown); } catch (e) { console.error('sync onRemote failed', e); } }
    }
    if (markDiff) {
      const remote = syncedData(data);
      const diff = SYNCED_KEYS.filter(k => !sameValue(merged[k], remote[k]));
      if (diff.length) markDirty(diff, diff.includes('prefs') ? diffKeys(remote.prefs, merged.prefs) : [], false);
    }
  }

  const take = () => {
    const b = { keys: new Set(pending.keys), prefKeys: new Set(pending.prefKeys), minor: pending.minor };
    pending.keys.clear(); pending.prefKeys.clear(); pending.minor = false; pending.since = 0;
    return b;
  };
  const restore = (b) => {
    const wasEmpty = !pending.keys.size;
    for (const k of b.keys) pending.keys.add(k);
    for (const k of b.prefKeys) pending.prefKeys.add(k);
    pending.minor = wasEmpty ? b.minor : pending.minor && b.minor;
    if (wasEmpty) pending.since = now();
  };

  function patchFor(batch) {
    const s = store.getState(), patch = {};
    for (const k of batch.keys) {
      if (k !== 'prefs') { patch[k] = s[k]; continue; }
      const p = {};
      for (const pk of batch.prefKeys) p[pk] = Object.hasOwn(s.prefs, pk) ? s.prefs[pk] : null;
      patch.prefs = p;
    }
    return patch;
  }

  async function push(opts = {}) {
    if (disabled || !ready) return;
    if (inflight) { again = true; return inflight; }
    if (!pending.keys.size) return;
    if (!isOnline()) { setStatus('offline'); return; }
    if (timer) { clearTimer(timer); timer = null; }
    sending = take();
    const body = JSON.stringify({ baseRev: rev(), patch: patchFor(sending) });
    setStatus('syncing');
    inflight = (async () => {
      let res, json = null;
      try {
        res = await doFetch(SYNC_PATH, {
          method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body,
          // A tab being closed: let the request outlive the page (browsers cap keepalive bodies at 64 KB).
          keepalive: !!opts.keepalive && body.length < 60000,
        });
      } catch { restore(sending); setStatus('offline'); if (isOnline()) retryLater(push); return; }
      if (loginBounce(res) || res.status === 401) { restore(sending); disable('signed-out'); return; }
      try { json = await res.json(); } catch {}
      if (res.status === 200 && json && json.data) {
        conflicts = 0; failures = 0; lastPushAt = now();
        sending = null; adopt(json, false);
        setStatus(pending.keys.size ? 'pending' : 'synced');
        return;
      }
      restore(sending);
      if (res.status === 409 && json && json.data) {
        // Someone else wrote since our base: take their state, merge, resend.
        adopt(json, true);
        if (++conflicts <= 3) { again = true; return; }
        conflicts = 0; setStatus('error', 'conflict'); retryLater(push); return;
      }
      if (res.status === 503) { disable('local'); return; }
      // Too big: retrying won't help until the data shrinks; the next change tries again.
      if (res.status === 413) { setStatus('error', 'too-large'); return; }
      setStatus('error', 'HTTP ' + res.status); retryLater(push);
    })();
    try { await inflight; } finally { inflight = null; if (sending) { sending = null; } persistPending(); }
    if (again) { again = false; schedule(0); } else if (pending.keys.size && status.state !== 'error') schedule();
  }

  async function pull() {
    if (disabled) return;
    if (!isOnline()) { ready = true; setStatus('offline'); return; }
    if (status.state === 'off' || status.state === 'offline') setStatus('connecting');
    let res, json = null;
    try { res = await doFetch(SYNC_PATH, { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } }); }
    catch { ready = true; setStatus('offline'); retryLater(pull); return; }
    if (loginBounce(res) || res.status === 401) { disable('signed-out'); return; }
    if (res.status === 503) { disable('local'); return; }
    try { json = await res.json(); } catch {}
    if (!res.ok || !json || !isObj(json.data)) { ready = true; setStatus('error', 'HTTP ' + res.status); retryLater(pull); return; }
    failures = 0; lastPullAt = now(); ready = true;
    adopt(json, true);
    if (pending.keys.size) await push();
    else setStatus('synced');
  }

  function start() {
    if (started) return Promise.resolve();
    started = true;
    unsub = store.subscribe((state, { keys, source }) => {
      const prev = seen; seen = syncedData(state);
      // Our own writes, and another tab's (that tab sends them), are not news.
      if (source === 'sync' || source === 'storage' || disabled) return;
      const changed = keys.filter(k => SYNCED_KEYS.includes(k) && !sameValue(prev[k], seen[k]));
      if (!changed.length) return;
      const prefKeys = changed.includes('prefs') ? diffKeys(prev.prefs, seen.prefs) : [];
      markDirty(changed, prefKeys, changed.every(k => k === 'tombs' || minorChange(k, prev[k], seen[k])));
    });
    return pull();
  }

  return {
    start,
    pull, push,
    status: () => status,
    /** Back online: fetch what changed elsewhere, then send what queued here. */
    online: () => (disabled ? Promise.resolve() : pull()),
    offline: () => { if (!disabled) setStatus('offline'); },
    /** Tab came back to the front: catch up if it has been a while. */
    visible: () => (!disabled && ready && now() - lastPullAt > 30000 ? pull() : Promise.resolve()),
    /** Tab hidden / closing: send what's queued now, throttle or not. */
    hidden: () => (pending.keys.size ? push({ keepalive: true }) : Promise.resolve()),
    syncNow: async () => { if (disabled) return; await pull(); },
    stop: () => { if (unsub) unsub(); unsub = null; disable('off'); },
  };
}

// ── The app's engine ──────────────────────────────────────────────────────────

let engine = null;
const watchers = new Set();
const OFF = Object.freeze({ state: 'off', at: 0, detail: '' });

/* A remote change landed under an open view. Re-render it only where it is
   safe — Home and My List, with no sheet or player open — by replaying the
   route (main.js renders on hashchange). Anything else picks it up on the
   next navigation. */
function refreshIfSafe(keys) {
  if (!keys.some(k => k === 'list' || k === 'continue')) return;
  const base = (String(location.hash || '').slice(1) || 'home').split('/')[0];
  if (base !== 'home' && base !== 'list') return;
  if (document.querySelector('.modal.open, .player.open')) return;
  window.dispatchEvent(new Event('hashchange'));
}

/** Start syncing (once, at boot, after the first route()). opts.onRemote(keys)
    replaces the default "re-render Home / My List" refresh. */
export function initSync(opts = {}) {
  if (engine) return engine;
  engine = createSync({
    store: appStore(),
    fetch: (url, init) => fetch(url, init),
    isOnline: () => navigator.onLine !== false,
    onRemote: opts.onRemote || refreshIfSafe,
    onStatus: (st) => { for (const fn of [...watchers]) { try { fn(st); } catch {} } },
  });
  window.addEventListener('online', () => engine.online());
  window.addEventListener('offline', () => engine.offline());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') engine.visible(); else engine.hidden();
  });
  window.addEventListener('pagehide', () => engine.hidden());
  engine.start();
  return engine;
}

/** { state, at, detail } — see createSync. 'off' until initSync runs. */
export const syncStatus = () => (engine ? engine.status() : OFF);
/** Watch status changes (Settings' indicator). Returns an unsubscribe. */
export function onSyncStatus(fn) { watchers.add(fn); return () => watchers.delete(fn); }
/** Pull + push now (Settings' "Sync now"). */
export const syncNow = () => (engine ? engine.syncNow() : Promise.resolve());
