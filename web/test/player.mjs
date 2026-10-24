// Player-parity checks (W2), run by check.mjs: subtitle ranking / language
// normalisation / SRT->VTT, the anime rung order and dub-badge rule, the
// debrid + remux pickers (incl. the silent-audio reason), the generation guard,
// the converter's seek plan and URL building, the /api/player/* Worker routes
// against a stubbed extractor, and the four pre-existing player bugs exercised
// on the real player code over a minimal fake DOM. Returns the number of
// assertions; throws (node:assert) on the first failure.

import assert from 'node:assert/strict';
import {
  langKey, langName, groupTracks, parseCues, cuesToVtt, srtToVtt, vttTime, shiftCues, activeCue,
  decodeSubtitle, titleOff, withTitleOff, wantedLangs, subSizeOf,
} from '../src/app/player/subtitles.js';
import {
  animeRungs, deliveredAudio, absoluteEpisode, absFor, seasonCounts, skipRung, mayTryRung, rungBudgetMs,
  maybeAnime, isNoStream, audioPref, ANIME_HOSTS,
} from '../src/app/player/anime.js';
import { pickDebridStreams, debridWhy } from '../src/app/player/debrid.js';
import { createGen, momentStart, startPoint } from '../src/app/player/session.js';
import { vtSeekPlan, vtFailure } from '../src/app/player/vt.js';
import { parseAniSkip, activeSkip } from '../src/app/player/skip.js';
import { streamFromResolve, PROVIDERS } from '../src/app/player/sources.js';
import { playerRoutes, vtPlayUrl, intParam, titleParams, vtStatus } from '../src/worker/player.js';

// ── A minimal DOM for the real player code ──────────────────────────────────────
class FakeEl {
  constructor(id = '') {
    this.id = id; this.style = {}; this.dataset = {}; this.children = []; this.innerHTML = ''; this.textContent = '';
    this.value = ''; this.src = ''; this.currentTime = 0; this.duration = NaN; this.paused = true; this.textTracks = [];
    const set = new Set();
    this.classList = { add: (...c) => c.forEach(x => set.add(x)), remove: (...c) => c.forEach(x => set.delete(x)),
      toggle: (c, on) => { const v = on === undefined ? !set.has(c) : !!on; if (v) set.add(c); else set.delete(c); return v; },
      contains: (c) => set.has(c) };
  }
  get options() { return [...String(this.innerHTML).matchAll(/value="([^"]*)"/g)].map(m => ({ value: m[1] })); }
  pause() { this.paused = true; } load() {} play() { this.paused = false; return Promise.resolve(); }
  removeAttribute(k) { if (k === 'src') this.src = ''; } setAttribute() {}
  appendChild(c) { this.children.push(c); return c; } remove() {} addEventListener() {} insertAdjacentHTML() {}
  canPlayType() { return ''; } closest() { return null; } querySelector() { return null; } find() { return null; }
}
function fakeDom() {
  const els = new Map();
  const get = (id) => { if (!els.has(id)) els.set(id, new FakeEl(id)); return els.get(id); };
  globalThis.document = {
    getElementById: get, createElement: () => new FakeEl(), querySelector: () => new FakeEl(),
    addEventListener() {}, fullscreenElement: null, pictureInPictureEnabled: false,
  };
  globalThis.window = { addEventListener() {} };
  globalThis.requestAnimationFrame = (f) => setTimeout(f, 16);
  globalThis.cancelAnimationFrame = (t) => clearTimeout(t);
  // The store's singleton reads globalThis.localStorage: give it one (node's
  // own is an experimental getter that warns without --localstorage-file).
  const mem = new Map();
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) } });
  } catch (_) {}
  return get;
}

const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

