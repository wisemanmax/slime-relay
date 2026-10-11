/* The ONE store for everything the SPA persists.

   Every read goes through getState() and every write through setState(patch).
   Nothing else in the app touches localStorage — keep it that way: server sync
   (sync.js) sits behind this same API, and it can only see writes that pass
   through here.

     getState()                -> frozen snapshot { list, continue, rdkey, installHint,
                                  prefs, reading, tombs, sync }
     setState(patch, meta?)    -> merges `patch`, persists each changed key, notifies
                                  subscribers. A value of null/undefined deletes the
                                  key (state falls back to its default).
                                  meta.source tags the change ('local' default; the
                                  sync layer passes 'sync' so it can skip its own echoes).
     subscribe(fn)             -> fn(state, { keys, source }) after every change,
                                  including changes made in ANOTHER TAB (source
                                  'storage'). Returns an unsubscribe function.

   Snapshots are deep-frozen: build new arrays/objects and setState them, never
   mutate what getState() returned (that would bypass persistence and sync, so
   it throws instead of failing silently).

   Storage keys are unchanged from the single-file app, so existing browsers
   keep their lists, progress and keys across the upgrade. `local: true` marks
   device-only keys sync must NOT upload (the RD token is promised to stay
   "only in this browser" in Settings).

   Sync bookkeeping happens HERE, centrally, so no writer has to know about it:
   on every write that isn't the sync layer's own (source 'sync'), each entry of
   an `items` key (list, continue, reading) whose content changed gets
   `updatedAt = Date.now()`, and each entry that disappeared gets a tombstone
   in `tombs` — that is how a removal on the laptop reaches the phone instead
   of being resurrected by it. Writers just setState / call the helpers. */

import { kindOf, titleOf } from './util.js';

export const SCHEMA = {
  // items: the value is a collection of separately-merged entries
  //   'array' — entries are objects identified by `${kind}:${id}`
  //   'map'   — a plain object; each own key is one entry (its value should be an object)
  // max: the size the sync merge keeps (newest first). The helpers cap the same way.
  list:        { storage: 'sw_list',         def: [], items: 'array', max: 60 },   // My List (newest first)
  continue:    { storage: 'sw_continue',     def: [], items: 'array', max: 24 },   // Continue Watching + resume positions
  rdkey:       { storage: 'sw_rdkey',        def: '', local: true },  // BYO Real-Debrid token
  installHint: { storage: 'sw_install_hint', def: '', local: true },  // 'dismissed' once the install hint is closed
  prefs:       { storage: 'sw_prefs',        def: {} },               // viewer prefs (PREF_DEFAULTS below), shallow-merged by sync
  reading:     { storage: 'sw_reading',      def: {}, items: 'map', max: 300 },    // manga/comic progress + saved titles keyed by source:id
  tombs:       { storage: 'sw_tombs',        def: {} },               // { list|continue|reading: { entryId: deletedAt } } — synced deletions
  sync:        { storage: 'sw_sync',         def: {}, local: true },  // sync.js bookkeeping: { rev, pending }
};

/** Keys sync uploads (everything not `local`). */
export const SYNCED_KEYS = Object.keys(SCHEMA).filter(k => !SCHEMA[k].local);

/** Tombstones live this long (a device offline for longer may resurrect a removal), and at most this many per key. */
export const TOMB_TTL_MS = 90 * 24 * 3600 * 1000;
export const TOMB_MAX = 400;

function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}
const fresh = (def) => deepFreeze(JSON.parse(JSON.stringify(def)));
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** A Storage-shaped in-memory fallback (private mode, blocked storage, node). */
export function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

// ── Entries of an `items` collection (shared with sync.js's merge) ─────────────

/** Identity of a list/continue record: `${kind}:${id}` (null when it has no id). */
export const itemId = (x) => (isObj(x) && x.id != null && x.id !== '') ? (x.kind || '') + ':' + x.id : null;

