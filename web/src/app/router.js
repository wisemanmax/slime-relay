// Hash routing, pure: parse a location.hash into what to render and which
// chrome to light. No DOM at import time (unit-checked from node). The view
// dispatch table lives in main.js — a new route needs an entry in KNOWN here
// AND in VIEWS there (main.js warns at boot if they drift).

export const KNOWN = ['home', 'movies', 'tv', 'live', 'anime', 'list', 'search', 'channels', 'channel', 'genre', 'read'];

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

/** Navigate (identical to clicking a link to `hash`; same hash = no re-render). */
export function go(hash) { location.hash = hash; }
