/* The page reader: a full-screen layer over the app for one chapter at a time.

   Modes (reader/logic.js): paged left-to-right, paged right-to-left, vertical
   pages, long strip — the strip is picked on its own when the source says
   webtoon or the opening pages measure taller than 2:1, unless the reader
   chose a mode for this title (kept in its `reading` record).
   Paged: tap zones (left/right thirds; the middle shows/hides the bars), a
   swipe, ←/→ (mirrored right-to-left), space; the next 3 pages are fetched
   ahead. After the last page an end-of-chapter card offers the next chapter.
   Scrolling modes: every page in one column; ←/→ jump a page, space scrolls.
   f fullscreen, Esc closes. Pinch-zoom is the browser's own (nothing here
   disables it; a swipe is ignored while zoomed in).

   Progress is written to the store's `reading` record on every page change
   (debounced) and on close, so Continue Reading resumes here — on any device
   once the record syncs.

   It is a route: '#read/r/<source>/<id>/<chapter>' (manga) and
   '#read/rc/<source>/<slug>/<chapter>' (comics), rendered over the series page
   by views/reading.js. Changing chapter rewrites the hash in place
   (replaceState), so Back always returns to the series page, and closing is
   history.back() when we came from it. route() calls closeReader() on every
   navigation, like closeDetail(). */

import { onAction } from '../ui/actions.js';
import { esc } from '../util.js';
import { MODES, isPaged, looksLikeLongStrip, initialMode, tapZone, keyAction, prefetchIndices, step, pageCounter, chapterLabel } from './logic.js';
import { recordProgress, setReaderMode } from './progress.js';

let R = null;          // the open session
let el = null;         // #reader, created on first open
const measured = new Map();   // `${source}:${id}` -> long strip? (this session)

export const isReaderOpen = () => !!R;

function ensureEl() {
  if (el) return el;
  el = document.createElement('div');
  el.id = 'reader';
  el.className = 'reader';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Reader');
  el.innerHTML = `
    <div class="rd-bar rd-top">
      <button class="rd-btn" data-act="reader-close" title="Close (Esc)" aria-label="Close">✕</button>
      <div class="rd-ti"><b id="rdtitle"></b><span id="rdch"></span></div>
      <div class="rd-modes" id="rdmodes"></div>
      <button class="rd-btn rd-fs" data-act="reader-fs" title="Fullscreen (f)" aria-label="Fullscreen">⛶</button>
    </div>
    <div class="rd-stage" id="rdstage" data-act="reader-tap" tabindex="-1"></div>
    <div class="rd-bar rd-bot">
      <button class="rd-btn" data-act="reader-chapter" data-dir="-1" id="rdprev">‹ Prev</button>
      <span class="rd-count" id="rdcount"></span>
      <button class="rd-btn" data-act="reader-chapter" data-dir="1" id="rdnext">Next ›</button>
    </div>`;
  document.body.appendChild(el);
  // A swipe in the paged modes (touch only; ignored while pinch-zoomed or multi-touch).
  let t0 = null;
  el.addEventListener('touchstart', (e) => {
    t0 = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() } : null;
  }, { passive: true });
  el.addEventListener('touchmove', (e) => { if (e.touches.length > 1) t0 = null; }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (!t0 || !R || !isPaged(R.mode) || zoomed()) { t0 = null; return; }
    const t = e.changedTouches[0], dx = t.clientX - t0.x, dy = t.clientY - t0.y;
    const quick = Date.now() - t0.t < 600;
    t0 = null;
    if (quick && Math.abs(dx) > 50 && Math.abs(dx) > 1.5 * Math.abs(dy)) {
      R.swiped = Date.now();   // the click that may follow is not a tap
      const forward = dx < 0;
      move((R.mode === 'rtl' ? !forward : forward) ? 1 : -1);
    }
  }, { passive: true });
  el.addEventListener('mousemove', () => { if (R && hoverDevice() && el.classList.contains('chrome-off')) showChrome(true); });
  return el;
}
const zoomed = () => !!(window.visualViewport && window.visualViewport.scale > 1.05);
const hoverDevice = () => { try { return matchMedia('(hover: hover)').matches; } catch { return false; } };
const $r = (id) => document.getElementById(id);

