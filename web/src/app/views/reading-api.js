/* Every call the Read tab makes, and the mapping of each source into ONE shape
   (the extractor's /read/* contract, docs/READING-ENGINE.md):

     search  -> [{ source, id, title, cover, year, altTitles }]
     series  -> { source, id, title, cover, description, status, year, authors,
                  genres, altTitles, isLongStrip, url, chapters }
                chapters oldest first: [{ id, number, volume, title, date, pages, external }]
     pages   -> [{ url, width?, height? }]   (a URL an <img> can load as-is)

   Manga sources:
     'mangadex'   MangaDex's API through the Worker (/api/read/mangadex/…: their
                  CORS admits only mangadex.org + localhost), mapped HERE; images
                  straight from MangaDex (load them with referrerpolicy="no-referrer").
     'mangapill'  scraped by the Worker (/api/read/mangapill/…) — works with the Mac off.
     anything else  an extractor engine source (/api/read/…) — needs the Mac.
   Comics: the extractor's /comic/* (/api/comic/…) — needs the Mac.

   The mapping functions are pure and unit-checked against saved API answers
   (test/fixtures/mangadex-*.json). */

import { apiFetch } from '../api.js';

export const LOCAL_SOURCES = [
  { id: 'mangadex', name: 'MangaDex', local: true },
  { id: 'mangapill', name: 'Mangapill', local: true },
];
export const isLocalSource = (id) => id === 'mangadex' || id === 'mangapill';

/** GET a JSON route with a deadline. Resolves { body, headers }; throws an
    Error carrying .status/.code (the server's `error`) on any failure. */
export async function getJSON(path, { timeout = 20000, signal } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  const onAbort = () => ctl.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    let r;
    try { r = await apiFetch(path, { signal: ctl.signal }); }
    catch (e) { throw Object.assign(new Error(ctl.signal.aborted ? 'timeout' : 'network'), { status: 0, code: ctl.signal.aborted ? 'timeout' : 'network' }); }
    let body = null;
    try { body = await r.json(); } catch {}
    if (!r.ok) {
      const code = (body && body.error) || ('http-' + r.status);
      throw Object.assign(new Error(code), { status: r.status, code, body });
    }
    return { body, headers: r.headers };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString();

// ── MangaDex mapping (pure) ────────────────────────────────────────────────────
export const MD_LONG_STRIP_TAG = '3e2b8dae-350e-4ab8-a8ce-016e844b9f0d';
const MD_RATINGS = ['safe', 'suggestive', 'erotica'];
const LATIN = /\p{Script=Latin}/u;
const NON_LATIN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Arabic}\p{Script=Cyrillic}\p{Script=Thai}]/u;

/** English title, else the primary one (an English alt title if that's non-Latin). */
export function mdTitle(title, alt) {
  title = title || {};
  if (title.en) return title.en;
  const first = Object.values(title).find(Boolean);
  const enAlt = (alt || []).map(a => a && a.en).find(Boolean);
  if (first) return (!LATIN.test(first) && enAlt) ? enAlt : first;
  return enAlt || 'Untitled';
}
/** Alt titles another site might list it under: English + romanised first, Latin only, deduped, max 8. */
export function mdLatinAlts(alt) {
  const pref = ['en', 'ja-ro', 'ko-ro', 'zh-ro'];
  const ordered = [];
  for (const l of pref) for (const a of alt || []) if (a && a[l]) ordered.push(a[l]);
  for (const a of alt || []) for (const [k, v] of Object.entries(a || {})) if (!pref.includes(k)) ordered.push(v);
  const seen = new Set();
  return ordered.filter(t => t && LATIN.test(t) && !NON_LATIN.test(t) && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase())).slice(0, 8);
}
export function mdCover(m, size = '.256.jpg') {
  const rel = (m.relationships || []).find(r => r.type === 'cover_art');
  const f = rel && rel.attributes && rel.attributes.fileName;
  return f ? `https://uploads.mangadex.org/covers/${m.id}/${f}${size}` : null;
}
/** A /manga entity -> the series shape (without chapters). */
export function mdMapManga(m, coverSize) {
  const a = m.attributes || {};
  const rel = (t) => (m.relationships || []).filter(r => r.type === t).map(r => r.attributes && r.attributes.name).filter(Boolean);
  return {
    source: 'mangadex', id: m.id,
    title: mdTitle(a.title, a.altTitles),
    cover: mdCover(m, coverSize),
    description: (a.description && (a.description.en || Object.values(a.description).find(Boolean))) || null,
    status: a.status || 'unknown',
    year: a.year || null,
    authors: [...new Set([...rel('author'), ...rel('artist')])],
    genres: (a.tags || []).map(t => t.attributes && t.attributes.name && t.attributes.name.en).filter(Boolean).slice(0, 8),
    altTitles: mdLatinAlts(a.altTitles),
    isLongStrip: (a.tags || []).some(t => t.id === MD_LONG_STRIP_TAG),
    url: 'https://mangadex.org/title/' + m.id,
  };
}
/** /manga/{id}/feed data -> chapters in reading order, one per chapter number
    (the first readable scanlation wins; unnumbered ones all kept, at the end).
    A chapter MangaDex doesn't host (external link, or no pages) carries `external`. */
