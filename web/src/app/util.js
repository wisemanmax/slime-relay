// Small pure helpers shared by every module. No DOM access at import time,
// no state — safe to import from node for unit checks.

export const IMG = (p, sz) => p ? 'https://image.tmdb.org/t/p/' + sz + p : null;
export const kindOf = (it) => it.media_type ? (it.media_type === 'tv' ? 'tv' : 'movie') : (it.name && !it.title ? 'tv' : 'movie');
export const titleOf = (it) => it.title || it.name || 'Untitled';
export const yearOf = (it) => (it.release_date || it.first_air_date || '').slice(0, 4);
export const esc = (s) => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** document.getElementById, shortened — every view renders into fixed ids from index.html. */
export const $ = (id) => document.getElementById(id);
