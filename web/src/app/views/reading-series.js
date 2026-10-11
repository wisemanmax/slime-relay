/* A manga's series page — '#read/manga/<source>/<id>' — and its reader route
   '#read/r/<source>/<id>/<chapter>' (the series page renders underneath).

   Cover, description, Continue / Start + Save, the "Read from" picker (the
   same title on another source, by strict title match — reading-match.js),
   and the chapter list (newest first; the toggle flips it to oldest first and
   is remembered in prefs.readingOldestFirst). */

import { esc, $ } from '../util.js';
import { getState, setPrefs } from '../state.js';
import { onAction } from '../ui/actions.js';
import { go } from '../router.js';
import { toast } from '../ui/toast.js';
import { openReader } from '../reader/reader.js';
import { chapterLabel } from '../reader/logic.js';
import { readingKey, readingEntry, resumeTarget, crossSourceEntry, isSaved, setSaved } from '../reader/progress.js';
import { mangaSeries, mangaPages, mangaSearch, engineSources, LOCAL_SOURCES, isLocalSource } from './reading-api.js';
import { bestMatch, matchQueries } from './reading-match.js';
import { coverImg, seriesHash, readerHash, pills, STATUS_WORDS } from './reading-ui.js';
import { live, openReaderRoute, takePending, cached } from './reading-nav.js';

const SERIES_TTL = 10 * 60 * 1000;
export const loadSeries = (source, id) => cached('manga:' + source + ':' + id, SERIES_TTL, () => mangaSeries(source, id));

let page = null;   // the series on screen: { source, id, s, gen }

/** A source id -> its display name (engine names once /api/read/sources answered). */
export function sourceName(id, engine) {
  const local = LOCAL_SOURCES.find(s => s.id === id);
  if (local) return local.name;
  const e = engine && engine.sources && engine.sources.find(s => s.id === id);
  return e ? e.name : id;
}
let engineCache = null;   // /api/read/sources, once the Mac answered

const oldestFirst = () => !!(getState().prefs || {}).readingOldestFirst;

export async function viewMangaSeries(source, id, gen) {
  const main = $('main');
  main.innerHTML = '<div class="empty">Loading…</div>';
  let s;
  try { s = await loadSeries(source, id); }
  catch (e) {
    if (!live(gen)) return null;
    main.innerHTML = `<div class="empty rd-err">Couldn't load this series from ${esc(sourceName(source, engineCache))}.<br><br>` +
      `<span class="rd-dim">${esc(isLocalSource(source) ? 'The site didn\'t answer — try again in a moment.' : 'It comes from your home server (the Mac), which isn\'t answering.')}</span><br><br>` +
      `<button class="btn ghost" data-act="go" data-to="#read">Back to Read</button></div>`;
    return null;
  }
  if (!live(gen)) return null;
  page = { source, id, s, gen };
  renderSeries();
  // Engine source names + the rest of the Read-from picker, when the Mac answers.
  engineSources().then(es => {
    engineCache = es;
    if (!page || page.gen !== gen || !live(gen)) return;
    renderFrom();
    const eb = $('rdeyebrow'); if (eb) eb.innerHTML = eyebrow();
  });
  return s;
}

function renderSeries() {
  const { source, id, s } = page;
  const main = $('main');
  const meta = [s.year, STATUS_WORDS[s.status], s.chapters.length ? s.chapters.length + ' chapters' : 'No chapters', ...(s.authors || []).slice(0, 2)]
    .filter(Boolean).map(x => `<span class="pill">${esc(x)}</span>`).join('');
  main.innerHTML = `<div class="rd-series">
    <div class="rd-shead">
      <div class="rd-cover">${coverImg(s.cover)}</div>
      <div class="rd-meta">
        <div class="eyebrow" id="rdeyebrow">${eyebrow()}</div>
        <h1>${esc(s.title)}</h1>
        <div class="pills">${meta}</div>
        <div class="btns" id="rdbtns"></div>
        ${s.genres && s.genres.length ? `<div class="rd-genres">${s.genres.map(g => `<span>${esc(g)}</span>`).join('')}</div>` : ''}
        ${s.description ? `<p class="ov rd-desc">${esc(s.description)}</p>` : ''}
        <div class="rd-from"><span class="rd-label">Read from</span><div class="rd-fromp" id="rdfromp"></div></div>
        <div class="rd-fromnote" id="rdfrom"></div>
      </div>
    </div>
    <div class="rd-chhead"><h2>Chapters</h2>${s.chapters.length > 1 ? `<button class="rd-order" data-act="read-order" id="rdorder"></button>` : ''}</div>
    <div class="rd-chs" id="rdchs"></div>
  </div>`;
  renderButtons();
  renderFrom();
  renderChapters();
}

