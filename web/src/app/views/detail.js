// The detail sheet (modal): backdrop, facts, Play / My List, an anime's Sub/Dub
// switch, and for series a season picker with episode cards.

import { api } from '../api.js';
import { IMG, titleOf, yearOf, esc, $ } from '../util.js';
import { inList, toggleList, getPrefs, setPrefs } from '../state.js';
import { onAction } from '../ui/actions.js';
import { play } from '../player/player.js';
import { audioPref, otherAudio, maybeAnime } from '../player/anime.js';
import { fetchAnimeIds } from '../player/playerapi.js';

let current = null;   // the TMDB detail object on screen (with _kind)
let curSeason = 1;

export async function openDetail(id, kind) { const modal = $('modal'), sheet = $('sheet');
  modal.classList.add('open'); sheet.innerHTML = '<div class="empty">Loading…</div>';
  const d = await api(kind + '/' + id); if (!d) { sheet.innerHTML = '<div class="empty">Couldn\'t load this title.</div>'; return; }
  d._kind = kind; current = d;
  const genres = (d.genres || []).slice(0, 3).map(g => `<span class="pill">${esc(g.name)}</span>`).join('');
  const rt = d.runtime ? `${Math.floor(d.runtime / 60)}h ${d.runtime % 60}m` : (d.episode_run_time?.[0] ? d.episode_run_time[0] + 'm' : '');
  const inl = inList(id, kind);
  sheet.innerHTML = `
    <div class="back" style="background-image:url(${IMG(d.backdrop_path, 'w1280')})">
      <button class="close" data-act="detail-close">✕</button></div>
    <div class="body">
      <h1>${esc(titleOf(d))}</h1>
      <div class="pills"><span class="pill">${yearOf(d) || ''}</span>
        <span class="pill rate">★ ${(d.vote_average || 0).toFixed(1)}</span>
        ${rt ? `<span class="pill">${rt}</span>` : ''}${genres}</div>
      <div class="btns" style="margin:6px 0 4px">
        <button class="btn play" data-act="detail-play">▶ Play</button>
        <button class="btn ghost" data-act="detail-list" data-id="${id}" data-kind="${kind}">${inl ? '✓ In My List' : '+ My List'}</button>
        <button class="btn ghost" id="daudio" data-act="detail-audio" style="display:none"></button>
      </div>
      <p class="ov">${esc(d.overview || '')}</p>
      <div id="epwrap"></div>
    </div>`;
  if (kind === 'tv') renderSeasons(d);
  showAudioSwitch(d);
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
export function closeDetail() { $('modal').classList.remove('open'); }

function renderSeasons(d) { const seasons = (d.seasons || []).filter(s => s.season_number > 0 && s.episode_count > 0);
  if (!seasons.length) return; curSeason = seasons[0].season_number;
  const wrap = $('epwrap');
  wrap.innerHTML = `<div class="seasons" id="seasonbar">${seasons.map(s =>
    `<button data-s="${s.season_number}" data-act="season" data-tv="${d.id}">${esc(s.name)}</button>`).join('')}</div>
    <div class="eps" id="eps"></div>`;
  loadSeason(d.id, curSeason);
}
async function loadSeason(tvid, n) { curSeason = n;
  document.querySelectorAll('#seasonbar button').forEach(b => b.classList.toggle('on', +b.dataset.s === n));
  const eps = $('eps'); eps.innerHTML = '<div class="empty" style="padding:20px">Loading…</div>';
  const s = await api('tv/' + tvid + '/season/' + n);
  eps.innerHTML = (s?.episodes || []).map(ep => { const st = IMG(ep.still_path, 'w300');
    return `<div class="ep" data-act="episode" data-s="${n}" data-e="${ep.episode_number}">` +
      (st ? `<img loading="lazy" src="${st}">` : `<div class="eph"></div>`) +
      `<div><div class="en">${ep.episode_number}. ${esc(ep.name || 'Episode')}</div>
        <div class="es">${ep.runtime ? ep.runtime + ' min' : ''}</div></div></div>`; }).join('')
    || '<div class="empty" style="padding:20px">No episodes.</div>';
}
function playFromDetail() { if (!current) return;
  if (current._kind === 'tv') { play(current, 'tv', curSeason, 1); } else { play(current, 'movie', 1, 1); } }

onAction('detail', (el) => openDetail(+el.dataset.id, el.dataset.kind));
onAction('detail-close', () => closeDetail());
onAction('detail-play', () => playFromDetail());
onAction('detail-list', (el) => { toggleList(current); openDetail(+el.dataset.id, el.dataset.kind); });
onAction('detail-audio', () => {
  setPrefs({ animeAudio: otherAudio(audioPref(getPrefs())) });
  renderAudioSwitch();
});
onAction('season', (el) => loadSeason(+el.dataset.tv, +el.dataset.s));
onAction('episode', (el) => play(current, 'tv', +el.dataset.s, +el.dataset.e));