/** [id, entry] pairs of a collection value, in order. Array entries without an id are skipped. */
export function itemEntries(items, value) {
  if (items === 'array') return (Array.isArray(value) ? value : []).map(x => [itemId(x), x]).filter(e => e[0] != null);
  return isObj(value) ? Object.entries(value) : [];
}

/** When an entry last changed (0 = before sync existed, or not an object). */
export const stampOf = (x) => (isObj(x) && Number.isFinite(x.updatedAt)) ? x.updatedAt : 0;

const bodyOf = (x) => { if (!isObj(x)) return JSON.stringify(x); const { updatedAt, ...rest } = x; return JSON.stringify(rest); };

/** Stamp what a local write changed. Returns { value, removed:[ids], touched:[ids] }.
    Unchanged entries keep their old stamp (or lack of one — a legacy entry must
    not suddenly look newer than another device's removal of it). */
function stampItems(items, prevValue, nextValue, ts) {
  const prev = new Map(itemEntries(items, prevValue));
  const touched = [];
  const stamp = (id, x) => {
    if (id == null || !isObj(x)) return x;
    const old = prev.get(id);
    if (old !== undefined && bodyOf(old) === bodyOf(x)) {
      const keep = stampOf(old);
      if (stampOf(x) === keep) return x;
      if (keep) return { ...x, updatedAt: keep };
      const { updatedAt, ...rest } = x; return rest;
    }
    touched.push(id);
    return { ...x, updatedAt: ts };
  };
  let value, ids;
  if (items === 'array') {
    value = (Array.isArray(nextValue) ? nextValue : []).map(x => stamp(itemId(x), x));
    ids = new Set(value.map(itemId));
  } else {
    value = {};
    for (const [k, x] of Object.entries(isObj(nextValue) ? nextValue : {})) value[k] = stamp(k, x);
    ids = new Set(Object.keys(value));
  }
  const removed = [...prev.keys()].filter(id => !ids.has(id));
  return { value, removed, touched };
}

/** Drop tombstones past TOMB_TTL_MS and keep the newest TOMB_MAX per key. */
export function pruneTombs(tombs, now) {
  const out = {};
  for (const [k, t] of Object.entries(isObj(tombs) ? tombs : {})) {
    if (!isObj(t)) continue;
    const live = Object.entries(t).filter(([, at]) => Number.isFinite(at) && now - at < TOMB_TTL_MS)
      .sort((a, b) => b[1] - a[1]).slice(0, TOMB_MAX);
    if (live.length) out[k] = Object.fromEntries(live);
  }
  return out;
}

/** Build a store over any Storage-like object. Exported for unit checks; the
    app uses the singleton below. opts.now overrides the clock (tests). */