export async function runPlayerChecks() {
  let n = 0;
  const eq = (a, b, m) => { assert.deepEqual(a, b, m); n++; };
  const ok = (v, m) => { assert.ok(v, m); n++; };
  const realFetch = globalThis.fetch;
  const saved = { document: globalThis.document, window: globalThis.window, raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame,
    localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage') };
  let restoreStore = null;

  try {
    // ── Subtitles: languages + ranking ─────────────────────────────────────────
    eq(['en', 'eng', 'EN-us', 'English', ''].map((l, i) => langKey(l, i === 4 ? 'English (SDH)' : '')), ['en', 'en', 'en', 'en', 'en'], 'en / eng / en-US / English / "English (SDH)" are one language');
    eq([langKey('spl'), langKey('pob'), langKey('pt-BR'), langKey('chi'), langKey('und', 'Subtitles 1'), langKey('', '')], ['es', 'pt', 'pt', 'zh', 'und', 'und'], 'aliases, regional tags, und');
    eq([langKey('xx'), langKey('', 'Klingon')], ['xx', 'x-klingon'], 'unknown code keeps its base; unknown name is its own group');
    eq([langName('en'), langName('und'), langName('x-klingon', 'Klingon (2)')], ['English', 'Unknown language', 'Klingon'], 'row names');
    {
      const tracks = [
        { t: 'ext', origin: 'index', lang: 'es', name: 'Spanish', url: 'u1' },
        { t: 'ext', origin: 'index', lang: 'eng', name: 'English', url: 'u2' },
        { t: 'ext', origin: 'stream', lang: 'en', name: 'English', url: 'u3' },
        { t: 'ext', origin: 'index', lang: 'fre', name: 'French', url: 'u4' },
        { t: 'ext', origin: 'index', lang: 'und', name: 'Subtitles', url: 'u5' },
        { t: 'ext', origin: 'index', lang: 'en', name: 'English', url: 'u2' },   // duplicate URL
        { t: 'emb', id: 0, lang: 'en', name: 'English CC' },
        { t: 'ext', origin: 'index', lang: 'de', name: 'German', url: 'u6' },
      ];
      const g = groupTracks(tracks, { leading: 'fr' });
      eq(g.map(x => x.lk), ['en', 'fr', 'de', 'es', 'und'], 'English first, then the viewer\'s language, then A–Z, Unknown last');
      eq(g[0].tracks.map(x => x.url || 'emb'), ['u3', 'u2', 'emb'], 'within a language: the stream\'s own, then the index, then embedded; URLs de-duplicated');
      eq(groupTracks(tracks, { embFirst: true })[0].tracks.map(x => x.url || 'emb'), ['emb', 'u3', 'u2'], 'Safari native HLS: the embedded rendition leads');
      eq(groupTracks(tracks, { leading: ['es', 'de'] }).map(x => x.lk), ['en', 'es', 'de', 'fr', 'und'], 'the viewer\'s languages (prefs.subLangs) in their order, after English');
    }
    // prefs (state.js getPrefs: subLangs ['en'] + subSize 'M' by default; subLang absent = off)
    {
      eq(wantedLangs({ subLang: 'fr', subLangs: ['fr', 'spa', 'English'] }), ['fr', 'es', 'en'], 'auto-on languages: subLang, then subLangs, normalised + de-duplicated');
      eq(wantedLangs({ subLangs: ['en'] }, 'en'), ['en'], 'anime SUB with no subLang: the list, English last resort');
      eq(wantedLangs({ subLangs: ['de'] }, 'en'), ['de', 'en'], 'anime SUB: the viewer\'s language first');
      const groups = groupTracks([{ t: 'ext', origin: 'index', lang: 'es', name: 'Spanish', url: 'a' }, { t: 'ext', origin: 'index', lang: 'en', name: 'English', url: 'b' }]);
      eq(wantedLangs({ subLang: 'fr', subLangs: ['fr', 'es', 'en'] }).find(lk => groups.some(g => g.lk === lk)), 'es', 'first language missing -> the next one the title has');
      eq([subSizeOf({ subSize: 'L' }), subSizeOf({ subSize: 'XL' }), subSizeOf({})], ['L', 'M', 'M'], 'subSize');
    }

    // ── Subtitles: SRT -> cues -> VTT ──────────────────────────────────────────
    {
      const srt = '﻿1\r\n00:00:01,500 --> 00:00:03,000\r\n<i>Hello</i> {\\an8}there\r\n\r\n2\r\n00:01:02,05 --> 00:01:04,000 X1:10\r\nLine one\r\nLine & two\r\n\r\n3\r\n00:00:09,000 --> 00:00:08,000\r\nbackwards\r\n';
      const cues = parseCues(srt);
      eq(cues, [{ start: 1.5, end: 3, text: 'Hello there' }, { start: 62.05, end: 64, text: 'Line one\nLine & two' }], 'SRT: BOM, CRLF, tags stripped, short millis, cue settings ignored, backwards cue dropped');
      const vtt = srtToVtt(srt);
      ok(vtt.startsWith('WEBVTT\n\n00:00:01.500 --> 00:00:03.000\nHello there\n\n'), 'SRT -> WebVTT header + dot millis');
      ok(vtt.includes('Line &amp; two') && !/<i>/.test(vtt), 'VTT payload escaped');
      eq(parseCues(vtt), cues, 'VTT round-trips');
      const webvtt = 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\nNOTE a comment\n\ncue-1\n01:02.000 --> 01:04.250 align:start\n&lt;b&gt; ok\n';
      eq(parseCues(webvtt), [{ start: 62, end: 64.25, text: '<b> ok' }], 'VTT: header metadata, NOTE, identifier, optional hours, settings, entities');
      eq([vttTime(0), vttTime(3725.5)], ['00:00:00.000', '01:02:05.500'], 'vttTime');
      eq(shiftCues([{ start: 1, end: 2, text: 'a' }, { start: 5, end: 6, text: 'b' }], -3), [{ start: 2, end: 3, text: 'b' }], 'shiftCues drops cues pushed before 0');
      const list = [{ start: 0, end: 10, text: 'long' }, { start: 2, end: 3, text: 'short' }, { start: 20, end: 21, text: 'later' }];
      eq([activeCue(list, 2.5)?.text, activeCue(list, 5)?.text, activeCue(list, 15), activeCue(list, -1)], ['short', 'long', null, null], 'activeCue: latest-starting running cue, overlap aware');
      eq(cuesToVtt([]), 'WEBVTT\n\n\n', 'empty VTT');
      eq(decodeSubtitle(new TextEncoder().encode('héllo')), 'héllo', 'UTF-8');
      eq(decodeSubtitle(new Uint8Array([0x68, 0xe9])), 'hé', 'Windows-1252 fallback');
      eq(decodeSubtitle(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00])), 'hi', 'UTF-16LE BOM');
      eq([titleOff({ subOff: ['tv:1'] }, 'tv:1'), titleOff({}, 'tv:1'), withTitleOff(['a', 'b'], 'b', true), withTitleOff(['a', 'b'], 'a', false)],
         [true, false, ['b', 'a'], ['b']], 'per-title "Off" memory');
    }

    // ── Anime: rungs + dub badge ───────────────────────────────────────────────
    {
      const ids = { anime: true, anilistId: 21, malId: 21, episode: 1120 };
      const dub = animeRungs(ids, 'dub');
      eq(dub.map(r => r.audio + '@' + r.host), [
        'dub@tryembed.us.cc', 'dub@vidnest.fun', 'dub@anixo.buzz', 'sub@tryembed.us.cc', 'sub@vidnest.fun', 'sub@anixo.buzz',
      ], 'preferred audio on every host (tryembed -> vidnest -> anixo), then the other');
      eq(dub.slice(0, 3).map(r => r.url), [
        'https://tryembed.us.cc/embed/anime/21/1120/dub', 'https://vidnest.fun/anime/21/1120/dub', 'https://anixo.buzz/embed/ani/21/1120/dub',
      ], 'host URL shapes');
      eq(animeRungs(ids, 'sub')[0].url, 'https://tryembed.us.cc/embed/anime/21/1120/sub', 'Sub preference leads with sub');
      eq([animeRungs({ anime: false }, 'dub'), animeRungs(null, 'dub'), animeRungs({ anime: true, anilistId: 0 }, 'dub')], [[], [], []], 'not anime -> no rungs');
      eq([audioPref({}), audioPref({ animeAudio: 'sub' }), audioPref({ animeAudio: 'weird' })], ['dub', 'sub', 'dub'], 'default Dub');
      eq(deliveredAudio('dub', { audio: 'sub', dubVerified: true, dubReason: 'identical-to-sub' }), { audio: 'sub', fellBack: true, verified: true }, 'dub request answered "sub" -> SUB badge, fell back');
      eq(deliveredAudio('dub', { audio: 'dub', dubVerified: true }), { audio: 'dub', fellBack: false, verified: true }, 'verified dub');
      eq(deliveredAudio('dub', {}), { audio: 'dub', fellBack: false, verified: false }, 'older server / mp4: dub taken at its word, unverified');
      eq(deliveredAudio('sub', { audio: 'dub' }), { audio: 'sub', fellBack: false, verified: true }, 'a sub request is a sub');
      eq(deliveredAudio('dub', { audio: 'SUB' }).fellBack, true, 'audio word case-insensitive');
      const [te, vn, ax] = ANIME_HOSTS.map(h => ({ audio: 'dub', catalog: h.catalog, primary: h.primary }));
      ok(skipRung(vn, [te]) && !skipRung(ax, [te]) && !skipRung({ ...vn, audio: 'sub' }, [te]), 'vidnest shares tryembed\'s catalog (same audio only); anixo does not');
      eq([rungBudgetMs(te), rungBudgetMs(vn), rungBudgetMs({ ...ax, audio: 'sub' })], [17000, 16000, 10000], 'rung budgets');
      ok(mayTryRung(17000, vn) && !mayTryRung(20000, vn), 'start budget: a hung primary still leaves one backup dub');
      ok(isNoStream({ error: 'resolve-502' }) && !isNoStream({ error: 'resolve-504' }) && !isNoStream(null), 'only 502 is the site\'s "no stream"');
      const counts = { 1: 61, 2: 16, 3: 14 };
      eq([absoluteEpisode(3, 5, counts), absoluteEpisode(1, 5, counts), absoluteEpisode(4, 2, { 1: 10, 3: 5 })], [82, 5, 2], 'absolute episode; missing earlier season -> unchanged');
      eq([absFor({ kind: 'tv', s: 2, e: 3 }, counts), absFor({ kind: 'tv', s: 1, e: 3 }, counts), absFor({ kind: 'movie', s: 1, e: 1 }, counts)], [64, null, null], 'abs only past season 1');
      eq(seasonCounts({ seasons: [{ season_number: 0, episode_count: 3 }, { season_number: 1, episode_count: 12 }] }), { 0: 3, 1: 12 }, 'season table');
      eq([maybeAnime({ genre_ids: [16, 10759] }), maybeAnime({ genre_ids: [18] }), maybeAnime({ genres: [{ id: 16 }] }), maybeAnime({ id: 1 })], [true, false, true, true], 'only Animation (or unknown genres) asks the map');
    }

    // ── Skip markers ───────────────────────────────────────────────────────────
    {
      const segs = parseAniSkip({ found: true, results: [
        { skipType: 'ed', episodeLength: 1420, interval: { startTime: 1300, endTime: 1390 } },
        { skipType: 'op', episodeLength: 1420, interval: { startTime: 60, endTime: 150 } },
        { skipType: 'ed', episodeLength: 1420, interval: { startTime: 2, endTime: 80 } },   // implausible
        { skipType: 'op', interval: { startTime: 9, endTime: 9 } },                          // empty
      ] });
      eq(segs.map(s => [s.kind, s.start, s.end]), [['intro', 60, 150], ['outro', 1300, 1390]], 'AniSkip op/ed, sorted, implausible + empty dropped');
      eq([activeSkip(segs, 100, 1420)?.label, activeSkip(segs, 149.5, 1420), activeSkip(segs, 1310, 1420)?.label], ['Skip intro', null, 'Skip outro'], 'window, hidden in its last second');
      eq(parseAniSkip({ found: false }), [], 'not found');
    }

    // ── Debrid + remux pickers ─────────────────────────────────────────────────
    {
      const S = (fn, name = 'RD+', extra = '') => ({ url: 'https://rd/' + fn, name, title: fn + extra, behaviorHints: { filename: fn } });
      const data = { streams: [
        S('Show.1080p.WEB.x264.mp4'),
        S('Show.2160p.x265.HDR.mp4'),
        S('Show.1080p.DDP5.1.mp4'),
        S('Show.720p.x264.AAC.mkv'),
        S('Show.1080p.BluRay.DTS-HD.MA.mkv'),
        S('Show.2160p.HEVC.mkv'),
        S('Show.1080p.DDP5.1.Atmos.H.264.mkv'),
        S('Show.1080p.TrueHD.Atmos.x264.mkv'),
        S('Show.480p.avi'),
      ] };
      const plain = pickDebridStreams(data);
      eq(plain.map(s => s.url.slice(11)), ['Show.2160p.x265.HDR.mp4', 'Show.1080p.WEB.x264.mp4'], 'no convert: mkv/avi still dropped (old behaviour)');
      eq(plain.silentDropped, 1, 'silentDropped survives the slice');
      const conv = pickDebridStreams(data, { convert: true, canHevc: false, canAc3: false });
      eq(conv.map(s => (s.vt ? 'vt:' : '') + s.url.slice(11)), [
        'Show.1080p.WEB.x264.mp4',
        'vt:Show.1080p.TrueHD.Atmos.x264.mkv', 'vt:Show.720p.x264.AAC.mkv', 'vt:Show.1080p.BluRay.DTS-HD.MA.mkv', 'vt:Show.480p.avi',
      ], 'direct first; remux: H.264-tagged first, HEVC never, DD+/Atmos-on-DD+ dropped without AC-3, DTS/TrueHD kept (transcoded); HEVC mp4 dropped without HEVC');
      ok(pickDebridStreams(data, { convert: true, canAc3: true }).some(s => /DDP5\.1\.Atmos/.test(s.url)), 'Safari (AC-3) keeps the DD+ remux');
      const many = { streams: Array.from({ length: 14 }, (_, i) => S(`M.${i}.1080p.x264.mkv`)) };
      eq(pickDebridStreams(many, { convert: true }).length, 4, 'at most 4 remuxes');
      ok(/Dolby \/ DTS/.test(debridWhy('silent-audio')), 'silent-audio explains itself');
    }

    // ── Generation guard + converter rules + resolve shape ───────────────────────
    {
      const g = createGen();
      const a = g.next(); ok(g.isCurrent(a), 'fresh token current');
      const b = g.next(); ok(!g.isCurrent(a) && g.isCurrent(b), 'a newer generation retires the old token');
      eq(vtSeekPlan(130, 100, { start: 0, end: 60 }), { local: 30 }, 'inside the generated window: local seek');
      eq(vtSeekPlan(500, 100, { start: 0, end: 60 }), { server: 500 }, 'past the window: restart there');
      eq(vtSeekPlan(50, 100, { start: 0, end: 60 }), { server: 50 }, 'before the epoch: restart there');
      eq(vtSeekPlan(130, 100, null), { server: 130 }, 'no window yet: restart');
      eq([429, 502, 503, 504, 0, 422, 404].map(vtFailure), ['busy', 'unsupported', 'unavailable', 'unavailable', 'unavailable', 'failed', 'failed'], 'converter failure classes');
      eq(streamFromResolve({ play: 'https://x/hls/1.m3u8', type: 'hls', subs: [{ lang: 'en', name: 'English', url: 'https://x/vtt/1/0' }, { lang: 'x' }] }, 'h'),
         { url: 'https://x/hls/1.m3u8', label: 'h', type: 'hls', subs: [{ lang: 'en', name: 'English', url: 'https://x/vtt/1/0' }] }, 'resolve -> stream record');
      eq([streamFromResolve({ error: 'resolve-502' }), streamFromResolve({ play: 'javascript:x' })], [null, null], 'no stream / bad URL');
    }

    // ── Where playback starts: a shared moment ('#title/…/t/<n>') vs the resume rule ──
    {
      eq([momentStart(90, 5400), momentStart(0, 5400), momentStart(5399, 5400)], [90, 0, 5399], 'a moment inside the length starts exactly there (t/0 = the top)');
      eq([momentStart(5400, 5400), momentStart(6000, 5400)], [0, 0], 'at or past the end: from the start');
      eq([momentStart(90, NaN), momentStart(90, Infinity), momentStart(90, 0)], [90, 90, 90], 'an unknown length trusts the moment');
      eq([momentStart(undefined, 5400), momentStart(null, 5400), momentStart(-1, 5400), momentStart(NaN, 5400), momentStart('90', 5400)],
         [null, null, null, null, null], 'no moment (or not a number) -> null: the caller\'s rule applies');
      eq([startPoint(600, 1200, 5400), startPoint(0, 1200, 5400), startPoint(10, 0, 5400), startPoint(5390, 0, 5400)], [600, 0, 10, 5390],
         'a moment wins over the saved position, exactly — t/0 too, and inside the first 30 s or the last minute');
      eq([startPoint(5400, 1200, 5400), startPoint(9e8, 1200, 5400)], [0, 0], 'a moment at/past the end plays from the start (not the resume point)');
      eq([startPoint(null, 1200, 5400), startPoint(null, 20, 5400), startPoint(null, 5350, 5400), startPoint(null, 1200, NaN), startPoint(null, 1200, Infinity), startPoint(null, 0, 5400)],
         [1200, 0, 0, 0, 0, 0], 'no moment: today\'s resume rule (> 30 s, < duration - 60, finite length)');
      const vidlink = PROVIDERS.find(p => p[0] === 'vidlink')[2];
      eq([vidlink(550, 'movie', 1, 1, 754.9), vidlink(1399, 'tv', 2, 3, 90), vidlink(550, 'movie', 1, 1), vidlink(550, 'movie', 1, 1, 0)], [
        'https://vidlink.pro/movie/550?autoplay=true&title=false&primaryColor=43e048&startAt=754',
        'https://vidlink.pro/tv/1399/2/3?autoplay=true&title=false&primaryColor=43e048&startAt=90',
        'https://vidlink.pro/movie/550?autoplay=true&title=false&primaryColor=43e048',
        'https://vidlink.pro/movie/550?autoplay=true&title=false&primaryColor=43e048'], 'VidLink takes startAt (whole seconds) only for a moment past 0');
      ok(PROVIDERS.filter(p => p[0] !== 'vidlink').every(p => !/start/i.test(p[2](550, 'movie', 1, 1, 754) + p[2](1399, 'tv', 2, 3, 754))), 'the other embeds have no start parameter: they start at the top');
    }

    // ── Worker: /api/player/* ──────────────────────────────────────────────────
    {
      eq([intParam('12', 1, 20), intParam('0', 1, 20), intParam('1e3', 1, 9999), intParam('-1', 0, 9), intParam(7, 1, 9)], [12, null, null, null, 7], 'intParam');
      eq(titleParams(new URLSearchParams('tmdb=5&kind=tv&s=2&e=3&abs=17')), { ok: true, q: { tmdb: 5, kind: 'tv', season: 2, episode: 3, abs: 17 } }, 'title params');
      eq(['tmdb=x&kind=tv&s=1&e=1', 'tmdb=5&kind=book', 'tmdb=5&kind=tv&s=1', 'tmdb=5&kind=tv&s=1&e=1&abs=a'].map(q => titleParams(new URLSearchParams(q)).error),
         ['bad-tmdb', 'bad-kind', 'bad-episode', 'bad-abs'], 'title params rejected');
      eq(vtPlayUrl('https://ex.invalid/', '/vt/ab12/2/index.m3u8?cap=deadbeefdeadbeef'), 'https://ex.invalid/vt/ab12/2/index.m3u8?cap=deadbeefdeadbeef', 'vt play URL on EXTRACTOR_BASE');
      eq([vtPlayUrl('https://ex', '//evil.com/x'), vtPlayUrl('https://ex', '/vt/a/1/index.m3u8?cap=x&key=TOK'), vtPlayUrl('https://ex', '/resolve?x')], [null, null, null], 'anything but a converter playlist refused');
      eq([200, 429, 502, 0, 400, 403, 401, 500].map(vtStatus), [200, 429, 502, 504, 422, 422, 503, 503], 'extractor /vt status mapping');

      const env = { SLIME_TOKEN: 'TOK-secret', EXTRACTOR_BASE: 'https://ex.invalid/' };
      const calls = [];
      let route = () => jsonRes({});
      globalThis.fetch = async (u, init = {}) => { const url = String(u); calls.push({ url, init }); return route(url, init); };
      const call = (path, init) => playerRoutes(new Request('https://w' + path, init), env, new URL('https://w' + path));
      const body = async (r) => { const t = await r.text(); ok(!t.includes('TOK-secret'), 'the extractor token never reaches the page'); return JSON.parse(t); };

      eq((await playerRoutes(new Request('https://w/api/player/subs'), {}, new URL('https://w/api/player/subs?tmdb=1&kind=movie'))).status, 503, 'not configured -> 503');
      eq(await call('/api/other'), null, 'other paths pass through');
      let r = await call('/api/player/subs?tmdb=1&kind=tv&s=1');
      eq([r.status, (await body(r)).error, calls.length], [400, 'bad-episode', 0], 'bad params never reach the extractor');

      route = () => jsonRes({ subs: [{ lang: 'en', name: 'English', url: 'https://sub.wyzie.io/c/1' }, { lang: 'es', url: 'javascript:alert(1)' }], keyed: true });
      r = await call('/api/player/subs?tmdb=37854&kind=tv&s=2&e=5&abs=66');
      eq(calls[0].url, 'https://ex.invalid/subs?tmdb=37854&kind=tv&season=2&episode=5&abs=66', 'subs -> extractor /subs with abs');
      eq(calls[0].init.headers.authorization, 'Bearer TOK-secret', 'bearer token on the extractor call');
      eq(await body(r), { subs: [{ lang: 'en', name: 'English', url: 'https://sub.wyzie.io/c/1' }] }, 'non-http(s) tracks dropped');
      route = () => { throw new TypeError('down'); };
      r = await call('/api/player/subs?tmdb=1&kind=movie');
      eq([r.status, (await body(r)).error], [502, 'subs-unreachable'], 'unreachable -> JSON error');

      // animeids: One Piece shape (one AniList entry for every TMDB season).
      calls.length = 0;
      route = (u) => { const q = new URL(u).searchParams; return jsonRes(q.get('season') === '1' && q.get('episode') === '66' ? { anilistId: 21, malId: 21, episode: 66 } : { anilistId: 21, malId: 21, episode: +q.get('episode') }); };
      r = await call('/api/player/animeids?tmdb=37854&kind=tv&s=2&e=5&abs=66');
      eq(await body(r), { anime: true, anilistId: 21, malId: 21, episode: 66, absolute: true }, 'no entry for the season -> asked by the absolute number');
      eq(calls.length, 3, 'per-season + S1E1 + absolute');
      route = (u) => { const q = new URL(u).searchParams; return jsonRes(q.get('season') === '2' ? { anilistId: 20958, malId: 25777, episode: 5 } : { anilistId: 16498, malId: 16498, episode: +q.get('episode') }); };
      r = await call('/api/player/animeids?tmdb=1429&kind=tv&s=2&e=5&abs=30');
      eq(await body(r), { anime: true, anilistId: 20958, malId: 25777, episode: 5, absolute: false }, 'the season has its own entry -> per-season');
      route = () => jsonRes({});
      r = await call('/api/player/animeids?tmdb=550&kind=movie');
      eq(await body(r), { anime: false }, 'not anime');

      // /vt
      calls.length = 0;
      route = () => jsonRes({ id: 'ab12cd34', cap: 'c'.repeat(64), epoch: 1, play: '/vt/ab12cd34/1/index.m3u8?cap=' + 'c'.repeat(64), duration: 5400.5, actualStart: 118.2, videoMode: 'copy', audioMode: 'aac' });
      const post = (path, obj, method = 'POST') => call(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
      r = await post('/api/player/vt/sessions', { url: 'https://rd.example/file.mkv', start: 120, audio: 'eng' });
      const sess = await body(r);
      eq(sess, { id: 'ab12cd34', play: 'https://ex.invalid/vt/ab12cd34/1/index.m3u8?cap=' + 'c'.repeat(64), epoch: 1, duration: 5400.5, actualStart: 118.2, videoMode: 'copy', audioMode: 'aac' }, 'session with an absolute play URL');
      eq([calls[0].url, calls[0].init.method, JSON.parse(calls[0].init.body)], ['https://ex.invalid/vt/sessions', 'POST', { sourceURL: 'https://rd.example/file.mkv', start: 120, profile: 'apple', audioPreference: 'eng' }], 'extractor body uses its own field names');
      eq((await post('/api/player/vt/sessions', { url: 'file:///etc/passwd' })).status, 400, 'non-http source refused');
      eq((await post('/api/player/vt/sessions', { url: 'https://x/a.mkv', audio: 'fr' })).status, 400, 'audio enum');
      eq((await call('/api/player/vt/sessions', { method: 'POST', body: '{"url":"https://x/a.mkv"}' })).status, 400, 'JSON content-type required (no simple cross-site POST)');
      route = () => jsonRes({ error: 'busy' }, 429);
      r = await post('/api/player/vt/sessions', { url: 'https://x/a.mkv' });
      eq([r.status, (await body(r)).error], [429, 'busy'], '429 busy passes through');
      route = () => jsonRes({ error: 'video-not-copyable:hevc' }, 502);
      r = await post('/api/player/vt/sessions', { url: 'https://x/a.mkv' });
      eq([r.status, (await body(r)).error], [502, 'video-not-copyable:hevc'], '502 can\'t remux');
      route = () => jsonRes({ id: 'zz', play: 'https://evil/x.m3u8' });
      eq((await post('/api/player/vt/sessions', { url: 'https://x/a.mkv' })).status, 502, 'a play URL that isn\'t a converter playlist is refused');
      calls.length = 0;
      route = () => jsonRes({ id: 'ab12cd34', epoch: 2, play: '/vt/ab12cd34/2/index.m3u8?cap=' + 'c'.repeat(64), actualStart: 1800 });
      r = await post('/api/player/vt/sessions/ab12cd34/seek', { start: 1800 });
      eq([calls[0].url, (await body(r)).epoch], ['https://ex.invalid/vt/sessions/ab12cd34/seek', 2], 'seek');
      eq((await post('/api/player/vt/sessions/ab12cd34/seek', { start: 'x' })).status, 400, 'seek needs a number');
      eq((await post('/api/player/vt/sessions/a%2Fb/seek', { start: 1 })).status, 400, 'id shape enforced');
      route = () => jsonRes({ ok: true });
      r = await call('/api/player/vt/sessions/ab12cd34', { method: 'DELETE' });
      eq([r.status, calls[calls.length - 1].init.method], [200, 'DELETE'], 'delete');
      eq((await call('/api/player/vt/sessions/ab12cd34')).status, 405, 'GET on a session is not a route');

      // AniSkip proxy + subtitle file proxy
      calls.length = 0;
      route = () => jsonRes({ found: true, results: [{ skipType: 'op', episodeLength: 1420, interval: { startTime: 60, endTime: 150 }, skipId: 'x' }] });
      r = await call('/api/player/skip?mal=21&ep=1120');
      eq([calls[0].url.startsWith('https://api.aniskip.com/v2/skip-times/21/1120?'), parseAniSkip(await body(r)).length], [true, 1], 'AniSkip proxy');
      eq((await call('/api/player/skip?mal=0&ep=1')).status, 400, 'skip params validated');
      eq((await call('/api/player/subfile?u=' + encodeURIComponent('https://evil.example/x.srt'))).status, 400, 'subfile: allowlisted hosts only');
      route = () => new Response('1\n00:00:01,000 --> 00:00:02,000\nhi\n');
      r = await call('/api/player/subfile?u=' + encodeURIComponent('https://sub.wyzie.io/c/abc/id/1?format=srt'));
      eq([r.status, (await r.text()).includes('-->')], [200, true], 'subfile fetch');
    }

    // ── The module is registered behind the gate ───────────────────────────────
    {
      globalThis.fetch = realFetch;
      const { default: worker } = await import('../src/worker.js');
      const env = { SITE_PASSWORD: 'pw', SESSION_SECRET: 's', TMDB_TOKEN: '' };
      const w = (p, init) => worker.fetch(new Request('https://watch.example' + p, init), env);
      let r = await w('/api/player/subs?tmdb=1&kind=movie', { redirect: 'manual' });
      eq(r.status, 302, '/api/player/* is behind the password gate');
      r = await w('/login', { method: 'POST', body: new URLSearchParams({ password: 'pw' }) });
      const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
      r = await w('/api/player/subs?tmdb=1&kind=movie', { headers: { cookie } });
      eq([r.status, (await r.json()).error], [503, 'not-configured'], 'registered in modules.js (answers, not the app page)');
    }

    // ── The four pre-existing player bugs, on the real player ──────────────────
    {
      const el = fakeDom();
      const { play, closePlayer } = await import('../src/app/player/player.js');
      const { session } = await import('../src/app/player/session.js');
      const { autoNext } = await import('../src/app/player/upnext.js');
      const { setRdKey, getState: snapState, setState: putState } = await import('../src/app/state.js');
      // Leave the app's store singleton as this suite found it.
      const before = snapState();
      restoreStore = () => putState({ prefs: before.prefs, rdkey: before.rdkey, continue: before.continue }, { source: 'sync' });

      // A switchboard fetch: each test sets the handlers it needs.
      let torrentio = () => jsonRes({ streams: [] });
      let resolve = () => jsonRes({ error: 'resolve-502' });
      let season = () => jsonRes({ episodes: [{ episode_number: 1 }, { episode_number: 2 }] });
      globalThis.fetch = async (u) => {
        const url = String(u);
        if (url.startsWith('/api/tmdb/') && url.includes('/season/')) return season(url);
        if (url.startsWith('/api/tmdb/')) return jsonRes({ imdb_id: 'tt0000001' });
        if (url.startsWith('https://torrentio.strem.fun/')) return torrentio(url);
        if (url.startsWith('/api/player/animeids')) return jsonRes({ anime: false });
        if (url.startsWith('/api/resolve')) return resolve(url);
        return jsonRes({});
      };
      setRdKey('KEY');
      const A = { id: 101, title: 'A' }, B = { id: 202, title: 'B' };

      // Bug 2: play() must not carry the previous title's ad-free list.
      session.direct = [{ url: 'https://old/ad-free.m3u8', label: 'VidLink' }];
      play(B, 'movie', 1, 1);
      eq(session.direct, [], 'play() resets the ad-free list');
      await flush(20);

      // Bug 4: a stale ad-free resolve must not land on the next title.
      let releaseA;
      resolve = (url) => url.includes('%2F101') ? new Promise(res => { releaseA = () => res(jsonRes({ play: 'https://ex/hls/A.m3u8', type: 'hls' })); }) : jsonRes({ error: 'resolve-502' });
      play(A, 'movie', 1, 1);
      for (let i = 0; i < 40 && !releaseA; i++) await flush(2);
      ok(typeof releaseA === 'function', 'A reached the ad-free tier');
      play(B, 'movie', 1, 1);
      releaseA();
      await flush(30);
      ok(session.ctx.it.id === 202 && !session.direct.some(x => /A\.m3u8/.test(x.url)), 'a stale ad-free resolve never joins the new title');
      ok(!/A\.m3u8/.test(el('pvideo').src), '...and never plays');

      // Generation guard on debrid too: A's Torrentio answer arriving after B started.
      // B's own answer is held back until A's stale one has been processed, so
      // it can't paper over a missing guard by overwriting it afterwards.
      const held = {};
      torrentio = (url) => new Promise(res => { held[url.includes('tt0000001') ? 'next' : 'x'] = res; });
      play(A, 'movie', 1, 1);
      for (let i = 0; i < 40 && !held.next; i++) await flush(2);
      const releaseA2 = held.next; held.next = null;
      play(B, 'movie', 1, 1);
      for (let i = 0; i < 40 && !held.next; i++) await flush(2);
      const releaseB2 = held.next;
      ok(typeof releaseA2 === 'function' && typeof releaseB2 === 'function', 'both titles asked Torrentio');
      releaseA2(jsonRes({ streams: [{ url: 'https://rd/A.mp4', name: 'RD+ 1080p', title: 'A.1080p.mp4', behaviorHints: { filename: 'A.1080p.mp4' } }] }));
      await flush(30);
      ok(session.ctx.it.id === 202 && !session.debrid.some(x => /A\.mp4/.test(x.url)) && el('pvideo').src !== 'https://rd/A.mp4', 'a stale debrid answer is dropped');
      releaseB2(jsonRes({ streams: [] }));
      torrentio = () => jsonRes({ streams: [] });
      await flush(30);

      // Bug 3: Up Next's banner survives the play() it triggers.
      play({ id: 303, name: 'Show' }, 'tv', 1, 1);
      await flush(20);
      await autoNext(play);
      ok(session.ctx.e === 2 && el('pupnext').classList.contains('on'), 'Up Next banner stays up for the next episode');
      closePlayer();
      ok(!el('player').classList.contains('open') && session.ctx === null, 'close');
      await flush(10);

      // Anime ladder + dub badge + the Sub/Dub switch, on the real player.
      const { initActions } = await import('../src/app/ui/actions.js');
      const { getState } = await import('../src/app/state.js');
      let click = null;
      initActions({ addEventListener: (t, f) => { if (t === 'click') click = f; } });
      const act = (name) => click({ target: { closest: () => ({ dataset: { act: name } }) } });
      const asked = [];
      globalThis.fetch = async (u) => {
        const url = String(u);
        if (url.startsWith('/api/tmdb/')) return jsonRes(url.includes('external_ids') ? { imdb_id: 'tt0000009' } : {});
        if (url.startsWith('https://torrentio.strem.fun/')) return jsonRes({ streams: [] });
        if (url.startsWith('/api/player/animeids')) return jsonRes({ anime: true, anilistId: 21, malId: 21, episode: 5, absolute: false });
        if (url.startsWith('/api/player/subs')) return jsonRes({ subs: [] });
        if (url.startsWith('/api/resolve')) {
          const embed = decodeURIComponent(url.split('embed=')[1]); asked.push(embed);
          if (embed.includes('tryembed') && embed.endsWith('/dub')) return jsonRes({ error: 'resolve-502' });
          return jsonRes({ play: 'https://ex/hls/' + (embed.endsWith('/dub') ? 'dubreq' : 'sub') + '.m3u8', type: 'hls', audio: 'sub', dubVerified: true,
            subs: [{ lang: 'en', name: 'English', url: 'https://ex/s.srt' }] });
        }
        if (url === 'https://ex/s.srt') return new Response('1\n00:00:00,000 --> 00:00:09,000\nHello\n');
        if (url.startsWith('https://api.aniskip.com/')) return new Response('{}', { status: 404 });
        return jsonRes({});
      };
      play({ id: 9001, name: 'Mock Anime', genre_ids: [16] }, 'tv', 1, 5);
      for (let i = 0; i < 60 && !/\.m3u8/.test(el('pvideo').src); i++) await flush(2);
      eq(asked, ['https://tryembed.us.cc/embed/anime/21/5/dub', 'https://anixo.buzz/embed/ani/21/5/dub'], 'dub first; vidnest skipped after tryembed\'s "no stream" (same catalog)');
      eq([el('pvideo').src, el('paudio').textContent, session.direct[0].anime.fellBack], ['https://ex/hls/dubreq.m3u8', 'SUB', true], 'a dub request answered as the sub plays badged SUB');
      ok(/No English dub yet/.test(el('phint').innerHTML), '"No English dub yet — playing subbed"');
      await flush(20);
      ok(el('pcc').classList.contains('on') && el('psubs').textContent === 'Hello', 'captions switched on by themselves (overlay drawn)');
      asked.length = 0;
      act('player-audio');
      for (let i = 0; i < 60 && !/sub\.m3u8/.test(el('pvideo').src); i++) await flush(2);
      eq(getState().prefs.animeAudio, 'sub', 'the switch persists prefs.animeAudio');
      eq([asked[0], el('pvideo').src, el('paudio').textContent], ['https://tryembed.us.cc/embed/anime/21/5/sub', 'https://ex/hls/sub.m3u8', 'SUB'], 'switching replays the episode from the Sub rungs');
      closePlayer();
      await flush(10);

      // The converter: an mkv-only title.
      const { seekTo } = await import('../src/app/player/player.js');
      const vtCalls = [];
      let vtOpenStatus = 429;
      globalThis.fetch = async (u, init = {}) => {
        const url = String(u);
        if (url.startsWith('/api/tmdb/')) return jsonRes({ imdb_id: 'tt0000042' });
        if (url.startsWith('https://torrentio.strem.fun/')) return jsonRes({ streams: [
          { url: 'https://rd/Film.1080p.x264.mkv', name: 'RD+ 1080p', title: 'Film.1080p.BluRay.x264.DTS.mkv', behaviorHints: { filename: 'Film.1080p.BluRay.x264.DTS.mkv' } },
          { url: 'https://rd/Film.720p.x264.mkv', name: 'RD+ 720p', title: 'Film.720p.x264.AAC.mkv', behaviorHints: { filename: 'Film.720p.x264.AAC.mkv' } }] });
        if (url.startsWith('/api/player/animeids')) return jsonRes({ anime: false });
        if (url.startsWith('/api/player/vt/')) {
          vtCalls.push((init.method || 'GET') + ' ' + url.slice('/api/player/vt/'.length) + (init.body ? ' ' + init.body : ''));
          if (init.method === 'DELETE') return jsonRes({ ok: true });
          if (url.endsWith('/seek')) return jsonRes({ id: 'ab', play: 'https://ex/vt/ab/2/index.m3u8?cap=cc', epoch: 2, actualStart: 1800 });
          return vtOpenStatus === 200 ? jsonRes({ id: 'ab', play: 'https://ex/vt/ab/1/index.m3u8?cap=cc', epoch: 1, duration: 5400, actualStart: 0 })
            : jsonRes({ error: 'busy' }, vtOpenStatus);
        }
        if (url.startsWith('/api/resolve')) return jsonRes({ error: 'resolve-502' });
        return jsonRes({});
      };
      play({ id: 4242, title: 'Film', genre_ids: [18] }, 'movie', 1, 1);
      for (let i = 0; i < 80 && session.cur !== 'vidlink'; i++) await flush(2);
      eq(vtCalls, ['POST sessions {"url":"https://rd/Film.1080p.x264.mkv","start":0,"audio":"eng"}'], '429 busy: ONE open, the other remux skipped (never retried)');
      eq([session.cur, session.debrid.map(x => !!x.vt)], ['vidlink', [true, true]], '...and the ladder fell through to the next tiers');
      vtCalls.length = 0; vtOpenStatus = 200;
      play({ id: 4243, title: 'Film 2', genre_ids: [18] }, 'movie', 1, 1);
      for (let i = 0; i < 80 && !/vt\/ab\/1/.test(el('pvideo').src); i++) await flush(2);
      eq([el('pvideo').src, session.vt && session.vt.duration, el('pvtbar').style.display], ['https://ex/vt/ab/1/index.m3u8?cap=cc', 5400, ''], 'remux plays the extractor playlist; converter bar shown');
      seekTo(1800);
      await new Promise(r => setTimeout(r, 450)); await flush(10);
      eq([vtCalls[1], el('pvideo').src, session.vt.baseOffset], ['POST sessions/ab/seek {"start":1800}', 'https://ex/vt/ab/2/index.m3u8?cap=cc', 1800], 'an out-of-window seek restarts generation there (new epoch)');
      closePlayer();
      await flush(5);
      eq(vtCalls[vtCalls.length - 1], 'DELETE sessions/ab', 'closing frees the Mac\'s converter slot');

      // Shared moments, on the real player: every path that can seek starts at `at`.
      const { recordContinue } = await import('../src/app/state.js');
      const mp4 = (name) => ({ url: 'https://rd/' + name, name: 'RD+ 1080p', title: name, behaviorHints: { filename: name } });
      let debridFiles = [mp4('Moment.1080p.WEB.mp4'), mp4('Moment.1080p.WEBRip.mp4')];
      vtCalls.length = 0;
      let vtOpenAnswer = () => jsonRes({ id: 'cd', play: 'https://ex/vt/cd/1/index.m3u8?cap=dd', epoch: 1, duration: 5400, actualStart: 0 });
      globalThis.fetch = async (u, init = {}) => {
        const url = String(u);
        if (url.startsWith('/api/tmdb/') && url.includes('/season/')) return jsonRes({ episodes: [{ episode_number: 1 }, { episode_number: 2 }] });
        if (url.startsWith('/api/tmdb/')) return jsonRes({ imdb_id: 'tt0000077' });
        if (url.startsWith('https://torrentio.strem.fun/')) return jsonRes({ streams: debridFiles });
        if (url.startsWith('/api/player/animeids')) return jsonRes({ anime: false });
        if (url.startsWith('/api/player/vt/')) {
          const body = init.body ? JSON.parse(init.body) : null;
          vtCalls.push((init.method || 'GET') + ' ' + url.slice('/api/player/vt/'.length) + (body ? ' ' + body.start : ''));
          return init.method === 'DELETE' ? jsonRes({ ok: true }) : vtOpenAnswer(body);
        }
        if (url.startsWith('/api/resolve')) return jsonRes({ error: 'resolve-502' });
        return jsonRes({});
      };
      const v = el('pvideo');
      const metadata = (duration) => { v.currentTime = 0; v.duration = duration; v.onloadedmetadata(); return v.currentTime; };
      const waitSrc = async (re) => { for (let i = 0; i < 80 && !re.test(v.src); i++) await flush(2); return v.src; };
      const film = { id: 7070, title: 'Moment Film', genre_ids: [18] };

      // A debrid file (native <video>): the moment, exactly; past the end, the top.
      play(film, 'movie', 1, 1, 754);
      eq(await waitSrc(/Moment/), 'https://rd/Moment.1080p.WEB.mp4', 'a film moment plays the debrid file');
      eq([session.momentAt, metadata(5400)], [754, 754], '...from the moment (< 30 s from the start or not)');
      play(film, 'movie', 1, 1, 6000); await waitSrc(/Moment/);
      eq(metadata(5400), 0, 'a moment past the end plays from the start');
      // The saved resume is untouched: t/0 starts at the top over it; no moment resumes as before.
      recordContinue(film, 'movie', 1, 1, 1200);
      play(film, 'movie', 1, 1, 0); await waitSrc(/Moment/);
      eq([session.resumeAt, session.momentAt, metadata(5400)], [1200, 0, 0], 't/0 starts at the top even with a saved position');
      play(film, 'movie', 1, 1); await waitSrc(/Moment/);
      eq([session.momentAt, metadata(5400)], [null, 1200], 'no moment: the normal resume');
      // A source that dies after playing hands the NEXT rung the playhead, still exact.
      play(film, 'movie', 1, 1, 754); await waitSrc(/Moment/); metadata(5400);
      v.currentTime = 800; v.onerror();
      eq([await waitSrc(/WEBRip/), session.momentAt, metadata(5400)], ['https://rd/Moment.1080p.WEBRip.mp4', 800, 800], 'a failed rung carries the moment to the playhead');
      // Up Next never inherits a moment.
      play({ id: 7071, name: 'Moment Show' }, 'tv', 1, 1, 300);
      eq(session.momentAt, 300, 'an episode moment');
      await flush(20);
      await autoNext(play);
      eq([session.ctx.e, session.momentAt], [2, null], 'Up Next starts the next episode normally');
      closePlayer();
      eq(session.momentAt, null, 'closing forgets the moment');
      await flush(10);

      // The /vt converter: opened AT the moment; past the file's end, once more from the top.
      debridFiles = [{ url: 'https://rd/Moment.1080p.x264.mkv', name: 'RD+ 1080p', title: 'Moment.1080p.BluRay.x264.AAC.mkv', behaviorHints: { filename: 'Moment.1080p.BluRay.x264.AAC.mkv' } }];
      play({ id: 7072, title: 'Moment Mkv', genre_ids: [18] }, 'movie', 1, 1, 754);
      await waitSrc(/vt\/cd/);
      eq(vtCalls, ['POST sessions 754'], 'the converter starts at the moment');
      closePlayer(); await flush(5); vtCalls.length = 0;
      vtOpenAnswer = (b) => b.start > 0 ? jsonRes({ error: 'convert-failed' }, 502) : jsonRes({ id: 'cd', play: 'https://ex/vt/cd/1/index.m3u8?cap=dd', epoch: 1, duration: 5400, actualStart: 0 });
      play({ id: 7073, title: 'Moment Mkv 2', genre_ids: [18] }, 'movie', 1, 1, 6000);
      eq(await waitSrc(/vt\/cd/), 'https://ex/vt/cd/1/index.m3u8?cap=dd', 'past the end: the remux still plays...');
      eq(vtCalls, ['POST sessions 6000', 'POST sessions 0'], '...from the top, after ONE retry');
      closePlayer(); await flush(5); vtCalls.length = 0;
      play({ id: 7074, title: 'Moment Mkv 3', genre_ids: [18] }, 'movie', 1, 1, 999999999);
      await waitSrc(/vt\/cd/);
      eq(vtCalls, ['POST sessions 0'], 'a moment past the Worker\'s 48 h bound opens at 0 (never a 400)');
      closePlayer(); await flush(5); vtCalls.length = 0;
      vtOpenAnswer = () => jsonRes({ error: 'convert-failed' }, 502);
      play({ id: 7075, title: 'Moment Mkv 4', genre_ids: [18] }, 'movie', 1, 1);
      for (let i = 0; i < 80 && session.cur !== 'vidlink'; i++) await flush(2);
      eq(vtCalls, ['POST sessions 0'], 'no moment: a failed remux is never retried');

      // The embed rung: VidLink gets the moment; with none, the URL is unchanged.
      debridFiles = [];
      play(film, 'movie', 1, 1, 754);
      for (let i = 0; i < 80 && session.cur !== 'vidlink'; i++) await flush(2);
      eq(el('pframe').src, 'https://vidlink.pro/movie/7070?autoplay=true&title=false&primaryColor=43e048&startAt=754', 'the embed rung starts VidLink at the moment');
      play(film, 'movie', 1, 1);
      for (let i = 0; i < 80 && session.cur !== 'vidlink'; i++) await flush(2);
      eq(el('pframe').src, 'https://vidlink.pro/movie/7070?autoplay=true&title=false&primaryColor=43e048', '...and without one, exactly as before');
      closePlayer();
      await flush(5);

      // The link itself (views/detail.js viewTitle): a film moment plays; a plain film link still only opens the sheet.
      globalThis.document.querySelectorAll = () => [];   // the season bar's buttons
      const { viewTitle, closeDetail } = await import('../src/app/views/detail.js');
      const ladderFetch = globalThis.fetch;
      globalThis.fetch = async (u, init) => {
        const url = String(u);
        if (url === '/api/tmdb/movie/7080') return jsonRes({ id: 7080, title: 'Linked Film', runtime: 100, genres: [] });
        if (url === '/api/tmdb/tv/7081') return jsonRes({ id: 7081, name: 'Linked Show', genres: [], seasons: [{ season_number: 1, episode_count: 2, name: 'Season 1' }] });
        return ladderFetch(u, init);
      };
      await viewTitle('#title/movie/7080', '#home');
      eq([el('modal').classList.contains('open'), session.ctx], [true, null], 'a plain film link opens the sheet and plays nothing (unchanged)');
      await viewTitle('#title/movie/7080/t/90', '#home');
      eq([session.ctx && session.ctx.it.id, session.ctx && session.ctx.kind, session.momentAt], [7080, 'movie', 90], 'a film moment plays the film from the moment');
      await viewTitle('#title/tv/7081/1/2/t/45', '#home');
      eq([session.ctx.it.id, session.ctx.kind, session.ctx.s, session.ctx.e, session.momentAt], [7081, 'tv', 1, 2, 45], 'an episode moment plays that episode from the moment');
      await viewTitle('#title/tv/7081/1/2', '#home');
      eq([session.ctx.e, session.momentAt], [2, null], 'an episode link without one plays as before');
      closeDetail(); closePlayer();
      await flush(20);
    }
  } finally {
    globalThis.fetch = realFetch;
    globalThis.document = saved.document; globalThis.window = saved.window;
    globalThis.requestAnimationFrame = saved.raf; globalThis.cancelAnimationFrame = saved.caf;
    if (restoreStore) restoreStore();
    if (saved.localStorage) Object.defineProperty(globalThis, 'localStorage', saved.localStorage); else delete globalThis.localStorage;
  }
  return n;
}