const eyebrow = () => `MANGA · ${esc(sourceName(page.source, engineCache))}${page.s.stale ? ' · saved copy' : ''}`;

/** Continue (from this title's record, or the same title read on another source) / Start, and Save. */
function resumeFor() {
  const { source, id, s } = page;
  const own = readingEntry(source, id);
  const entry = own && own.chapter ? own : crossSourceEntry(getState().reading, s.title, readingKey(source, id));
  return { entry, target: resumeTarget(entry, s.chapters) };
}
function firstReadable(chapters) { return chapters.findIndex(c => !c.external); }

function renderButtons() {
  const box = $('rdbtns'); if (!box || !page) return;
  const { source, id, s } = page;
  const { target } = resumeFor();
  let play = '';
  if (target) {
    const c = s.chapters[target.index];
    play = `<button class="btn play" data-act="read-open" data-i="${target.index}" data-page="${target.page}">▶ Continue · ${esc(chapterLabel(c))}${target.page ? ` · p. ${target.page + 1}` : ''}</button>`;
  } else {
    const i = firstReadable(s.chapters);
    if (i >= 0) play = `<button class="btn play" data-act="read-open" data-i="${i}" data-page="0">▶ Start · ${esc(chapterLabel(s.chapters[i]))}</button>`;
  }
  const saved = isSaved(source, id);
  box.innerHTML = play + `<button class="btn ghost" data-act="read-save">${saved ? '✓ Saved' : '＋ Save'}</button>`;
}

function renderFrom() {
  const box = $('rdfromp'); if (!box || !page) return;
  const engines = (engineCache && engineCache.sources) || [];
  const items = [...LOCAL_SOURCES.map(x => [x.id, x.name]), ...engines.filter(e => !e.slow).map(e => [e.id, e.name])];
  if (!items.some(([v]) => v === page.source)) items.push([page.source, sourceName(page.source, engineCache)]);
  box.innerHTML = pills('read-from', items, page.source);
}

function renderChapters() {
  const box = $('rdchs'); if (!box || !page) return;
  const { s, source, id } = page;
  const entry = readingEntry(source, id);
  const cur = entry && entry.chapter ? s.chapters.findIndex(c => c.id === entry.chapter) : -1;
  const asc = oldestFirst();
  const order = $('rdorder');
  if (order) order.textContent = asc ? 'Oldest first ↑' : 'Newest first ↓';
  if (!s.chapters.length) { box.innerHTML = '<div class="rd-status">This source lists no chapters for it. Try another under “Read from”.</div>'; return; }
  const idx = s.chapters.map((_, i) => i);
  if (!asc) idx.reverse();
  box.innerHTML = idx.map(i => {
    const c = s.chapters[i];
    const sub = [c.date ? String(c.date).slice(0, 10) : '', c.group || ''].filter(Boolean).join(' · ');
    const cls = 'rd-ch' + (i === cur ? ' cur' : cur >= 0 && i < cur ? ' read' : '');
    if (c.external) {
      return `<a class="${cls} ext" href="${esc(c.external)}" target="_blank" rel="noopener noreferrer">` +
        `<span class="rd-cht">${esc(chapterLabel(c))} ↗</span><span class="rd-chd">on the publisher's site${sub ? ' · ' + esc(sub) : ''}</span></a>`;
    }
    return `<div class="${cls}" data-act="read-open" data-i="${i}" data-page="${i === cur ? (entry.page || 0) : 0}">` +
      `<span class="rd-cht">${esc(chapterLabel(c))}</span>${sub || i === cur ? `<span class="rd-chd">${i === cur ? 'Reading · p. ' + ((entry.page || 0) + 1) + (sub ? ' · ' : '') : ''}${esc(sub)}</span>` : ''}</div>`;
  }).join('');
}

