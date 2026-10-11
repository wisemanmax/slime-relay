/* Phone floating tab bar. Five tabs: Movies/Series/Anime live in the pills,
   exactly as they do on iOS Home, and Read is the manga + comics section
   (views/reading.js). Which tab a route lights is router.tabFor().

   Width budget at 375 px (test/reading.mjs checks it against phone.css):
   the bar is inset 10 px a side with 5 px padding and a 1 px border, so each
   of the five flex:1 buttons gets (375 − 20 − 10 − 2) / 5 = 68.6 px — the
   widest label, "My Stuff" at 9 px/800, needs about 45. */

import { $ } from '../util.js';
import { tabFor } from '../router.js';

// An open book, drawn in the label colour (the other glyphs are text).
const BOOK = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 5.5C4.5 4 8 4 12 6c4-2 7.5-2 10-.5V19c-2.5-1.5-6-1.5-10 .5-4-2-7.5-2-10-.5z"/>' +
  '<path d="M12 6v13.5"/></svg>';

export const M_TABS = [['home','⌂','Home'],['search','⌕','Search'],
                       ['live','((‧))','Live TV'],['read',BOOK,'Read'],['list','❏','My Stuff']];

export function renderTabbar(active) {
  const el = $('tabbar'); if (!el) return;
  const tab = tabFor(active);
  el.innerHTML = M_TABS.map(([r, g, l]) =>
    `<button class="${r === tab ? 'on' : ''}" data-act="go" data-to="#${r}"><span class="g">${g}</span>${l}</button>`).join('');
}
