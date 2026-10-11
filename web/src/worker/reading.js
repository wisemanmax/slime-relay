/* Reading routes (the Read tab): manga + comics, behind the password gate.

     /api/read/sources|search|series|pages   the extractor's reading engine (/read/*)
     /api/read/img                           one engine image (cover or page)
     /api/read/mangapill/search|series|pages Mangapill scraped HERE, so manga reads with the Mac off
     /api/read/mangapill/img?u=              a Mangapill CDN image (it 403s without its Referer)
     /api/read/mangadex/<api path>           MangaDex's JSON API, passed through (see below)
     /api/comic/sources|search|browse|detail|pages|library   the extractor's comics (/comic/*)
     /api/comic/img, /api/comic/file         comic images / a downloaded issue's pages

   The extractor token (env.SLIME_TOKEN) rides as a Bearer header and NEVER
   reaches the page: the engine mints its image URLs as `/read/img?…&key=<token>`,
   so every URL in an answer is rewritten to `/api/read/img?<same params>` with
   `key=` dropped (the signature covers u/ref/src/m, not the key), and every
   proxied JSON body is scrubbed of the token as a backstop.

   MangaDex: its API answers CORS only for mangadex.org and localhost origins
   (checked 2026-10-11 — no Access-Control-Allow-Origin for watch.byheir.com),
   so the browser cannot call it directly. This passes an allowlisted set of
   read-only paths through, unchanged; the app maps the JSON itself. Images
   (uploads.mangadex.org covers, *.mangadex.network pages) still load straight
   from MangaDex — with referrerpolicy="no-referrer", because a third-party
   Referer gets their "read this at mangadex.org" placeholder instead.

   Every error is JSON `{error}`. Nothing here is a 200 HTML page: an unknown
   /api path would otherwise fall through to the app shell, which api.js reads
   as a login bounce. */

export const MP_BASE = 'https://mangapill.com';
const MP_REFERER = 'https://mangapill.com/';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const MD_API = 'https://api.mangadex.org/';
const MD_UA = 'SlimeWatchWeb/1.0 (private reader)';

/* Deadlines. The engine's own are longer than a plain proxy's 15 s, and
   cutting it off early loses the answer it was about to give: the all-sources
   search waits 20 s for stragglers then answers partial; a single-source
   search gets 25 s; a first-load series 45 s (engine scrape), pages 30 s
   (docs/READING-ENGINE.md "Reliability"). Ours sit just past each. */
export const T = {
  short: 15000,         // sources, library, MangaDex, Mangapill HTML
  searchAll: 23000,     // /read/search with no source (20 s fan-out)
  searchOne: 28000,     // /read/search?source= (25 s)
  series: 48000,        // /read/series (45 s)
  pages: 33000,         // /read/pages (30 s)
  comic: 25000,         // comic search/browse/detail (BatCave drives a browser)
  comicPages: 45000,    // comic pages (BatCave: a slow headless nav; the apps allow 45 s)
  img: 30000,
};

// ── small helpers ──────────────────────────────────────────────────────────────
function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}
const fail = (error, status) => json({ error }, status);
const coded = (error, status) => Object.assign(new Error(error), { error, status });
const isTimeout = (e) => e && (e.name === 'TimeoutError' || e.name === 'AbortError');

/** Remove every occurrence of the token from a string (a backstop for JSON we pass on). */
export function scrubToken(text, token) {
  return token && token.length >= 8 ? String(text).split(token).join('') : String(text);
}

/* Parameter checks. Ids are opaque strings from the sources; bound their
   length and refuse control characters rather than guess at their shape. */
const okStr = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max && !/[\u0000-\u001f]/.test(s);
const okSource = (s) => okStr(s, 80) && /^[A-Za-z0-9:._-]+$/.test(s);
const okComicSource = (s) => /^[a-z0-9-]{2,32}$/.test(s || '');
const okPage = (s) => /^\d{1,4}$/.test(s || '');

// ── URL rewriting (pure; unit-checked) ─────────────────────────────────────────
/** An engine image URL -> ours. `/read/img?u=…&sig=…&key=TOKEN` (relative, or
    on any base) becomes `/api/read/img?u=…&sig=…`. A plain https URL passes
    through; anything else (another extractor-relative path the browser can't
    reach) becomes null. */