/** Open the reader. opts: {
      kind:'manga'|'comic', source, id, comic?, title, cover,
      chapters:[{ id, number, title, external }] (reading order), index, page,
      formatLongStrip, chosenMode, backHash, fromApp,
      loadPages(chapter, status) -> Promise<[{ url, width?, height? }]> (status(text) rewords the wait),
      hashFor(index) -> the route hash for that chapter } */
export function openReader(opts) {
  closeReader();
  ensureEl();
  const key = `${opts.source}:${opts.id}`;
  R = {
    ...opts, key,
    mode: initialMode({ chosen: opts.chosenMode, formatLongStrip: opts.formatLongStrip, measured: measured.get(key), kind: opts.kind }),
    pages: null, page: 0, load: 0, saveTimer: null, hideTimer: null, io: null, swiped: 0,
  };
  document.documentElement.classList.add('rd-lock');
  el.classList.add('open');
  $r('rdtitle').textContent = opts.title || '';
  renderModes();
  openChapter(opts.index, { page: opts.page || 0 });
  showChrome(true);
}

/** Tear down (no navigation). Saves where the reader was. */
export function closeReader() {
  if (!R) return;
  saveNow();
  clearTimeout(R.hideTimer);
  if (R.io) R.io.disconnect();
  R = null;
  if (el) {
    el.classList.remove('open', 'chrome-off');
    $r('rdstage').innerHTML = '';
  }
  document.documentElement.classList.remove('rd-lock');
  if (document.fullscreenElement === el && document.exitFullscreen) document.exitFullscreen().catch(() => {});
}

/** Close from inside: back to the series page (history when we came from it). */
function leave() {
  if (!R) return;
  const { fromApp, backHash } = R;
  closeReader();
  if (fromApp && history.length > 1) history.back();
  else location.replace(backHash);
}

// ── chapters ────────────────────────────────────────────────────────────────
async function openChapter(index, { page = 0, atEnd = false } = {}) {
  if (!R) return;
  const ch = R.chapters[index];
  if (!ch) return;
  saveNow();
  const token = ++R.load;
  R.index = index; R.pages = null; R.page = 0;
  if (R.io) { R.io.disconnect(); R.io = null; }
  if (R.hashFor) { try { history.replaceState(history.state, '', R.hashFor(index)); } catch {} }
  $r('rdch').textContent = chapterLabel(ch);
  $r('rdprev').disabled = index <= 0;
  $r('rdnext').disabled = index >= R.chapters.length - 1;
  $r('rdcount').textContent = '';
  const stage = $r('rdstage');
  if (ch.external) {
    stage.innerHTML = card(`<div class="rd-endt">${esc(chapterLabel(ch))}</div>
      <p>This chapter is only readable on the publisher's site.</p>
      <a class="btn play" href="${esc(ch.external)}" target="_blank" rel="noopener noreferrer">Open on the site ↗</a>
      ${nextButton()}`);
    return;
  }
  stage.innerHTML = '<div class="rd-msg">Loading pages…</div>';
  let pages;
  try {
    // `status(text)` lets a slow source (a comic download) word its progress.
    pages = await R.loadPages(ch, (text) => {
      const m = R && token === R.load && stage.querySelector('.rd-msg');
      if (m) m.textContent = text;
    });
  } catch (e) {
    if (!R || token !== R.load) return;
    stage.innerHTML = card(`<div class="rd-endt">Couldn't load this chapter</div>
      <p>${esc(errorWords(e))}</p>
      <button class="btn play" data-act="reader-reload">Try again</button>
      <button class="btn ghost" data-act="reader-close">Back to series</button>`);
    return;
  }
  if (!R || token !== R.load) return;
  if (!pages || !pages.length) {
    stage.innerHTML = card(`<div class="rd-endt">No pages</div><p>The source returned no pages for this chapter.</p>${nextButton()}`);
    return;
  }
  R.pages = pages;
  R.page = atEnd ? pages.length - 1 : Math.min(Math.max(0, page), pages.length - 1);
  render();
  probeShape(token);
  saveSoon();
}

