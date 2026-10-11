/* Comics: a comic's series page '#read/comic/<source>/<slug>', its reader route
   '#read/rc/<source>/<slug>/<chapter>', and one source's (or publisher's) grid
   '#read/comics/<source>[/<publisher>]'. All of it comes from the extractor's
   /comic/* through the Worker, so it needs the Mac.

   GetComics and the Internet Archive ("downloads" sources) fetch a whole
   CBZ to the Mac first: the first /comic/pages call starts it, and the
   download card polls every 2 s — progress %, the server's own error
   sentence, Retry when it says retrying can help — then opens the reader. */

import { esc, $ } from '../util.js';
import { getState, setPrefs } from '../state.js';
import { onAction } from '../ui/actions.js';
import { openReader } from '../reader/reader.js';
import { chapterLabel } from '../reader/logic.js';
import { readingEntry, resumeTarget, isSaved, setSaved } from '../reader/progress.js';
import { comicSources, comicDetail, comicPages, comicBrowse, comicPagesId, comicErrorWords } from './reading-api.js';
import { coverImg, itemCard, seriesHash, readerHash } from './reading-ui.js';
import { live, openReaderRoute, takePending, cached } from './reading-nav.js';

const DETAIL_TTL = 10 * 60 * 1000;
const loadDetail = (source, slug) => cached('comic:' + source + ':' + slug, DETAIL_TTL, () => comicDetail(source, slug));

export const comicSourceName = (id, list) => ((list || []).find(s => s.id === id) || {}).name || id;
const isDownloadSource = (id, list) => !!((list || []).find(s => s.id === id) || {}).downloads || id === 'getcomics' || id === 'ia';

