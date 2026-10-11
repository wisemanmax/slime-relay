/* Phone filter pills (All · Movies · Series · Anime). They mirror the iOS app:
   Movies/Series/Anime are FILTERS on Home there, not destinations. Rendered on
   every route so the highlight always matches where you are. */

import { $ } from '../util.js';
import { PILL_ROUTES } from '../router.js';

export const M_PILLS = [['home','All'],['movies','Movies'],['tv','Series'],['anime','Anime']];

export function renderPills(active) {
  const el = $('pills'); if (!el) return;
  const show = PILL_ROUTES.includes(active);
  el.style.display = show ? '' : 'none';
  if (!show) { el.innerHTML = ''; return; }
  el.innerHTML = M_PILLS.map(([r, l]) =>
    `<button class="${r === active ? 'on' : ''}" data-act="go" data-to="#${r}">${l}</button>`).join('');
}
