// "Up Next": autoplay the next episode when a <video>-path episode ends.

import { api } from '../api.js';
import { $ } from '../util.js';
import { session, isCurrentGen } from './session.js';

let hideTimer = null;
/** Show the banner for `ms` (it used to stay up until something hid it). */
export function showUpNext(html, ms = 6000) {
  const u = $('pupnext'); u.innerHTML = html; u.classList.add('on');
  clearTimeout(hideTimer); hideTimer = setTimeout(hideUpNext, ms);
}
export function hideUpNext() { clearTimeout(hideTimer); hideTimer = null; $('pupnext').classList.remove('on'); }

/** TV only, and only if the season really has a next episode. `play` is
    player.play (passed in to keep this module free of an import cycle).
    The banner goes up AFTER play(): play() hides any banner from the title
    before, which used to take this one down the instant it was shown. */
export async function autoNext(play) {
  if (!session.ctx || session.ctx.kind !== 'tv') return;
  const gen = session.gen;
  const it = session.ctx.it, s = session.ctx.s, e = session.ctx.e;
  const sn = await api('tv/' + it.id + '/season/' + s);
  if (!isCurrentGen(gen)) return;   // closed, or something else started meanwhile
  const max = (sn && sn.episodes || []).reduce((m, x) => Math.max(m, x.episode_number), 0);
  if (e < max) { play(it, 'tv', s, e + 1); showUpNext('▶ <b>Up Next</b> · S' + s + ' E' + (e + 1)); }
}
