// Every call the SPA makes to its own Worker goes through here, so the full
// list of endpoints it depends on is in one file:
//   /api/tmdb/*        TMDB proxy (token stays server-side)
//   /api/rdcheck       validate a pasted Real-Debrid token      (header x-rd-key)
//   /api/rdkey         the owner's default RD token, if set
//   /api/debrid        server-side Torrentio fallback            (header x-rd-key)
//   /api/resolve       ad-free tier: embed URL -> direct stream via the extractor
//   /api/live/channels, /api/live/resolve   Live TV + Sports via the extractor
// Torrentio itself is called straight from the browser (player/debrid.js).

/* The worker 302s any /api/* call to /login once the session cookie is missing
   or stale, and fetch FOLLOWS redirects — so the caller gets 200 + the login
   page's HTML and every JSON parse throws. The app used to report that as a
   network error, a bad TMDB_TOKEN, or a missing SLIME_TOKEN: one expired cookie,
   three different wrong diagnoses, none of them mentioning signing in. Detect the
   bounce once, here. */
export function loginBounce(r) {
  try { if (r.redirected && new URL(r.url).pathname.startsWith('/login')) return true; } catch (e) {}
  // A JSON endpoint answering 200 with HTML is the login page in disguise.
  return r.ok && (r.headers.get('content-type') || '').includes('text/html');
}

/** fetch() for /api/* routes: a session bounce sends the whole app to /login. */
export async function apiFetch(path, opts) {
  const r = await fetch(path, opts);
  if (loginBounce(r)) { location.href = '/login'; throw new Error('session-expired'); }
  return r;
}

/** TMDB via the Worker proxy. Resolves to the parsed JSON, or null on any failure. */
export const api = async (path) => { try { const r = await apiFetch('/api/tmdb/' + path); return r.ok ? await r.json() : null; } catch { return null; } };

// The helpers below return parsed JSON and THROW on failure; callers keep their
// own try/catch so each surface words its own error.

/** Check a pasted RD token server-side (RD's API blocks browser CORS). -> {valid, name, premium, reason} */
export async function rdCheck(key) {
  const r = await apiFetch('/api/rdcheck', { headers: { 'x-rd-key': key } });
  return r.json();
}

/** The site's default RD token (the RD_KEY secret), handed only to a signed-in session. -> {key} */
export async function rdKeyFromSite() {
  const r = await apiFetch('/api/rdkey');
  return r.json();
}

/** Ad-free tier: the extractor opens the embed server-side and returns its stream. -> {play|url|stream, error} */
export async function resolveEmbed(embed, opts) {
  const r = await apiFetch('/api/resolve?embed=' + encodeURIComponent(embed), opts);
  return r.json();
}

/** Live TV + Sports channel list. -> {channels:[{id,name}]} */
export async function liveChannels() {
  const r = await apiFetch('/api/live/channels');
  return r.json();
}

/** Resolve one live channel to an HLS URL. -> {play} */
export async function liveResolve(id) {
  const r = await apiFetch('/api/live/resolve?id=' + encodeURIComponent(id));
  return r.json();
}

/** Server-side debrid fallback. Deliberately plain fetch (not apiFetch): a
    session bounce here just reads as "no debrid", as it always has. */
export function debridFallback(it, kind, s, e, key, opts) {
  return fetch(`/api/debrid?tmdb=${it.id}&kind=${kind}&s=${s}&e=${e}`, Object.assign({ headers: { 'x-rd-key': key } }, opts));
}
