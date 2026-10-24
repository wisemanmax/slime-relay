// Plain-node unit checks for the pure modules: the store (and its domain
// helpers), the router, and the debrid stream pickers. Run by check.mjs; returns
// the number of assertions, throws (node:assert) on the first failure.

import assert from 'node:assert/strict';
import {
  createStore, memoryStorage, SCHEMA,
  toggleList, inList, myList, recordContinue, savedPos, saveProgress, continueList, getRdKey, setRdKey, clearRdKey,
} from '../src/app/state.js';
import { parseRoute, parseTitle, routeHash, tabFor, KNOWN } from '../src/app/router.js';
import { pickDebridStreams, qualityOf, debridWhy } from '../src/app/player/debrid.js';
import { provQ } from '../src/app/catalog.js';
import { safeNext } from '../src/worker/next.js';

export async function runUnitChecks() {
  let n = 0;
  const eq = (a, b, m) => { assert.deepEqual(a, b, m); n++; };
  const ok = (v, m) => { assert.ok(v, m); n++; };

  // ── Store ────────────────────────────────────────────────────────────────────
  {
    const ls = memoryStorage();
    const s = createStore(ls);
    eq(s.getState(), { list: [], continue: [], rdkey: '', installHint: '', prefs: {}, reading: {}, tombs: {}, sync: {}, profile: null }, 'defaults');
    eq(Object.values(SCHEMA).map(x => x.storage).sort(), ['sw_continue', 'sw_install_hint', 'sw_list', 'sw_prefs', 'sw_profile', 'sw_rdkey', 'sw_reading', 'sw_sync', 'sw_tombs'], 'localStorage keys unchanged (+ install hint, prefs, reading, sync bookkeeping, profile)');

    const seen = [];
    const off = s.subscribe((st, meta) => seen.push([meta.keys, meta.source]));
    s.setState({ rdkey: 'ABC' });
    eq(ls.getItem('sw_rdkey'), '"ABC"', 'persisted as JSON under the old key');
    eq(seen, [[['rdkey'], 'local']], 'subscriber told which keys changed');
    s.setState({ rdkey: null }, { source: 'sync' });
    eq(ls.getItem('sw_rdkey'), null, 'null removes the key (old removeItem)');
    eq(s.getState().rdkey, '', 'removed key falls back to its default');
    eq(seen[1], [['rdkey'], 'sync'], 'meta.source passes through');
    off(); s.setState({ rdkey: 'x' }); eq(seen.length, 2, 'unsubscribe works');

    assert.throws(() => s.getState().list.push(1), TypeError); n++;          // frozen: mutate -> throws
    assert.throws(() => s.setState({ nope: 1 }), /unknown key/); n++;

    // Same read semantics as the old load(k, d): bad JSON / null -> default.
    const ls2 = memoryStorage(); ls2.setItem('sw_list', '{not json'); ls2.setItem('sw_continue', 'null');
    const s2 = createStore(ls2);
    eq(s2.getState().list, [], 'corrupt JSON -> default');
    eq(s2.getState().continue, [], 'null -> default');

    // Another tab wrote a key -> reload() refreshes + notifies with source 'storage'.
    const got = [];
    s2.subscribe((st, m) => got.push(m));
    ls2.setItem('sw_list', JSON.stringify([{ id: 1, kind: 'movie' }]));
    s2.reload('sw_list');
    eq(s2.getState().list.length, 1, 'reload picked up the other tab\'s write');
    eq(got, [{ keys: ['list'], source: 'storage' }], 'cross-tab change is announced');

    // A failing storage (quota / private mode) keeps working in memory.
    const throwing = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
    const s3 = createStore(throwing);
    s3.setState({ rdkey: 'k' }); eq(s3.getState().rdkey, 'k', 'write failure does not lose the value this session');
  }

  // ── Domain helpers ───────────────────────────────────────────────────────────
  {
    const ls = memoryStorage();
    const s = createStore(ls);
    const it = { id: 7, title: 'Seven', poster_path: '/p.jpg', backdrop_path: '/b.jpg' };
    toggleList(it, s);
    ok(inList(7, 'movie', s), 'toggleList adds');
    // (updatedAt is the sync stamp state.js adds to every changed entry — see test/sync.mjs)
    const bare = (x) => { const { updatedAt, ...rest } = x; return rest; };
    eq(JSON.parse(ls.getItem('sw_list')).map(bare), [{ id: 7, kind: 'movie', title: 'Seven', poster: '/p.jpg', backdrop: '/b.jpg' }], 'list record shape unchanged');
    for (let i = 0; i < 70; i++) toggleList({ id: 100 + i, name: 'S' + i }, s);
    eq(myList(s).length, 60, 'list capped at 60');
    eq(bare(myList(s)[0]), { id: 169, kind: 'tv', title: 'S69' }, 'newest first; snapshot == what storage holds (undefined dropped)');
    toggleList({ id: 169, name: 'S69' }, s);
    ok(!inList(169, 'tv', s), 'toggleList removes');

    recordContinue(it, 'movie', 1, 1, 0, s);
    recordContinue({ id: 9, name: 'Nine' }, 'tv', 2, 3, 0, s);
    eq(continueList(s).map(x => x.id), [9, 7], 'continue: most recent first');
    saveProgress({ it, kind: 'movie', s: 1, e: 1 }, 1234.7, 5400.2, s);
    const rec = continueList(s).find(x => x.id === 7);
    eq([rec.pos, rec.dur], [1234, 5400], 'progress floored');
    eq(Object.keys(bare(JSON.parse(ls.getItem('sw_continue'))[1])), ['id', 'kind', 'title', 'poster', 'backdrop', 's', 'e', 'pos', 'ts', 'dur'], 'record key order as before');
    eq(savedPos(7, 'movie', 1, 1, s), 1234, 'savedPos reads it back');
    eq(savedPos(7, 'movie', 1, 2, s), 0, 'savedPos is per episode');
    saveProgress({ it: { id: 404 }, kind: 'movie', s: 1, e: 1 }, 50, 100, s);
    ok(!continueList(s).some(x => x.id === 404), 'saveProgress never creates a record');
    for (let i = 0; i < 30; i++) recordContinue({ id: 500 + i, title: 't' }, 'movie', 1, 1, 0, s);
    eq(continueList(s).length, 24, 'continue capped at 24');

    setRdKey('KEY', s); eq(getRdKey(s), 'KEY', 'rd key set');
    clearRdKey(s); eq(ls.getItem('sw_rdkey'), null, 'rd key removed from storage');
  }

  // ── Router ───────────────────────────────────────────────────────────────────
  {
    eq(parseRoute(''), { base: 'home', arg: undefined, active: 'home', nav: 'home', tab: 'home', pills: true }, 'empty hash');
    eq(parseRoute('#genre/28'), { base: 'genre', arg: '28', active: 'genre', nav: 'genre', tab: 'home', pills: false }, 'genre/28');
    eq(parseRoute('#channel/8').arg, '8', 'channel arg');
    eq(parseRoute('#search'), { base: 'search', arg: undefined, active: 'search', nav: 'home', tab: 'search', pills: false }, 'search lights Home in the desktop nav');
    eq(parseRoute('#movies').pills, true, 'movies shows pills');
    eq(parseRoute('#bogus'), { base: 'bogus', arg: undefined, active: 'home', nav: 'home', tab: 'home', pills: true }, 'unknown route -> home');
    eq(parseRoute('#constructor').active, 'home', 'prototype names are not routes');
    eq(['movies', 'tv', 'anime', 'channels', 'channel', 'genre', 'live', 'list', 'search', 'home'].map(tabFor),
       ['home', 'home', 'home', 'home', 'home', 'home', 'live', 'list', 'search', 'home'], 'tab bar mapping');
    eq(KNOWN.length, 12, 'route list (+ read, title)');

    // Shared title links: the shapes the app's AASA claims and AppRoute.webRoute reads.
    eq(parseTitle('#title/movie/550'), { kind: 'movie', anime: false, id: 550 }, 'a film');
    eq(parseTitle('#title/tv/1399'), { kind: 'tv', anime: false, id: 1399 }, 'a series');
    eq(parseTitle('#title/anime/30984'), { kind: 'tv', anime: true, id: 30984 }, 'anime = a TMDB tv id');
    eq(parseTitle('#title/tv/1399/2/3'), { kind: 'tv', anime: false, id: 1399, s: 2, e: 3 }, 'an episode');
    eq(parseTitle('#title/anime/30984/1/12'), { kind: 'tv', anime: true, id: 30984, s: 1, e: 12 }, 'an anime episode');
    eq(parseTitle('#title/tv/1399/0/4'), { kind: 'tv', anime: false, id: 1399, s: 0, e: 4 }, 'season 0 is specials');
    eq(parseTitle(routeHash('title', 'tv', 1399, 2, 3)), parseTitle('#title/tv/1399/2/3'), 'routeHash builds what parseTitle reads');
    eq(parseTitle('#title/tv/%31%33%39%39'), { kind: 'tv', anime: false, id: 1399 }, 'segments are URI-decoded, like the app');
    for (const bad of ['#title', '#title/tv', '#title/tv/', '#title/show/1399', '#title/other/1', '#title/tv/abc', '#title/tv/0',
      '#title/tv/-5', '#title/tv/+5', '#title/tv/1e3', '#title/tv/1234567890', '#title/tv/1399/', '#title/tv/1399/2',
      '#title/tv/1399/2/0', '#title/tv/1399/x/3', '#title/movie/550/1/1', '#title/tv/1399/2/3/4', '#title/tv/1399?x=1', '#titles/tv/1', '#list', '']) {
      eq(parseTitle(bad), null, 'not a title link: ' + JSON.stringify(bad));
    }
    eq([parseRoute('#title/tv/1399').base, parseRoute('#title/bogus').base, parseRoute('#list').active], ['title', 'title', 'list'], 'title is a route; #list is My List');
  }

  // ── Login landing: the `next` hash allow-list (src/worker/next.js) ──────────────
  {
    const good = ['#title/tv/1399/2/3', '#title/movie/550', '#title/anime/30984', '#list', '#read/manga', '#search/ask', '#a_b-c', '#' + 'a'.repeat(80)];
    eq(good.map(safeNext), good, 'plain hash routes (up to 80 characters after #) pass');
    for (const bad of ['', '#', '//evil', '/#list', '#list/../x', 'https://x', 'https://x/#list', 'javascript:alert(1)', '#<script>', '#"><b>',
      '#title/tv/1399?x=1', '#a b', '#%2F%2Fevil', '#a\nb', '#' + 'a'.repeat(81), 'list', null, undefined, 42, ['#list']]) {
      eq(safeNext(bad), '', 'dropped: ' + JSON.stringify(bad));
    }
  }

  // ── Debrid pickers + catalog ─────────────────────────────────────────────────
  {
    const streams = pickDebridStreams({ streams: [
      { url: 'https://rd/a', name: 'RD+ 1080p', title: 'Movie.2020.1080p.WEB.mp4', behaviorHints: { filename: 'Movie.2020.1080p.WEB.mp4' } },
      { url: 'https://rd/b', name: 'RD+ 2160p', title: 'Movie.2020.2160p.mkv', behaviorHints: { filename: 'Movie.2020.2160p.mkv' } },
      { url: 'https://rd/c', name: 'RD+ 720p', title: 'Movie.720p.DDP5.1.mp4', behaviorHints: { filename: 'Movie.720p.DDP5.1.mp4' } },
      { url: 'https://rd/d', name: 'RD download 720p', title: 'Movie.720p.mp4', behaviorHints: { filename: 'Movie.720p.mp4' } },
      { url: 'https://rd/e', name: 'RD+ 4k', title: 'Movie.4k.webm', behaviorHints: { filename: 'Movie.4k.webm' } },
      { name: 'no url', title: 'x.mp4' },
    ] });
    eq(streams.map(s => s.url), ['https://rd/e', 'https://rd/a'], 'mkv, surround, uncached and url-less dropped; best first');
    // Fixed (W2): silentDropped is set on the RETURNED array — it used to be
    // lost to slice(), so resolveDebrid could never report 'silent-audio'.
    eq(streams.silentDropped, 1, 'silentDropped survives the slice (the DDP5.1 mp4)');
    eq(streams[1].label, '1080p · Movie 2020 1080p WEB', 'label');
    eq([qualityOf('UHD remux'), qualityOf('1440p'), qualityOf('480p'), qualityOf('cam')], [2160, 1440, 480, 0], 'qualityOf');
    ok(debridWhy('no-key').includes('data-act="settings"') && !/onclick/.test(debridWhy('no-key')), 'debridWhy links Settings via data-act');
    eq(provQ(8, { sort_by: 'vote_average.desc' }).match(/sort_by=/g).length, 1, 'provQ override replaces, never duplicates');
  }
  return n;
}
