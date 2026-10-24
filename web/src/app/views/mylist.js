// My List (desktop "My List", phone "My Stuff").
//
// Wave 8 (W1): laid out like the iPhone's My Stuff — Continue Watching first,
// then My List with "Pick one for me" (Ask chooses tonight's title from the
// list, in a conversation that sees the list only: views/search.js). On a Kids
// profile both are thinned to the cap and there is no Pick (the apps hide Ask
// from Kids). Downloads and Saved Links stay app-only (docs/WEB-PARITY-2026-10-24.md).

import { myList, continueList } from '../state.js';
import { card } from '../ui/card.js';
import { rowResume } from '../ui/row.js';
import { onAction } from '../ui/actions.js';
import { kidsActive, visibleRecords } from '../kids.js';   // W8: the Kids gate
import { openAsk, PICK_FROM_LIST } from './search.js';

/** "Pick one for me" needs a couple of titles to choose between, and Ask (never on Kids). */
export const canPickFromList = (list, kids) => !kids && (Array.isArray(list) ? list : []).filter(x => x && Number(x.id) > 0).length >= 2;

export async function viewMyList() { const main = document.getElementById('main');
  const kids = kidsActive();
  const [records, cont] = kids ? await Promise.all([visibleRecords(myList()), visibleRecords(continueList())]) : [myList(), continueList()];
  const l = records.map(c => ({ id: c.id, media_type: c.kind, title: c.title, poster_path: c.poster }));
  const resume = cont.length
    ? rowResume(cont.map(c => ({ id: c.id, media_type: c.kind, title: c.title, poster_path: c.poster, backdrop_path: c.backdrop })), cont) : '';
  const pick = canPickFromList(records, kids)
    ? '<button class="btn ghost mylist-pick" data-act="mylist-pick" title="Ask chooses something from My List for tonight">✦ Pick one for me</button>' : '';
  main.innerHTML = resume + (l.length
    ? `<div class="row mylist-head"><h2>My List</h2>${pick}</div><div class="grid">${l.map(card).join('')}</div>`
    : '<div class="empty">Your list is empty. Add titles from any detail page.</div>');
}

onAction('mylist-pick', () => openAsk(PICK_FROM_LIST, { myListOnly: true }));