function errorWords(e) {
  if (e && e.words) return e.words;   // a source that already said it in words
  const c = (e && (e.code || e.message)) || '';
  if (/timeout/.test(c)) return 'The source took too long to answer.';
  if (/not-configured|home-server|unreachable|http-50[23]|engine down/.test(c)) return 'Your home server (the Mac) isn\'t answering.';
  if (/challenge/.test(c)) return 'The site is behind a Cloudflare check right now.';
  if (/locked/.test(c)) return 'This chapter isn\'t free to read.';
  if (/expired|http-410/.test(c)) return 'The page links expired. Try again.';
  return 'The source failed (' + c + ').';
}
const card = (inner) => `<div class="rd-end"><div class="rd-endbox">${inner}</div></div>`;
function nextButton() {
  const n = R && R.chapters[R.index + 1];
  return n ? `<button class="btn play" data-act="reader-chapter" data-dir="1">Next: ${esc(chapterLabel(n))}</button>`
           : `<button class="btn ghost" data-act="reader-close">Back to series</button>`;
}
function endCard() {
  const ch = R.chapters[R.index], n = R.chapters[R.index + 1];
  return card(`<div class="rd-endt">End of ${esc(chapterLabel(ch))}</div>` +
    (n ? `<p>Next: ${esc(chapterLabel(n))}</p><button class="btn play" data-act="reader-chapter" data-dir="1">Read next chapter</button>`
       : `<p>You're all caught up.</p>`) +
    `<button class="btn ghost" data-act="reader-close">Back to series</button>`);
}

// ── rendering ───────────────────────────────────────────────────────────────
function renderModes() {
  $r('rdmodes').innerHTML = MODES.map(([m, label, title]) =>
    `<button class="rd-mode${R.mode === m ? ' on' : ''}" data-act="reader-mode" data-mode="${m}" title="${esc(title)}">${esc(label)}</button>`).join('');
  el.className = 'reader open mode-' + R.mode + (el.classList.contains('chrome-off') ? ' chrome-off' : '');
}

const imgTag = (pg, i, eager) =>
  `<img src="${esc(pg.url)}" alt="Page ${i + 1}" referrerpolicy="no-referrer" decoding="async" draggable="false"${eager ? '' : ' loading="lazy"'}>`;

function render() {
  if (!R || !R.pages) return;
  const stage = $r('rdstage');
  if (R.io) { R.io.disconnect(); R.io = null; }
  if (isPaged(R.mode)) {
    stage.innerHTML = '<div class="rd-paged" id="rdpaged"></div>';
    showPage(R.page);
    return;
  }
  // Vertical pages / long strip: one column; known sizes reserve their space.
  stage.innerHTML = '<div class="rd-col">' + R.pages.map((pg, i) => {
    const ar = pg.width > 0 && pg.height > 0 ? ` style="aspect-ratio:${pg.width}/${pg.height}"` : '';
    return `<div class="rd-pg${ar ? ' sized' : ''}" data-i="${i}"${ar}>${imgTag(pg, i, Math.abs(i - R.page) < 3)}</div>`;
  }).join('') + `<div class="rd-pg rd-tail" data-i="${R.pages.length}">${endCard()}</div></div>`;
  wireImages(stage);
  const target = stage.querySelector(`.rd-pg[data-i="${R.page}"]`);
  if (target && R.page > 0) target.scrollIntoView({ block: 'start' });
  else stage.scrollTop = 0;
  R.io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting || !R) continue;
      const i = +en.target.dataset.i;
      setPage(Math.min(i, R.pages.length - 1), i >= R.pages.length);
    }
  }, { root: stage, rootMargin: '-40% 0px -59% 0px' });
  stage.querySelectorAll('.rd-pg').forEach(p => R.io.observe(p));
  updateCounter();
  // Space / arrows / PageDown scroll the focused scroller.
  try { stage.focus({ preventScroll: true }); } catch {}
}

