// /api/player/* — the player's extractor proxies (W2). Behind the password
// gate (src/worker/modules.js). Every extractor call carries
// `authorization: Bearer ${env.SLIME_TOKEN}`; the token never reaches the page
// and nothing here forwards the viewer's cookie. Params are validated before
// anything leaves; every failure is JSON.
//
//   GET    /api/player/subs?tmdb=&kind=&s=&e=[&abs=]       -> {subs:[{lang,name,url}]}
//          the extractor's subtitle index lookup (/subs). `abs`: the absolute
//          episode, for anime past season 1 (see the extractor's lib/subindex.js)
//   GET    /api/player/animeids?tmdb=&kind=&s=&e=[&abs=]   -> {anime:false} |
//          {anime:true, anilistId, malId, episode, absolute}
//          the extractor's TMDB->AniList map (/animeids). For a series past
//          season 1 whose map has NO entry for that season (the lookup falls
//          back to the season-1 entry, as One Piece's single entry does), the
//          episode is asked again by its absolute number (`abs`) — the apps'
//          AnimeSource.aniRef rule; the extractor alone answers per-season.
//   POST   /api/player/vt/sessions          {url, start?, audio?}  -> {id, play, epoch, duration, actualStart, videoMode, audioMode}
//   POST   /api/player/vt/sessions/<id>/seek {start}             -> {id, play, epoch, actualStart}
//   DELETE /api/player/vt/sessions/<id>                           -> {ok:true}
//          the /vt converter (SlimeWatchExtractor/vt.js). `play` comes back
//          ABSOLUTE on EXTRACTOR_BASE; it carries the session's own capability
//          (?cap=), never the token, so the page fetches playlists and segments
//          straight from the extractor (CORS *) — no media pass-through here.
//          429 busy (one job at a time) · 502 can't remux · 422 refused source ·
//          503 not configured / extractor refused us · 504 unreachable.
//   GET    /api/player/skip?mal=&ep=        -> AniSkip's JSON (op/ed). The page
//          asks api.aniskip.com itself (it sends ACAO *); this is its fallback.
//   GET    /api/player/subfile?u=<https url> -> the subtitle file's bytes, for a
//          host the browser can't fetch (CORS). Allowlisted hosts only.
//   GET    /api/player/markers?tmdb=&kind=&s=&e=  -> TheIntroDB's intro / recap /
//          credits / preview windows for the title (Wave 8), reduced to the fields
//          the page reads (markers.js sanitizeIntroDB); {} when the title isn't in
//          the database. The page asks api.theintrodb.org itself first; this is
//          its fallback. Answers (incl. "not found") are kept 6 h in this isolate
//          and by the browser — TheIntroDB allows 30 requests per 10 s per address,
//          and every visitor shares the Worker's — failures are never kept.
//          502 upstream error · 504 unreachable.

import { INTRODB_BASE, sanitizeIntroDB } from '../app/player/markers.js';

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const json = (obj, status = 200, cache) => new Response(JSON.stringify(obj), {
  status, headers: cache ? { ...JSON_HEADERS, 'cache-control': cache } : JSON_HEADERS,
});
const err = (status, error) => json({ error }, status);

/** A whole number in [min, max] from a query/body value, else null. Pure. */
export function intParam(v, min, max) {
  if (typeof v === 'number') v = String(v);
  if (typeof v !== 'string' || !/^\d{1,9}$/.test(v)) return null;
  const n = Number(v);
  return n >= min && n <= max ? n : null;
}

/** The title params shared by /subs and /animeids, validated. -> {ok, q} | {ok:false, error} */
export function titleParams(sp) {
  const tmdb = intParam(sp.get('tmdb'), 1, 99999999);
  const kind = sp.get('kind');
  if (!tmdb) return { ok: false, error: 'bad-tmdb' };
  if (kind !== 'movie' && kind !== 'tv') return { ok: false, error: 'bad-kind' };
  const q = { tmdb, kind };
  if (kind === 'tv') {
    const s = intParam(sp.get('s'), 0, 500), e = intParam(sp.get('e'), 1, 20000);
    if (s == null || e == null) return { ok: false, error: 'bad-episode' };
    q.season = s; q.episode = e;
    const rawAbs = sp.get('abs');
    if (rawAbs != null && rawAbs !== '') {
      const abs = intParam(rawAbs, 1, 100000);
      if (abs == null) return { ok: false, error: 'bad-abs' };
      q.abs = abs;
    }
  }
  return { ok: true, q };
}

