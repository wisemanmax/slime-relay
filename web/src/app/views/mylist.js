// My List (desktop "My List", phone "My Stuff").

import { myList } from '../state.js';
import { card } from '../ui/card.js';

export async function viewMyList() { const main = document.getElementById('main');
  const l = myList().map(c => ({ id: c.id, media_type: c.kind, title: c.title, poster_path: c.poster }));
  main.innerHTML = l.length ? `<div class="grid">${l.map(card).join('')}</div>` :
    '<div class="empty">Your list is empty. Add titles from any detail page.</div>';
}