/** Paged: show page `i` (i === pages.length is the end card). */
function showPage(i) {
  const box = $r('rdpaged'); if (!box || !R) return;
  const total = R.pages.length;
  if (i >= total) {
    box.innerHTML = endCard();
    setPage(total - 1, true);
    return;
  }
  box.innerHTML = `<div class="rd-one" data-i="${i}">${imgTag(R.pages[i], i, true)}</div>`;
  wireImages(box);
  setPage(i, false);
  for (const j of prefetchIndices(i, total, 3)) warm(R.pages[j].url);
}

function warm(url) {
  const im = new Image();
  im.referrerPolicy = 'no-referrer';
  im.decoding = 'async';
  im.src = url;
}

/** Failed pages get a retry control; loaded ones lose their placeholder. */
function wireImages(root) {
  root.querySelectorAll('img').forEach(img => {
    img.addEventListener('load', () => { const p = img.parentElement; if (p) p.classList.add('ok'); }, { once: true });
    img.addEventListener('error', () => {
      const p = img.parentElement; if (!p || p.querySelector('.rd-retry')) return;
      p.classList.add('err');
      const b = document.createElement('button');
      b.className = 'rd-retry'; b.dataset.act = 'reader-retry'; b.type = 'button';
      b.textContent = "Couldn't load this page — tap to retry";
      p.appendChild(b);
    });
  });
}

function setPage(i, atEnd) {
  if (!R) return;
  const changed = R.page !== i || R.atEnd !== atEnd;
  R.page = i; R.atEnd = atEnd;
  updateCounter();
  if (changed) saveSoon();
  if (!isPaged(R.mode)) for (const j of prefetchIndices(i, R.pages.length, 3)) {
    const img = $r('rdstage').querySelector(`.rd-pg[data-i="${j}"] img`);
    if (img && img.loading === 'lazy') img.loading = 'eager';
  }
}
function updateCounter() {
  if (!R || !R.pages) return;
  $r('rdcount').textContent = R.atEnd ? 'End' : pageCounter(R.page, R.pages.length);
}

