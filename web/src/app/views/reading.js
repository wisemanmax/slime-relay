/* The Read tab — '#read' and everything under it:

     #read, #read/manga, #read/comics       the hub: Continue Reading + Saved
                                            (every title, from the store's
                                            `reading` key), a Manga | Comics
                                            switch, search, shelves
     #read/manga/<source>/<id>              a manga's series page   (reading-series.js)
     #read/r/<source>/<id>/<chapter>        …and its reader
     #read/comic/<source>/<slug>            a comic's series page   (reading-comic.js)
     #read/rc/<source>/<slug>/<chapter>     …and its reader
     #read/comics/<source>[/<publisher>]    one comic source's grid (reading-comic.js)

   Manga search asks MangaDex and Mangapill (neither needs the Mac) and, when
   the Mac answers, every engine source at once (/api/read/search). Comics
   search every comic source, or the one picked in the pills. Each row fills
   in as its source answers. */

import { esc, $ } from '../util.js';
import { getState, subscribe } from '../state.js';
import { onAction } from '../ui/actions.js';
import { routeArgs, routeHash } from '../router.js';
import { continueShelf, savedShelf } from '../reader/progress.js';
import { mdSearch, mdPopular, mdLatest, mangaSearch, engineSearchAll, engineSources, comicSources, comicSearch, comicBrowse, LOCAL_SOURCES } from './reading-api.js';
import { itemCard, resumeCard, savedCard, shelf, statusRow, pills } from './reading-ui.js';
import { nav, nextGen, live, openReaderRoute } from './reading-nav.js';
import { viewMangaSeries, viewMangaReader } from './reading-series.js';
import { viewComicSeries, viewComicReader, viewComicBrowse } from './reading-comic.js';

export function viewRead() {
  const [kind, a, b, c] = routeArgs(location.hash);
  const gen = nextGen();
  if (kind === 'manga' && a && b) return viewMangaSeries(a, b, gen);
  if (kind === 'r' && a && b && c) return viewMangaReader(a, b, c, gen);
  if (kind === 'comic' && a && b) return viewComicSeries(a, b, gen);
  if (kind === 'rc' && a && b && c) return viewComicReader(a, b, c, gen);
  if (kind === 'comics' && a) return viewComicBrowse(a, b || null, gen);
  return viewHub(kind === 'comics' || kind === 'manga' ? kind : lastTab, gen);
}

// ── the hub ──────────────────────────────────────────────────────────────────
let lastTab = 'manga';
const lastSearch = { manga: { q: '', html: '' }, comics: { q: '', html: '', src: '' } };
const names = new Map(LOCAL_SOURCES.map(s => [s.id, s.name]));   // source id -> name, as the sources answer
const nameOf = (id) => names.get(id) || id;
let watching = false;

function viewHub(tab, gen) {
  lastTab = tab;
  const main = $('main');
  const isManga = tab === 'manga';
  main.innerHTML = `<div class="rd-hub">
    <div class="rd-hubhead">
      <h1>Read</h1>
      <div class="rd-switch" role="tablist">
        <button class="${isManga ? 'on' : ''}" data-act="go" data-to="#read/manga">Manga</button>
        <button class="${isManga ? '' : 'on'}" data-act="go" data-to="#read/comics">Comics</button>
      </div>
    </div>
    <div id="rdmine"></div>
    <div class="rd-search">
      <input id="rdq" type="search" placeholder="${isManga ? 'Search manga' : 'Search comics'}" autocomplete="off"
             autocapitalize="none" enterkeyhint="search" value="${esc(lastSearch[tab].q)}">
    </div>
    ${isManga ? '' : '<div class="genrebar rd-pills" id="rdsrc"></div>'}
    <div id="rdres">${lastSearch[tab].html}</div>
    <div id="rdshelves"></div>
  </div>`;
  renderMine();
  const input = $('rdq');
  let t = null;
  const run = () => { clearTimeout(t); (isManga ? searchManga : searchComics)(input.value.trim(), gen); };
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 450); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); input.blur(); } });
  if (isManga) mangaShelves(gen); else comicShelves(gen);
  // Another device's progress arriving (sync) refreshes the shelves in place.
  if (!watching) {
    watching = true;
    subscribe((state, m) => { if (m.keys.includes('reading') && m.source !== 'local' && $('rdmine')) renderMine(); });
  }
}

