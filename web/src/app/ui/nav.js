// Desktop top-bar navigation (hidden on phones, where pills + the tab bar take over).

import { $ } from '../util.js';

export const NAV = [['home','Home'],['channels','Channels'],['movies','Movies'],['tv','TV'],
                   ['live','Live'],['anime','Anime'],['read','Read'],['genre/28','Genres'],['list','My List']];

export function renderNav(active) {
  $('nav').innerHTML =
    // A nav entry may carry a route argument (genre/28); highlight on its base.
    NAV.map(([r, l]) => `<a class="${r.split('/')[0] === active ? 'on' : ''}" data-act="go" data-to="#${r}">${l}</a>`).join('');
}