// ── "Read from": the same title on another source ─────────────────────────────
const matchCache = new Map();   // `${fromKey}>${toSource}` -> id | null
async function readFrom(toSource) {
  if (!page || toSource === page.source) return;
  const { s, source, id, gen } = page;
  const note = $('rdfrom');
  const name = sourceName(toSource, engineCache);
  const ck = `${source}:${id}>${toSource}`;
  if (matchCache.has(ck)) {
    const hit = matchCache.get(ck);
    if (hit) return go(seriesHash('manga', toSource, hit));
    if (note) note.textContent = `Not found on ${name}.`;
    return;
  }
  if (note) note.textContent = `Looking on ${name}…`;
  const titles = matchQueries(s.title, s.altTitles || []);
  let found = null;
  for (const q of titles) {
    let hits;
    try { hits = await mangaSearch(toSource, q); }
    catch (e) {
      if (live(gen) && note) note.textContent = `${name} didn't answer${isLocalSource(toSource) ? '' : ' (it needs your home server)'}.`;
      return;
    }
    if (!live(gen)) return;
    const m = bestMatch(titles, s.year, hits);
    if (m) { found = m.item; break; }
  }
  matchCache.set(ck, found ? found.id : null);
  if (!live(gen)) return;
  if (found) go(seriesHash('manga', toSource, found.id));
  else if (note) note.textContent = `Not found on ${name}.`;
}

// ── the reader route ──────────────────────────────────────────────────────────
export async function viewMangaReader(source, id, chapterId, gen) {
  const hash = readerHash('manga', source, id, chapterId);
  const pending = takePending(hash);
  const s = await viewMangaSeries(source, id, gen);
  if (!s || !live(gen)) return;
  let index = s.chapters.findIndex(c => c.id === chapterId);
  let pg = pending ? pending.page || 0 : 0;
  const entry = readingEntry(source, id);
  if (pending && pending.resume) {
    const t = resumeTarget(entry, s.chapters);
    if (t) { index = t.index; pg = t.page; }
  } else if (!pending && entry && entry.chapter === chapterId) {
    pg = entry.page || 0;   // a reload lands where it was
  }
  if (index < 0) { toast('That chapter is no longer listed on this source.'); history.replaceState(history.state, '', seriesHash('manga', source, id)); return; }
  openReader({
    kind: 'manga', source, id, title: s.title, cover: s.cover,
    chapters: s.chapters, index, page: pg,
    formatLongStrip: !!s.isLongStrip, chosenMode: entry && entry.mode,
    backHash: seriesHash('manga', source, id), fromApp: !!pending,
    loadPages: (ch) => mangaPages(source, id, ch.id),
    hashFor: (i) => readerHash('manga', source, id, s.chapters[i].id),
  });
}

// ── actions ──────────────────────────────────────────────────────────────────
onAction('read-open', (el) => {
  if (!page) return;
  const c = page.s.chapters[+el.dataset.i];
  if (c) openReaderRoute('manga', page.source, page.id, c.id, { page: +el.dataset.page || 0 });
});
onAction('read-save', () => {
  if (!page) return;
  const { source, id, s } = page;
  setSaved({ kind: 'manga', source, id, title: s.title, cover: s.cover }, !isSaved(source, id));
  renderButtons();
});
onAction('read-order', () => {
  setPrefs({ readingOldestFirst: !oldestFirst() });
  renderChapters();
});
onAction('read-from', (el) => readFrom(el.dataset.v));