/** The extractor's /vt `play` path -> the absolute URL the page fetches, or
    null for anything that isn't a converter playlist. Pure. */
export function vtPlayUrl(base, play) {
  if (typeof base !== 'string' || typeof play !== 'string') return null;
  if (!/^\/vt\/[a-z0-9]{1,64}\/\d{1,6}\/index\.m3u8\?cap=[A-Za-z0-9]{8,128}$/i.test(play)) return null;
  return base.replace(/\/+$/, '') + play;
}

/** A session id as the extractor mints them (hex). */
const VT_ID = /^[a-z0-9]{1,64}$/i;

/** Hosts /subfile will fetch for the page. sub.wyzie.io is what the
    extractor's /subs lists; its own /vtt URLs already send CORS. */
export const SUBFILE_HOSTS = new Set(['sub.wyzie.io']);

function extractor(env) {
  if (!env.SLIME_TOKEN || !env.EXTRACTOR_BASE) return null;
  return String(env.EXTRACTOR_BASE).replace(/\/+$/, '');
}

/** One extractor call: bearer token, bounded. -> {status, data} ; status 0 = unreachable/timeout. */
async function callExtractor(env, path, { method = 'GET', body, timeoutMs = 10000 } = {}) {
  const base = extractor(env);
  const headers = { authorization: `Bearer ${env.SLIME_TOKEN}`, accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  try {
    const r = await fetch(base + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let data = null;
    try { data = await r.json(); } catch (_) { data = null; }
    return { status: r.status, data };
  } catch (e) {
    return { status: 0, data: null, timeout: !!(e && e.name === 'TimeoutError') };
  }
}

const qstr = (o) => Object.entries(o).filter(([, v]) => v != null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
const cleanStr = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, '').slice(0, n);

async function readJsonBody(request, cap = 8192) {
  if (!/^application\/json\b/i.test(request.headers.get('content-type') || '')) return null;
  if (Number(request.headers.get('content-length')) > cap) return null;   // don't read what we'd refuse
  const text = await request.text();
  if (text.length > cap) return null;
  try { const j = JSON.parse(text || '{}'); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch (_) { return null; }
}

// ── routes ───────────────────────────────────────────────────────────────────

async function subs(env, sp) {
  const v = titleParams(sp); if (!v.ok) return err(400, v.error);
  const { tmdb, kind, season, episode, abs } = v.q;
  const r = await callExtractor(env, '/subs?' + qstr({ tmdb, kind, season, episode, abs }));
  if (r.status !== 200 || !r.data) return json({ subs: [], error: r.status ? 'subs-' + r.status : 'subs-unreachable' }, 502);
  const list = (Array.isArray(r.data.subs) ? r.data.subs : [])
    .filter(x => x && typeof x.url === 'string' && /^https?:\/\//i.test(x.url) && x.url.length < 2048)
    .slice(0, 40)
    .map(x => ({ lang: cleanStr(x.lang || 'und', 16), name: cleanStr(x.name || x.lang || 'Subtitles', 60), url: x.url }));
  return json({ subs: list }, 200, 'private, max-age=600');
}

const idsOf = (d) => (d && Number(d.anilistId) > 0
  ? { anilistId: Number(d.anilistId), malId: Number(d.malId) > 0 ? Number(d.malId) : 0, episode: Math.max(1, Number(d.episode) || 1) }
  : null);

async function animeids(env, sp) {
  const v = titleParams(sp); if (!v.ok) return err(400, v.error);
  const { tmdb, kind, season, episode, abs } = v.q;
  const ask = (s, e) => callExtractor(env, '/animeids?' + qstr({ tmdb, kind, season: s, episode: e }), { timeoutMs: 8000 });
  const first = await ask(season, episode);
  if (first.status !== 200) return err(first.status ? 502 : 504, first.status ? 'animeids-' + first.status : 'animeids-unreachable');
  const per = idsOf(first.data);
  if (!per) return json({ anime: false }, 200, 'private, max-age=3600');
  // Past season 1 with an absolute number to try: does the map know THIS
  // season, or did it fall back to the season-1 entry?
  if (kind === 'tv' && season > 1 && abs && abs !== episode) {
    const [s1, absolute] = await Promise.all([ask(1, 1), ask(1, abs)]);
    const one = s1.status === 200 && idsOf(s1.data), byAbs = absolute.status === 200 && idsOf(absolute.data);
    if (one && byAbs && one.anilistId === per.anilistId) {
      return json({ anime: true, ...byAbs, absolute: true }, 200, 'private, max-age=3600');
    }
  }
  return json({ anime: true, ...per, absolute: false }, 200, 'private, max-age=3600');
}

/** Extractor /vt status -> ours (see the header). Pure. */
export function vtStatus(status) {
  if (status === 200 || status === 429 || status === 502 || status === 404 || status === 409) return status;
  if (status === 0) return 504;                     // unreachable / timed out
  if (status === 400 || status === 403) return 422; // the extractor refused this source
  return 503;                                       // 401 (our token) and anything else
}
const vtError = (r) => (r.status === 0 ? (r.timeout ? 'timeout' : 'unreachable')
  : r.status === 401 ? 'extractor-auth'
  : cleanStr((r.data && r.data.error) || ('vt-' + r.status), 80));

async function vtCreate(env, request) {
  const b = await readJsonBody(request); if (!b) return err(400, 'bad-body');
  const url = typeof b.url === 'string' ? b.url : '';
  if (!/^https?:\/\/[^\s]+$/i.test(url) || url.length > 4096) return err(400, 'bad-url');
  const start = b.start == null ? 0 : Number(b.start);
  if (!Number.isFinite(start) || start < 0 || start > 172800) return err(400, 'bad-start');
  const audio = b.audio == null || b.audio === '' ? undefined : String(b.audio);
  if (audio !== undefined && !['eng', 'jpn'].includes(audio)) return err(400, 'bad-audio');
  // 40 s: the server's own worst legitimate open (15 s ffprobe + 20 s
  // first-segment wait). Shorter abandons opens it would have completed.
  const r = await callExtractor(env, '/vt/sessions', {
    method: 'POST', timeoutMs: 40000,
    body: { sourceURL: url, start, profile: 'apple', ...(audio ? { audioPreference: audio } : {}) },
  });
  const status = vtStatus(r.status);
  if (status !== 200) return json({ error: vtError(r) }, status);
  const d = r.data || {};
  const play = vtPlayUrl(extractor(env), d.play);
  if (!play || typeof d.id !== 'string' || !VT_ID.test(d.id)) return err(502, 'vt-bad-answer');
  return json({
    id: d.id, play, epoch: Number(d.epoch) || 1,
    duration: Number(d.duration) || 0, actualStart: Number.isFinite(Number(d.actualStart)) ? Number(d.actualStart) : start,
    videoMode: cleanStr(d.videoMode, 16), audioMode: cleanStr(d.audioMode, 16),
  });
}

async function vtSeek(env, request, id) {
  const b = await readJsonBody(request); if (!b) return err(400, 'bad-body');
  const start = Number(b.start);
  if (typeof b.start !== 'number' || !Number.isFinite(start) || start < 0 || start > 172800) return err(400, 'bad-start');
  // 30 s: the seek waits up to 20 s for the new epoch's first segment.
  const r = await callExtractor(env, `/vt/sessions/${id}/seek`, { method: 'POST', body: { start }, timeoutMs: 30000 });
  const status = vtStatus(r.status);
  if (status !== 200) return json({ error: vtError(r) }, status);
  const d = r.data || {};
  const play = vtPlayUrl(extractor(env), d.play);
  if (!play) return err(502, 'vt-bad-answer');
  return json({ id, play, epoch: Number(d.epoch) || 0, actualStart: Number.isFinite(Number(d.actualStart)) ? Number(d.actualStart) : start });
}

async function vtDelete(env, id) {
  const r = await callExtractor(env, `/vt/sessions/${id}`, { method: 'DELETE', timeoutMs: 8000 });
  if (r.status === 200) return json({ ok: true });
  return json({ ok: false, error: vtError(r) }, vtStatus(r.status));
}

async function skip(sp) {
  const mal = intParam(sp.get('mal'), 1, 9999999), ep = intParam(sp.get('ep'), 1, 20000);
  if (!mal || !ep) return err(400, 'bad-params');
  try {
    const r = await fetch(`https://api.aniskip.com/v2/skip-times/${mal}/${ep}?types[]=op&types[]=ed&episodeLength=0`, {
      headers: { accept: 'application/json', 'user-agent': 'SlimeWatch' }, signal: AbortSignal.timeout(10000),
    });
    if (r.status === 404) return json({ found: false, results: [] }, 200, 'private, max-age=3600');
    if (!r.ok) return err(502, 'aniskip-' + r.status);
    const j = await r.json();
    const results = Array.isArray(j && j.results) ? j.results.slice(0, 20).map(x => ({
      skipType: cleanStr(x && x.skipType, 16),
      episodeLength: Number(x && x.episodeLength) || 0,
      interval: { startTime: Number(x && x.interval && x.interval.startTime) || 0, endTime: Number(x && x.interval && x.interval.endTime) || 0 },
    })) : [];
    return json({ found: !!(j && j.found), results }, 200, 'private, max-age=3600');
  } catch (_) {
    return err(504, 'aniskip-unreachable');
  }
}

/* TheIntroDB answers per title / episode, newest last (a Map keeps insertion
   order, so the first key is the oldest). Per isolate: a cold isolate asks again. */
export const MARKERS_TTL_MS = 6 * 3600 * 1000;
const MARKERS_MAX = 500;
const markerCache = new Map();
const markerKey = (q) => q.kind === 'movie' ? 'm' + q.tmdb : `t${q.tmdb}:${q.season}:${q.episode}`;

async function markers(sp) {
  const v = titleParams(sp); if (!v.ok) return err(400, v.error);
  const q = v.q, key = markerKey(q), now = Date.now();
  const hit = markerCache.get(key);
  if (hit && now - hit.at < MARKERS_TTL_MS) return json(hit.body, 200, 'private, max-age=21600');
  const url = INTRODB_BASE + '?tmdb_id=' + q.tmdb + (q.kind === 'tv' ? `&season=${q.season}&episode=${q.episode}` : '');
  let r, body;
  try {
    r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'SlimeWatch' }, signal: AbortSignal.timeout(8000) });
  } catch (_) {
    return err(504, 'introdb-unreachable');
  }
  if (r.status === 404) body = {};   // "media not found": a real answer, kept like one
  else if (!r.ok) return err(502, 'introdb-' + r.status);
  else {
    try { body = sanitizeIntroDB(await r.json()); } catch (_) { return err(502, 'introdb-bad-answer'); }
  }
  markerCache.delete(key);
  markerCache.set(key, { body, at: now });
  if (markerCache.size > MARKERS_MAX) markerCache.delete(markerCache.keys().next().value);
  return json(body, 200, 'private, max-age=21600');
}

async function subfile(sp) {
  let u; try { u = new URL(sp.get('u') || ''); } catch (_) { return err(400, 'bad-url'); }
  if (u.protocol !== 'https:' || !SUBFILE_HOSTS.has(u.hostname) || u.username || u.password || u.port) return err(400, 'host-not-allowed');
  try {
    const r = await fetch(u.toString(), { headers: { 'user-agent': 'SlimeWatch' }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    if (!r.ok) return err(502, 'subfile-' + r.status);
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 2 * 1024 * 1024) return err(502, 'subfile-too-large');
    return new Response(buf, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' } });
  } catch (_) {
    return err(504, 'subfile-unreachable');
  }
}

/** The module's handler (src/worker/modules.js). */
export async function playerRoutes(request, env, url) {
  const p = url.pathname;
  if (!p.startsWith('/api/player/')) return null;
  const route = p.slice('/api/player/'.length);
  const m = request.method;
  const sp = url.searchParams;

  if (route === 'skip') return m === 'GET' ? skip(sp) : err(405, 'method');
  if (route === 'subfile') return m === 'GET' ? subfile(sp) : err(405, 'method');
  if (route === 'markers') return m === 'GET' ? markers(sp) : err(405, 'method');   // W8 (TheIntroDB)

  // Everything below talks to the extractor.
  if (!['subs', 'animeids'].includes(route) && !route.startsWith('vt/')) return err(404, 'not-found');
  if (!extractor(env)) return err(503, 'not-configured');
  if (route === 'subs') return m === 'GET' ? subs(env, sp) : err(405, 'method');
  if (route === 'animeids') return m === 'GET' ? animeids(env, sp) : err(405, 'method');
  if (route === 'vt/sessions') return m === 'POST' ? vtCreate(env, request) : err(405, 'method');
  let mm = /^vt\/sessions\/([^/]+)\/seek$/.exec(route);
  if (mm) {
    if (!VT_ID.test(mm[1])) return err(400, 'bad-id');
    return m === 'POST' ? vtSeek(env, request, mm[1]) : err(405, 'method');
  }
  mm = /^vt\/sessions\/([^/]+)$/.exec(route);
  if (mm) {
    if (!VT_ID.test(mm[1])) return err(400, 'bad-id');
    return m === 'DELETE' ? vtDelete(env, mm[1]) : err(405, 'method');
  }
  return err(404, 'not-found');
}
