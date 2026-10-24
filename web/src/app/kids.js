/* Wave 8 (W1): the Kids catalog gate at runtime.

   The pure rules are profilelock.js; this file runs them over the app: one
   certification store on the Worker's TMDB proxy (unfiltered, tmdbRaw) and the
   store's device-only `certs` key, the hook api() passes every TMDB answer
   through, and the checks the title sheet, the player and the My List / Home
   rows ask. On an Adults profile every function here is a no-op that answers
   "allowed" without a lookup. */

import { tmdbRaw, setTmdbGate } from './api.js';
import { getState, setState } from './state.js';
import { capOf, isKidsProfile, createCertStore, isListPath, rowKind, trustsCeiling, NOT_AVAILABLE } from './profilelock.js';
import { toast } from './ui/toast.js';

let certs = null, saveTimer = null;
function store() {
  if (certs) return certs;
  certs = createCertStore({
    tmdb: tmdbRaw,
    load: () => getState().certs,
    // One localStorage write per burst of lookups, not one per title.
    save: (map) => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { setState({ certs: map }); } catch (_) {} }, 800); },
  });
  return certs;
}

/** The active profile's cap ('adults' unless it is a Kids profile). */
export const currentCap = () => capOf(getState().profile);
export const kidsActive = () => isKidsProfile(getState().profile);

/** api()'s hook: a TMDB list answer thinned to what the cap verifiably allows
    (people dropped; a ceiling-filtered discover/movie trusted as it is). Any
    other answer passes untouched. */
export async function gateList(path, json) {
  const cap = currentCap();
  if (cap === 'adults' || !json || !Array.isArray(json.results) || !isListPath(path)) return json;
  const titles = json.results.filter(x => rowKind(path, x));
  if (trustsCeiling(path, cap)) return { ...json, results: titles };
  return { ...json, results: await store().filter(titles, cap, (x) => rowKind(path, x) === 'movie') };
}

/** Boot (main.js): every api() answer goes through gateList from now on. */
export function initKidsGate() { setTmdbGate(gateList); }

/** -> {verdict, cert} for a title on the active profile. */
export const titleCheck = (id, kind) => store().check(id, kind === 'movie', currentCap());
/** A certification the title sheet already fetched (appended to its detail call). */
export const seedCert = (id, kind, cert) => store().seed(id, kind === 'movie', cert);

/** My List / Continue Watching records ({id, kind}) the cap allows, in order. */
export async function visibleRecords(records) {
  const cap = currentCap();
  return cap === 'adults' ? records : store().filter(records, cap, (x) => x.kind === 'movie');
}

/** Synchronous: may play() go ahead now? True on Adults, or for a title the
    cache already allows; anything else asks gatePlay first. */
export function playAllowedNow(it, kind) {
  const cap = currentCap();
  return cap === 'adults' || store().now(it && it.id, kind === 'movie', cap) === 'allowed';
}
/** Look the title up; true when it may play, else say why not (fail closed). */
export async function gatePlay(it, kind) {
  const r = await titleCheck(it && it.id, kind);
  if (r.verdict === 'allowed') return true;
  toast(NOT_AVAILABLE, { id: 'kids-gate' });
  return false;
}