/** Paged step, crossing into the next/previous chapter at the ends. */
function move(dir) {
  if (!R || !R.pages) {
    if (R && dir > 0 && R.index < R.chapters.length - 1) openChapter(R.index + 1);
    return;
  }
  if (!isPaged(R.mode)) return scrollPage(dir);
  const cur = R.atEnd ? R.pages.length : R.page;
  if (dir > 0 && R.atEnd) {
    if (R.index < R.chapters.length - 1) openChapter(R.index + 1);
    return;
  }
  const s = step(cur, R.pages.length, dir);
  if (s.start) {
    if (R.index > 0) openChapter(R.index - 1, { atEnd: true });
    return;
  }
  showPage(s.index);
  hideChrome();
}
function scrollPage(dir) {
  const stage = $r('rdstage');
  const target = stage.querySelector(`.rd-pg[data-i="${Math.max(0, (R.atEnd ? R.pages.length : R.page) + dir)}"]`);
  if (target) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

/** Long-strip detection from the opening pages (their reported sizes, else the decoded images). */
function probeShape(token) {
  if (!R || R.chosenMode || R.formatLongStrip || measured.has(R.key)) return;
  const first = R.pages.slice(0, 4);
  const decide = (sizes) => {
    if (!R || token !== R.load) return;
    const v = looksLikeLongStrip(sizes);
    if (v == null) return;
    measured.set(R.key, v);
    if (v && R.mode !== 'strip' && !R.chosenMode) { R.mode = 'strip'; renderModes(); render(); }
  };
  if (first.every(p => p.width > 0 && p.height > 0)) return decide(first);
  Promise.all(first.map(p => new Promise(res => {
    const im = new Image();
    im.referrerPolicy = 'no-referrer';
    im.onload = () => res({ width: im.naturalWidth, height: im.naturalHeight });
    im.onerror = () => res(null);
    im.src = p.url;
  }))).then(decide);
}

// ── chrome + progress ───────────────────────────────────────────────────────
/* The bars: shown on open and on mouse movement (then they fade after 3 s),
   shown by a tap in the middle until the next tap there, hidden by a page turn. */
function showChrome(autoHide) {
  if (!R || !el) return;
  clearTimeout(R.hideTimer);
  el.classList.remove('chrome-off');
  if (autoHide) R.hideTimer = setTimeout(hideChrome, 3000);
}
function hideChrome() {
  if (!R || !el) return;
  clearTimeout(R.hideTimer);
  el.classList.add('chrome-off');
}
function saveSoon() {
  if (!R) return;
  clearTimeout(R.saveTimer);
  R.saveTimer = setTimeout(saveNow, 700);
}
function saveNow() {
  if (!R) return;
  clearTimeout(R.saveTimer); R.saveTimer = null;
  const ch = R.chapters[R.index];
  if (!ch || !R.pages || !R.pages.length) return;
  recordProgress({
    kind: R.kind, source: R.source, id: R.id, comic: R.comic, title: R.title, cover: R.cover,
    chapter: ch.id, chapterLabel: chapterLabel(ch), chapterNum: ch.number == null ? null : ch.number,
    page: R.atEnd ? R.pages.length - 1 : R.page, pages: R.pages.length,
  });
}

function toggleFullscreen() {
  if (!el) return;
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (fsEl) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (req) { try { const p = req.call(el); if (p && p.catch) p.catch(() => {}); } catch {} }
}

// ── actions + keys ──────────────────────────────────────────────────────────
onAction('reader-close', () => leave());
onAction('reader-fs', () => toggleFullscreen());
onAction('reader-reload', () => { if (R) openChapter(R.index, { page: R.page }); });
onAction('reader-chapter', (b) => {
  if (!R) return;
  const i = R.index + Number(b.dataset.dir || 1);
  if (i >= 0 && i < R.chapters.length) openChapter(i);
});
onAction('reader-mode', (b) => {
  if (!R) return;
  const mode = b.dataset.mode;
  if (!MODES.some(m => m[0] === mode)) return;
  R.mode = mode; R.chosenMode = mode;
  setReaderMode({ kind: R.kind, source: R.source, id: R.id, title: R.title, cover: R.cover }, mode);
  renderModes();
  render();
});
onAction('reader-retry', (b) => {
  const p = b.parentElement, img = p && p.querySelector('img');
  if (!img) return;
  p.classList.remove('err'); b.remove();
  const src = img.src; img.src = ''; img.src = src;
});
onAction('reader-tap', (stage, e) => {
  if (!R || e.target.closest('button, a')) return;
  if (R.swiped && Date.now() - R.swiped < 400) return;
  const rect = stage.getBoundingClientRect();
  const zone = tapZone(e.clientX - rect.left, rect.width, R.mode);
  if (zone === 'menu') { if (el.classList.contains('chrome-off')) showChrome(false); else hideChrome(); return; }
  if (isPaged(R.mode)) move(zone === 'next' ? 1 : -1);
  else stage.scrollBy({ top: (zone === 'next' ? 1 : -1) * stage.clientHeight * 0.85, behavior: 'smooth' });
});

/** Registered before keys.js (main.js), so while the reader is open its keys
    win — including Esc, and '/' which would otherwise jump to Search. */
export function initReaderKeys() {
  window.addEventListener('keydown', (e) => {
    if (!R) return;
    const tag = (e.target && e.target.tagName) || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '/') { e.stopImmediatePropagation(); return; }
    const act = keyAction(e.key, e.shiftKey, R.mode);
    if (!act) return;
    // The browser leaves fullscreen on Esc by itself; that Esc shouldn't also close.
    if (act === 'close' && (document.fullscreenElement || document.webkitFullscreenElement)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (tag === 'BUTTON') e.target.blur();
    if (act === 'close') leave();
    else if (act === 'fullscreen') toggleFullscreen();
    else move(act === 'next' ? 1 : -1);
  }, true);
  // Leaving the page (tab hidden, app switched) saves the spot right away.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });
}
