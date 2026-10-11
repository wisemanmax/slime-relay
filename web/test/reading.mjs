// The Read tab, from node: the Worker's Mangapill parsers (pinned by pages saved
// from mangapill.com on 2026-10-11), the Worker routes with a scripted
// upstream (token never leaves, URLs rewritten, errors stay JSON), MangaDex
// mapping (saved API answers), the reader's rules (long strip, taps, keys,
// steps), progress/resume over a real store, the title match, comic download
// states, the deep routes, and the phone tab bar's width budget at 375 px.
// Run by check.mjs; returns the number of assertions.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  readingRoutes, parseMangapillSearch, parseMangapillSeries, parseMangapillPages, rewriteReadImg, rewriteComicUrl,
  rewriteReadPages, scrubToken, mangapillImageAllowed, mangadexPathAllowed, chapterNumber, readingOrder, htmlText,
} from '../src/worker/reading.js';
import worker from '../src/worker.js';
import { mdMapManga, mdMapChapters, mdPageUrls, mdTitle, mdLatinAlts } from '../src/app/views/reading-api.js';
import { looksLikeLongStrip, initialMode, tapZone, keyAction, prefetchIndices, step, pageCounter, chapterLabel } from '../src/app/reader/logic.js';
import { recordProgress, setSaved, isSaved, continueShelf, savedShelf, resumeTarget, crossSourceEntry, pruneReading, setReaderMode, readingEntry } from '../src/app/reader/progress.js';
import { scoreTitle, bestMatch, normalizeTitle, matchQueries, ACCEPT } from '../src/app/views/reading-match.js';
import { comicChapters, comicState, comicFraction, comicStatusLine, issueNumber } from '../src/app/views/reading-comic.js';
import { comicErrorWords, comicPagesId } from '../src/app/views/reading-api.js';
import { createStore, memoryStorage } from '../src/app/state.js';
import { parseRoute, routeArgs, routeHash, KNOWN } from '../src/app/router.js';
import { M_TABS } from '../src/app/ui/tabbar.js';

const fx = (f) => readFileSync(new URL('./fixtures/' + f, import.meta.url), 'utf8');
const TOKEN = 'tok_SECRET_0123456789abcdef';

/* A scripted upstream: `routes` maps a URL prefix to (url, init) -> Response. */
async function withFetch(routes, fn) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input && input.url ? input.url : input);
    calls.push({ url, headers: Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v])) });
    for (const [prefix, h] of Object.entries(routes)) if (url.startsWith(prefix)) return h(url, init);
    throw new TypeError('unexpected fetch ' + url);
  };
  try { return await fn(calls); } finally { globalThis.fetch = real; }
}
const jsonRes = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
const htmlRes = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const env = { EXTRACTOR_BASE: 'https://slime.example/', SLIME_TOKEN: TOKEN };
const XB = 'https://slime.example';
const route = (path, e = env, init) => readingRoutes(new Request('https://watch.example' + path, init), e, new URL('https://watch.example' + path));

