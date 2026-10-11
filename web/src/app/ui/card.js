// Poster cards. A card opens the title's detail sheet (action 'detail',
// registered in views/detail.js); a resume card picks playback back up
// (action 'resume', registered in views/home.js).

import { IMG, kindOf, titleOf, esc } from '../util.js';

export function card(it) {
  const k = kindOf(it), p = IMG(it.poster_path, 'w342');
  return `<div class="card" data-act="detail" data-id="${it.id}" data-kind="${k}">` +
    (p ? `<img loading="lazy" src="${p}" alt="">` : `<div class="ph">▦</div>`) +
    `<div class="t">${esc(titleOf(it))}</div></div>`;
}

/** Continue Watching card, with a progress bar once there's a known duration. */
export function resumeCard(it, rec) {
  const p = IMG(it.poster_path, 'w342'), k = kindOf(it);
  const pct = (rec && rec.dur && rec.pos) ? Math.min(100, Math.round(100 * rec.pos / rec.dur)) : 0;
  return `<div class="card" data-act="resume" data-id="${it.id}" data-kind="${k}">` +
    (p ? `<img loading="lazy" src="${p}">` : `<div class="ph">▦</div>`) +
    (pct > 2 ? `<div class="prog"><i style="width:${pct}%"></i></div>` : '') +
    `<div class="t">${esc(titleOf(it))}</div></div>`;
}