function renderMine() {
  const box = $('rdmine'); if (!box) return;
  const r = getState().reading || {};
  box.innerHTML =
    shelf('Continue Reading', continueShelf(r).slice(0, 30).map(e => resumeCard(e, nameOf(e.source)))) +
    shelf('Saved', savedShelf(r).slice(0, 60).map(e => savedCard(e, nameOf(e.source))));
}

// ── manga ────────────────────────────────────────────────────────────────────
let searchSeq = 0;
async function searchManga(q, gen) {
  const box = $('rdres'); if (!box) return;
  const sid = ++searchSeq;
  if (q.length < 2) { box.innerHTML = ''; lastSearch.manga = { q: '', html: '' }; return; }
  box.innerHTML = `<div id="rsmd">${statusRow('MangaDex', 'Searching…')}</div><div id="rsmp">${statusRow('Mangapill', 'Searching…')}</div><div id="rseng"></div>`;
  const put = (id, html) => {
    if (sid !== searchSeq || !live(gen)) return;
    const el = $(id); if (el) el.innerHTML = html;
    lastSearch.manga = { q, html: box.innerHTML };
  };
  const row = (title, items, sub) => items.length ? shelf(title, items.map(it => itemCard(it, 'manga', sub ? sub(it) : (it.year ? String(it.year) : ''))))
                                                  : statusRow(title, 'No matches.');
  mdSearch(q).then(items => put('rsmd', row('MangaDex', items)), () => put('rsmd', statusRow('MangaDex', "MangaDex didn't answer.")));
  mangaSearch('mangapill', q).then(items => put('rsmp', row('Mangapill', items)), () => put('rsmp', statusRow('Mangapill', "Mangapill didn't answer.")));
  put('rseng', statusRow('Your home server', 'Searching its sources…'));
  const es = await engineSources();
  if (sid !== searchSeq || !live(gen)) return;
  if (!es) { put('rseng', statusRow('Your home server', "Not answering — MangaDex and Mangapill still work.")); return; }
  for (const s of es.sources) names.set(s.id, s.name);
  if (!es.sources.length) { put('rseng', ''); return; }
  try {
    const { items, partial } = await engineSearchAll(q);
    const hits = items.filter(it => it.source !== 'mangadex' && it.source !== 'mangapill');
    put('rseng', hits.length
      ? shelf('Your home server', hits.slice(0, 40).map(it => itemCard(it, 'manga', nameOf(it.source))), partial ? 'some sources were slow' : '')
      : statusRow('Your home server', 'No matches.'));
  } catch {
    put('rseng', statusRow('Your home server', "Its sources didn't answer this time."));
  }
}

const shelfCache = new Map();   // name -> { at, value: Promise }
function cachedShelf(name, load) {
  const hit = shelfCache.get(name);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
  const value = load().catch(e => { shelfCache.delete(name); throw e; });
  shelfCache.set(name, { at: Date.now(), value });
  return value;
}

function mangaShelves(gen) {
  const box = $('rdshelves'); if (!box) return;
  box.innerHTML = '<div id="shpop"></div><div id="shlat"></div>';
  const fill = (id, title, p) => p.then(items => {
    if (!live(gen)) return;
    const el = $(id); if (el) el.innerHTML = shelf(title, items.map(it => itemCard(it, 'manga', it.year ? String(it.year) : '')));
  }, () => { if (live(gen)) { const el = $(id); if (el) el.innerHTML = statusRow(title, "MangaDex didn't answer."); } });
  fill('shpop', 'Popular on MangaDex', cachedShelf('md-popular', () => mdPopular(20)));
  fill('shlat', 'Latest updates on MangaDex', cachedShelf('md-latest', () => mdLatest(20)));
}

// ── comics ───────────────────────────────────────────────────────────────────
const MAC_OFF = "Comics come from your home server (the Mac), which isn't answering right now. Manga still works.";

