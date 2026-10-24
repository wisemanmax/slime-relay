// Hash routing, pure: parse a location.hash into what to render and which
// chrome to light. No DOM at import time (unit-checked from node). The view
// dispatch table lives in main.js — a new route needs an entry in KNOWN here
// AND in VIEWS there (main.js warns at boot if they drift).

export const KNOWN = ['home', 'movies', 'tv', 'live', 'anime', 'list', 'search', 'channels', 'channel', 'genre', 'read', 'title', 'party'];

/* Movies/Series/Anime are pill routes, and the channel/genre surfaces are
   reached FROM Home, so all of them keep Home lit in the tab bar rather than
   leaving the bar with nothing highlighted. */
export const HOME_TAB_ROUTES = ['movies', 'tv', 'anime', 'channels', 'channel', 'genre'];
export const tabFor = (active) => HOME_TAB_ROUTES.includes(active) ? 'home' : active;

/* Pills belong to the browse surfaces only — they'd be meaningless on Search,
   Live TV or My Stuff, which is also how the app behaves. */
export const PILL_ROUTES = ['home', 'movies', 'tv', 'anime'];

/** '#genre/28' -> { base:'genre', arg:'28', active:'genre', nav:'genre', tab:'home', pills:false } */
export function parseRoute(hash) {
  const h = String(hash || '').slice(1) || 'home';
  const base = h.split('/')[0];
  const arg = h.split('/')[1];
  // An unknown route renders Home, and lights Home.
  const active = KNOWN.includes(base) ? base : 'home';
  return {
    base, arg, active,
    nav: active === 'search' ? 'home' : active,   // desktop nav has no Search entry
    tab: tabFor(active),
    pills: PILL_ROUTES.includes(active),
  };
}

/** Every segment after the route base, URI-decoded — for routes deeper than one
    argument: '#read/manga/mangapill/723%2Fchainsaw-man' -> ['manga', 'mangapill', '723/chainsaw-man'].
    Build such hashes with routeHash(), which encodes each segment. */
export function routeArgs(hash) {
  const h = String(hash || '').slice(1);
  return h.split('/').slice(1).map(s => { try { return decodeURIComponent(s); } catch { return s; } });
}
export const routeHash = (base, ...args) => '#' + [base, ...args.map(a => encodeURIComponent(String(a)))].join('/');

/** A shared title link — the hash routes the apps' universal links claim
    (worker.js AASA), in the grammar the app reads them with (AppRoute.webRoute):
      '#title/<movie|tv|anime>/<tmdbId>'                 the title's sheet
      '#title/<tv|anime>/<tmdbId>/<season>/<episode>'    that episode (season 0 = specials)
      '#title/<tv|anime>/<tmdbId>/<season>/<episode>/t/<seconds>'
      '#title/movie/<tmdbId>/t/<seconds>'                a shared moment: plays from there
    'anime' is a TMDB tv id. -> { kind: 'movie'|'tv', anime, id[, s, e][, t] }, or
    null for anything else: another segment count, an unknown kind, an id that
    isn't 1-9 plain digits or is 0, a film with an episode, episode 0, a moment
    on a show with no episode, a moment segment other than 't', seconds that
    aren't 1-9 plain digits (0 — the start — is legal, unlike an id). */
export function parseTitle(hash) {
  if (String(hash || '').slice(1).split('/')[0] !== 'title') return null;
  const args = routeArgs(hash);
  const num = (raw) => /^[0-9]{1,9}$/.test(raw) ? Number(raw) : null;
  // A moment is two trailing segments: the literal 't', then whole seconds.
  const at = (seg, raw) => seg === 't' ? num(raw) : null;
  const [kind, rawId, a, b, c, d] = args;
  const id = num(rawId);
  if (!['movie', 'tv', 'anime'].includes(kind) || !id) return null;
  const title = { kind: kind === 'movie' ? 'movie' : 'tv', anime: kind === 'anime', id };
  if (args.length === 2) return title;
  if (kind === 'movie') {   // a film has no episode: only a moment may follow its id
    const t = args.length === 4 ? at(a, b) : null;
    return t === null ? null : { ...title, t };
  }
  const s = num(a), e = num(b);
  if ((args.length !== 4 && args.length !== 6) || s === null || !e) return null;
  if (args.length === 4) return { ...title, s, e };
  const t = at(c, d);
  return t === null ? null : { ...title, s, e, t };
}

/** Navigate (identical to clicking a link to `hash`; same hash = no re-render). */
export function go(hash) { location.hash = hash; }
