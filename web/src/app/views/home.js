// Home: hero carousel, Continue Watching, My List, then catalog shelves.

import { api } from '../api.js';
import { kindOf } from '../util.js';
import { myList, continueList, continueRecord } from '../state.js';
import { onAction } from '../ui/actions.js';
import { renderHero, paintHero, heroPool } from '../ui/hero.js';
import { row, rowResume, rowChannels } from '../ui/row.js';
import { openDetail } from './detail.js';
import { play } from '../player/player.js';
import { kidsActive, currentCap, visibleRecords } from '../kids.js';   // W8: the Kids gate
import { kidsShelves, dedupeRows } from '../profilelock.js';

export async function viewHome() { const main = document.getElementById('main'); main.innerHTML = '<div class="empty">Loading…</div>';
  if (kidsActive()) return viewKidsHome(main);
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

/* W8: a Kids profile's Home is its own line-up (TMDBService+Kids): films
   ceiling-filtered by TMDB, shows checked per title by the gate api() runs,
   a title once (its first row); Continue Watching and My List thinned to the cap. */
async function viewKidsHome(main) {
  const specs = kidsShelves(currentCap());
  const [res, cont, list] = await Promise.all([
    Promise.all(specs.map(s => api(s.path))), visibleRecords(continueList()), visibleRecords(myList()),
  ]);
  const rows = dedupeRows(specs.map((s, i) => ({ label: s.label, items: (res[i]?.results || []).map(x => ({ ...x, media_type: s.kind })) })));
  if (!rows.some(r => r.items.length)) {
    main.innerHTML = '<div class="empty">Couldn\'t load the catalog.<br><br>Check the connection and try again.</div>';
    return;
  }
  let out = renderHero(rows[0].items.length ? rows[0].items : rows.find(r => r.items.length).items);
  if (cont.length) out += rowResume(cont.map(c => ({ id: c.id, media_type: c.kind, title: c.title, poster_path: c.poster, backdrop_path: c.backdrop })), cont);
  const mine = list.map(c => ({ id: c.id, media_type: c.kind, title: c.title, poster_path: c.poster }));
  if (mine.length) out += row('My List', mine);
  for (const r of rows) out += row(r.label, r.items);
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
