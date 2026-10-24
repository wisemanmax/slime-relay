/* SlimeWatch web — boot + route dispatch.

   The SPA as ES modules, bundled by build.mjs (esbuild, one IIFE) and inlined
   into the single HTML document the Worker serves. Boot order mirrors the old
   single-file script: player wiring, debrid key seed, hash routing, header
   search, keyboard, first route — then the PWA extras, which nothing above
   depends on. */

import { KNOWN, parseRoute, go } from './router.js';
import { initActions, onAction } from './ui/actions.js';
import { renderNav } from './ui/nav.js';
import { renderPills } from './ui/pills.js';
import { renderTabbar } from './ui/tabbar.js';
import './ui/settings.js';   // registers the settings / debrid actions
import { initInstall } from './ui/install.js';
import { viewHome } from './views/home.js';
import { viewMovies, viewTV, viewAnime, viewChannels, viewChannel, viewGenre } from './views/browse.js';
import { viewLive } from './views/live.js';
import { viewMyList } from './views/mylist.js';
import { viewSearchScreen, initHeaderSearch } from './views/search.js';
import { closeDetail, viewTitle } from './views/detail.js';
import { viewRead } from './views/reading.js';
import { viewParty } from './views/party.js';   // W7 (Watch Party join)
import { closeReader, initReaderKeys } from './reader/reader.js';
import { initPlayer } from './player/player.js';
import { seedRdKey } from './player/debrid.js';
import { initKeys } from './keys.js';
import { initPwa } from './pwa.js';
import { initProfiles } from './profiles.js';
import { initKidsGate, kidsActive } from './kids.js';   // W8: the Kids gate
import { hiddenForKids } from './profilelock.js';

/** route base -> view(arg). Keep in step with router.KNOWN ('title' is the one
    route that isn't a #main view: route() opens it over one). */
const VIEWS = {
  home: viewHome,
  movies: viewMovies,
  tv: viewTV,
  anime: viewAnime,
  live: viewLive,
  list: viewMyList,
  search: viewSearchScreen,
  channels: viewChannels,
  channel: viewChannel,
  genre: viewGenre,
  read: viewRead,
  party: viewParty,   // W7: '#party/<CODE>' (renders Home until P5 lands)
};
for (const k of KNOWN) if (!VIEWS[k] && k !== 'title') console.warn('route "' + k + '" has no view in main.js');

let under = '';   // the hash of the view #main shows ('' until the first render)

function route() {
  const r = parseRoute(location.hash);
  // W8: a Kids profile never lands on Live sports, Reading or a Watch Party (the
  // apps hide all three); layout.css takes their entries off the bar and nav.
  if (hiddenForKids(r.base, kidsActive())) { location.replace('#home'); return; }
  closeDetail();
  closeReader();   // a reader route re-opens it (views/reading.js)
  // A shared '#title/…' link opens the detail sheet OVER the view on screen —
  // Home on a cold load — and closing the sheet goes back to that view's hash.
  if (r.base === 'title') {
    if (!under) render(parseRoute('#home'), '#home');
    viewTitle(location.hash, under);
    return;
  }
  render(r, location.hash || '#home');
}

function render(r, hash) {
  under = hash;
  renderNav(r.nav);
  renderPills(r.active);
  renderTabbar(r.active);
  // Own keys only: '#constructor' must render Home, not call Object().
  (Object.hasOwn(VIEWS, r.base) ? VIEWS[r.base] : viewHome)(r.arg);
}

onAction('go', (el) => go(el.dataset.to));
onAction('logout', () => { location.href = '/logout'; });

initActions();
initKidsGate();   // W8: before the first render, so a Kids profile's first rows are already thinned
initPlayer();
seedRdKey();   // fills a blank key from the site secret, before anything plays
window.addEventListener('hashchange', route);
initHeaderSearch();
initReaderKeys();   // before initKeys: an open reader's keys (Esc, '/') win
initKeys();
route();
initProfiles();   // who's watching -> that profile's sync (or the picker); after the first render
initPwa();
initInstall();