export async function runReadingChecks() {
  let n = 0;
  const eq = (a, b, m) => { assert.deepEqual(a, b, m); n++; };
  const ok = (v, m) => { assert.ok(v, m); n++; };

  // ── Mangapill parsers (fixtures: chainsaw man search / series / chapter 1) ──
  {
    const s = parseMangapillSearch(fx('mangapill-search.html'));
    eq(s.length, 8, 'search: 8 result cards');
    eq(s[0], { source: 'mangapill', id: '723/chainsaw-man', title: 'Chainsaw Man',
               cover: 'https://cdn.readdetectiveconan.com/file/mangapill/i/723.jpeg', year: 2018, altTitles: [] }, 'search: first card');
    ok(s.some(x => x.title === 'Chainsaw Man: Buddy Stories'), 'search: side titles are listed (the match must reject them)');
    eq(new Set(s.map(x => x.id)).size, s.length, 'search: no duplicate ids');

    const se = parseMangapillSeries(fx('mangapill-series.html'), '723/chainsaw-man');
    eq([se.title, se.status, se.year, se.isLongStrip], ['Chainsaw Man', 'completed', 2018, false], 'series: title/status/year/format');
    eq(se.genres, ['Action', 'Comedy', 'Drama', 'Horror', 'Shounen', 'Supernatural'], 'series: genres');
    ok(/^Meet Denji, he's poor\./.test(se.description), 'series: description, entities decoded');
    eq(se.cover, 'https://cdn.readdetectiveconan.com/file/mangapill/i/723.jpeg', 'series: cover (last data-src before the h1)');
    eq(se.chapters.length, 232, 'series: every chapter');
    eq(se.chapters.slice(0, 2).map(c => [c.id, c.number, c.title]),
       [['723-10001000/chainsaw-man-chapter-1', 1, 'Chapter 1'], ['723-10002000/chainsaw-man-chapter-2', 2, 'Chapter 2']], 'series: oldest first');
    eq(se.chapters.at(-1).number, 232, 'series: newest last');
    ok(se.chapters.every((c, i) => i === 0 || c.number > se.chapters[i - 1].number), 'series: strictly ascending');
    eq(parseMangapillSeries('<html>no title here</html>', 'x'), null, 'series: a non-series page -> null');

    const p = parseMangapillPages(fx('mangapill-chapter.html'));
    eq(p.length, 58, 'pages: 58 for chapter 1');
    eq(p[0], { url: 'https://cdn.readdetectiveconan.com/file/mangap/723/10001000/1.jpeg?t=1663049146', width: 1067, height: 1600 }, 'pages: url + size');
    ok(p.every(x => mangapillImageAllowed(x.url)), 'pages: every page host is on the image allowlist');

    eq([chapterNumber('Chapter 1151.5'), chapterNumber('Ch.12'), chapterNumber('one-piece-chapter-1053'), chapterNumber('punch-100'), chapterNumber('Oneshot')],
       [1151.5, 12, 1053, null, null], 'chapterNumber');
    eq(readingOrder([{ number: 3 }, { number: null, t: 'x' }, { number: 2 }, { number: 1 }]).map(c => c.number), [1, 2, 3, null], 'readingOrder: unnumbered last');
    eq(htmlText('a&amp;b<br>c &#8217; &hellip;'), 'a&b\nc ’ …', 'htmlText entities + breaks');
  }

  // ── URL rewriting (pure) ──────────────────────────────────────────────────
  {
    eq(rewriteReadImg('/read/img?u=https%3A%2F%2Fx%2F1.jpg&ref=r&src=mangaplus&m=e30&sig=AbC&key=' + TOKEN),
       '/api/read/img?u=https%3A%2F%2Fx%2F1.jpg&ref=r&src=mangaplus&m=e30&sig=AbC', 'engine image: key dropped, params kept');
    eq(rewriteReadImg('http://192.168.1.5:8787/read/img?u=a&src=s&sig=z&key=k'), '/api/read/img?u=a&src=s&sig=z', 'engine image on an absolute base');
    eq(rewriteReadImg('https://cdn.example/a.jpg'), 'https://cdn.example/a.jpg', 'plain https passes');
    eq([rewriteReadImg('/health'), rewriteReadImg(''), rewriteReadImg(null)], [null, null, null], 'anything else -> null');
    eq(rewriteComicUrl('/comic/file?id=abc&n=3', 'getcomics'), '/api/comic/file?id=abc&n=3', 'comic library page');
    eq(rewriteComicUrl('http://10.0.0.2:8787/comic/file?id=abc&n=3&key=' + TOKEN, 'ia'), '/api/comic/file?id=abc&n=3', 'library page on a base, key dropped');
    eq(rewriteComicUrl('/comic/img?u=https%3A%2F%2Fimg.batcave.biz%2F1.jpg&key=' + TOKEN), '/api/comic/img?u=https%3A%2F%2Fimg.batcave.biz%2F1.jpg', 'wrapped comic image, key dropped');
    eq(rewriteComicUrl({ url: 'https://img.batcave.biz/p/1.jpg', headers: {} }, 'batcave'), '/api/comic/img?u=https%3A%2F%2Fimg.batcave.biz%2Fp%2F1.jpg&source=batcave', 'raw comic page -> proxied with source');
    eq(rewriteComicUrl('javascript:alert(1)', 'x'), null, 'not a URL -> null');
    eq(rewriteReadPages({ pages: [{ url: '/read/img?u=a&src=s&sig=z&key=k', headers: { Referer: 'x' }, width: 10, height: 30 }, { url: '/x' }] }),
       { pages: [{ url: '/api/read/img?u=a&src=s&sig=z', headers: {}, width: 10, height: 30 }] }, 'pages: rewritten, headers emptied, unreachable dropped');
    eq(scrubToken(`{"a":"x?key=${TOKEN}"}`, TOKEN), '{"a":"x?key="}', 'scrubToken');
    eq([mangapillImageAllowed('https://cdn.readdetectiveconan.com/a.jpg'), mangapillImageAllowed('https://mangapill.com/x.png'),
        mangapillImageAllowed('http://cdn.readdetectiveconan.com/a.jpg'), mangapillImageAllowed('https://evilreaddetectiveconan.com/a'),
        mangapillImageAllowed('https://169.254.169.254/'), mangapillImageAllowed('https://cdn.readdetectiveconan.com:8443/a')],
       [true, true, false, false, false, false], 'Mangapill image host allowlist');
    const uuid = 'a1c7c817-4e59-43b7-9365-09675a149a6f';
    eq(['manga', 'chapter', `manga/${uuid}`, `manga/${uuid}/feed`, `at-home/server/${uuid}`].map(mangadexPathAllowed), [true, true, true, true, true], 'MangaDex paths allowed');
    eq(['user/me', `manga/${uuid}/../user`, 'auth/login', `manga/${uuid}/aggregate`, ''].map(mangadexPathAllowed), [false, false, false, false, false], 'other MangaDex paths refused');
  }

  // ── Worker routes against a scripted extractor ──────────────────────────────
  {
    await withFetch({
      [XB + '/read/pages']: () => jsonRes({ pages: [{ url: `/read/img?u=https%3A%2F%2Fa%2F1.jpg&src=mangaplus&sig=S1&key=${TOKEN}`, headers: {}, width: 800, height: 1200 }] }),
      [XB + '/read/search']: () => jsonRes([{ source: 'engine:1', id: '9', title: 'X', cover: { url: `/read/img?u=c&src=engine%3A1&sig=S2&key=${TOKEN}` }, note: `leak ${TOKEN}` }], 200, { 'x-read-partial': '1', 'x-read-benched': '2' }),
      [XB + '/read/series']: () => jsonRes({ error: 'engine down' }, 503, { 'retry-after': '30' }),
      [XB + '/read/sources']: () => htmlRes('<html>Cloudflare tunnel error</html>', 530),
      [XB + '/read/img']: (u) => new URL(u).searchParams.get('sig') === 'HTML'
        ? htmlRes('<script>alert(1)</script>') : new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { 'content-type': 'image/jpeg' } }),
    }, async (calls) => {
      let r = await route('/api/read/pages?source=mangaplus&series=100020&chapter=1000486');
      let body = await r.json();
      eq(body, { pages: [{ url: '/api/read/img?u=https%3A%2F%2Fa%2F1.jpg&src=mangaplus&sig=S1', headers: {}, width: 800, height: 1200 }] }, 'pages: urls ours, no key');
      const c0 = calls.at(-1);
      eq(c0.url, XB + '/read/pages?source=mangaplus&series=100020&chapter=1000486', 'pages: extractor URL (no key in the query)');
      eq(c0.headers.authorization, 'Bearer ' + TOKEN, 'pages: the token rides as a Bearer header');

      r = await route('/api/read/search?q=one%20piece');
      const text = await r.text();
      ok(!text.includes(TOKEN), 'search: the token never reaches the page (cover rewritten, stray copy scrubbed)');
      eq(JSON.parse(text)[0].cover, '/api/read/img?u=c&src=engine%3A1&sig=S2', 'search: {url} cover rewritten');
      eq([r.headers.get('x-read-partial'), r.headers.get('x-read-benched')], ['1', '2'], 'search: x-read-* forwarded');

      r = await route('/api/read/series?source=engine:1&id=9');
      eq([r.status, (await r.json()).error, r.headers.get('retry-after')], [503, 'engine down', '30'], 'series: an extractor error passes through as JSON');
      r = await route('/api/read/sources');
      eq([r.status, (await r.json()).error], [502, 'home-server-unreachable'], 'a non-JSON upstream (tunnel down) -> 502 JSON, never HTML');

      r = await route(`/api/read/img?u=c&src=engine%3A1&sig=S2&key=${TOKEN}`);
      eq([r.status, r.headers.get('content-type'), r.headers.get('x-content-type-options')], [200, 'image/jpeg', 'nosniff'], 'img: streamed with its type');
      ok(!calls.at(-1).url.includes('key='), 'img: key stripped before the extractor call');
      r = await route('/api/read/img?u=c&src=s&sig=HTML');
      eq(r.status, 502, 'img: a non-image upstream body is refused (never served as HTML from our origin)');
      r = await route('/api/read/img?u=c');
      eq(r.status, 400, 'img: unsigned request refused');

      for (const bad of ['/api/read/search?q=', '/api/read/search?q=x&source=a%20b', '/api/read/series?source=s', '/api/read/pages?source=s&series=1']) {
        eq((await route(bad)).status, 400, 'validation: ' + bad);
      }
      r = await route('/api/read/nope');
      eq([r.status, r.headers.get('content-type').startsWith('application/json')], [404, true], 'unknown /api/read path -> 404 JSON');
      r = await route('/api/read/sources', env, { method: 'POST' });
      eq(r.status, 405, 'POST refused');
      r = await route('/api/read/sources', { EXTRACTOR_BASE: XB });
      eq([r.status, (await r.json()).error], [503, 'not-configured'], 'no SLIME_TOKEN -> 503 not-configured');
      eq(await route('/api/tmdb/x'), null, 'other paths pass through (null)');
    });

    await withFetch({
      [XB + '/comic/pages']: (u) => new URL(u).searchParams.get('comic') === 'dl'
        ? jsonRes({ source: 'getcomics', pages: [], state: 'downloading', progress: 0.4, bytes: 4e7, total: 1e8 })
        : jsonRes({ source: 'batcave', pages: ['https://img.batcave.biz/1.jpg', '/comic/file?id=k&n=0', `/comic/img?u=x&key=${TOKEN}`] }),
      [XB + '/comic/search']: () => jsonRes([{ source: 'globalcomix', id: 'a', slug: 'a', title: 'A', cover: 'https://gc.example/c.jpg' }]),
      [XB + '/comic/file']: (u, init) => (init.headers['if-none-match'] === '"k-0"' ? new Response(null, { status: 304 })
        : new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/webp', etag: '"k-0"' } })),
    }, async (calls) => {
      let r = await route('/api/comic/pages?comic=12&chapter=34&source=batcave');
      eq((await r.json()).pages, ['/api/comic/img?u=https%3A%2F%2Fimg.batcave.biz%2F1.jpg&source=batcave', '/api/comic/file?id=k&n=0', '/api/comic/img?u=x'], 'comic pages rewritten');
      r = await route('/api/comic/pages?comic=dl&chapter=g-1&source=getcomics&retry=1');
      const b = await r.json();
      eq([b.state, b.progress], ['downloading', 0.4], 'comic download state passes through');
      ok(calls.at(-1).url.endsWith('retry=1'), 'retry=1 forwarded');
      r = await route('/api/comic/search?q=batman&source=globalcomix');
      eq((await r.json())[0].cover, '/api/comic/img?u=https%3A%2F%2Fgc.example%2Fc.jpg&source=globalcomix', 'comic covers proxied');
      r = await route('/api/comic/file?id=k&n=0');
      eq([r.status, r.headers.get('etag')], [200, '"k-0"'], 'comic file streamed with its etag');
      r = await route('/api/comic/file?id=k&n=0', env, { headers: { 'if-none-match': '"k-0"' } });
      eq(r.status, 304, 'comic file revalidates');
      eq((await route('/api/comic/search?q=x&source=BAD!')).status, 400, 'comic source validated');
    });

    // Mangapill + MangaDex adapters, upstream scripted with the fixtures.
    await withFetch({
      'https://mangapill.com/search': () => htmlRes(fx('mangapill-search.html')),
      'https://mangapill.com/manga/723/chainsaw-man': () => htmlRes(fx('mangapill-series.html')),
      'https://mangapill.com/chapters/': () => htmlRes(fx('mangapill-chapter.html')),
      'https://mangapill.com/manga/1/cf': () => htmlRes('<html><head><title>Just a moment...</title></head></html>', 403),
      'https://cdn.readdetectiveconan.com/': (u) => (u.includes('html') ? htmlRes('<b>403</b>') : new Response(new Uint8Array([0xff, 0xd8]), { headers: { 'content-type': 'image/jpeg' } })),
      'https://api.mangadex.org/': () => jsonRes({ result: 'ok', data: [] }),
    }, async (calls) => {
      let r = await route('/api/read/mangapill/search?q=chainsaw%20man');
      const s = await r.json();
      eq([s.length, s[0].cover], [8, '/api/read/mangapill/img?u=https%3A%2F%2Fcdn.readdetectiveconan.com%2Ffile%2Fmangapill%2Fi%2F723.jpeg'], 'mangapill search: covers through our image proxy');
      ok(calls.at(-1).headers['user-agent'].includes('Mozilla') && calls.at(-1).url.includes('q=chainsaw+man'), 'mangapill search: browser UA, query passed');
      r = await route('/api/read/mangapill/series?id=723/chainsaw-man');
      eq([(await r.json()).chapters.length], [232], 'mangapill series');
      r = await route('/api/read/mangapill/pages?series=723/chainsaw-man&chapter=723-10001000/chainsaw-man-chapter-1');
      const pg = (await r.json()).pages;
      eq([pg.length, pg[0].width, pg[0].url.startsWith('/api/read/mangapill/img?u=')], [58, 1067, true], 'mangapill pages');
      eq(calls.at(-1).headers.referer, 'https://mangapill.com/manga/723/chainsaw-man', 'mangapill pages: series Referer');
      r = await route('/api/read/mangapill/series?id=1/cf');
      eq([r.status, (await r.json()).error], [504, 'provider unreachable: challenge'], 'a Cloudflare page is a challenge verdict');
      r = await route('/api/read/mangapill/img?u=' + encodeURIComponent('https://cdn.readdetectiveconan.com/file/mangap/1.jpeg'));
      eq([r.status, r.headers.get('content-type'), calls.at(-1).headers.referer], [200, 'image/jpeg', 'https://mangapill.com/'], 'mangapill image: fetched with its Referer');
      eq((await route('/api/read/mangapill/img?u=' + encodeURIComponent('https://example.com/a.jpg'))).status, 403, 'mangapill image: other hosts refused (not an open proxy)');
      eq((await route('/api/read/mangapill/img?u=' + encodeURIComponent('https://cdn.readdetectiveconan.com/html'))).status, 502, 'mangapill image: non-image refused');
      eq((await route('/api/read/mangapill/series?id=../../etc')).status, 400, 'mangapill ids validated');
      r = await route('/api/read/mangadex/manga?title=x&includes[]=cover_art');
      eq(calls.at(-1).url, 'https://api.mangadex.org/manga?title=x&includes[]=cover_art', 'mangadex: query passed verbatim');
      ok(/SlimeWatchWeb/.test(calls.at(-1).headers['user-agent']), 'mangadex: identifies itself');
      eq((await route('/api/read/mangadex/user/me')).status, 400, 'mangadex: path allowlist enforced');
    });

    // End to end through the Worker's gate: the module is registered for both prefixes.
    const wenv = { SITE_PASSWORD: 'pw', SESSION_SECRET: 'sec', TMDB_TOKEN: '', EXTRACTOR_BASE: XB };
    const cookie = 'sw_auth=' + createHash('sha256').update('pw:sec').digest('hex');
    const call = (p) => worker.fetch(new Request('https://watch.example' + p, { headers: { cookie } }), wenv);
    let r = await call('/api/read/nope');
    eq([r.status, r.headers.get('content-type').includes('json')], [404, true], 'worker: /api/read/* is dispatched to reading.js');
    r = await call('/api/comic/sources');
    eq([r.status, (await r.json()).error], [503, 'not-configured'], 'worker: /api/comic/* is dispatched to reading.js');
    r = await worker.fetch(new Request('https://watch.example/api/read/sources'), wenv);
    eq(r.status, 302, 'worker: reading routes sit behind the password gate');
  }

  // ── MangaDex mapping (saved API answers) ──────────────────────────────────
  {
    const search = JSON.parse(fx('mangadex-search.json'));
    const m = mdMapManga(search.data[0]);
    eq([m.source, m.id, m.title, m.year], ['mangadex', 'a77742b1-befd-49a4-bff5-1ad4e6b0ef7b', 'Chainsaw Man', 2018], 'manga: ja-ro title used when there is no en');
    ok(/^https:\/\/uploads\.mangadex\.org\/covers\/a77742b1-befd-49a4-bff5-1ad4e6b0ef7b\/[^/]+\.256\.jpg$/.test(m.cover), 'manga: cover URL (256 thumb)');
    ok(m.altTitles.length > 0 && m.altTitles.every(t => /\p{Script=Latin}/u.test(t) && !/[\p{Script=Han}\p{Script=Katakana}\p{Script=Hiragana}\p{Script=Hangul}]/u.test(t)), 'manga: Latin alt titles only');
    eq(search.data.map(x => mdMapManga(x).title).filter(t => /Doujinshi|Colored/.test(t)).length, 4, 'manga: side titles keep their own names');
    const full = mdMapManga(JSON.parse(fx('mangadex-manga.json')).data, '.512.jpg');
    ok(full.cover.endsWith('.512.jpg') && full.description && full.authors.length >= 1, 'manga entity: description, authors, 512 cover');
    eq(mdTitle({ ja: 'ワンピース' }, [{ en: 'One Piece' }]), 'One Piece', 'title: non-Latin primary -> English alt');
    eq(mdLatinAlts([{ ja: 'ワンピース' }, { en: 'One Piece' }, { 'ja-ro': 'one piece' }, { fr: 'Une Pièce' }]), ['One Piece', 'Une Pièce'], 'alt titles: deduped case-insensitively, Latin only');

    const ch = mdMapChapters(JSON.parse(fx('mangadex-feed.json')).data);
    eq(ch.map(c => [c.number, c.pages, c.external]), [[1, 24, null], [2, 30, null], [3, 23, null]], 'feed: readable chapters ascending');
    ok(ch[0].title === 'The Monster Boyfriend and the Dying Girl' && ch[0].date, 'feed: title + date');
    const mk = (id, chapter, pages, ext) => ({ id, attributes: { chapter, pages, externalUrl: ext }, relationships: [] });
    eq(mdMapChapters([mk('a', '2', 0, 'https://mangaplus/x'), mk('b', '1', 10, null), mk('c', '2', 12, null), mk('d', null, 5, null), mk('e', '1', 9, null)])
      .map(c => c.id), ['b', 'c', 'd'], 'feed: one per number, the readable scanlation wins, unnumbered last');
    eq(mdMapChapters([mk('x', '4', 0, 'https://mangaplus/4')])[0].external, 'https://mangaplus/4', 'feed: external-only chapter keeps its link');
    eq(mdMapChapters([mk('y', '5', 0, null)])[0].external, 'https://mangadex.org/chapter/y', 'feed: page-less chapter -> its MangaDex page');

    const ah = JSON.parse(fx('mangadex-athome.json'));
    const urls = mdPageUrls(ah);
    eq(urls.length, ah.chapter.data.length, 'at-home: one URL per page');
    eq(urls[0], `${ah.baseUrl}/data/${ah.chapter.hash}/${ah.chapter.data[0]}`, 'at-home: {baseUrl}/data/{hash}/{file}');
    ok(mdPageUrls(ah, true)[0].includes('/data-saver/'), 'at-home: data saver');
    eq(mdPageUrls(null), [], 'at-home: nothing -> []');
  }

  // ── Reader rules ──────────────────────────────────────────────────────────
  {
    const sz = (w, h) => ({ width: w, height: h });
    eq(looksLikeLongStrip([sz(800, 1200), sz(800, 1200)]), false, 'manga pages: not a strip');
    eq(looksLikeLongStrip([sz(720, 900), sz(720, 4000), sz(720, 5000), sz(720, 3800)]), true, 'webtoon: majority > 2:1 (a title card does not sway it)');
    eq(looksLikeLongStrip([sz(720, 4000), sz(720, 900)]), false, 'a tie is not a majority');
    eq(looksLikeLongStrip([sz(800, 1200), sz(800, 1200), sz(800, 1200), sz(800, 1200), sz(700, 9000), sz(700, 9000), sz(700, 9000)]), false, 'only the first 4 pages are sampled');
    eq([looksLikeLongStrip([]), looksLikeLongStrip([null, sz(0, 0)])], [null, null], 'nothing to judge -> null');
    eq([initialMode({ kind: 'manga' }), initialMode({ kind: 'comic' }), initialMode({ kind: 'manga', formatLongStrip: true }),
        initialMode({ kind: 'manga', measured: true }), initialMode({ kind: 'manga', chosen: 'vertical', formatLongStrip: true }), initialMode({ chosen: 'bogus', kind: 'comic' })],
       ['rtl', 'ltr', 'strip', 'strip', 'vertical', 'ltr'], 'initial mode: choice > strip signal > kind default');
    eq([tapZone(10, 300, 'ltr'), tapZone(290, 300, 'ltr'), tapZone(150, 300, 'ltr'), tapZone(10, 300, 'rtl'), tapZone(290, 300, 'rtl'), tapZone(5, 0, 'ltr')],
       ['prev', 'next', 'menu', 'next', 'prev', 'menu'], 'tap zones (mirrored right-to-left)');
    eq([keyAction('ArrowRight', false, 'ltr'), keyAction('ArrowRight', false, 'rtl'), keyAction('ArrowLeft', false, 'rtl'), keyAction(' ', false, 'ltr'),
        keyAction(' ', true, 'ltr'), keyAction(' ', false, 'strip'), keyAction('ArrowDown', false, 'strip'), keyAction('f', false, 'strip'), keyAction('Escape', false, 'ltr'), keyAction('x', false, 'ltr')],
       ['next', 'prev', 'next', 'next', 'prev', null, null, 'fullscreen', 'close', null], 'keys (space/arrows scroll natively in the scrolling modes)');
    eq([prefetchIndices(0, 10), prefetchIndices(8, 10), prefetchIndices(9, 10)], [[1, 2, 3], [9], []], 'prefetch the next 3');
    eq([step(4, 5, 1), step(5, 5, 1), step(0, 5, -1), step(2, 5, -1)],
       [{ index: 5, end: true }, { index: 5, end: true }, { index: 0, start: true }, { index: 1, end: false }], 'paged steps: last page -> end card; before the first -> start');
    eq([pageCounter(0, 20), pageCounter(19, 20), pageCounter(20, 20), pageCounter(0, 0)], ['1 / 20', '20 / 20', '20 / 20', ''], 'page counter');
    eq([chapterLabel({ number: 12, title: 'The Duel' }), chapterLabel({ number: 12, title: 'Chapter 12' }), chapterLabel({ number: 12.5 }), chapterLabel({ title: 'Extra' }), chapterLabel({})],
       ['Chapter 12 · The Duel', 'Chapter 12', 'Chapter 12.5', 'Extra', 'Oneshot'], 'chapter labels');
    eq(chapterLabel({ label: 'Batman #1', number: 1, title: 'Batman #1' }), 'Batman #1', 'a comic issue keeps its own label');
  }

  // ── Progress + resume over a real store ───────────────────────────────────
  {
    const st = createStore(memoryStorage());
    const info = { kind: 'manga', source: 'mangapill', id: '723/chainsaw-man', title: 'Chainsaw Man', cover: '/api/read/mangapill/img?u=c' };
    const chapters = [1, 2, 3].map(i => ({ id: 'c' + i, number: i }));
    recordProgress({ ...info, chapter: 'c1', chapterLabel: 'Chapter 1', chapterNum: 1, page: 4.7, pages: 20 }, st, 1000);
    const e = st.getState().reading['mangapill:723/chainsaw-man'];
    eq([e.title, e.cover, e.chapter, e.page, e.saved, e.kind, e.source, e.id, e.pages], ['Chainsaw Man', info.cover, 'c1', 4, false, 'manga', 'mangapill', '723/chainsaw-man', 20], 'record: the briefed shape + extras');
    ok(Number.isFinite(e.updatedAt) && e.readAt === 1000, 'record: updatedAt (store-stamped) + readAt');
    eq(resumeTarget(e, chapters), { index: 0, page: 4 }, 'resume: same chapter, same page');
    recordProgress({ ...info, chapter: 'c2', chapterNum: 2, page: 19, pages: 20 }, st, 2000);
    eq(resumeTarget(readingEntry('mangapill', '723/chainsaw-man', st), chapters), { index: 2, page: 0 }, 'resume: a finished chapter moves to the next');
    recordProgress({ ...info, chapter: 'c3', chapterNum: 3, page: 19, pages: 20 }, st, 3000);
    eq(resumeTarget(readingEntry('mangapill', '723/chainsaw-man', st), chapters), { index: 2, page: 0 }, 'resume: the last chapter finished stays on it');
    eq(resumeTarget({ chapter: 'other-source-id', chapterNum: 2, page: 7, pages: 20 }, chapters), { index: 1, page: 0 }, 'resume: by chapter number across sources');
    eq([resumeTarget(null, chapters), resumeTarget({ chapter: null }, chapters), resumeTarget({ chapter: 'zz' }, chapters)], [null, null, null], 'resume: nothing to resume');

    setSaved({ kind: 'manga', source: 'mangadex', id: 'u1', title: 'Saved One', cover: null }, true, st, 4000);
    ok(isSaved('mangadex', 'u1', st), 'save');
    recordProgress({ kind: 'comic', source: 'getcomics', id: 'slug-x', comic: 'slug-x', title: 'Batman #1', cover: null, chapter: 'g-1', page: 2, pages: 30 }, st, 5000);
    eq(continueShelf(st.getState().reading).map(x => x.key), ['getcomics:slug-x', 'mangapill:723/chainsaw-man'], 'Continue Reading: opened titles, newest read first (saved-only titles excluded)');
    setSaved(info, true, st, 6000);
    eq(continueShelf(st.getState().reading)[0].key, 'getcomics:slug-x', 'saving does not reorder Continue Reading');
    eq(savedShelf(st.getState().reading).map(x => x.key), ['mangapill:723/chainsaw-man', 'mangadex:u1'], 'Saved: newest save first');
    setSaved({ source: 'mangadex', id: 'u1' }, false, st, 7000);
    ok(!('mangadex:u1' in st.getState().reading), 'unsaving a never-opened title removes it…');
    ok('mangadex:u1' in (st.getState().tombs.reading || {}), '…and the store tombstones the removal for sync');
    setSaved(info, false, st, 8000);
    eq([isSaved('mangapill', '723/chainsaw-man', st), readingEntry('mangapill', '723/chainsaw-man', st).chapter], [false, 'c3'], 'unsaving a title with progress keeps the progress');
    setReaderMode(info, 'strip', st);
    eq(readingEntry('mangapill', '723/chainsaw-man', st).mode, 'strip', 'reader mode kept per title');
    eq(crossSourceEntry(st.getState().reading, 'CHAINSAW MAN', 'mangadex:zzz').key, 'mangapill:723/chainsaw-man', 'cross-source resume finds the same title on another source');
    eq(crossSourceEntry(st.getState().reading, 'Chainsaw Man', 'mangapill:723/chainsaw-man'), null, '…but not itself');

    const big = {};
    for (let i = 0; i < 10; i++) big['s:' + i] = { chapter: 'c', updatedAt: i, saved: i === 0 };
    eq(Object.keys(pruneReading(big, 3)).sort(), ['s:0', 's:7', 's:8', 's:9'], 'prune: saved kept + the newest others');
  }

  // ── Title match ("Read from") ──────────────────────────────────────────────
  {
    eq([normalizeTitle('[Oshi no Ko]'), normalizeTitle('SPY×FAMILY'), normalizeTitle('The Promised Neverland'), normalizeTitle('Pokémon Adventures')],
       ['oshi no ko', 'spy x family', 'promised neverland', 'pokemon adventures'], 'normalize');
    eq(scoreTitle('Chainsaw Man', 'Chainsaw Man'), 100, 'exact');
    eq(scoreTitle('Dandadan', 'Dan Da Dan'), 95, 'spacing');
    ok(scoreTitle('One Piece', 'One Piece Party') < ACCEPT, 'a side title is rejected');
    ok(scoreTitle('Chainsaw Man', 'Chainsaw Man - Digital Colored Comics') < ACCEPT, 'a coloured edition is rejected');
    ok(scoreTitle('Jujutsu Kaisen', 'Jujutsu Kaisen 0') < ACCEPT, 'one extra word is another book');
    const hits = parseMangapillSearch(fx('mangapill-search.html'));
    eq(bestMatch(['Chainsaw Man'], 2018, hits).item.id, '723/chainsaw-man', 'best match on the Mangapill results');
    eq(bestMatch(['Chainsaw Man'], null, hits.filter(h => h.id !== '723/chainsaw-man')), null, 'no acceptable match -> null');
    eq(matchQueries('Chainsaw Man', ['チェンソーマン', 'chainsaw man', 'Chensoman']), ['Chainsaw Man', 'Chensoman'], 'queries: title + distinct Latin alts');
  }

  // ── Comics: chapters, download states ─────────────────────────────────────
  {
    eq(comicChapters({ title: 'Saga #54', chapters: [] }, 'saga-54').map(c => [c.id, c.number]), [['saga-54', 54]], 'a single-file item is its own issue');
    eq(comicChapters({ chapters: [{ id: '3', title: 'X #3' }, { id: '2', title: 'X #2' }, { id: '1', title: 'X #1' }] }, 's').map(c => c.id), ['1', '2', '3'], 'newest-first issues flipped to reading order');
    eq(comicChapters({ chapters: [{ id: 'g-1', title: 'Main', readable: false, size: '40 MB', hosts: ['pixeldrain'] }] }, 's')[0].locked, true, 'a group with no direct host is locked');
    eq(comicChapters({ chapters: [{ id: '1', title: 'Batman #1' }] }, 's')[0].label, 'Batman #1', 'issues carry their title as the reader label');
    eq(comicPagesId({ id: '9123' }, '9123-batman'), '9123', 'BatCave pages use its numeric id');
    eq(issueNumber('Batman (2016) Issue 12'), 12, 'issue number');
    eq([comicState({ state: 'downloading' }), comicState({ state: 'extracting' }), comicState({ state: 'queued' }), comicState({ state: 'error' }),
        comicState({ pages: ['a'] }), comicState({ pages: [], error: 'x' }), comicState({ state: 'weird', pages: [] })],
       ['downloading', 'downloading', 'queued', 'error', 'ready', 'error', 'downloading'], 'download states (lenient)');
    eq([comicFraction({ progress: 0.62 }), comicFraction({ bytes: 25, total: 100 }), comicFraction({})], [0.62, 0.25, null], 'progress fraction');
    eq(comicStatusLine({ state: 'downloading', progress: 0.62, total: 48e6 }), 'Downloading 48 MB… 62%', 'status line');
    eq(comicStatusLine({ state: 'queued', position: 2 }), 'Waiting for another download to finish… (#2 in line)', 'queued line');
    eq(comicStatusLine({ state: 'error', error: 'resolve-timeout', message: 'GetComics took too long.' }), 'GetComics took too long.', "the server's sentence for codes we don't word");
    eq(comicErrorWords('pdf-unsupported'), "This issue is a PDF, which isn't supported yet. Try another release of it.", 'known code worded');
    eq(comicErrorWords('library-full-cbr'), "This issue is a CBR file, which isn't supported yet. Try another release of it.", 'cbr detected');
  }

  // ── Routes + the tab bar ─────────────────────────────────────────────────
  {
    ok(KNOWN.includes('read'), 'read is a route');
    eq([parseRoute('#read').tab, parseRoute('#read/manga/mangapill/1').tab, parseRoute('#read').pills], ['read', 'read', false], 'Read lights its own tab, no pills');
    const h = routeHash('read', 'r', 'engine:2131', '723/chainsaw-man', 'ch 1?x');
    eq(h, '#read/r/engine%3A2131/723%2Fchainsaw-man/ch%201%3Fx', 'routeHash encodes each segment');
    eq(routeArgs(h), ['r', 'engine:2131', '723/chainsaw-man', 'ch 1?x'], 'routeArgs decodes them back');
    eq(routeArgs('#read'), [], 'no args');
    eq(routeArgs('#read/%E0%A4%A'), ['%E0%A4%A'], 'malformed escapes are kept, not thrown');

    // Width budget at 375 px from phone.css's #tabbar rule: inset, padding, border.
    const css = readFileSync(new URL('../src/app/styles/phone.css', import.meta.url), 'utf8');
    const rule = css.match(/#tabbar\{display:flex;[^}]*\}/)[0];
    const px = (prop) => Number((rule.match(new RegExp('[;{\\s]' + prop + ':(\\d+)px')) || [])[1]);
    const inner = 375 - px('left') - px('right') - 2 * px('padding') - 2 * 1;   // 1px border
    const per = inner / M_TABS.length;
    eq(M_TABS.map(t => t[0]), ['home', 'search', 'live', 'read', 'list'], 'five tabs, Read before My Stuff');
    eq([px('left'), px('right'), px('padding'), Math.round(per * 10) / 10], [10, 10, 5, 68.6], 'geometry snapshot: 68.6 px per tab at 375 px');
    // Label: 9 px / weight 800 / .2 px tracking; ~0.62 em per glyph is generous for bold sans.
    for (const [, glyph, label] of M_TABS) {
      const labelW = label.length * (9 * 0.62 + 0.2);
      const glyphW = glyph.startsWith('<svg') ? 17 : [...glyph].length * 17 * 0.62;
      ok(labelW + 8 <= per && glyphW + 8 <= per, `"${label}" fits its ${per.toFixed(1)} px tab`);
    }
    ok(per >= 44, 'every tab stays a 44 px+ touch target');
  }
  return n;
}
