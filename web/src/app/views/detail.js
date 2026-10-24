// The detail sheet (modal): backdrop, facts, Play / My List, an anime's Sub/Dub
// switch, and for series a season picker with episode cards. Opened by a card
// (no route), or by a shared '#title/…' link (viewTitle, below).

import { api } from '../api.js';
import { IMG, titleOf, yearOf, esc, $ } from '../util.js';
import { inList, toggleList, getPrefs, setPrefs } from '../state.js';
import { onAction } from '../ui/actions.js';
import { play } from '../player/player.js';
import { audioPref, otherAudio, maybeAnime } from '../player/anime.js';
import { fetchAnimeIds } from '../player/playerapi.js';
import { parseRoute, parseTitle } from '../router.js';
import { toast } from '../ui/toast.js';
import { isProfilesOpen } from '../profiles.js';

let current = null;   // the TMDB detail object on screen (with _kind)
let curSeason = 1;
let curEpisode = 1;   // what Play starts in curSeason: 1, or the episode a link picked
let loadTok = 0;      // bumped by every open / close: a late answer never fills a closed or newer sheet
let titleBack = '#home';   // on a '#title/…' route, the hash of the view under the sheet

/** A one-line sheet (loading, not found) that can still be closed on a phone (no Esc there). */
const notice = (msg) => `<div style="position:relative"><button class="close" data-act="detail-close" aria-label="Close">✕</button><div class="empty">${msg}</div></div>`;

/** Open the sheet for TMDB `id` ('movie' | 'tv'). want = { s, e }: a series opens on
    season s with episode e marked, scrolled to, and on Play. -> the detail, or null
    (not found / failed, or the sheet was closed or replaced while it loaded). */
export async function openDetail(id, kind, want = null) { const modal = $('modal'), sheet = $('sheet');
  const tok = ++loadTok;
  modal.classList.add('open'); sheet.innerHTML = notice('Loading…');
  const d = await api(kind + '/' + id);
  if (tok !== loadTok) return null;
  if (!d) { sheet.innerHTML = notice('Couldn\'t load this title.'); return null; }
  d._kind = kind; current = d;
  const genres = (d.genres || []).slice(0, 3).map(g => `<span class="pill">${esc(g.name)}</span>`).join('');
  const rt = d.runtime ? `${Math.floor(d.runtime / 60)}h ${d.runtime % 60}m` : (d.episode_run_time?.[0] ? d.episode_run_time[0] + 'm' : '');
  const inl = inList(id, kind);
  const bd = IMG(d.backdrop_path, 'w1280');   // null without one: no url(null) request
  sheet.innerHTML = `
    <div class="back"${bd ? ` style="background-image:url(${bd})"` : ''}>
      <button class="close" data-act="detail-close">✕</button></div>
    <div class="body">
      <h1>${esc(titleOf(d))}</h1>
      <div class="pills"><span class="pill">${yearOf(d) || ''}</span>
        <span class="pill rate">★ ${(d.vote_average || 0).toFixed(1)}</span>
        ${rt ? `<span class="pill">${rt}</span>` : ''}${genres}</div>
      <div class="btns" style="margin:6px 0 4px">
        <button class="btn play" id="dplay" data-act="detail-play">▶ Play</button>
        <button class="btn ghost" data-act="detail-list" data-id="${id}" data-kind="${kind}">${inl ? '✓ In My List' : '+ My List'}</button>
        <button class="btn ghost" id="daudio" data-act="detail-audio" style="display:none"></button>
      </div>
      <p class="ov">${esc(d.overview || '')}</p>
      <div id="epwrap"></div>
    </div>`;
  if (kind === 'tv') renderSeasons(d, want);
  showAudioSwitch(d);
  return d;
}

/* '#title/<movie|tv|anime>/<id>[/<season>/<episode>][/t/<seconds>]'
   (router.parseTitle) — the links the apps' universal links claim, for anyone
   without the app. main.js route() renders it over the view on screen; `back`
   is that view's hash, where closing the sheet returns (dismissDetail). An
   episode link plays that episode through the normal play path once the sheet
   has loaded and "Who's watching?" is gone (a first visit opens it): until then
   the episode waits, marked, in the sheet. A pick re-renders the route
   (profiles.js), which lands here again and plays it; a picker that just
   closes (no profiles on this site) lets this call play it. A browser that
   blocks autoplay without a tap leaves the player paused on its own controls,
   as it does after any slow resolve. A shared moment ('/t/<seconds>') plays the
   same way from that second — a film's too, where a plain film link only opens
   its sheet. */