/** "#12" / "Issue 12" in a title -> 12. */
export function issueNumber(title) {
  const m = String(title || '').match(/#\s*(\d+(?:\.\d+)?)/) || String(title || '').match(/\bissue\s+(\d+(?:\.\d+)?)/i);
  return m ? Number(m[1]) : null;
}

/** /comic/detail -> chapters in reading order. A single-file item (a GetComics
    post, an Archive item) that lists none IS the issue. Numbered issues that
    come newest first are flipped. */
export function comicChapters(detail, slug) {
  let list = (detail && Array.isArray(detail.chapters) ? detail.chapters : []).map(c => ({
    id: String(c.id), title: c.title || null, label: c.title || null, number: issueNumber(c.title),
    date: c.date || null, pages: c.pages || null, external: null,
    locked: c.readable === false, downloaded: !!c.downloaded,
    note: [c.size, Array.isArray(c.hosts) ? c.hosts.join(', ') : ''].filter(Boolean).join(' · ') || null,
  })).filter(c => c.id);
  if (!list.length && detail) list = [{ id: String(slug), title: detail.title || null, label: detail.title || null, number: issueNumber(detail.title), date: null, pages: null, external: null, locked: false, downloaded: false, note: null }];
  const nums = list.map(c => c.number).filter(n => n != null);
  if (nums.length >= 2 && nums.length >= list.length / 2) {
    let down = 0, up = 0;
    for (let i = 1; i < nums.length; i++) { if (nums[i] < nums[i - 1]) down++; else if (nums[i] > nums[i - 1]) up++; }
    if (down > up) list.reverse();
  }
  return list;
}

/** /comic/pages state, read leniently (the iOS ComicPagesResponse rules). */
export function comicState(b) {
  const pages = Array.isArray(b && b.pages) ? b.pages : [];
  const st = String((b && b.state) || '').toLowerCase();
  if (['downloading', 'extracting', 'unpacking'].includes(st)) return 'downloading';
  if (['queued', 'pending', 'waiting'].includes(st)) return 'queued';
  if (st === 'error' || st === 'failed') return 'error';
  if (st === 'ready' || st === '') return !pages.length && b && b.error ? 'error' : 'ready';
  return pages.length ? 'ready' : 'downloading';
}
/** 0…1 when known: `progress`, else bytes/total. */
export function comicFraction(b) {
  if (b && typeof b.progress === 'number' && isFinite(b.progress)) return Math.min(Math.max(b.progress > 1 ? b.progress / 100 : b.progress, 0), 1);
  if (b && b.bytes > 0 && b.total > 0) return Math.min(b.bytes / b.total, 1);
  return null;
}
const mb = (n) => { const m = n / 1e6; return m >= 10 ? Math.round(m) + ' MB' : m.toFixed(1) + ' MB'; };
/** The card's status line: "Downloading 48 MB… 62%". */
export function comicStatusLine(b) {
  const st = comicState(b);
  if (st === 'queued') return 'Waiting for another download to finish…' + (b && b.position ? ` (#${b.position} in line)` : '');
  if (st === 'downloading') {
    const f = comicFraction(b);
    const size = b && b.total > 0 ? ' ' + mb(b.total) : b && b.bytes > 0 ? ' ' + mb(b.bytes) : '';
    const phase = b && /unpack|extract/i.test(b.phase || b.state || '') ? 'Unpacking' : 'Downloading';
    return `${phase}${size}…${f != null ? ' ' + Math.floor(f * 100) + '%' : ''}`;
  }
  if (st === 'error') return comicErrorWords(b && b.error, b && b.message);
  return 'Ready';
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
/** Poll /comic/pages until ready or failed (2 s apart; give up after 10 min or
    5 failed requests in a row). Resolves the final answer, or null if
    `isLive()` turned false (the reader moved on). */
export async function pollComic(source, comic, chapter, { retry = false, onState = () => {}, isLive = () => true } = {}) {
  const t0 = Date.now();
  let failures = 0, first = true;
  while (isLive()) {
    let b = null;
    try { b = await comicPages(source, comic, chapter, retry && first); failures = 0; }
    catch (e) {
      failures++;
      if (e.status === 404) return { state: 'error', error: 'not-found', message: 'This issue is no longer listed by the source.', retryable: false };
      if (e.status === 400) return { state: 'error', error: 'bad-request', message: "The source didn't accept this issue.", retryable: false };
      if (failures >= 5) return { state: 'error', error: e.code || 'unreachable', message: "Your home server (the Mac) isn't answering.", retryable: true };
    }
    first = false;
    if (!isLive()) return null;
    if (b) {
      const st = comicState(b);
      onState(b, st);
      if (st === 'ready') return { ...b, state: 'ready' };
      if (st === 'error') return { ...b, state: 'error' };
    }
    if (Date.now() - t0 > 10 * 60 * 1000) return { state: 'error', error: 'timeout', message: 'The download is taking too long. Try again in a while.', retryable: true };
    await sleep(2000);
  }
  return null;
}

// ── series page ──────────────────────────────────────────────────────────────
let page = null;   // { source, slug, d, chapters, comic, gen, sources }
let dl = null;     // the download card's job: { i, run }

// The same list-order preference as manga (prefs.readingOldestFirst).
const oldestFirst = () => !!(getState().prefs || {}).readingOldestFirst;

export async function viewComicSeries(source, slug, gen) {
  const main = $('main');
  main.innerHTML = '<div class="empty">Loading…</div>';
  dl = null;
  let d, sources;
  try { [d, sources] = await Promise.all([loadDetail(source, slug), comicSources()]); }
  catch (e) {
    if (!live(gen)) return null;
    main.innerHTML = `<div class="empty rd-err">Couldn't load this comic.<br><br><span class="rd-dim">${esc(e && e.status === 404 ? 'The source no longer lists it.' : "Comics come from your home server (the Mac), which isn't answering.")}</span><br><br>` +
      `<button class="btn ghost" data-act="go" data-to="#read/comics">Back to Comics</button></div>`;
    return null;
  }
  if (!live(gen)) return null;
  page = { source, slug, d, chapters: comicChapters(d, slug), comic: comicPagesId(d, slug), gen, sources: sources || [] };
  renderSeries();
  return page;
}

function renderSeries() {
  const { source, d, chapters, sources } = page;
  const meta = [d.publisher, d.year, chapters.length === 1 ? 'Single issue' : chapters.length + ' issues']
    .filter(Boolean).map(x => `<span class="pill">${esc(x)}</span>`).join('');
  $('main').innerHTML = `<div class="rd-series">
    <div class="rd-shead">
      <div class="rd-cover">${coverImg(d.cover)}</div>
      <div class="rd-meta">
        <div class="eyebrow">COMIC · ${esc(comicSourceName(source, sources))}</div>
        <h1>${esc(d.title || 'Untitled')}</h1>
        <div class="pills">${meta}</div>
        <div class="btns" id="rdbtns"></div>
        <div id="rddl"></div>
        ${d.description ? `<p class="ov rd-desc">${esc(d.description)}</p>` : ''}
        ${isDownloadSource(source, sources) ? `<p class="rd-dim rd-small">Issues from ${esc(comicSourceName(source, sources))} download to your home server first, then open.</p>` : ''}
      </div>
    </div>
    <div class="rd-chhead"><h2>${chapters.length === 1 ? 'Issue' : 'Issues'}</h2>${chapters.length > 1 ? `<button class="rd-order" data-act="read-corder" id="rdorder"></button>` : ''}</div>
    <div class="rd-chs" id="rdchs"></div>
  </div>`;
  renderButtons();
  renderIssues();
}

function renderButtons() {
  const box = $('rdbtns'); if (!box || !page) return;
  const { source, slug, chapters } = page;
  const entry = readingEntry(source, slug);
  const t = resumeTarget(entry, chapters);
  let play = '';
  if (t) play = `<button class="btn play" data-act="read-issue" data-i="${t.index}" data-page="${t.page}">▶ Continue · ${esc(issueLabel(chapters[t.index]))}${t.page ? ` · p. ${t.page + 1}` : ''}</button>`;
  else {
    const i = chapters.findIndex(c => !c.locked);
    if (i >= 0) play = `<button class="btn play" data-act="read-issue" data-i="${i}" data-page="0">▶ Read · ${esc(issueLabel(chapters[i]))}</button>`;
  }
  box.innerHTML = play + `<button class="btn ghost" data-act="read-csave">${isSaved(source, slug) ? '✓ Saved' : '＋ Save'}</button>`;
}
const issueLabel = (c) => (c.number != null ? '#' + c.number : chapterLabel(c));

function renderIssues() {
  const box = $('rdchs'); if (!box || !page) return;
  const { chapters, source, slug } = page;
  const entry = readingEntry(source, slug);
  const cur = entry && entry.chapter ? chapters.findIndex(c => c.id === entry.chapter) : -1;
  const asc = oldestFirst();
  const order = $('rdorder');
  if (order) order.textContent = asc ? 'Oldest first ↑' : 'Newest first ↓';
  const idx = chapters.map((_, i) => i);
  if (!asc) idx.reverse();
  box.innerHTML = idx.map(i => {
    const c = chapters[i];
    const sub = [i === cur ? 'Reading · p. ' + ((entry.page || 0) + 1) : '', c.downloaded ? 'On your home server' : '', c.note, c.date ? String(c.date).slice(0, 10) : '', c.locked ? 'No direct download' : '']
      .filter(Boolean).join(' · ');
    const cls = 'rd-ch' + (i === cur ? ' cur' : cur >= 0 && i < cur ? ' read' : '') + (c.locked ? ' locked' : '');
    return `<div class="${cls}"${c.locked ? '' : ` data-act="read-issue" data-i="${i}" data-page="${i === cur ? entry.page || 0 : 0}"`}>` +
      `<span class="rd-cht">${esc(c.title || issueLabel(c))}</span>${sub ? `<span class="rd-chd">${esc(sub)}</span>` : ''}</div>`;
  }).join('') || '<div class="rd-status">No issues listed.</div>';
}

/** Open an issue: straight into the reader, or (download sources) via the download card. */
function readIssue(i, pg, retry = false) {
  if (!page) return;
  const c = page.chapters[i];
  if (!c || c.locked) return;
  const { source, slug } = page;
  if (!isDownloadSource(source, page.sources) || c.downloaded) return openReaderRoute('comic', source, slug, c.id, { page: pg });
  startDownload(i, pg, retry);
}

async function startDownload(i, pg, retry) {
  const { source, slug, comic, chapters, gen } = page;
  const c = chapters[i];
  const run = {};
  dl = { i, run };
  const isLive = () => live(gen) && dl && dl.run === run;
  paintCard(c, { state: 'queued' }, 'Starting the download…');
  const b = await pollComic(source, comic, c.id, {
    retry, isLive, onState: (ans) => { if (isLive()) paintCard(c, ans); },
  });
  if (!b || !isLive()) return;
  if (b.state === 'ready') { dl = null; openReaderRoute('comic', source, slug, c.id, { page: pg }); return; }
  paintCard(c, b, null, i, pg);
}

function paintCard(c, b, line, i, pg) {
  const box = $('rddl'); if (!box) return;
  const st = comicState(b);
  const f = comicFraction(b);
  const retry = st === 'error' && b.retryable !== false;
  box.innerHTML = `<div class="rd-dl${st === 'error' ? ' err' : ''}">
    <div class="rd-dlt">${esc(c.title || issueLabel(c))}</div>
    <div class="rd-dls">${esc(line || comicStatusLine(b))}</div>
    ${st !== 'error' ? `<div class="rd-prog${f == null ? ' indet' : ''}"><i style="width:${f == null ? 30 : Math.round(f * 100)}%"></i></div>` : ''}
    <div class="rd-dlb">${retry ? `<button class="btn play" data-act="read-dlretry" data-i="${i}" data-page="${pg || 0}">Try again</button>` : ''}
      <button class="btn ghost" data-act="read-dlstop">${st === 'error' ? 'Close' : 'Stop waiting'}</button></div>
  </div>`;
}

// ── reader route ─────────────────────────────────────────────────────────────
export async function viewComicReader(source, slug, chapterId, gen) {
  const hash = readerHash('comic', source, slug, chapterId);
  const pending = takePending(hash);
  const p = await viewComicSeries(source, slug, gen);
  if (!p || !live(gen)) return;
  const { d, chapters, comic, sources } = p;
  let index = chapters.findIndex(c => c.id === chapterId);
  let pg = pending ? pending.page || 0 : 0;
  const entry = readingEntry(source, slug);
  if (pending && pending.resume) { const t = resumeTarget(entry, chapters); if (t) { index = t.index; pg = t.page; } }
  else if (!pending && entry && entry.chapter === chapterId) pg = entry.page || 0;
  if (index < 0) { history.replaceState(history.state, '', seriesHash('comic', source, slug)); return; }
  const downloads = isDownloadSource(source, sources);
  openReader({
    kind: 'comic', source, id: slug, comic, title: d.title, cover: d.cover,
    chapters: chapters.map(c => (c.locked ? { ...c, external: null } : c)), index, page: pg,
    formatLongStrip: false, chosenMode: entry && entry.mode,
    backHash: seriesHash('comic', source, slug), fromApp: !!pending,
    hashFor: (i) => readerHash('comic', source, slug, chapters[i].id),
    loadPages: async (ch, status) => {
      const myGen = gen;
      const b = downloads
        ? await pollComic(source, comic, ch.id, { isLive: () => live(myGen), onState: (ans) => status(comicStatusLine(ans)) })
        : await comicPages(source, comic, ch.id);
      if (!b) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
      if (comicState(b) !== 'ready') throw Object.assign(new Error(b.error || 'error'), { code: b.error || 'error', words: comicErrorWords(b.error, b.message) });
      return (b.pages || []).map(url => ({ url }));
    },
  });
}

// ── one source's grid (latest, or a publisher) ───────────────────────────────
export async function viewComicBrowse(source, publisher, gen) {
  const main = $('main');
  const sources = await comicSources();
  if (!live(gen)) return;
  const name = comicSourceName(source, sources);
  main.innerHTML = `<div class="chead"><h1>${esc(publisher || name)}</h1><p>${esc(publisher ? 'On ' + name : 'Latest on ' + name)}</p></div>
    <div class="grid" id="rdgrid"></div><div class="rd-more" id="rdmore"><div class="empty">Loading…</div></div>`;
  browseState = { source, publisher, page: 0, gen, seen: new Set() };
  loadMore();
}
let browseState = null;
async function loadMore() {
  const b = browseState; if (!b) return;
  const more = $('rdmore');
  b.page++;
  let items;
  try { items = await comicBrowse(b.source, b.publisher, String(b.page)); }
  catch (e) {
    if (!live(b.gen)) return;
    if (more) more.innerHTML = `<div class="rd-status">${esc(e.code === 'not-configured' || e.status >= 500 || !e.status ? "Comics come from your home server (the Mac), which isn't answering." : "Couldn't load this list.")}</div>`;
    return;
  }
  if (!live(b.gen)) return;
  const fresh = items.filter(it => { const k = it.slug || it.id; if (b.seen.has(k)) return false; b.seen.add(k); return true; });
  const grid = $('rdgrid');
  if (grid) grid.insertAdjacentHTML('beforeend', fresh.map(it => itemCard({ ...it, source: it.source || b.source }, 'comic', [it.publisher, it.year].filter(Boolean).join(' · '))).join(''));
  if (more) more.innerHTML = fresh.length ? '<button class="btn ghost" data-act="read-more">Load more</button>'
    : (b.page === 1 ? '<div class="empty">Nothing listed here right now.</div>' : '');
}

// ── actions ──────────────────────────────────────────────────────────────────
onAction('read-issue', (el) => readIssue(+el.dataset.i, +el.dataset.page || 0));
onAction('read-dlretry', (el) => readIssue(+el.dataset.i, +el.dataset.page || 0, true));
onAction('read-dlstop', () => { dl = null; const box = $('rddl'); if (box) box.innerHTML = ''; });
onAction('read-csave', () => {
  if (!page) return;
  const { source, slug, d, comic } = page;
  setSaved({ kind: 'comic', source, id: slug, comic, title: d.title, cover: d.cover }, !isSaved(source, slug));
  renderButtons();
});
onAction('read-corder', () => {
  setPrefs({ readingOldestFirst: !oldestFirst() });
  renderIssues();
});
onAction('read-more', (el) => { el.disabled = true; loadMore(); });
