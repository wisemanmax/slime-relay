// Home: hero carousel, Continue Watching, My List, then catalog shelves.

import { api } from '../api.js';
import { kindOf } from '../util.js';
import { myList, continueList, continueRecord } from '../state.js';
import { onAction } from '../ui/actions.js';
import { renderHero, paintHero, heroPool } from '../ui/hero.js';
import { row, rowResume, rowChannels } from '../ui/row.js';
import { openDetail } from './detail.js';
import { play } from '../player/player.js';

export async function viewHome() { const main = document.getElementById('main'); main.innerHTML = '<div class="empty">Loading…</div>';
  const [trend, pm, pt, anime, action] = await Promise.all([
    api('trending/all/week'), api('movie/popular'), api('tv/popular'),
    api('discover/tv?with_keywords=210024&sort_by=popularity.desc'),
    api('discover/movie?with_genres=28&sort_by=popularity.desc'),
  ]);
  if (!trend && !pm && !pt) {
    main.innerHTML = '<div class="empty">Couldn\'t load the catalog.<br><br>The site\'s <b>TMDB_TOKEN</b> secret is likely unset or wrong. Re-set it and reload.</div>';
    return;
  }
  const trItems = (trend?.results || []).filter(x => x.media_type !== 'person');
  let out = renderHero(trItems);
  const records = continueList();
  const cont = records.map(c => ({ id: c.id, media_type: c.kind, title: c.title, poster_path: c.poster, backdrop_path: c.backdrop }));
  if (cont.length) out += rowResume(cont, records);
  const list = myList().map(c => ({ id: c.id, media_type: c.kind, title: c.title, poster_path: c.poster }));
  if (list.length) out += row('My List', list);
  out += row('Trending This Week', trItems);
  out += rowChannels();
  out += row('Popular Movies', (pm?.results || []).map(x => ({ ...x, media_type: 'movie' })));
  out += row('Popular TV', (pt?.results || []).map(x => ({ ...x, media_type: 'tv' })));
  out += row('Anime', (anime?.results || []).map(x => ({ ...x, media_type: 'tv' })));
  out += row('Action', (action?.results || []).map(x => ({ ...x, media_type: 'movie' })));
  main.innerHTML = out; paintHero();
}

export async function surprise() { const pool = heroPool().concat(continueList());
  const pick = pool[Math.floor(Math.random() * pool.length)]; if (pick) openDetail(pick.id, pick.kind || kindOf(pick)); }

/** Continue Watching: straight back into the saved episode, or the detail sheet if the record is gone. */
export function resumeItem(id, kind) { const rec = continueRecord(id, kind);
  if (!rec) return openDetail(id, kind);
  play({ id, media_type: kind, title: rec.title, poster_path: rec.poster, backdrop_path: rec.backdrop }, kind, rec.s || 1, rec.e || 1); }

onAction('surprise', () => surprise());
onAction('resume', (el) => resumeItem(+el.dataset.id, el.dataset.kind));