export function createStore(storage, schema = SCHEMA, opts = {}) {
  storage = storage || memoryStorage();
  const now = opts.now || (() => Date.now());
  const keys = Object.keys(schema);
  const subs = new Set();

  // Same semantics as the old load(k, d): missing, null or unparseable -> default.
  const read = (k) => {
    const spec = schema[k];
    try {
      const v = JSON.parse(storage.getItem(spec.storage));
      return v == null ? fresh(spec.def) : deepFreeze(v);
    } catch { return fresh(spec.def); }
  };

  let state = Object.freeze(Object.fromEntries(keys.map(k => [k, read(k)])));

  const emit = (changed, source) => {
    for (const fn of [...subs]) {
      try { fn(state, { keys: changed, source }); } catch (e) { console.error('state subscriber failed', e); }
    }
  };

  /* Stamp updatedAt on changed entries and tombstone removed ones (see the
     header). The sync layer's own writes (source 'sync') carry the server's
     stamps and deletions already, so they pass through untouched. */
  function stampPatch(patch, ts) {
    let tombs = null;
    for (const [k, v] of Object.entries(patch)) {
      const spec = schema[k];
      if (!spec.items) continue;
      const r = stampItems(spec.items, state[k], v == null ? spec.def : v, ts);
      if (v != null) patch[k] = r.value;
      if (!r.removed.length && !r.touched.length) continue;
      tombs = tombs || { ...(isObj(patch.tombs) ? patch.tombs : state.tombs) };
      const t = { ...(tombs[k] || {}) };
      for (const id of r.removed) t[id] = ts;
      for (const id of r.touched) delete t[id];   // re-added: its new stamp outranks the removal anyway
      tombs[k] = t;
    }
    if (tombs) patch.tombs = pruneTombs(tombs, ts);
  }

  function getState() { return state; }

  function setState(patch, meta) {
    const source = (meta && meta.source) || 'local';
    patch = { ...(patch || {}) };
    for (const k of Object.keys(patch)) {
      if (!schema[k]) throw new Error('setState: unknown key "' + k + '" (add it to SCHEMA in state.js)');
    }
    if (source !== 'sync' && schema.tombs) stampPatch(patch, now());
    const changed = [];
    const next = { ...state };
    for (const [k, v] of Object.entries(patch)) {
      const spec = schema[k];
      if (v === undefined || v === null) {
        try { storage.removeItem(spec.storage); } catch {}
        next[k] = fresh(spec.def);
      } else {
        // The snapshot is the JSON round-trip of what was stored — exactly what
        // the old read-from-localStorage-every-time code saw (undefined fields
        // dropped, Infinity -> null) — and never the caller's own object.
        const json = JSON.stringify(v);
        // A failed write (quota, private mode) keeps the value for this session.
        try { storage.setItem(spec.storage, json); } catch {}
        next[k] = deepFreeze(JSON.parse(json));
      }
      changed.push(k);
    }
    if (!changed.length) return state;
    state = Object.freeze(next);
    emit(changed, source);
    return state;
  }

  function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }

  /** Re-read keys from storage (another tab wrote them). null = all keys. */
  function reload(storageKey) {
    const changed = keys.filter(k => storageKey == null || schema[k].storage === storageKey);
    if (!changed.length) return;
    const next = { ...state };
    for (const k of changed) next[k] = read(k);
    state = Object.freeze(next);
    emit(changed, 'storage');
  }

  return { getState, setState, subscribe, reload };
}

// ── The app's singleton, created on first use (never at import time) ──────────
let store = null;
function app() {
  if (store) return store;
  let ls = null;
  try { ls = globalThis.localStorage || null; } catch {}
  store = createStore(ls);
  // Another tab changed a key: refresh the snapshot so reads stay current, as
  // they were when every read went straight to localStorage.
  try { globalThis.addEventListener('storage', (e) => { if (e.storageArea === ls) store.reload(e.key); }); } catch {}
  return store;
}
export const getState = () => app().getState();
export const setState = (patch, meta) => app().setState(patch, meta);
export const subscribe = (fn) => app().subscribe(fn);
/** The singleton as an object ({getState, setState, subscribe, reload}) — for sync.js. */
export const appStore = () => app();

// ── Domain helpers: named reads/writes over the store ─────────────────────────
// Each takes an optional `store` last, so the unit checks can run them against
// createStore(memoryStorage()); the app always uses the singleton.

export const getRdKey = (store = app()) => store.getState().rdkey;   // BYO Real-Debrid token, this browser only
export const setRdKey = (key, store = app()) => { store.setState({ rdkey: key }); };
export const clearRdKey = (store = app()) => { store.setState({ rdkey: null }); };

export const myList = (store = app()) => store.getState().list;
export const inList = (id, k, store = app()) => myList(store).some(x => x.id === id && x.kind === k);
export function toggleList(it, store = app()) {
  const k = kindOf(it), id = it.id;
  let l = myList(store);
  if (inList(id, k, store)) l = l.filter(x => !(x.id === id && x.kind === k));
  else l = [{ id, kind: k, title: titleOf(it), poster: it.poster_path, backdrop: it.backdrop_path }, ...l];
  store.setState({ list: l.slice(0, SCHEMA.list.max) });
}