export function mdMapChapters(feed) {
  const rows = (feed || []).map(c => {
    const a = c.attributes || {};
    const group = (c.relationships || []).find(r => r.type === 'scanlation_group');
    const readable = (a.pages || 0) > 0 && !a.externalUrl;
    const num = a.chapter != null && a.chapter !== '' && !isNaN(Number(a.chapter)) ? Number(a.chapter) : null;
    return {
      id: c.id, number: num, volume: a.volume != null && a.volume !== '' ? a.volume : null,
      title: a.title || null, date: a.readableAt || a.publishAt || null, pages: a.pages || null,
      external: readable ? null : (a.externalUrl || 'https://mangadex.org/chapter/' + c.id),
      group: (group && group.attributes && group.attributes.name) || null,
    };
  });
  const byNum = new Map();
  const loose = [];
  for (const r of rows) {
    if (r.number == null) { loose.push(r); continue; }
    const have = byNum.get(r.number);
    if (!have || (have.external && !r.external)) byNum.set(r.number, r);
  }
  return [...byNum.values()].sort((x, y) => x.number - y.number).concat(loose);
}
/** /at-home/server/{chapter} -> page URLs. */
export function mdPageUrls(atHome, dataSaver = false) {
  const ch = atHome && atHome.chapter;
  if (!atHome || !atHome.baseUrl || !ch || !ch.hash) return [];
  const files = (dataSaver ? ch.dataSaver : ch.data) || [];
  return files.map(f => `${atHome.baseUrl}/${dataSaver ? 'data-saver' : 'data'}/${ch.hash}/${f}`);
}

const md = (path, params, timeout) => getJSON('/api/read/mangadex/' + path + (params ? '?' + params : ''), { timeout }).then(r => r.body);
const mdListParams = (extra) => {
  const p = new URLSearchParams(extra);
  p.append('includes[]', 'cover_art'); p.append('includes[]', 'author');
  for (const r of MD_RATINGS) p.append('contentRating[]', r);
  return p;
};

export async function mdSearch(q, limit = 20) {
  const p = mdListParams({ title: q, limit: String(limit), 'order[relevance]': 'desc' });
  return ((await md('manga', p.toString())).data || []).map(m => mdMapManga(m));
}
/** Most-followed titles with English chapters. */
export async function mdPopular(limit = 20) {
  const p = mdListParams({ limit: String(limit), 'order[followedCount]': 'desc', hasAvailableChapters: 'true', 'availableTranslatedLanguage[]': 'en' });
  return ((await md('manga', p.toString())).data || []).map(m => mdMapManga(m));
}
/** Titles with the newest readable English chapters (latest chapters -> their manga, in order). */
export async function mdLatest(limit = 20) {
  const cp = new URLSearchParams({ limit: '60', 'order[readableAt]': 'desc', 'translatedLanguage[]': 'en', 'includes[]': 'manga' });
  for (const r of MD_RATINGS) cp.append('contentRating[]', r);
  const chapters = (await md('chapter', cp.toString())).data || [];
  const ids = [];
  for (const c of chapters) {
    const a = c.attributes || {};
    if (!(a.pages > 0) || a.externalUrl) continue;
    const m = (c.relationships || []).find(r => r.type === 'manga');
    if (m && !ids.includes(m.id)) ids.push(m.id);
    if (ids.length >= limit) break;
  }
  if (!ids.length) return [];
  const p = mdListParams({ limit: String(ids.length) });
  for (const id of ids) p.append('ids[]', id);
  const byId = new Map(((await md('manga', p.toString())).data || []).map(m => [m.id, mdMapManga(m)]));
  return ids.map(id => byId.get(id)).filter(Boolean);
}
export async function mdSeries(id) {
  const p = new URLSearchParams();
  for (const i of ['cover_art', 'author', 'artist']) p.append('includes[]', i);
  const [m, chapters] = await Promise.all([md('manga/' + id, p.toString()), mdFeed(id)]);
  return { ...mdMapManga(m.data, '.512.jpg'), chapters };
}
/** Every English chapter (the feed pages at 500; stop at 4,000). */
async function mdFeed(id) {
  const all = [];
  for (let offset = 0; offset < 4000; offset += 500) {
    const p = new URLSearchParams({ 'translatedLanguage[]': 'en', 'order[chapter]': 'asc', limit: '500', offset: String(offset), 'includes[]': 'scanlation_group' });
    for (const r of MD_RATINGS) p.append('contentRating[]', r);
    const body = await md(`manga/${id}/feed`, p.toString());
    all.push(...(body.data || []));
    if (!body.data || body.data.length < 500 || offset + 500 >= (body.total || 0)) break;
  }
  return mdMapChapters(all);
}
export async function mdPages(chapterId) {
  return mdPageUrls(await md('at-home/server/' + chapterId, '', 15000)).map(url => ({ url }));
}

