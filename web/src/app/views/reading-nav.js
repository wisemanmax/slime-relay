// Navigation state shared by the Read tab's views (kept apart so the hub, the
// series pages and the reader routes don't import each other in a circle).

import { go } from '../router.js';
import { readerHash } from './reading-ui.js';

/** `gen` bumps on every Read-tab render: async work started by an older
    render checks it and drops its result (the user has moved on). */
export const nav = { gen: 0, pending: null };
export const nextGen = () => ++nav.gen;
export const live = (gen) => gen === nav.gen;

/** Open the reader route from inside the app. `resume`: pick the spot from the
    title's progress record (a finished chapter moves on to the next). */
export function openReaderRoute(kind, source, id, chapterId, { page = 0, resume = false } = {}) {
  const hash = readerHash(kind, source, id, chapterId);
  nav.pending = { hash, page, resume, fromApp: true };
  go(hash);
}

/** What openReaderRoute left for this hash (once), or null for a deep link / reload. */
export function takePending(hash) {
  const p = nav.pending;
  nav.pending = null;
  return p && p.hash === hash ? p : null;
}

/** A tiny TTL cache for series answers, so Back from the reader is instant. */
const cache = new Map();
export function cached(key, ttlMs, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = load().catch((e) => { cache.delete(key); throw e; });
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  return value;
}
