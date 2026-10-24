// Wave 8 — W1's parity checks (roadmap 8.3; docs/WEB-PARITY-2026-10-24.md in the
// app repo), run by check.mjs. Three items:
//   1. Skip markers beyond anime: TheIntroDB parsing (markers.js), the per-kind
//      merge with AniSkip, the window -> button rule shared with AniSkip
//      (skip.js), and the Worker's cached /api/player/markers fallback against
//      a fake upstream.
//   2. Kids + Parent PIN: the maturity table, certification parsing, which TMDB
//      answers the gate thins, the certification store (fake TMDB + clock), the
//      gate api() runs on the real app store, PBKDF2 proofs cross-checked with
//      node:crypto, the lockout rule, and /api/profiles over a fake KV (Kids and
//      lock flags, the PIN routes, /select refusing a locked profile / a Kids
//      exit without the PIN, never echoing the verifier), the client
//      controller against that Worker, and the picker's new panels.
//   3. My List: "Pick one for me" (who gets it, what Ask may see).
// Returns the number of assertions; throws (node:assert) on the first failure.

import assert from 'node:assert/strict';
import { pbkdf2Sync, createHash } from 'node:crypto';
import {
  parseIntroDB, mergeMarkers, sanitizeIntroDB, introDBUrl, introDBKey, kindGroup, INTRODB_BASE,
} from '../src/app/player/markers.js';
import { parseAniSkip, activeSkip, plausible, skipTarget } from '../src/app/player/skip.js';
import { playerRoutes, MARKERS_TTL_MS } from '../src/worker/player.js';
import {
  isKidsProfile, capOf, levelForCertification, verdict, verdictForCert, movieCeiling, usCertification, certFromTMDB,
  blockedReason, isListPath, rowKind, trustsCeiling, kidsMovieParams, kidsShelves, kidsMovieRows, dedupeRows,
  hiddenForKids, KIDS_HIDDEN_ROUTES, createCertStore, certFresh, isValidPin, pinProof, pinVerifier, sameSecret,
  lockoutSeconds, countdown, afterFailure, lockedFor, needsPIN, needsPINToManage, newSalt, PIN_ITERATIONS, NOT_AVAILABLE,
} from '../src/app/profilelock.js';
import { profilesRoutes, PROFILES_KEY, PIN_KEY, PIN_FAILS_KEY } from '../src/worker/profiles.js';
import { createStore, memoryStorage, getState, setState } from '../src/app/state.js';
import { createProfiles, pickerHTML, localProfile } from '../src/app/profiles.js';
import { actionNames } from '../src/app/ui/actions.js';
import { api, setTmdbGate } from '../src/app/api.js';
import { gateList, visibleRecords, playAllowedNow, gatePlay, titleCheck, currentCap, kidsActive } from '../src/app/kids.js';
import { canPickFromList } from '../src/app/views/mylist.js';
import { PICK_FROM_LIST, listOnlyLibrary } from '../src/app/views/search.js';

const jsonRes = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const DAY = 86400000;

function fakeKV(seed = {}) {
  const m = new Map(Object.entries(seed).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return {
    m,
    async get(k, type) { const v = m.has(k) ? m.get(k) : null; return v == null ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, String(v)); },
    async delete(k) { m.delete(k); },
    json(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; },
  };
}