// ── Manga: one interface over every source ────────────────────────────────────
export async function mangaSearch(source, q) {
  if (source === 'mangadex') return mdSearch(q);
  if (source === 'mangapill') return (await getJSON('/api/read/mangapill/search?' + qs({ q }))).body || [];
  return (await getJSON('/api/read/search?' + qs({ q, source }), { timeout: 30000 })).body || [];
}
/** All engine sources at once (the extractor fans out). -> { items, partial } */
export async function engineSearchAll(q) {
  const { body, headers } = await getJSON('/api/read/search?' + qs({ q }), { timeout: 25000 });
  return { items: body || [], partial: headers.get('x-read-partial') === '1' };
}
export async function mangaSeries(source, id) {
  if (source === 'mangadex') return mdSeries(id);
  if (source === 'mangapill') return (await getJSON('/api/read/mangapill/series?' + qs({ id }))).body;
  const { body, headers } = await getJSON('/api/read/series?' + qs({ source, id }), { timeout: 55000 });
  return { ...body, stale: headers.get('x-read-stale') === '1' };
}
export async function mangaPages(source, seriesId, chapterId) {
  if (source === 'mangadex') return mdPages(chapterId);
  if (source === 'mangapill') return (await getJSON('/api/read/mangapill/pages?' + qs({ series: seriesId, chapter: chapterId }))).body.pages || [];
  return (await getJSON('/api/read/pages?' + qs({ source, series: seriesId, chapter: chapterId }), { timeout: 35000 })).body.pages || [];
}
/** The engine's sources (cached for the session once answered). null = the Mac didn't answer. */
let engineSourcesCache = null;
export async function engineSources() {
  if (engineSourcesCache) return engineSourcesCache;
  try {
    const { body } = await getJSON('/api/read/sources', { timeout: 15000 });
    const list = ((body && body.sources) || []).filter(s => !isLocalSource(s.id) && (!s.kind || s.kind === 'manga'));
    engineSourcesCache = { engine: body && body.engine, sources: list };
    return engineSourcesCache;
  } catch { return null; }
}

// ── Comics ─────────────────────────────────────────────────────────────────────
let comicSourcesCache = null;
/** /comic/sources minus blocked ones. null = the Mac didn't answer. */
export async function comicSources() {
  if (comicSourcesCache) return comicSourcesCache;
  try {
    const { body } = await getJSON('/api/comic/sources', { timeout: 15000 });
    comicSourcesCache = (Array.isArray(body) ? body : []).filter(s => !s.blocked);
    return comicSourcesCache;
  } catch { return null; }
}
export const comicSearch = (source, q) => getJSON('/api/comic/search?' + qs({ q, source }), { timeout: 28000 }).then(r => r.body || []);
export const comicBrowse = (source, publisher, page) => getJSON('/api/comic/browse?' + qs({ source, publisher, page }), { timeout: 28000 }).then(r => r.body || []);
export const comicDetail = (source, slug) => getJSON('/api/comic/detail?' + qs({ slug, source }), { timeout: 28000 }).then(r => r.body);
/** One look at a comic's pages. A download source's FIRST call starts the
    download; poll every 2 s. An error answer that explains itself (state
    "error" + message/retryable) is returned, not thrown. */
export async function comicPages(source, comic, chapter, retry = false) {
  try {
    return (await getJSON('/api/comic/pages?' + qs({ comic, chapter, source, retry: retry ? '1' : null }), { timeout: 48000 })).body;
  } catch (e) {
    if (e.body && (e.body.state || e.body.message)) return { ...e.body, state: 'error' };
    throw e;
  }
}
/** A comic item's id for /comic/pages: BatCave's numeric `id` (its `slug` navigates); elsewhere the same. */
export const comicPagesId = (detail, slug) => String((detail && detail.id) || slug);

/** The series/download state words a reader can act on (iOS ComicDownloadState.wording). */
export function comicErrorWords(code, message) {
  const e = String(code || '').toLowerCase();
  const known = {
    'too-large': "This issue is bigger than your home server's download limit.",
    'pdf-unsupported': "This issue is a PDF, which isn't supported yet. Try another release of it.",
    'cb7-unsupported': "This issue is a CB7 file, which isn't supported yet. Try another release of it.",
    'encrypted': "This file is password-protected, so it can't be opened.",
    'no-images': 'The download had no pages in it. Try another release of it.',
    'locked': "This issue isn't free to read.",
    'aborted': 'The download was stopped.',
  };
  if (known[e]) return known[e];
  if (/\b(cbr|rar)\b/.test(e)) return "This issue is a CBR file, which isn't supported yet. Try another release of it.";
  if (message && String(message).trim()) return String(message).trim();
  return e ? 'The download failed: ' + e : 'The download failed.';
}