export const continueList = (store = app()) => store.getState().continue;
export const continueRecord = (id, kind, store = app()) => continueList(store).find(x => x.id === id && x.kind === kind);
export function recordContinue(it, k, s, e, pos, store = app()) {
  const c = continueList(store).filter(x => !(x.id === it.id && x.kind === k));
  c.unshift({ id: it.id, kind: k, title: titleOf(it), poster: it.poster_path, backdrop: it.backdrop_path, s, e, pos: pos || 0, ts: Date.now() });
  store.setState({ continue: c.slice(0, SCHEMA.continue.max) });
}
/** Persisted resume position for the <video> path. */
export function savedPos(id, kind, s, e, store = app()) {
  const r = continueList(store).find(x => x.id === id && x.kind === kind && x.s === s && x.e === e);
  return (r && r.pos) || 0;
}
/** Remember where playback is for the title in `ctx` ({it, kind, s, e}). Only
    updates an existing Continue Watching record, never creates one. */
export function saveProgress(ctx, pos, dur, store = app()) {
  if (!ctx || !(pos > 0)) return;
  const c = continueList(store);
  const i = c.findIndex(x => x.id === ctx.it.id && x.kind === ctx.kind); if (i < 0) return;
  const rec = { ...c[i], pos: Math.floor(pos) };
  if (dur) rec.dur = Math.floor(dur);
  rec.s = ctx.s; rec.e = ctx.e; rec.ts = Date.now();
  store.setState({ continue: c.map((x, j) => (j === i ? rec : x)) });
}

// ── Viewer prefs (synced; shallow-merged across devices) ──────────────────────
/* One flat object; any module may add keys (keep values small JSON). Known keys:
     subLang     ISO 639-1 the player turns captions on in automatically when a
                 title starts; ABSENT = captions off by default. player/subtitles.js
                 sets it when the viewer picks a track; Settings' "Turn on
                 automatically" sets/clears it. No default on purpose.
     subLangs    preferred caption languages, best first (Settings). When subLang
                 is set, Settings keeps it equal to subLangs[0]. Default ['en'].
     subSize     caption size 'S' | 'M' | 'L'. Default 'M'.
     subOff      [title keys] where the viewer turned captions off (player).
     animeAudio  'sub' | 'dub'. Default 'dub' — player/anime.js audioPref() reads
                 anything but 'sub' as dub (a dub request falls back to the sub).
     askHistory  Ask may see My List + Continue Watching (sent to the model). Default false.
     readingOldestFirst   chapter-list order (views/reading*.js).
   getPrefs() fills in the defaults below; raw getState().prefs does not. To
   "reset" a pref, set it to its default rather than null: a deleted key can
   come back from a device that never saw the deletion. */
export const PREF_DEFAULTS = Object.freeze({
  subLangs: Object.freeze(['en']),
  subSize: 'M',
  animeAudio: 'dub',
  askHistory: false,
});

/** Prefs with the defaults filled in (frozen). */
export const getPrefs = (store = app()) => Object.freeze({ ...PREF_DEFAULTS, ...store.getState().prefs });
/** Shallow-merge `patch` into prefs (null deletes a key). */
export function setPrefs(patch, store = app()) {
  const next = { ...store.getState().prefs };
  for (const [k, v] of Object.entries(patch || {})) { if (v == null) delete next[k]; else next[k] = v; }
  store.setState({ prefs: next });
}

// ── Reading entries (objects keyed by `source:id`; views/reading*.js own the shape) ──
export const readingEntry = (key, store = app()) => store.getState().reading[key] || null;
/** Write one reading entry (replaces it). Stamped and synced by the store. */
export function putReading(key, entry, store = app()) {
  store.setState({ reading: { ...store.getState().reading, [key]: entry } });
}
export function removeReading(key, store = app()) {
  const next = { ...store.getState().reading }; delete next[key];
  store.setState({ reading: next });
}