async function comicShelves(gen) {
  const box = $('rdshelves'); if (!box) return;
  box.innerHTML = '<div class="empty">Loading…</div>';
  const sources = await comicSources();
  if (!live(gen)) return;
  const pillBox = $('rdsrc');
  if (!sources) {
    box.innerHTML = `<div class="rd-status rd-wide">${esc(MAC_OFF)}</div>`;
    if (pillBox) pillBox.style.display = 'none';
    return;
  }
  for (const s of sources) names.set(s.id, s.name);
  renderMine();   // comic source names are known now
  if (pillBox) pillBox.innerHTML = pills('read-src', [['', 'All sources'], ...sources.map(s => [s.id, s.name])], lastSearch.comics.src);
  box.innerHTML = sources.map(s => `<div id="shc-${esc(s.id)}">${statusRow('Latest on ' + s.name, 'Loading…')}</div>`).join('');
  for (const s of sources) {
    cachedShelf('comic-' + s.id, () => comicBrowse(s.id, null, '1')).then(items => {
      if (!live(gen)) return;
      const el = $('shc-' + s.id); if (!el) return;
      const pubs = (s.publisherList || []).slice(0, 12);
      el.innerHTML = (items.length
        ? `<div class="row rd-row"><h2>Latest on ${esc(s.name)} <a class="rd-all" data-act="go" data-to="${esc(routeHash('read', 'comics', s.id))}">See all ›</a></h2>` +
          `<div class="track">${items.slice(0, 24).map(it => itemCard({ ...it, source: it.source || s.id }, 'comic', [it.publisher, it.year].filter(Boolean).join(' · '))).join('')}</div></div>`
        : statusRow('Latest on ' + s.name, 'Nothing listed right now.')) +
        (pubs.length ? `<div class="rd-pubs">${pubs.map(p => `<button data-act="go" data-to="${esc(routeHash('read', 'comics', s.id, p))}">${esc(p)}</button>`).join('')}</div>` : '');
    }, () => { if (live(gen)) { const el = $('shc-' + s.id); if (el) el.innerHTML = statusRow('Latest on ' + s.name, "Didn't answer."); } });
  }
}

let comicSeq = 0;
async function searchComics(q, gen) {
  const box = $('rdres'); if (!box) return;
  const sid = ++comicSeq;
  const src = lastSearch.comics.src;
  if (q.length < 2) { box.innerHTML = ''; lastSearch.comics = { q: '', html: '', src }; return; }
  const sources = await comicSources();
  if (sid !== comicSeq || !live(gen)) return;
  if (!sources) { box.innerHTML = `<div class="rd-status rd-wide">${esc(MAC_OFF)}</div>`; return; }
  const pick = src ? sources.filter(s => s.id === src) : sources;
  box.innerHTML = pick.map(s => `<div id="rsc-${esc(s.id)}">${statusRow(s.name, 'Searching…')}</div>`).join('');
  const put = (id, html) => {
    if (sid !== comicSeq || !live(gen)) return;
    const el = $(id); if (el) el.innerHTML = html;
    lastSearch.comics = { q, html: box.innerHTML, src };
  };
  for (const s of pick) {
    comicSearch(s.id, q).then(items => put('rsc-' + s.id, items.length
      ? shelf(s.name, items.slice(0, 30).map(it => itemCard({ ...it, source: it.source || s.id }, 'comic', [it.publisher, it.year].filter(Boolean).join(' · '))))
      : statusRow(s.name, 'No matches.')),
    () => put('rsc-' + s.id, statusRow(s.name, "Didn't answer.")));
  }
}

// ── actions ──────────────────────────────────────────────────────────────────
onAction('read-resume', (el) => {
  const e = (getState().reading || {})[el.dataset.key];
  if (!e || !e.chapter) return;
  const key = el.dataset.key;
  const source = e.source || key.slice(0, key.indexOf(':'));
  const id = e.id || key.slice(key.indexOf(':') + 1);
  openReaderRoute(e.kind === 'comic' ? 'comic' : 'manga', source, id, e.chapter, { page: e.page || 0, resume: true });
});
onAction('read-src', (el) => {
  lastSearch.comics.src = el.dataset.v || '';
  const box = $('rdsrc');
  if (box) box.querySelectorAll('button').forEach(b => b.classList.toggle('on', (b.dataset.v || '') === lastSearch.comics.src));
  const input = $('rdq');
  // Same render, so the current generation stays live.
  if (input && input.value.trim().length >= 2) searchComics(input.value.trim(), nav.gen);
});
