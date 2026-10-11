// Every call the player makes to its own Worker routes (src/worker/player.js),
// in one file — the /api/player/* counterpart of api.js:
//   GET    /api/player/subs?tmdb=&kind=&s=&e=[&abs=]       subtitle index (extractor /subs)
//   GET    /api/player/animeids?tmdb=&kind=&s=&e=[&abs=]   TMDB -> AniList/MAL (extractor /animeids)
//   POST   /api/player/vt/sessions          {url, start, audio}  -> converter session
//   POST   /api/player/vt/sessions/<id>/seek {start}            -> new epoch
//   DELETE /api/player/vt/sessions/<id>
//   GET    /api/player/skip?mal=&ep=        AniSkip, when the browser can't reach it
//   GET    /api/player/subfile?u=           a subtitle file, when its host refuses CORS
// The extractor token never reaches the page: the Worker adds it.

import { apiFetch } from '../api.js';

const qs = (o) => Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');

async function getJSON(path, ms) {
  try {
    const r = await apiFetch(path, { signal: AbortSignal.timeout(ms) });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) { return null; }   // incl. a login bounce: apiFetch is already sending the app to /login
}

/** -> [{lang, name, url}] (never throws; [] on any miss). */
export async function fetchIndexSubs(ctx, abs) {
  const j = await getJSON('/api/player/subs?' + qs({ tmdb: ctx.it.id, kind: ctx.kind, s: ctx.kind === 'tv' ? ctx.s : '', e: ctx.kind === 'tv' ? ctx.e : '', abs }), 12000);
  return (j && Array.isArray(j.subs)) ? j.subs : [];
}

/** -> {anime:false} | {anime:true, anilistId, malId, episode, absolute}; null when unreachable. */
export function fetchAnimeIds(ctx, abs) {
  return getJSON('/api/player/animeids?' + qs({ tmdb: ctx.it.id, kind: ctx.kind, s: ctx.kind === 'tv' ? ctx.s : '', e: ctx.kind === 'tv' ? ctx.e : '', abs }), 9000);
}

/** AniSkip proxied (the browser call is tried first, in skip.js). */
export function fetchSkipProxy(malId, ep) {
  return getJSON('/api/player/skip?' + qs({ mal: malId, ep }), 9000);
}

/** A subtitle file's raw bytes through the Worker (allowlisted hosts only). */
export async function fetchSubfileProxy(url) {
  try {
    const r = await apiFetch('/api/player/subfile?' + qs({ u: url }), { signal: AbortSignal.timeout(15000) });
    return r.ok ? await r.arrayBuffer() : null;
  } catch (_) { return null; }
}

async function send(method, path, body, ms, extra) {
  try {
    const r = await apiFetch(path, Object.assign({
      method, signal: AbortSignal.timeout(ms),
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }, extra || {}));
    let j = null; try { j = await r.json(); } catch (_) {}
    return { status: r.status, ok: r.ok, body: j || {} };
  } catch (e) {
    return { status: 0, ok: false, body: { error: (e && e.name === 'TimeoutError') ? 'timeout' : 'network' } };
  }
}

/* The converter's own budgets (ConverterClient.swift): an open may take the
   server's 15 s ffprobe + 20 s first-segment wait; a seek up to 20 s. Cutting
   below them abandons work the server would have finished. */
export const vtOpenRequest = (url, start, audio) => send('POST', '/api/player/vt/sessions', { url, start, audio }, 45000);
export const vtSeekRequest = (id, start) => send('POST', '/api/player/vt/sessions/' + encodeURIComponent(id) + '/seek', { start }, 35000);
/** Fire-and-forget; keepalive so it still goes out when the tab is closing. */
export const vtCloseRequest = (id) => send('DELETE', '/api/player/vt/sessions/' + encodeURIComponent(id), null, 8000, { keepalive: true });