export function rewriteReadImg(u) {
  if (typeof u !== 'string' || !u) return null;
  const m = u.match(/^(?:https?:\/\/[^/?#]+)?\/read\/img\?(.*)$/i);
  if (m) {
    const q = new URLSearchParams(m[1]);
    q.delete('key');
    return '/api/read/img?' + q.toString();
  }
  return /^https:\/\//i.test(u) ? u : null;
}

/** A comic page or cover -> a URL the page can load: a downloaded issue's
    `/comic/file?id=&n=` -> `/api/comic/file?id=&n=`; an already-wrapped
    `/comic/img?…` -> `/api/comic/img?…` minus `key`; a source's raw https URL
    -> `/api/comic/img?u=<it>&source=<source>` (the extractor fetches it with
    the source's Referer, or its browser for BatCave). Strings or {url}. */
export function rewriteComicUrl(p, source) {
  const raw = typeof p === 'string' ? p : (p && typeof p.url === 'string' ? p.url : '');
  if (!raw) return null;
  let m = raw.match(/^(?:https?:\/\/[^/?#]+)?\/comic\/file\?(.*)$/i);
  if (m) {
    const q = new URLSearchParams(m[1]);
    return '/api/comic/file?' + new URLSearchParams({ id: q.get('id') || '', n: q.get('n') || '' }).toString();
  }
  m = raw.match(/^(?:https?:\/\/[^/?#]+)?\/comic\/img\?(.*)$/i);
  if (m) {
    const q = new URLSearchParams(m[1]);
    q.delete('key');
    return '/api/comic/img?' + q.toString();
  }
  if (!/^https?:\/\//i.test(raw)) return null;
  const q = new URLSearchParams({ u: raw });
  if (source) q.set('source', source);
  return '/api/comic/img?' + q.toString();
}

/** `/read/pages` answer -> the same shape with every url ours. */
export function rewriteReadPages(body) {
  const pages = Array.isArray(body && body.pages) ? body.pages : [];
  return {
    ...body,
    pages: pages.map(pg => {
      const url = rewriteReadImg(typeof pg === 'string' ? pg : pg && pg.url);
      if (!url) return null;
      const out = { url, headers: {} };
      if (pg && pg.width > 0) out.width = pg.width;
      if (pg && pg.height > 0) out.height = pg.height;
      return out;
    }).filter(Boolean),
  };
}

const withCover = (it, fn) => (it && typeof it === 'object' && 'cover' in it ? { ...it, cover: fn(it.cover) } : it);
/** Engine cover: a string or { url, headers }. */
const readCover = (c) => rewriteReadImg(typeof c === 'string' ? c : c && c.url);

// ── Mangapill (the Worker's own on-the-edge source) ────────────────────────────
/* Ported from the iOS MangapillSource + ReadingHTML (regex over the
   server-rendered HTML; no DOM). Pinned by test/fixtures/mangapill-*.html,
   captured 2026-10-11. */
const rx = (p, flags) => new RegExp(p, flags);
function allMatches(pattern, s) {
  return [...String(s).matchAll(rx(pattern, 'gis'))].map(m => m.slice(1).map(x => (x == null ? '' : x)));
}
function firstMatch(pattern, s) {
  const m = rx(pattern, 'is').exec(String(s));
  return m ? m.slice(1).map(x => (x == null ? '' : x)) : null;
}
/** Capture group 1 of the first match, trimmed; null when absent or empty. */
function group(pattern, s) {
  const f = firstMatch(pattern, s);
  const g = f && f[0] != null ? f[0].trim() : '';
  return g || null;
}
/** `html` cut into chunks, each starting at a match of `pattern`. */
function chunks(html, pattern) {
  const starts = [...String(html).matchAll(rx(pattern, 'gis'))].map(m => m.index);
  return starts.map((st, i) => html.slice(st, i + 1 < starts.length ? starts[i + 1] : html.length));
}
/** Outer HTML of the <tag> whose opening tag contains `marker`, nesting counted. */
function element(tag, marker, html) {
  const lower = html.toLowerCase();
  const at = lower.indexOf(marker.toLowerCase());
  if (at < 0) return null;
  const open = lower.lastIndexOf('<' + tag.toLowerCase(), at);
  if (open < 0) return null;
  const re = rx('<(/?)' + tag + '\\b[^>]*>', 'gi');
  re.lastIndex = open;
  let depth = 0, m;
  while ((m = re.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(open, re.lastIndex);
  }
  return html.slice(open);
}
const escRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function attribute(name, tag) { return group('\\s' + escRx(name) + '\\s*=\\s*["\']([^"\']*)["\']', tag); }

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', rsquo: '\u2019', lsquo: '\u2018',
  rdquo: '\u201d', ldquo: '\u201c', hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', times: '\u00d7' };
export function decodeEntities(s) {
  s = String(s);
  if (!s.includes('&')) return s;
  return s.replace(/&(#[0-9]+|#x[0-9a-f]+|[a-z]+);/gi, (m, b) => {
    if (b[0] === '#') {
      const cp = b[1] === 'x' || b[1] === 'X' ? parseInt(b.slice(2), 16) : parseInt(b.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    return NAMED[b.toLowerCase()] ?? m;
  });
}
/** Visible text: <br> and </p> become breaks, tags go, entities decode, spaces collapse. */
export function htmlText(html) {
  let s = String(html).replace(/<br\s*\/?>/gi, '\n').replace(/<\/p\s*>/gi, '\n\n').replace(/<[^>]+>/g, '');
  s = decodeEntities(s).split('\n').map(l => l.replace(/[ \t\u00a0]+/g, ' ').trim()).join('\n');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}
const line = (html) => htmlText(html).replace(/\s+/g, ' ');
function absUrl(raw, base = MP_BASE) {
  const s = decodeEntities(String(raw || '').trim());
  if (!s || /^javascript:/i.test(s) || s === '#') return null;
  if (s.startsWith('//')) return 'https:' + s;
  try { return new URL(s, base).href; } catch { return null; }
}
/** "Chapter 1151.5", "Ch.12", "one-piece-chapter-1053" -> number; null for oneshots/extras. */
export function chapterNumber(t) {
  const n = group('\\b(?:chapter|chap|ch)[\\s._-]*(\\d+(?:\\.\\d+)?)', t) || group('(?:^|/)c(\\d+(?:\\.\\d+)?)/?$', t);
  return n == null ? null : Number(n);
}
/** Sites list newest first (sometimes mixed) -> reading order: ascending by
    number, stable for ties; unnumbered entries keep their order at the end. */
export function readingOrder(chapters) {
  const asc = [...chapters].reverse();
  const numbered = asc.map((c, i) => [c, i]).filter(([c]) => c.number != null)
    .sort((a, b) => (a[0].number - b[0].number) || (a[1] - b[1])).map(([c]) => c);
  return numbered.concat(asc.filter(c => c.number == null));
}
const splitAlt = (raw) => raw.split(/[,;]/).map(s => s.trim()).filter(Boolean);
function normalisedStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.includes('publishing')) return 'ongoing';
  if (s.includes('finished')) return 'completed';
  return s || 'unknown';
}
const labelled = (label, html) => {
  const g = group('<label[^>]*>\\s*' + label + '\\s*</label>\\s*<div[^>]*>([^<]*)</div>', html);
  return g ? line(g) : null;
};

/** `/search?q=` -> [{ source, id, title, cover, year, altTitles }] (cover = the raw CDN URL). */
export function parseMangapillSearch(html) {
  const seen = new Set();
  const out = [];
  for (const card of chunks(html, '<a href="/manga/[^"]+" class="relative block"')) {
    const slug = group('<a href="/manga/([^"]+)"', card);
    const rawTitle = group('line-clamp-2[^"]*">([^<]*)</div>', card);
    if (!slug || !rawTitle || seen.has(slug)) continue;
    seen.add(slug);
    const alt = group('text-secondary mt-1">([^<]*)</div>', card);
    const year = group('bg-orange-500[^"]*">\\s*(\\d{4})\\s*</div>', card);
    out.push({
      source: 'mangapill', id: slug, title: line(rawTitle),
      cover: absUrl(group('data-src="([^"]+)"', card)),
      year: year ? Number(year) : null,
      altTitles: alt ? splitAlt(line(alt)) : [],
    });
  }
  return out;
}

/** The series page's chapter links, in reading order (oldest first). */
export function parseMangapillChapters(html) {
  const list = element('div', 'id="chapters"', html) || html;
  return readingOrder(allMatches('<a [^>]*href="/chapters/([^"]+)"[^>]*>(.*?)</a>', list).map(([id, inner]) => {
    const label = line(inner);
    return { id, number: chapterNumber(label) ?? chapterNumber(id), volume: null, title: label || null,
             date: null, pages: null, external: null };
  }));
}

/** `/manga/{id}` -> the `/read/series` shape (chapters oldest first). null if it isn't a series page. */
export function parseMangapillSeries(html, id) {
  const h1 = firstMatch('<h1[^>]*>(.*?)</h1>', html);
  if (!h1) return null;
  const before = html.slice(0, Math.max(0, html.indexOf('<h1')));
  const covers = allMatches('data-src="([^"]+)"', before);
  const alt = group('</h1>\\s*<div class="text-sm[^"]*">(.*?)</div>', html);
  const type = labelled('Type', html);
  const year = labelled('Year', html);
  const desc = group('<p class="text-sm text--secondary">(.*?)</p>', html);
  return {
    source: 'mangapill', id,
    title: line(h1[0]),
    cover: covers.length ? absUrl(covers[covers.length - 1][0]) : null,
    description: desc ? htmlText(desc) : null,
    status: normalisedStatus(labelled('Status', html)),
    year: year && /^\d{4}$/.test(year) ? Number(year) : null,
    authors: [],
    genres: allMatches('href="/search\\?genre=[^"]*">([^<]*)</a>', html).map(g => line(g[0])).filter(Boolean),
    altTitles: alt ? splitAlt(line(alt)) : [],
    // Mangapill dropped manhwa in 2026 but still labels the type.
    isLongStrip: ['manhwa', 'manhua', 'webtoon'].includes((type || '').toLowerCase()),
    url: MP_BASE + '/manga/' + id,
    chapters: parseMangapillChapters(html),
  };
}

/** `/chapters/{id}` -> [{ url, width, height }] (raw CDN URLs). */
export function parseMangapillPages(html) {
  let tags = allMatches('(<img[^>]*class="[^"]*js-page[^"]*"[^>]*>)', html).map(x => x[0]);
  if (!tags.length) tags = allMatches('<picture>\\s*(<img[^>]*>)', html).map(x => x[0]);
  return tags.map(tag => {
    const url = absUrl(attribute('data-src', tag));
    if (!url) return null;
    const w = Number(attribute('width', tag)) || null, h = Number(attribute('height', tag)) || null;
    return { url, width: w, height: h };
  }).filter(Boolean);
}

/** The hosts Mangapill's covers and pages live on (cdn.readdetectiveconan.com
    answered 403 without `Referer: https://mangapill.com/`, 200 with it). */
export function mangapillImageAllowed(u) {
  let p;
  try { p = new URL(u); } catch { return false; }
  if (p.protocol !== 'https:' || p.username || p.password || (p.port && p.port !== '443')) return false;
  const h = p.hostname.toLowerCase();
  return ['readdetectiveconan.com', 'mangapill.com'].some(d => h === d || h.endsWith('.' + d));
}
export const mangapillImg = (u) => (u ? '/api/read/mangapill/img?' + new URLSearchParams({ u }).toString() : null);

/** A Cloudflare (or similar) interstitial instead of the page. */
function isChallenge(body) {
  const head = String(body).slice(0, 6000);
  return /<title>Just a moment/i.test(head) || head.includes('cf-browser-verification') ||
    head.includes('challenge-platform') || /Attention Required! \| Cloudflare/i.test(head);
}

async function mangapillHtml(path, referer) {
  let r;
  try {
    r = await fetch(MP_BASE + path, {
      headers: { 'user-agent': BROWSER_UA, referer: referer || MP_REFERER, accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(T.short),
      cf: { cacheEverything: true, cacheTtl: 600 },
    });
  } catch (e) {
    throw coded(isTimeout(e) ? 'provider unreachable: timeout' : 'provider unreachable', 504);
  }
  const body = await r.text();
  if (isChallenge(body)) throw coded('provider unreachable: challenge', 504);
  if (r.status === 404) throw coded('not found', 404);
  if (!r.ok) throw coded('source error', 502);
  return body;
}

const MP_SERIES_ID = /^\d{1,7}\/[A-Za-z0-9._-]{1,160}$/;
const MP_CHAPTER_ID = /^\d{1,7}-\d{1,12}\/[A-Za-z0-9._-]{1,200}$/;

async function mangapillRoute(sub, p) {
  if (sub === 'search') {
    const q = (p.get('q') || '').trim();
    if (!okStr(q, 200)) return fail('bad request', 400);
    const html = await mangapillHtml('/search?' + new URLSearchParams({ q, type: '', status: '' }).toString());
    return json(parseMangapillSearch(html).map(it => ({ ...it, cover: mangapillImg(it.cover) })), 200, { 'cache-control': 'private, max-age=300' });
  }
  if (sub === 'series') {
    const id = p.get('id') || '';
    if (!MP_SERIES_ID.test(id)) return fail('bad request', 400);
    const s = parseMangapillSeries(await mangapillHtml('/manga/' + id), id);
    if (!s) return fail('source error', 502);
    return json({ ...s, cover: mangapillImg(s.cover) }, 200, { 'cache-control': 'private, max-age=300' });
  }
  if (sub === 'pages') {
    const series = p.get('series') || '', chapter = p.get('chapter') || '';
    if (!MP_CHAPTER_ID.test(chapter) || (series && !MP_SERIES_ID.test(series))) return fail('bad request', 400);
    const html = await mangapillHtml('/chapters/' + chapter, series ? MP_BASE + '/manga/' + series : MP_REFERER);
    const pages = parseMangapillPages(html);
    if (!pages.length) return fail('source error', 502);
    return json({ pages: pages.map(pg => ({ ...pg, url: mangapillImg(pg.url), headers: {} })) }, 200, { 'cache-control': 'private, max-age=3600' });
  }
  if (sub === 'img') {
    const u = p.get('u') || '';
    if (!okStr(u, 2000) || !mangapillImageAllowed(u)) return fail('host not allowed', 403);
    let r;
    try {
      r = await fetch(u, {
        headers: { 'user-agent': BROWSER_UA, referer: MP_REFERER, accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
        signal: AbortSignal.timeout(T.img),
        cf: { cacheEverything: true, cacheTtl: 604800 },
      });
    } catch (e) {
      return fail(isTimeout(e) ? 'timeout' : 'unreachable', 504);
    }
    return imageResponse(r, 'public, max-age=604800, immutable');
  }
  return fail('not found', 404);
}

// ── MangaDex passthrough ───────────────────────────────────────────────────────
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const MD_PATH = new RegExp(`^(?:manga|chapter|manga/${UUID}|manga/${UUID}/feed|at-home/server/${UUID})$`);
export const mangadexPathAllowed = (path) => MD_PATH.test(path);

async function mangadexRoute(path, url) {
  if (!mangadexPathAllowed(path) || url.search.length > 4000) return fail('bad request', 400);
  let r;
  try {
    r = await fetch(MD_API + path + url.search, {
      headers: { 'user-agent': MD_UA, accept: 'application/json' },
      signal: AbortSignal.timeout(T.short),
    });
  } catch (e) {
    return fail(isTimeout(e) ? 'timeout' : 'unreachable', 504);
  }
  const text = await r.text();
  if (!/^\s*[{[]/.test(text)) return fail(r.status === 429 ? 'rate limited' : 'source error', r.status === 429 ? 429 : 502);
  // at-home base URLs are short-lived (and per request); catalogue answers can sit a few minutes.
  const cache = path.startsWith('at-home/') || !r.ok ? 'no-store' : 'private, max-age=300';
  return new Response(text, { status: r.status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache } });
}

// ── The extractor (engine + comics) ────────────────────────────────────────────
async function extractor(env, path, params, timeoutMs, headers = {}) {
  if (!env.SLIME_TOKEN || !env.EXTRACTOR_BASE) throw coded('not-configured', 503);
  const target = new URL(String(env.EXTRACTOR_BASE).replace(/\/+$/, '') + path);
  for (const [k, v] of params) target.searchParams.append(k, v);
  try {
    return await fetch(target.toString(), {
      headers: { authorization: `Bearer ${env.SLIME_TOKEN}`, ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw coded(isTimeout(e) ? 'timeout' : 'home-server-unreachable', isTimeout(e) ? 504 : 502);
  }
}

/** Read an extractor JSON answer (scrubbed of the token). A non-JSON answer —
    the tunnel's own error page while the Mac is off — is a 502, never passed on. */
async function extractorJson(r, env) {
  const text = scrubToken(await r.text(), env.SLIME_TOKEN);
  let body;
  try { body = JSON.parse(text); } catch { throw coded('home-server-unreachable', 502); }
  return body;
}

const FORWARD = ['x-read-partial', 'x-read-benched', 'x-read-stale', 'x-read-stale-age', 'retry-after'];
function forwarded(r) {
  const h = {};
  for (const k of FORWARD) { const v = r.headers.get(k); if (v != null) h[k] = v; }
  return h;
}

/** JSON route: fetch, map a 200 body with `map`, pass errors (status + body) through. */
async function proxyJson(env, path, params, timeoutMs, map) {
  const r = await extractor(env, path, params, timeoutMs, { accept: 'application/json' });
  const body = await extractorJson(r, env);
  const out = r.ok && map ? map(body) : body;
  return json(r.ok ? out : (out && typeof out === 'object' && !Array.isArray(out) ? out : { error: 'error' }), r.status, forwarded(r));
}

/** Stream an image back. Only image/* is passed (an HTML body served from this
    origin would be same-origin with the app); errors stay JSON. */
function imageResponse(r, cache, extra = {}) {
  if (r.status === 304) return new Response(null, { status: 304, headers: { 'cache-control': cache, ...extra } });
  const ct = r.headers.get('content-type') || '';
  if (!r.ok) {
    try { r.body && r.body.cancel(); } catch {}
    return fail(r.status === 404 ? 'not found' : r.status === 410 ? 'expired' : r.status === 403 ? 'forbidden' : 'image error',
      [403, 404, 410, 429, 503, 504].includes(r.status) ? r.status : 502);
  }
  if (!/^image\//i.test(ct)) {
    try { r.body && r.body.cancel(); } catch {}
    return fail('not an image', 502);
  }
  const headers = { 'content-type': ct, 'cache-control': cache, 'x-content-type-options': 'nosniff',
                    'content-security-policy': "default-src 'none'", ...extra };
  const len = r.headers.get('content-length');
  if (len) headers['content-length'] = len;
  return new Response(r.body, { status: 200, headers });
}

async function engineRoute(sub, p, env) {
  if (sub === 'sources') return proxyJson(env, '/read/sources', [], T.short);
  if (sub === 'search') {
    const q = (p.get('q') || '').trim(), source = p.get('source');
    if (!okStr(q, 200) || (source != null && !okSource(source))) return fail('bad request', 400);
    const params = [['q', q]];
    if (source) params.push(['source', source]);
    return proxyJson(env, '/read/search', params, source ? T.searchOne : T.searchAll,
      (list) => (Array.isArray(list) ? list.map(it => withCover(it, readCover)) : []));
  }
  if (sub === 'series') {
    const source = p.get('source'), id = p.get('id');
    if (!okSource(source) || !okStr(id, 400)) return fail('bad request', 400);
    return proxyJson(env, '/read/series', [['source', source], ['id', id]], T.series, (s) => withCover(s, readCover));
  }
  if (sub === 'pages') {
    const source = p.get('source'), series = p.get('series'), chapter = p.get('chapter');
    if (!okSource(source) || !okStr(series, 400) || !okStr(chapter, 400)) return fail('bad request', 400);
    return proxyJson(env, '/read/pages', [['source', source], ['series', series], ['chapter', chapter]], T.pages, rewriteReadPages);
  }
  if (sub === 'img') {
    const params = [...p].filter(([k]) => k !== 'key');
    if (!p.get('sig') || !p.get('src') || params.reduce((n, [k, v]) => n + k.length + v.length, 0) > 8000) return fail('bad request', 400);
    const r = await extractor(env, '/read/img', params, T.img);
    return imageResponse(r, 'public, max-age=86400');
  }
  return fail('not found', 404);
}

async function comicRoute(sub, p, env, request) {
  const source = p.get('source');
  if (source != null && !okComicSource(source)) return fail('bad request', 400);
  const src = source ? [['source', source]] : [];
  const covers = (list) => (Array.isArray(list) ? list.map(it => withCover(it, c => rewriteComicUrl(c, (it && it.source) || source))) : []);
  if (sub === 'sources') return proxyJson(env, '/comic/sources', [], T.short);
  if (sub === 'library') return proxyJson(env, '/comic/library', [], T.short, covers);
  if (sub === 'search') {
    const q = (p.get('q') || '').trim(), page = p.get('page');
    if (!okStr(q, 200) || (page != null && !okPage(page))) return fail('bad request', 400);
    return proxyJson(env, '/comic/search', [['q', q], ...(page ? [['page', page]] : []), ...src], T.comic, covers);
  }
  if (sub === 'browse') {
    const publisher = p.get('publisher'), page = p.get('page');
    if ((publisher != null && !okStr(publisher, 100)) || (page != null && !okPage(page))) return fail('bad request', 400);
    return proxyJson(env, '/comic/browse', [...(publisher ? [['publisher', publisher]] : []), ...(page ? [['page', page]] : []), ...src], T.comic, covers);
  }
  if (sub === 'detail') {
    const slug = p.get('slug') || p.get('id') || '';
    if (!okStr(slug, 400)) return fail('bad request', 400);
    return proxyJson(env, '/comic/detail', [['slug', slug], ...src], T.comic,
      (d) => withCover(d, c => rewriteComicUrl(c, (d && d.source) || source)));
  }
  if (sub === 'pages') {
    const comic = p.get('comic'), chapter = p.get('chapter');
    if (!okStr(comic, 400) || !okStr(chapter, 400)) return fail('bad request', 400);
    const params = [['comic', comic], ['chapter', chapter], ...src];
    if (p.get('retry') === '1') params.push(['retry', '1']);
    return proxyJson(env, '/comic/pages', params, T.comicPages, (b) => ({
      ...b,
      pages: (Array.isArray(b && b.pages) ? b.pages : []).map(pg => rewriteComicUrl(pg, (b && b.source) || source)).filter(Boolean),
    }));
  }
  if (sub === 'img') {
    const u = p.get('u') || '', ref = p.get('ref');
    if (!okStr(u, 4000) || (ref != null && !okStr(ref, 2000))) return fail('bad request', 400);
    const params = [['u', u], ...src, ...(ref ? [['ref', ref]] : [])];
    const r = await extractor(env, '/comic/img', params, T.img);
    return imageResponse(r, 'public, max-age=86400');
  }
  if (sub === 'file') {
    const id = p.get('id'), n = p.get('n');
    if (!okStr(id, 200) || !/^\d{1,5}$/.test(n || '')) return fail('bad request', 400);
    const inm = request.headers.get('if-none-match');
    const r = await extractor(env, '/comic/file', [['id', id], ['n', n]], T.img, inm ? { 'if-none-match': inm } : {});
    const etag = r.headers.get('etag');
    return imageResponse(r, 'private, max-age=604800, immutable', etag ? { etag } : {});
  }
  return fail('not found', 404);
}

// ── Entry (src/worker/modules.js registers this for /api/read/ and /api/comic/) ──
export async function readingRoutes(request, env, url) {
  const path = url.pathname;
  const inRead = path.startsWith('/api/read/'), inComic = path.startsWith('/api/comic/');
  if (!inRead && !inComic) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'method' }, 405, { allow: 'GET, HEAD' });
  const p = url.searchParams;
  try {
    if (inComic) return await comicRoute(path.slice('/api/comic/'.length), p, env, request);
    const sub = path.slice('/api/read/'.length);
    if (sub.startsWith('mangadex/')) return await mangadexRoute(sub.slice('mangadex/'.length), url);
    if (sub.startsWith('mangapill/')) return await mangapillRoute(sub.slice('mangapill/'.length), p);
    return await engineRoute(sub, p, env);
  } catch (e) {
    if (e && e.error) return fail(e.error, e.status || 502);
    return fail('error', 502);
  }
}
