// Horizontal shelves: poster rows, the Continue Watching row and the brand
// channel tiles.

import { esc, kindOf } from '../util.js';
import { CHANNELS } from '../catalog.js';
import { card, resumeCard } from './card.js';

/* A row is dropped below four items rather than rendered thin. The apps use the
   same floor (TMDBService.loadChannel): a service that genuinely has two war
   films should show no War row, not a shelf with a gap where the posters end. */
export const ROW_MIN = 4;
export function row(title, items) {
  if (!items || items.length < ROW_MIN) return '';
  return `<div class="row"><h2>${esc(title)}</h2><div class="track">${items.map(card).join('')}</div></div>`;
}

/** Continue Watching. `records` is the store's continue list (for progress). */
export function rowResume(items, records) {
  return `<div class="row"><h2>Continue Watching</h2><div class="track">` +
    items.map(it => {
      const k = kindOf(it);
      const rec = records.find(x => x.id === it.id && x.kind === k);
      return resumeCard(it, rec);
    }).join('') + `</div></div>`;
}

// Service tiles. Text on a brand tint rather than logos: TMDB's logo paths need
// a second lookup per service and 404 individually, and a missing logo makes a
// tile unidentifiable, whereas a missing tint is merely plainer.
export function chanTile(pid, name, tint) {
  return `<div class="chip" style="background:${tint}" data-act="go" data-to="#channel/${pid}">
    <span>${esc(name)}</span></div>`;
}
export function rowChannels() {
  return `<div class="row"><h2>Channels</h2><div class="track chips">` +
    CHANNELS.map(([p, n, t]) => chanTile(p, n, t)).join('') + `</div></div>`;
}
