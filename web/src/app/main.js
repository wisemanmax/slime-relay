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
import { closeDetail } from './views/detail.js';
import { viewRead } from './views/reading.js';
import { closeReader, initReaderKeys } from './reader/reader.js';
import { initPlayer } from './player/player.js';
import { seedRdKey } from './player/debrid.js';
import { initKeys } from './keys.js';
import { initPwa } from './pwa.js';
import { initProfiles } from './profiles.js';

/** route base -> view(arg). Keep in step with router.KNOWN. */
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
};
for (const k of KNOWN) if (!VIEWS[k]) console.warn('route "' + k + '" has no view in main.js');

function route() {
  const r = parseRoute(location.hash);
  closeDetail();
  closeReader();   // a reader route re-opens it (views/reading.js)
  renderNav(r.nav);
  renderPills(r.active);
  renderTabbar(r.active);
  // Own keys only: '#constructor' must render Home, not call Object().
  (Object.hasOwn(VIEWS, r.base) ? VIEWS[r.base] : viewHome)(r.arg);
}

onAction('go', (el) => go(el.dataset.to));
onAction('logout', () => { location.href = '/logout'; });

initActions();
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