export async function runParityChecks() {
  let n = 0;
  const eq = (a, b, m) => { assert.deepEqual(a, b, m); n++; };
  const ok = (v, m) => { assert.ok(v, m); n++; };
  const realFetch = globalThis.fetch;

  // ── 1. TheIntroDB markers ────────────────────────────────────────────────────
  {
    const show = { tmdb_id: 1396, type: 'tv', season: 1, episode: 1,
      intro: [{ start_ms: 228664, end_ms: 246143 }], recap: [{ start_ms: null, end_ms: 42000 }],
      credits: [{ start_ms: 3431000, end_ms: null }], preview: [{ start_ms: 3500000, end_ms: 3520000 }] };
    const segs = parseIntroDB(show, { tmdb: 1396, isMovie: false });
    eq(segs.map(s => [s.kind, s.start, s.end, s.label]), [
      ['recap', 0, 42, 'Skip recap'], ['intro', 228.664, 246.143, 'Skip intro'],
      ['credits', 3431, Infinity, 'Skip credits'], ['preview', 3500, 3520, 'Skip preview']],
    'intro / recap / credits / preview, sorted; a null start is the top, a null end runs to the end of the file');
    ok(segs.find(s => s.kind === 'credits').endsPlayback === true && !segs.find(s => s.kind === 'intro').endsPlayback, 'only the open-ended window finishes the file');
    const film = { tmdb_id: 1726, type: 'movie', credits: [{ start_ms: 7039000, end_ms: 7512000 }, { start_ms: 7546000, end_ms: 7561000 }] };
    eq(parseIntroDB(film, { tmdb: 1726, isMovie: true }).map(s => [s.kind, s.start, s.end]), [['credits', 7039, 7512], ['credits', 7546, 7561]], 'a film (no season): two credit windows around a scene');
    eq(parseIntroDB({ error: 'media not found' }, { tmdb: 1, isMovie: true }), [], '404 "media not found" -> nothing');
    eq(parseIntroDB({ intro: [{ start_ms: 10000, end_ms: null }] }), [], 'an intro "to the end of the file" is a bad submission, not a window');
    for (const junk of [null, undefined, 'x', 42, [], { intro: 'x' }, { intro: [null, 7, { start_ms: 'a', end_ms: 5 }, { start_ms: 5000, end_ms: 4000 }, { start_ms: -1, end_ms: 500 }, { start_ms: 1000, end_ms: 'z' }, { start_ms: NaN, end_ms: 9 }] }]) {
      eq(parseIntroDB(junk), [], 'junk -> nothing: ' + JSON.stringify(junk));
    }
    eq(parseIntroDB(show, { tmdb: 1399, isMovie: false }), [], 'an answer for another title is ignored');
    eq(parseIntroDB(film, { tmdb: 1726, isMovie: false }), [], 'an answer of the other media type is ignored');
    eq(parseIntroDB({ intro: Array.from({ length: 14 }, (_, i) => ({ start_ms: i * 1000, end_ms: i * 1000 + 500 })) }).length, 10, 'at most 10 windows a kind');
    eq([introDBUrl({ it: { id: 1726 }, kind: 'movie' }), introDBUrl({ it: { id: 1396 }, kind: 'tv', s: 2, e: 3 }), introDBUrl({ it: { id: 0 }, kind: 'movie' }), introDBUrl({ it: { id: 5 }, kind: 'tv', s: 1 }), introDBUrl(null)],
      [INTRODB_BASE + '?tmdb_id=1726', INTRODB_BASE + '?tmdb_id=1396&season=2&episode=3', null, null, null], 'lookup URL: a film by id, an episode by id + season + episode');
    eq([introDBKey({ it: { id: 7 }, kind: 'movie' }), introDBKey({ it: { id: 7 }, kind: 'tv', s: 0, e: 4 })], ['m7', 't7:0:4'], 'one answer per film / episode (the apps\' cache key)');

    // Merge per kind: AniSkip wins what it answered; credits == AniSkip's outro.
    const ani = parseAniSkip({ found: true, results: [
      { skipType: 'op', episodeLength: 1420, interval: { startTime: 60, endTime: 150 } },
      { skipType: 'ed', episodeLength: 1420, interval: { startTime: 1300, endTime: 1390 } }] });
    const tidb = parseIntroDB({ intro: [{ start_ms: 62000, end_ms: 151000 }], recap: [{ start_ms: 0, end_ms: 30000 }],
      credits: [{ start_ms: 1302000, end_ms: null }], preview: [{ start_ms: 1395000, end_ms: 1415000 }] });
    eq(mergeMarkers(ani, tidb).map(s => s.kind + '@' + s.start), ['recap@0', 'intro@60', 'outro@1300', 'preview@1395'], 'AniSkip\'s op/ed kept; TheIntroDB fills recap + preview (its intro and credits are the same stretches)');
    eq(mergeMarkers([], tidb), tidb, 'no anime markers: TheIntroDB\'s as they are');
    eq([kindGroup('credits'), kindGroup('outro'), kindGroup('preview')], ['outro', 'outro', 'preview'], 'credits count as the outro');

    // The window -> button rule (shared with AniSkip's).
    const merged = mergeMarkers(ani, tidb);
    eq([activeSkip(merged, 10, 1420)?.label, activeSkip(merged, 29.5, 1420), activeSkip(merged, 100, 1420)?.label, activeSkip(merged, 1400, 1420)?.label],
      ['Skip recap', null, 'Skip intro', 'Skip preview'], 'recap, then nothing in its last second, the intro, the preview');
    const open = parseIntroDB({ credits: [{ start_ms: 1300000, end_ms: null }] });
    eq([activeSkip(open, 1350, 1420)?.label, activeSkip(open, 1419.5, 1420), activeSkip(open, 1350, 0)?.label], ['Skip credits', null, 'Skip credits'], 'open-ended credits: up until the last second of the file (any time while the length is unknown)');
    eq([plausible({ kind: 'credits', start: 300 }, 1420), plausible({ kind: 'preview', start: 1000 }, 1420), plausible({ kind: 'recap', start: 800 }, 1420), plausible({ kind: 'recap', start: 30 }, 1420)],
      [false, true, false, true], 'credits / preview only in the last 40 %, a recap only in the first half');
    eq([skipTarget(merged[1], 1420, false), skipTarget(open[0], 1420, false), skipTarget(open[0], 1420, true), skipTarget(open[0], 0, false), skipTarget(null, 1, false)],
      [150, 1419.5, null, null, null], 'a skip lands at the window\'s end; open-ended credits just short of the end (Up Next takes over) — never on a converter session or an unknown length');

    const clean = sanitizeIntroDB({ tmdb_id: 5, type: 'tv', season: 1, episode: 2, extra: '<script>', intro: [{ start_ms: 1000, end_ms: 2000, by: 'x' }, { start_ms: 'a', end_ms: 3 }],
      credits: [{ start_ms: 9000, end_ms: null }, { start_ms: 9000, end_ms: -4 }], preview: 'x' });
    eq(clean, { tmdb_id: 5, type: 'tv', season: 1, episode: 2, intro: [{ start_ms: 1000, end_ms: 2000 }], credits: [{ start_ms: 9000, end_ms: null }] },
      'the fallback passes only what the page reads: numbers or null, junk rows dropped (never turned into open-ended windows)');
    eq([sanitizeIntroDB(null), sanitizeIntroDB([])], [{}, {}], 'nothing from nothing');
  }

  // ── 1b. /api/player/markers (fake upstream) ─────────────────────────────────
  try {
    const calls = [];
    let upstream = () => jsonRes({ tmdb_id: 1396, type: 'tv', intro: [{ start_ms: 228664, end_ms: 246143 }], secret: 'x' });
    globalThis.fetch = async (u, init = {}) => { calls.push(String(u)); return upstream(String(u), init); };
    const call = (path, init) => playerRoutes(new Request('https://w' + path, init), {}, new URL('https://w' + path));
    let r = await call('/api/player/markers?tmdb=1396&kind=tv&s=1&e=1');
    eq([r.status, r.headers.get('cache-control'), await r.json()], [200, 'private, max-age=21600', { tmdb_id: 1396, type: 'tv', intro: [{ start_ms: 228664, end_ms: 246143 }] }], 'fallback answers TheIntroDB\'s windows, cleaned, cacheable for 6 h');
    eq(calls, [INTRODB_BASE + '?tmdb_id=1396&season=1&episode=1'], 'asks TheIntroDB by TMDB id + season + episode (no extractor, no token)');
    r = await call('/api/player/markers?tmdb=1396&kind=tv&s=1&e=1');
    eq([r.status, calls.length], [200, 1], 'the same episode again: answered from the isolate\'s cache');
    ok(MARKERS_TTL_MS === 6 * 3600 * 1000, 'kept 6 h');
    upstream = () => jsonRes({ error: 'media not found' }, 404);
    r = await call('/api/player/markers?tmdb=1726&kind=movie');
    eq([r.status, await r.json(), calls.at(-1)], [200, {}, INTRODB_BASE + '?tmdb_id=1726'], 'a film asks without season; "not found" is an answer ({}: no button)');
    await call('/api/player/markers?tmdb=1726&kind=movie');
    eq(calls.length, 2, '...and is kept like one');
    upstream = () => new Response('busy', { status: 503 });
    r = await call('/api/player/markers?tmdb=99&kind=movie');
    eq([r.status, (await r.json()).error], [502, 'introdb-503'], 'an upstream error -> 502 (the page shows no button)');
    upstream = () => jsonRes({ tmdb_id: 99, type: 'movie', credits: [{ start_ms: 1, end_ms: 2 }] });
    r = await call('/api/player/markers?tmdb=99&kind=movie');
    eq([r.status, calls.length], [200, 4], 'a failure is never cached: asked again');
    upstream = () => { throw new TypeError('down'); };
    eq((await call('/api/player/markers?tmdb=98&kind=movie')).status, 504, 'unreachable -> 504');
    upstream = () => new Response('<html>', { status: 200 });
    eq([(r = await call('/api/player/markers?tmdb=97&kind=movie')).status, (await r.json()).error], [502, 'introdb-bad-answer'], 'a body that isn\'t JSON -> 502');
    const before = calls.length;
    eq([(await call('/api/player/markers?tmdb=x&kind=movie')).status, (await call('/api/player/markers?tmdb=5&kind=tv&s=1')).status, (await call('/api/player/markers?tmdb=5&kind=movie', { method: 'POST' })).status, calls.length],
      [400, 400, 405, before], 'bad params / methods never reach upstream');
    globalThis.fetch = realFetch;
    const { default: worker } = await import('../src/worker.js');
    r = await worker.fetch(new Request('https://watch.example/api/player/markers?tmdb=1&kind=movie', { redirect: 'manual' }), { SITE_PASSWORD: 'pw', SESSION_SECRET: 's' });
    eq(r.status, 302, '/api/player/markers sits behind the password gate');
  } finally { globalThis.fetch = realFetch; }

  // ── 2. Kids: the maturity table, certifications, which answers are thinned ──
  {
    eq(['TV-Y', 'g', 'tv y7', 'TV_Y7_FV', 'TV-G', 'PG', 'pg-13', 'TV 14', 'TV-PG', 'TV-MA', 'R', 'NC-17', 'NR', '', 'Unrated', '18+', null, 7].map(levelForCertification),
      ['littleKids', 'littleKids', 'olderKids', 'olderKids', 'olderKids', 'olderKids', 'teens', 'teens', 'teens', 'adults', 'adults', 'adults', null, null, null, null, null, null],
      'US certifications -> tiers (case, spaces and underscores forgiven; NR / unrated / foreign -> none)');
    eq([['G', 'olderKids'], ['PG', 'olderKids'], ['PG-13', 'olderKids'], [null, 'olderKids'], ['TV-MA', 'adults'], [null, 'adults'], ['TV-Y7', 'littleKids'], ['TV-14', 'teens']].map(([c, cap]) => verdictForCert(c, cap)),
      ['allowed', 'allowed', 'blocked', 'unknown', 'allowed', 'allowed', 'blocked', 'allowed'], 'verdicts: at or under the cap; no rating = unknown below Adults; Adults allows everything');
    eq([verdict('teens', 'nonsense'), verdict('bogus', 'teens')], ['blocked', 'unknown'], 'an unknown cap allows nothing above it; an unknown level is unknown');
    eq([capOf(null), capOf({ kids: true }), capOf({ kids: true, maturity: 'littleKids' }), capOf({ kids: true, maturity: 'adults' }), capOf({ kids: 'yes', maturity: 'teens' }), capOf({ maturity: 'littleKids' })],
      ['adults', 'olderKids', 'littleKids', 'olderKids', 'adults', 'adults'], 'cap: Older Kids by default; a Kids record can\'t claim Adults; only kids === true counts');
    eq([isKidsProfile(null), isKidsProfile({ kids: true }), isKidsProfile({ kids: 1 })], [false, true, false], 'isKidsProfile');
    eq([movieCeiling('littleKids'), movieCeiling('olderKids'), movieCeiling('teens'), movieCeiling('adults')], ['G', 'PG', 'PG-13', null], 'discover/movie ceilings');
    eq(usCertification([{ country: 'GB', certification: '12A' }, { country: 'US', certification: 'NR' }, { country: 'US', certification: ' PG ' }]), 'PG', 'a known US rating wins over NR');
    eq([usCertification([{ country: 'US', certification: 'NR' }, { country: 'US', certification: '' }]), usCertification([{ country: 'FR', certification: 'U' }])], ['NR', null], '...else the first non-empty US value, else none');
    const rd = { id: 9, results: [{ iso_3166_1: 'US', release_dates: [{ certification: '' }, { certification: 'PG-13' }] }, { iso_3166_1: 'DE', release_dates: [{ certification: '12' }] }] };
    const cr = { results: [{ iso_3166_1: 'US', rating: 'TV-Y7' }, { iso_3166_1: 'BR', rating: 'L' }] };
    eq([certFromTMDB(rd, true), certFromTMDB({ id: 9, title: 'x', release_dates: rd }, true), certFromTMDB(cr, false), certFromTMDB({ name: 's', content_ratings: cr }, false), certFromTMDB({}, true), certFromTMDB(null, false)],
      ['PG-13', 'PG-13', 'TV-Y7', 'TV-Y7', null, null], 'certification from release_dates / content_ratings, standalone or appended to a detail call');
    eq([blockedReason('TV-MA'), blockedReason('NR'), blockedReason(null)], ['Rated TV-MA', 'This title has no rating', 'This title has no rating'], 'the blocked sheet\'s reason');
    eq(['trending/all/week', 'discover/tv?with_genres=16', 'search/multi?query=x', 'movie/popular', 'tv/top_rated?page=2', 'movie/550/similar', 'tv/1/recommendations',
      'movie/550', 'movie/550/release_dates', 'tv/1/season/2', 'tv/1/content_ratings', 'movie/550/videos', 'person/3/combined_credits'].map(isListPath),
      [true, true, true, true, true, true, true, false, false, false, false, false, false], 'the gate thins list answers only (a detail is refused by the sheet instead)');
    eq([rowKind('trending/all/week', { id: 1, media_type: 'tv' }), rowKind('search/multi', { id: 2, media_type: 'person' }), rowKind('discover/tv?x', { id: 3 }), rowKind('movie/popular', { id: 4 }), rowKind('trending/all/day', { id: 5 }), rowKind('movie/popular', { id: 0 })],
      ['tv', null, 'tv', 'movie', null, null], 'row kinds: media_type, else the path; people and id-less rows are not titles');
    const pg = 'discover/movie?certification_country=US&certification.lte=PG&with_genres=16';
    eq([trustsCeiling(pg, 'olderKids'), trustsCeiling(pg, 'teens'), trustsCeiling(pg, 'littleKids'), trustsCeiling('discover/movie?certification.lte=PG', 'olderKids'),
      trustsCeiling('discover/tv?certification_country=US&certification.lte=PG', 'olderKids'), trustsCeiling(pg, 'adults')],
      [true, true, false, false, false, false], 'a ceiling-filtered discover/movie is trusted only when its ceiling fits the cap (TV has no such filter)');
    eq([kidsMovieParams('adults'), kidsMovieParams('littleKids')], [{}, { include_adult: 'false', certification_country: 'US', 'certification.lte': 'G' }], 'browse views add the ceiling on Kids only');
    const shelves = kidsShelves('olderKids');
    eq(shelves.map(s => s.label), ['Top Picks for Kids', "Kids' Shows", 'Family Movies', 'Animated Movies', 'Cartoons', 'Family Shows', 'Disney+ for Kids'], 'the Kids line-up (TMDBService+Kids)');
    ok(shelves.every(s => (s.kind === 'movie') === trustsCeiling(s.path, 'olderKids')), 'every film row is ceiling-filtered (free); every show row is checked per title');
    ok(kidsShelves('littleKids').filter(s => s.kind === 'movie').every(s => s.path.includes('certification.lte=G')) && kidsShelves('adults').length === 0, 'Little Kids: G; Adults: no Kids line-up');
    ok(kidsMovieRows('teens').length === 4 && kidsMovieRows('teens').every(r => trustsCeiling(r.path, 'teens')), 'the Movies pill on Kids: ceiling-filtered rows only');
    eq(dedupeRows([{ label: 'a', items: [{ id: 1, media_type: 'movie' }, { id: 2, media_type: 'tv' }] }, { label: 'b', items: [{ id: 1, media_type: 'movie' }, { id: 1, media_type: 'tv' }] }]).map(r => r.items.map(x => x.media_type + x.id)),
      [['movie1', 'tv2'], ['tv1']], 'a title shows once, in its first row');
    eq([KIDS_HIDDEN_ROUTES, hiddenForKids('live', true), hiddenForKids('read', true), hiddenForKids('party', true), hiddenForKids('list', true), hiddenForKids('live', false)],
      [['live', 'read', 'party'], true, true, true, false, false], 'Kids never land on Live sports, Reading or a Watch Party');
  }

  // ── 2b. The certification store (fake TMDB + clock) ──────────────────────────
  {
    let now = Date.UTC(2026, 9, 24), asked = [], saved = null, active = 0, peak = 0;
    const certs = { 'movie/1': 'G', 'movie/2': 'R', 'tv/3': 'TV-Y7', 'tv/4': null, 'tv/5': 'fail' };
    const tmdb = async (path) => {
      asked.push(path); active++; peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 2)); active--;
      const key = path.replace(/\/(release_dates|content_ratings)$/, '');
      const c = certs[key];
      if (c === 'fail' || c === undefined) return null;
      return path.endsWith('release_dates') ? { results: c ? [{ iso_3166_1: 'US', release_dates: [{ certification: c }] }] : [] } : { results: c ? [{ iso_3166_1: 'US', rating: c }] : [] };
    };
    const store = createCertStore({ tmdb, load: () => ({ 'movie-9': { c: 'PG', t: now - 89 * DAY } }), save: (m) => { saved = m; }, now: () => now, maxInFlight: 2 });
    const items = [{ id: 1, k: 'movie' }, { id: 2, k: 'movie' }, { id: 3, k: 'tv' }, { id: 4, k: 'tv' }, { id: 5, k: 'tv' }, { id: 9, k: 'movie' }, { id: 1, k: 'movie' }];
    const kept = await store.filter(items, 'olderKids', (x) => x.k === 'movie');
    eq(kept.map(x => x.k + x.id), ['movie1', 'tv3', 'movie9', 'movie1'], 'G, TV-Y7 and a cached PG stay; R, an unrated show and a failed lookup go (fail closed)');
    eq(asked.sort(), ['movie/1/release_dates', 'movie/2/release_dates', 'tv/3/content_ratings', 'tv/4/content_ratings', 'tv/5/content_ratings'], 'one lookup per title (the duplicate and the cached one asked nothing)');
    ok(peak <= 2, 'never more than maxInFlight lookups at once (peak ' + peak + ')');
    ok(saved && saved['movie-1'].c === 'G' && saved['tv-4'].c === null && !('tv-5' in saved), 'answers persist (incl. "no US rating"); a failed lookup is not kept');
    eq([store.now(1, true, 'olderKids'), store.now(2, true, 'olderKids'), store.now(77, true, 'olderKids'), store.now(77, true, 'adults')], ['allowed', 'blocked', null, 'allowed'], 'cache-only verdicts (null = never looked up)');
    asked = [];
    await store.filter(items, 'olderKids', (x) => x.k === 'movie');
    eq(asked, ['tv/5/content_ratings'], 'a second pass asks only what failed before');
    now += 8 * DAY; asked = [];
    await store.filter(items, 'olderKids', (x) => x.k === 'movie');
    eq(asked.sort(), ['movie/9/release_dates', 'tv/4/content_ratings', 'tv/5/content_ratings'], 'after a week: "no rating" asked again (it often appears with a US release); known ratings kept 90 days (the seeded PG was 89 days old)');
    ok(certFresh('PG', 0, 89 * DAY) && !certFresh('PG', 0, 91 * DAY) && certFresh(null, 0, 6 * DAY) && !certFresh(null, 0, 8 * DAY), '90 days known, 7 days unknown');
    asked = [];
    eq((await store.filter(items, 'adults', () => true)).length, items.length, 'Adults: everything, nothing asked');
    store.seed(40, true, 'TV-MA');
    eq([(await store.check(40, true, 'teens')).verdict, (await store.check(40, true, 'teens')).cert, asked], ['blocked', 'TV-MA', []], 'a seeded certification (the sheet\'s appended answer) needs no lookup');
    const capped = createCertStore({ tmdb, now: () => now, max: 3 });
    for (const id of [1, 2, 3]) await capped.lookup(id, id < 3);
    now += 1; await capped.lookup(4, false);
    ok(capped.size() === 3, 'the cache is bounded (oldest dropped)');
  }

  // ── 2c. The gate api() runs, on the app's real store ─────────────────────────
  const prevProfile = getState().profile, prevCerts = getState().certs;
  try {
    const asked = [];
    const answers = {
      '/api/tmdb/trending/all/week': { results: [{ id: 101, media_type: 'movie', title: 'G film' }, { id: 102, media_type: 'movie', title: 'R film' }, { id: 103, media_type: 'tv', name: 'TV-Y7 show' },
        { id: 104, media_type: 'tv', name: 'Unrated show' }, { id: 105, media_type: 'person', name: 'An actor' }] },
      '/api/tmdb/movie/101/release_dates': { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'G' }] }] },
      '/api/tmdb/movie/102/release_dates': { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'R' }] }] },
      '/api/tmdb/tv/103/content_ratings': { results: [{ iso_3166_1: 'US', rating: 'TV-Y7' }] },
      '/api/tmdb/tv/104/content_ratings': { results: [] },
      '/api/tmdb/movie/550': { id: 550, title: 'Fight Club' },
    };
    globalThis.fetch = async (u) => {
      const url = String(u); asked.push(url);
      if (url.startsWith('/api/tmdb/discover/movie?')) return jsonRes({ results: [{ id: 201, title: 'x' }, { id: 202, title: 'y' }] });
      return url in answers ? jsonRes(answers[url]) : jsonRes({}, 404);
    };
    setTmdbGate(gateList);
    setState({ profile: { id: 'adult-aaaaa', name: 'Ann', color: '#35C759' } }, { source: 'sync' });
    eq([currentCap(), kidsActive(), (await api('trending/all/week')).results.length, asked.filter(u => /release_dates|content_ratings/.test(u)).length],
      ['adults', false, 5, 0], 'an Adults profile: the answer as it came, no lookups');
    setState({ profile: { id: 'kid-bbbbb', name: 'Kid', color: '#FF9800', kids: true } }, { source: 'sync' });
    eq((await api('trending/all/week')).results.map(x => x.id), [101, 103], 'a Kids profile (Older Kids): G film + TV-Y7 show; R, unrated and the person are gone');
    asked.length = 0;
    eq([(await api('discover/movie?certification_country=US&certification.lte=PG&with_genres=16')).results.length, asked.length], [2, 1], 'a ceiling-filtered discover/movie is trusted: no per-title lookups');
    eq((await api('movie/550')).title, 'Fight Club', 'a detail passes untouched (the sheet refuses it instead)');
    eq((await visibleRecords([{ id: 101, kind: 'movie' }, { id: 102, kind: 'movie' }, { id: 103, kind: 'tv' }])).map(x => x.id), [101, 103], 'My List / Continue Watching records thinned the same way');
    eq([playAllowedNow({ id: 101 }, 'movie'), playAllowedNow({ id: 102 }, 'movie'), playAllowedNow({ id: 999 }, 'movie'), await gatePlay({ id: 101 }, 'movie')], [true, false, false, true],
      'play(): allowed straight away from the cache; anything else is looked up first');
    eq([(await titleCheck(102, 'movie')).verdict, (await titleCheck(104, 'tv')).verdict], ['blocked', 'unknown'], 'the sheet\'s check: blocked, or no rating');
    const docDesc = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: { getElementById: () => null } });
    try { eq(await gatePlay({ id: 102 }, 'movie'), false, 'a blocked title never plays'); }
    finally { if (docDesc) Object.defineProperty(globalThis, 'document', docDesc); else delete globalThis.document; }
    eq(NOT_AVAILABLE, 'Not available on this profile', 'the apps\' wording');
  } finally {
    setTmdbGate(null);
    globalThis.fetch = realFetch;
    setState({ profile: prevProfile, certs: prevCerts }, { source: 'sync' });
  }

  // ── 2d. The Parent PIN: proofs, lockout, the rules ───────────────────────────
  const SALT = '00112233445566778899aabbccddeeff';
  const P1234 = await pinProof('1234', SALT);
  {
    eq(['1234', '123456', '0000', '123', '1234567', '12a4', ' 1234', 1234, null].map(isValidPin), [true, true, true, false, false, false, false, false, false], 'a PIN is 4–6 digits');
    eq(P1234, pbkdf2Sync('1234', Buffer.from(SALT, 'hex'), PIN_ITERATIONS, 32, 'sha256').toString('hex'), 'the proof is PBKDF2-SHA256(pin, salt, 100,000) — WebCrypto matches node:crypto');
    ok(PIN_ITERATIONS === 100000, '100,000 iterations: the Workers ceiling');
    ok(P1234 !== await pinProof('1235', SALT) && P1234 !== await pinProof('1234', 'ffeeddccbbaa99887766554433221100'), 'another PIN, or another salt, gives another proof');
    eq(await pinVerifier(P1234), createHash('sha256').update(Buffer.from(P1234, 'hex')).digest('hex'), 'the stored verifier is SHA-256 of the proof\'s bytes');
    ok(/^[0-9a-f]{32}$/.test(newSalt()) && newSalt() !== newSalt(), 'salts: 16 random bytes');
    ok(sameSecret('abc', 'abc') && !sameSecret('abc', 'abd') && !sameSecret('abc', 'abcd') && !sameSecret('', 'a'), 'constant-time comparison');
    eq(Array.from({ length: 11 }, (_, i) => lockoutSeconds(i)), [0, 0, 0, 0, 30, 60, 120, 240, 480, 900, 900], 'lockout: three free misses, then 30 s doubling, capped at 15 min');
    eq([countdown(27), countdown(90), countdown(0.2), countdown(900), countdown(-3)], ['0:27', '1:30', '0:01', '15:00', '0:00'], 'the countdown');
    const t0 = 1e12;
    let rec = null;
    for (let i = 0; i < 4; i++) rec = afterFailure(rec, t0);
    eq([rec.n, lockedFor(rec, t0), lockedFor(rec, t0 + 30000), lockedFor(null, t0)], [4, 30, 0, 0], 'four misses: 30 s to wait, then free to try');
    const kid = { id: 'k', kids: true }, adult = { id: 'a', kids: false };
    eq([
      needsPIN({ current: kid, target: { id: 'a' }, hasPIN: true }), needsPIN({ current: kid, target: { id: 'k' }, hasPIN: true }),
      needsPIN({ current: adult, target: { id: 'b' }, hasPIN: true }), needsPIN({ current: adult, target: { id: 'a', locked: true }, hasPIN: true }),
      needsPIN({ current: null, target: { id: 'b' }, hasPIN: true }), needsPIN({ current: null, target: { id: 'b', locked: true }, hasPIN: true }),
      needsPIN({ current: kid, target: { id: 'a', locked: true }, hasPIN: false }), needsPINToManage({ hasPIN: true }), needsPINToManage({ hasPIN: false }),
    ], [true, false, false, true, false, true, false, true, false],
    'PIN asked: leaving Kids, opening a locked profile (even the active one); never without a PIN; every change once one exists');
  }

  // ── 2e. /api/profiles with Kids, locks and the PIN (fake KV) ────────────────
  {
    const P = (env, method, path, { body, cookie, pin } = {}) => {
      const h = {};
      if (cookie) h.cookie = 'sw_profile=' + cookie;
      if (pin) h['x-sw-pin'] = pin;
      if (body !== undefined) h['content-type'] = 'application/json';
      const req = new Request('https://watch.example' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
      return profilesRoutes(req, env, new URL(req.url));
    };
    const seen = [];   // every body the routes answered, to check none carries the verifier
    const J = async (r) => { const t = await r.text(); seen.push(t); return JSON.parse(t); };
    const env = { STATE: fakeKV({ [PROFILES_KEY]: { profiles: [{ id: 'ann-aaaaa', name: 'Ann', color: '#35C759', createdAt: 1, lastUsedAt: 0 }] } }) };
    let r = await P(env, 'GET', '/api/profiles');
    let j = await J(r);
    eq([r.status, j.profiles[0], 'pin' in j], [200, { id: 'ann-aaaaa', name: 'Ann', color: '#35C759', createdAt: 1, lastUsedAt: 0 }, false], 'an old record (no Kids / lock fields) still reads; no PIN, no `pin` key');
    eq(capOf(j.profiles[0]), 'adults', '...as an ordinary, unlocked profile');
    r = await P(env, 'POST', '/api/profiles', { body: { name: 'Kid', kids: true, maturity: 'littleKids' } });
    j = await J(r);
    const kidId = j.profile.id;
    eq([r.status, j.profile.kids, j.profile.maturity, 'locked' in j.profile], [201, true, 'littleKids', false], 'a Kids profile can be made with its level (no PIN set yet: no PIN asked)');
    eq((await P(env, 'POST', '/api/profiles', { body: { name: 'Odd', kids: true, maturity: 'adults' } })).status, 400, 'a Kids level must be a Kids level');
    r = await P(env, 'PATCH', '/api/profiles/ann-aaaaa', { body: { locked: true } });
    eq([r.status, (await J(r)).error], [409, 'no-pin'], 'locking needs a PIN to exist');
    eq((await P(env, 'PATCH', '/api/profiles/ann-aaaaa', { body: { kids: 'yes' } })).status, 400, 'flags are booleans');
    eq((await P(env, 'PATCH', '/api/profiles/nobody-00000', { body: { kids: true } })).status, 404, 'PATCH an unknown id -> 404');
    for (const [body, why] of [[{ salt: 'xx', newProof: P1234, iterations: PIN_ITERATIONS }, 'bad salt'], [{ salt: SALT, newProof: '1234', iterations: PIN_ITERATIONS }, 'the digits instead of a proof'], [{ salt: SALT, newProof: P1234, iterations: 1000 }, 'another iteration count']]) {
      r = await P(env, 'POST', '/api/profiles/pin', { body });
      eq([r.status, (await J(r)).error], [400, 'bad-pin'], 'set PIN refused: ' + why);
    }
    r = await P(env, 'POST', '/api/profiles/pin', { body: { salt: SALT, newProof: P1234, iterations: PIN_ITERATIONS } });
    j = await J(r);
    const stored = env.STATE.json(PIN_KEY);
    eq([r.status, j.pin], [200, { set: true, salt: SALT, iterations: PIN_ITERATIONS }], 'set PIN -> the public part only');
    eq([stored.salt, stored.verifier, Object.keys(stored).sort()], [SALT, await pinVerifier(P1234), ['iterations', 'salt', 'updatedAt', 'v', 'verifier']], 'KV keeps salt + SHA-256(proof): never the digits, never the proof');
    j = await J(await P(env, 'GET', '/api/profiles'));
    eq(j.pin, { set: true, salt: SALT, iterations: PIN_ITERATIONS }, 'GET says a PIN is set and how to derive a proof');
    r = await P(env, 'POST', '/api/profiles', { body: { name: 'Bob' } });
    eq([r.status, (await J(r)).error], [403, 'pin-required'], 'once a PIN exists, adding a name asks for it');
    r = await P(env, 'POST', '/api/profiles', { body: { name: 'Bob' }, pin: P1234 });
    eq(r.status, 201, '...and goes through with the proof');
    r = await P(env, 'PATCH', '/api/profiles/ann-aaaaa', { body: { locked: true, pinProof: P1234 } });
    j = await J(r);
    eq([r.status, j.profile.locked], [200, true], 'lock Ann (the proof in the body)');

    // /select: a locked profile.
    r = await P(env, 'POST', '/api/profiles/select', { body: { id: 'ann-aaaaa' } });
    eq([r.status, (await J(r)).error, r.headers.get('set-cookie')], [403, 'pin-required', null], 'a locked profile without the PIN: refused, no cookie (a direct API call can\'t skip the prompt)');
    const wrong = await pinProof('9999', SALT);
    for (let i = 1; i <= 3; i++) {
      r = await P(env, 'POST', '/api/profiles/select', { body: { id: 'ann-aaaaa', pinProof: wrong } });
      j = await J(r);
      eq([r.status, j.error, j.failures, j.retryAfter], [403, 'pin-wrong', i, 0], `wrong PIN #${i}: no wait yet`);
    }
    r = await P(env, 'POST', '/api/profiles/select', { body: { id: 'ann-aaaaa', pinProof: 'not-hex' } });
    j = await J(r);
    eq([r.status, j.failures, j.retryAfter], [403, 4, 30], 'the fourth miss (a malformed proof counts too) -> 30 s');
    r = await P(env, 'POST', '/api/profiles/select', { body: { id: 'ann-aaaaa', pinProof: P1234 } });
    j = await J(r);
    ok(r.status === 429 && j.error === 'pin-locked' && j.retryAfter > 0 && j.retryAfter <= 30, 'locked out: even the right PIN waits (429 pin-locked)');
    eq((await J(await P(env, 'GET', '/api/profiles'))).pin.retryAfter > 0, true, 'GET carries the wait, so the picker shows the countdown first');
    env.STATE.m.set(PIN_FAILS_KEY, JSON.stringify({ n: 4, until: Date.now() - 1 }));
    r = await P(env, 'POST', '/api/profiles/select', { body: { id: 'ann-aaaaa', pinProof: P1234 } });
    j = await J(r);
    eq([r.status, j.profile.id, /^sw_profile=ann-aaaaa;/.test(r.headers.get('set-cookie') || ''), env.STATE.m.has(PIN_FAILS_KEY)], [200, 'ann-aaaaa', true, false], 'after the wait the right PIN opens it (and clears the count)');

    // /select: the kid-proof exit.
    r = await P(env, 'POST', '/api/profiles/select', { body: { id: 'ann-aaaaa' }, cookie: kidId });
    eq(r.status, 403, 'leaving Kids for a locked profile: PIN');
    const bob = (await J(await P(env, 'GET', '/api/profiles'))).profiles.find(p => p.name === 'Bob');
    r = await P(env, 'POST', '/api/profiles/select', { body: { id: bob.id }, cookie: kidId });
    eq([r.status, (await J(r)).error], [403, 'pin-required'], 'leaving Kids for an unlocked profile: PIN too');
    eq((await P(env, 'POST', '/api/profiles/select', { body: { id: bob.id, pinProof: P1234 }, cookie: kidId })).status, 200, '...which opens it');
    eq((await P(env, 'POST', '/api/profiles/select', { body: { id: kidId }, cookie: kidId })).status, 200, 'staying on the Kids profile asks nothing');
    eq((await P(env, 'POST', '/api/profiles/select', { body: { id: kidId }, cookie: bob.id })).status, 200, 'going INTO Kids asks nothing');
    eq((await P(env, 'POST', '/api/profiles/select', { body: { id: bob.id } })).status, 200, 'a browser with no profile picks an unlocked one freely (the site password is the gate)');

    // Changes and the PIN routes.
    eq((await P(env, 'DELETE', '/api/profiles/' + bob.id + '?confirm=Bob')).status, 403, 'delete asks for the PIN');
    eq((await P(env, 'DELETE', '/api/profiles/' + bob.id + '?confirm=Bob', { pin: P1234 })).status, 200, '...in the x-sw-pin header');
    eq([(await P(env, 'POST', '/api/profiles/pin/check', { pin: wrong })).status, (await P(env, 'POST', '/api/profiles/pin/check', { pin: P1234 })).status], [403, 200], '/pin/check: the picker\'s "Enter the Parent PIN" before a change');
    const P5678 = await pinProof('5678', 'aa'.repeat(16));
    eq((await P(env, 'POST', '/api/profiles/pin', { body: { salt: 'aa'.repeat(16), newProof: P5678, iterations: PIN_ITERATIONS } })).status, 403, 'changing the PIN needs the current one');
    eq((await P(env, 'POST', '/api/profiles/pin', { body: { salt: 'aa'.repeat(16), newProof: P5678, iterations: PIN_ITERATIONS, pinProof: P1234 } })).status, 200, 'change it');
    eq([(await P(env, 'POST', '/api/profiles/pin/check', { pin: P1234 })).status, (await P(env, 'POST', '/api/profiles/pin/check', { pin: P5678 })).status], [403, 200], 'the old PIN stops working, the new one works');
    env.STATE.m.delete(PIN_FAILS_KEY);
    eq((await P(env, 'DELETE', '/api/profiles/pin')).status, 403, 'removing the PIN needs it');
    r = await P(env, 'DELETE', '/api/profiles/pin', { pin: P5678 });
    j = await J(r);
    eq([r.status, j.profiles.some(p => p.locked), env.STATE.m.has(PIN_KEY)], [200, false, false], 'remove the PIN: every lock goes with it');
    eq([(await P(env, 'POST', '/api/profiles/pin/check', { pin: P5678 })).status, 'pin' in (await J(await P(env, 'GET', '/api/profiles')))], [409, false], 'no PIN: /pin/check says so, GET has no `pin`');
    eq((await P(env, 'POST', '/api/profiles/select', { body: { id: 'ann-aaaaa' }, cookie: kidId })).status, 200, 'with no PIN, leaving Kids asks nothing (as in the apps)');
    ok(!seen.some(t => t.includes(stored.verifier) || t.includes(P1234) || t.includes(P5678)), 'no answer ever carried a verifier or a proof (' + seen.length + ' bodies)');
    eq((await P(env, 'GET', '/api/profiles/pin')).status, 405, 'the PIN route is not readable');
  }

  // ── 2f. The client controller against that Worker ────────────────────────────
  {
    const env = { STATE: fakeKV({ [PROFILES_KEY]: { profiles: [{ id: 'ann-aaaaa', name: 'Ann', color: '#35C759' }, { id: 'kid-bbbbb', name: 'Kid', color: '#FF9800', kids: true, maturity: 'teens' }] } }) };
    const jar = new Map();
    const log = [];
    const doFetch = async (url, init = {}) => {
      const headers = { ...(init.headers || {}) };
      if (jar.size) headers.cookie = [...jar].map(([k, v]) => k + '=' + v).join('; ');
      log.push({ method: init.method || 'GET', url, body: init.body ? JSON.parse(init.body) : null, pin: headers['x-sw-pin'] || null });
      const req = new Request('https://w' + url, { method: init.method || 'GET', headers, body: init.body });
      const res = await profilesRoutes(req, env, new URL(req.url));
      const sc = res.headers.get('set-cookie');
      if (sc) { const [k, v] = sc.split(';')[0].split('='); jar.set(k, v); }
      return res;
    };
    const store = createStore(memoryStorage());
    const sync = { start: async () => {}, flush: async () => true, stop: () => {}, status: () => ({ state: 'off' }) };
    const ctl = createProfiles({ store, fetch: doFetch, sync });
    eq([localProfile({ id: 'a', name: 'A', color: '#000000' }), localProfile({ id: 'k', name: 'K', color: 'x', kids: true, maturity: 'bogus' })],
      [{ id: 'a', name: 'A', color: '#000000' }, { id: 'k', name: 'K', color: '#8E8E93', kids: true, maturity: 'olderKids' }], 'the local record: Kids flag + level only when set');
    let r = await ctl.select({ id: 'kid-bbbbb' }, { importLocal: false });
    eq([r.ok, store.getState().profile], [true, { id: 'kid-bbbbb', name: 'Kid', color: '#FF9800', kids: true, maturity: 'teens' }], 'select a Kids profile: the browser remembers its level (the catalog cap)');
    r = await ctl.setPin('2468', null, SALT);
    eq([r.ok, r.proof, log.at(-1).body], [true, await pinProof('2468', SALT), { salt: SALT, newProof: await pinProof('2468', SALT), iterations: PIN_ITERATIONS }], 'set the PIN: the browser sends the salt and the proof, never the digits');
    ok(!JSON.stringify(log).includes('2468'), 'the digits never left the browser');
    const proof = r.proof;
    r = await ctl.select({ id: 'ann-aaaaa' });
    eq([r.error, store.getState().profile.id], ['pin-required', 'kid-bbbbb'], 'leaving Kids without the PIN: refused, still Kid');
    r = await ctl.select({ id: 'ann-aaaaa' }, { pinProof: await pinProof('1111', SALT) });
    eq([r.error, r.failures], ['pin-wrong', 1], 'a wrong PIN comes back with the count');
    r = await ctl.select({ id: 'ann-aaaaa' }, { pinProof: proof });
    eq([r.ok, store.getState().profile], [true, { id: 'ann-aaaaa', name: 'Ann', color: '#35C759' }], 'the right one switches (an adult record carries no Kids fields)');
    eq(log.at(-1).body, { id: 'ann-aaaaa', pinProof: proof }, 'the proof travels in the /select body');
    r = await ctl.update({ id: 'ann-aaaaa' }, { kids: true, maturity: 'littleKids' }, proof);
    eq([r.profile.kids, log.at(-1).method, log.at(-1).pin, store.getState().profile.kids, store.getState().profile.maturity], [true, 'PATCH', proof, true, 'littleKids'],
      'edit the current profile into Kids (proof in x-sw-pin): this browser\'s record follows');
    env.STATE.m.set(PROFILES_KEY, JSON.stringify({ profiles: [{ id: 'ann-aaaaa', name: 'Ann', color: '#35C759' }] }));
    const l = await ctl.list();
    eq([l.pin, ctl.refreshLocal(l.profiles), store.getState().profile], [{ set: true, salt: SALT, iterations: PIN_ITERATIONS }, true, { id: 'ann-aaaaa', name: 'Ann', color: '#35C759' }],
      'a fresh list corrects the remembered Kids flags (changed on another device, or edited by hand)');
    eq(ctl.refreshLocal(l.profiles), false, '...once');
    eq([(await ctl.checkPin(proof)).ok, (await ctl.checkPin('00'.repeat(32))).error], [true, 'pin-wrong'], 'checkPin');
    r = await ctl.removePin(proof);
    eq([r.ok, 'pin' in (await ctl.list())], [true, false], 'removePin');
  }

  // ── 2g. The picker's new panels ──────────────────────────────────────────────
  {
    const profiles = [{ id: 'max-aaaaa', name: 'Max', color: '#35C759', locked: true }, { id: 'kid-bbbbb', name: 'Kid', color: '#FF9800', kids: true }];
    const base = { closable: true, profiles, adding: false, draft: '', confirm: '', target: null, note: '', error: '', busyText: '', pin: { set: true, salt: SALT, iterations: PIN_ITERATIONS } };
    const states = [
      { ...base, mode: 'grid' }, { ...base, mode: 'grid', pin: null },
      { ...base, mode: 'pin', pinFor: 'select', target: profiles[0] }, { ...base, mode: 'pin', pinFor: 'select', target: profiles[1] }, { ...base, mode: 'pin', pinFor: 'manage' },
      { ...base, mode: 'pin', pinFor: 'select', target: profiles[0], lockedUntil: 2000 + 27000, now: 2000 },
      { ...base, mode: 'edit', target: profiles[1], flags: { kids: true, maturity: 'olderKids', locked: false } },
      { ...base, mode: 'edit', target: profiles[0], flags: { kids: false, maturity: 'olderKids', locked: true }, pin: null },
      { ...base, mode: 'pinset' }, { ...base, mode: 'pinset', pin: null },
    ];
    const html = states.map(s => pickerHTML(s, profiles[1]));
    for (const a of new Set(html.join('\n').match(/data-act="[a-z-]+"/g).map(x => x.slice(10, -1)))) ok(actionNames().includes(a), `picker data-act="${a}" has a handler`);
    ok(html[0].includes('>Kids<') && html[0].includes('aria-label="Locked"') && html[0].includes('🔒 Parent PIN') && html[1].includes('Set a Parent PIN'), 'tiles show Kids / 🔒; the grid offers the Parent PIN');
    ok(html[2].includes('Max is locked.') && html[3].includes('Leaving Kid needs the Parent PIN.') && html[4].includes('Changing profiles needs the Parent PIN.'), 'the prompt says why it asks');
    ok(html[2].includes('inputmode="numeric"') && html[2].includes('type="password"') && html[2].includes('maxlength="6"'), 'a numeric, hidden, 6-digit field');
    ok(html[5].includes('try again in 0:27') && /id="pick-pin"[^>]*disabled/.test(html[5]) && html[5].includes('data-act="profile-pin-ok" disabled'), 'locked out: the countdown, the field and OK disabled');
    ok(html[6].includes('Little Kids') && html[6].includes('aria-checked="true" class="pick-btn small on" data-act="profile-flag" data-flag="maturity" data-val="olderKids"') && html[6].includes('Up to TV-Y7, TV-G and PG'), 'Edit: the Kids levels with the chosen one marked');
    ok(/data-flag="locked" checked disabled/.test(html[7]) && html[7].includes('Set a Parent PIN first.') && !html[7].includes('data-val="littleKids"'), 'Edit without a PIN: the lock can\'t be set; no levels for an adult profile');
    ok(html[8].includes('Remove PIN') && !html[9].includes('Remove PIN') && html[9].includes('Set PIN'), 'Parent PIN: change / remove once set; set otherwise');
    ok(!html.join('').includes(SALT), 'the salt never reaches the markup');
  }

  // ── 3. My List: "Pick one for me" ────────────────────────────────────────────
  {
    eq([canPickFromList([{ id: 1 }, { id: 2 }], false), canPickFromList([{ id: 1 }], false), canPickFromList([{ id: 1 }, { id: 2 }], true), canPickFromList([{ id: 1 }, { id: 0 }], false), canPickFromList(null, false)],
      [true, false, false, false, false], 'Pick one for me: two or more titles, never on Kids (no Ask there)');
    eq(PICK_FROM_LIST, 'Pick one thing from my list for me to watch tonight, and give me two backups from my list.', 'the apps\' seed question (AssistantSeed.pickFromList)');
    const st = { list: Array.from({ length: 18 }, (_, i) => ({ id: i + 1, kind: i % 2 ? 'tv' : 'movie', title: 'T' + i })), continue: [{ id: 99, kind: 'movie', title: 'Watched', pos: 10, dur: 20 }] };
    const lib = listOnlyLibrary(st);
    eq([lib.length, lib.every(x => x.status === 'My List'), lib.some(x => x.item.id === 99), lib[1].item.media_type], [15, true, false, 'tv'], 'the pick sees My List only (first 15), never Continue Watching');
    eq(listOnlyLibrary(null), [], 'an empty store: nothing');
  }

  return n;
}