export async function viewTitle(hash, back) {
  titleBack = back || '#home';
  const t = parseTitle(hash);
  if (!t) { loadTok++; $('modal').classList.add('open'); $('sheet').innerHTML = notice('That link doesn\'t point to a title.'); return; }
  const want = t.e ? { s: t.s, e: t.e } : null;
  const d = await openDetail(t.id, t.kind, want);
  if (!d || (!want && t.t === undefined)) return;   // a title link (no episode, no moment) is the sheet alone
  if (want) {
    const season = (d.seasons || []).find(x => x.season_number === want.s);
    if (!season || want.e > (season.episode_count || 0)) {
      toast(`Season ${want.s}, episode ${want.e} isn't listed for ${titleOf(d)}.`);
      return;
    }
  }
  const tok = loadTok;   // a closed or replaced sheet (incl. that re-render) stops this one
  while (isProfilesOpen()) { await new Promise(r => setTimeout(r, 250)); if (tok !== loadTok) return; }
  if (tok !== loadTok) return;
  // parseTitle gives a moment only to a film or an episode, so no `want` here = a film.
  if (want) play(d, 'tv', want.s, want.e, t.t); else play(d, 'movie', 1, 1, t.t);
}

/* Anime only: which audio Play asks for first (prefs.animeAudio, shared with
   the player's own switch). Shown once the extractor's anime map confirms the
   title; Animation-genre titles are the only ones asked. */
async function showAudioSwitch(d) {
  if (!maybeAnime(d) || !(d.genres || []).length) return;
  const j = await fetchAnimeIds({ it: d, kind: d._kind, s: 1, e: 1 });
  if (current !== d || !j || !j.anime) return;
  renderAudioSwitch();
}
function renderAudioSwitch() {
  const b = $('daudio'); if (!b) return;
  const a = audioPref(getPrefs());
  b.textContent = a === 'dub' ? '🔊 Dub (English)' : '🔊 Sub (Japanese)';
  b.title = 'Anime audio Play asks for first — click to switch';
  b.style.display = '';
}
/** Close the sheet (no navigation — route() calls this on every hash change). */
export function closeDetail() { loadTok++; $('modal').classList.remove('open'); }

/** Close it from the ✕ / Esc. On a '#title/…' route the hash goes back to the view
    under the sheet — replaced, not pushed or history.back(): nothing in the app
    links there, so the entry before a shared link is another page, and Back must
    not reopen the sheet (as the reader does for its deep links). */
export function dismissDetail() {
  closeDetail();
  if (parseRoute(location.hash).base === 'title') location.replace(titleBack);
}

function renderSeasons(d, want) {
  // Specials (season 0) only when a link asks for one.
  const seasons = (d.seasons || []).filter(s => (s.season_number > 0 || (want && want.s === 0)) && s.episode_count > 0);
  if (!seasons.length) return;
  curSeason = want && seasons.some(s => s.season_number === want.s) ? want.s : seasons[0].season_number;
  const wrap = $('epwrap');
  wrap.innerHTML = `<div class="seasons" id="seasonbar">${seasons.map(s =>
    `<button data-s="${s.season_number}" data-act="season" data-tv="${d.id}">${esc(s.name)}</button>`).join('')}</div>
    <div class="eps" id="eps"></div>`;
  loadSeason(d.id, curSeason, want && want.s === curSeason ? want.e : 0);
}
async function loadSeason(tvid, n, pickE = 0) { curSeason = n; curEpisode = pickE || 1;
  const pb = $('dplay'); if (pb) pb.textContent = pickE ? `▶ Play S${n} E${pickE}` : '▶ Play';
  document.querySelectorAll('#seasonbar button').forEach(b => b.classList.toggle('on', +b.dataset.s === n));
  const eps = $('eps'); eps.innerHTML = '<div class="empty" style="padding:20px">Loading…</div>';
  const s = await api('tv/' + tvid + '/season/' + n);
  eps.innerHTML = (s?.episodes || []).map(ep => { const st = IMG(ep.still_path, 'w300');
    return `<div class="ep" data-act="episode" data-s="${n}" data-e="${ep.episode_number}">` +
      (st ? `<img loading="lazy" src="${st}">` : `<div class="eph"></div>`) +
      `<div><div class="en">${ep.episode_number}. ${esc(ep.name || 'Episode')}</div>
        <div class="es">${ep.runtime ? ep.runtime + ' min' : ''}</div></div></div>`; }).join('')
    || '<div class="empty" style="padding:20px">No episodes.</div>';
  const picked = pickE && eps.querySelector(`.ep[data-e="${pickE}"]`);
  if (picked) { picked.classList.add('on'); picked.scrollIntoView({ block: 'center' }); }
}
function playFromDetail() { if (!current) return;
  if (current._kind === 'tv') { play(current, 'tv', curSeason, curEpisode); } else { play(current, 'movie', 1, 1); } }

onAction('detail', (el) => openDetail(+el.dataset.id, el.dataset.kind));
onAction('detail-close', () => dismissDetail());
onAction('detail-play', () => playFromDetail());
onAction('detail-list', (el) => { toggleList(current); openDetail(+el.dataset.id, el.dataset.kind); });
onAction('detail-audio', () => {
  setPrefs({ animeAudio: otherAudio(audioPref(getPrefs())) });
  renderAudioSwitch();
});
onAction('season', (el) => loadSeason(+el.dataset.tv, +el.dataset.s));
onAction('episode', (el) => play(current, 'tv', +el.dataset.s, +el.dataset.e));
