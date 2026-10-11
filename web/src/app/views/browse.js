// Browse surfaces reached from Home / the nav: Movies, TV, Anime shelves,
// the Channels grid, one brand channel, and genre browse.

import { api } from '../api.js';
import { esc } from '../util.js';
import { CHANNELS, GENRES, chanName, provQ } from '../catalog.js';
import { card } from '../ui/card.js';
import { row, chanTile } from '../ui/row.js';

export async function viewList(kind, title, endpoints) { const main = document.getElementById('main');
  main.innerHTML = '<div class="empty">Loading…</div>';
  const res = await Promise.all(endpoints.map(e => api(e.path)));
  let out = ''; endpoints.forEach((e, i) => { out += row(e.label, (res[i]?.results || []).map(x => ({ ...x, media_type: kind }))); });
  main.innerHTML = out || '<div class="empty">Nothing here.</div>';
}
export const viewMovies = () => viewList('movie', 'Movies', [
  { path: 'movie/popular', label: 'Popular' }, { path: 'movie/top_rated', label: 'Top Rated' },
  { path: 'movie/now_playing', label: 'Now Playing' }, { path: 'movie/upcoming', label: 'Upcoming' }]);
export const viewTV = () => viewList('tv', 'TV', [
  { path: 'tv/popular', label: 'Popular' }, { path: 'tv/top_rated', label: 'Top Rated' },
  { path: 'tv/on_the_air', label: 'On The Air' }]);
export const viewAnime = () => viewList('tv', 'Anime', [
  { path: 'discover/tv?with_keywords=210024&sort_by=popularity.desc', label: 'Popular Anime' },
  { path: 'discover/tv?with_keywords=210024&sort_by=vote_average.desc&vote_count.gte=200', label: 'Top Rated Anime' }]);

/* One service's catalog: the blend, then each kind, then every genre that
   actually has enough titles. Rows are fetched together and rendered in a fixed
   order, so a slow genre cannot reorder the page under the viewer. */
export async function viewChannel(pid) {
  const main = document.getElementById('main'); const name = chanName(pid);
  main.innerHTML = '<div class="empty">Loading ' + esc(name) + '…</div>';
  const specs = [
    { label: 'Popular on ' + name, path: `discover/movie?${provQ(pid)}`, kind: 'movie' },
    { label: 'Series',             path: `discover/tv?${provQ(pid)}`,    kind: 'tv' },
    { label: 'Top Rated',          path: `discover/movie?${provQ(pid, { sort_by: 'vote_average.desc', 'vote_count.gte': '200' })}`, kind: 'movie' },
    ...GENRES.map(([g, l]) => ({ label: l, path: `discover/movie?${provQ(pid, { with_genres: g })}`, kind: 'movie' })),
  ];
  const res = await Promise.all(specs.map(s => api(s.path)));
  let out = `<div class="chead" style="background:${(CHANNELS.find(c => c[0] === +pid) || [0, 0, '#151515'])[2]}">
      <h1>${esc(name)}</h1><p>Everything streaming on ${esc(name)} right now.</p></div>`;
  specs.forEach((s, i) => { out += row(s.label, (res[i]?.results || []).map(x => ({ ...x, media_type: s.kind }))); });
  // Only the header survived → every row was under the floor, which means the
  // provider id returned nothing, not that the service is small.
  main.innerHTML = /class="row"/.test(out) ? out
    : '<div class="empty">Nothing streaming on ' + esc(name) + ' right now.</div>';
}

export function viewChannels() {
  document.getElementById('main').innerHTML =
    `<div class="row"><h2>Channels</h2></div><div class="chipgrid">` +
    CHANNELS.map(([p, n, t]) => chanTile(p, n, t)).join('') + `</div>`;
}

/* Genre browse. Movie ids only, against /discover/movie — see GENRES. */
export async function viewGenre(gid) {
  const main = document.getElementById('main');
  const label = (GENRES.find(g => g[0] === +gid) || [0, 'Genre'])[1];
  main.innerHTML = '<div class="empty">Loading ' + esc(label) + '…</div>';
  const chips = GENRES.map(([g, l]) =>
    `<button class="${+g === +gid ? 'on' : ''}" data-act="go" data-to="#genre/${g}">${l}</button>`).join('');
  const [pop, top] = await Promise.all([
    api(`discover/movie?with_genres=${gid}&sort_by=popularity.desc&vote_count.gte=40`),
    api(`discover/movie?with_genres=${gid}&sort_by=vote_average.desc&vote_count.gte=300`),
  ]);
  const items = (pop?.results || []).map(x => ({ ...x, media_type: 'movie' }));
  main.innerHTML = `<div class="genrebar">${chips}</div>` +
    (items.length ? `<div class="grid">${items.map(card).join('')}</div>`
                  : '<div class="empty">Nothing in ' + esc(label) + '.</div>') +
    row('Top Rated ' + label, (top?.results || []).map(x => ({ ...x, media_type: 'movie' })));
}
