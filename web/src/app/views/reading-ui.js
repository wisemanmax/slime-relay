// Markup builders for the Read tab: cover cards, shelves, the source pills.
// Every reading image loads with referrerpolicy="no-referrer": MangaDex's
// cover CDN answers a third-party Referer with a "read this at mangadex.org"
// placeholder, and the proxied images don't need one.

import { esc } from '../util.js';
import { routeHash } from '../router.js';

export const seriesHash = (kind, source, id) => routeHash('read', kind === 'comic' ? 'comic' : 'manga', source, id);
export const readerHash = (kind, source, id, chapter) => routeHash('read', kind === 'comic' ? 'rc' : 'r', source, id, chapter);

export const coverImg = (url, cls = '') => url
  ? `<img${cls ? ` class="${cls}"` : ''} loading="lazy" src="${esc(url)}" alt="" referrerpolicy="no-referrer">`
  : `<div class="ph${cls ? ' ' + cls : ''}">▤</div>`;

/** A search/browse hit -> a card opening its series page. `sub` is a small second line. */
export function itemCard(it, kind, sub) {
  return `<div class="card rd-card" data-act="go" data-to="${esc(seriesHash(kind, it.source, it.slug || it.id))}">` +
    coverImg(it.cover) + `<div class="t">${esc(it.title || 'Untitled')}</div>` +
    (sub ? `<div class="rd-sub">${esc(sub)}</div>` : '') + `</div>`;
}

/** A Continue Reading card: straight back into the saved chapter. */
export function resumeCard(e, sourceName) {
  const pct = e.pages > 0 ? Math.min(100, Math.round(100 * ((e.page || 0) + 1) / e.pages)) : 0;
  const sub = [e.chapterLabel, sourceName].filter(Boolean).join(' · ');
  return `<div class="card rd-card" data-act="read-resume" data-key="${esc(e.key)}">` + coverImg(e.cover) +
    (pct > 2 ? `<div class="prog"><i style="width:${pct}%"></i></div>` : '') +
    `<div class="t">${esc(e.title || 'Untitled')}</div>` + (sub ? `<div class="rd-sub">${esc(sub)}</div>` : '') + `</div>`;
}

/** A Saved card: the series page. */
export function savedCard(e, sourceName) {
  return `<div class="card rd-card" data-act="go" data-to="${esc(seriesHash(e.kind, e.source, e.id))}">` + coverImg(e.cover) +
    `<div class="t">${esc(e.title || 'Untitled')}</div>` + (sourceName ? `<div class="rd-sub">${esc(sourceName)}</div>` : '') + `</div>`;
}

/** A horizontal shelf of ready-made cards (any count — search rows can be short). */
export function shelf(title, cards, note = '') {
  if (!cards || !cards.length) return '';
  return `<div class="row rd-row"><h2>${esc(title)}${note ? ` <span class="rd-note">${esc(note)}</span>` : ''}</h2>` +
    `<div class="track">${cards.join('')}</div></div>`;
}

/** A one-line status under a heading (loading / failed / empty). */
export const statusRow = (title, text) => `<div class="row rd-row"><h2>${esc(title)}</h2><div class="rd-status">${esc(text)}</div></div>`;

/** Pills (source filter, Read-from picker). items: [[value, label]]. */
export function pills(act, items, current, extra = '') {
  return items.map(([v, label]) =>
    `<button class="${v === current ? 'on' : ''}" data-act="${act}" data-v="${esc(v)}"${extra}>${esc(label)}</button>`).join('');
}

export const STATUS_WORDS = { ongoing: 'Ongoing', completed: 'Completed', hiatus: 'Hiatus', cancelled: 'Cancelled', licensed: 'Licensed' };
