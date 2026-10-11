/* The reader's pure rules (no DOM; unit-checked), after the iOS PageReader:
   modes, long-strip detection, tap zones, keys and the prefetch window. */

export const MODES = [
  ['ltr', 'Paged →', 'Paged, left to right'],
  ['rtl', '← Paged', 'Paged, right to left (manga)'],
  ['vertical', 'Vertical', 'Vertical pages'],
  ['strip', 'Strip', 'Long strip (webtoon)'],
];
export const isPaged = (mode) => mode === 'ltr' || mode === 'rtl';

/** A page taller than 2:1 reads as a webtoon strip. */
export const TALL = 2.0;
/** How many opening pages the shape probe looks at. */
export const SAMPLE = 4;

/** Long strip when a strict majority of the opening pages are taller than 2:1
    (a lone wide title card or credits page doesn't sway it). null when there's
    nothing to judge by yet. */
export function looksLikeLongStrip(sizes) {
  const usable = (sizes || []).slice(0, SAMPLE).filter(s => s && s.width > 0 && s.height > 0);
  if (!usable.length) return null;
  const tall = usable.filter(s => s.height / s.width > TALL).length;
  return tall * 2 > usable.length;
}

/** The mode a title opens in: the reader's choice for it, else a long-strip
    signal (the source's format tag, or the measured page shape), else the
    default for its kind (manga right-to-left, comics left-to-right). */
export function initialMode({ chosen, formatLongStrip, measured, kind }) {
  if (chosen && MODES.some(m => m[0] === chosen)) return chosen;
  if (formatLongStrip || measured) return 'strip';
  return kind === 'comic' ? 'ltr' : 'rtl';
}

/** A tap at x on a stage `width` wide: left third back, right third forward
    (mirrored right-to-left), the middle toggles the controls. */
export function tapZone(x, width, mode) {
  if (!(width > 0)) return 'menu';
  const third = x < width / 3 ? 0 : x > (2 * width) / 3 ? 2 : 1;
  if (third === 1) return 'menu';
  const forward = third === 2;
  return (mode === 'rtl' ? !forward : forward) ? 'next' : 'prev';
}

/** A key -> 'next' | 'prev' | 'fullscreen' | 'close' | null (null = leave it to
    the browser: in the scrolling modes space and the vertical arrows scroll). */
export function keyAction(key, shift, mode) {
  if (key === 'Escape') return 'close';
  if (key === 'f' || key === 'F') return 'fullscreen';
  if (key === 'ArrowRight') return mode === 'rtl' ? 'prev' : 'next';
  if (key === 'ArrowLeft') return mode === 'rtl' ? 'next' : 'prev';
  if (isPaged(mode)) {
    if (key === ' ' || key === 'PageDown') return shift ? 'prev' : 'next';
    if (key === 'PageUp') return 'prev';
    if (key === 'ArrowDown') return 'next';
    if (key === 'ArrowUp') return 'prev';
  }
  return null;
}

/** Pages to warm after showing `index`: the next `n` that exist. */
export function prefetchIndices(index, total, n = 3) {
  const out = [];
  for (let i = index + 1; i <= index + n && i < total; i++) out.push(i);
  return out;
}

/** Step `dir` from page `index` of `total`. Past the last page is the end-of-
    chapter card (index === total); before the first is { start: true }. */
export function step(index, total, dir) {
  const next = index + dir;
  if (next < 0) return { index: 0, start: true };
  if (next > total) return { index: total, end: true };
  return { index: next, end: next === total };
}

/** "3 / 20" — the end card counts as the last page. */
export const pageCounter = (index, total) => (total ? `${Math.min(index, total - 1) + 1} / ${total}` : '');

/** A chapter's label: its own `label` (comics), else "Chapter 12 · The Duel", "Chapter 12",
    the source's title, or "Oneshot". */
export function chapterLabel(c) {
  if (!c) return '';
  if (c.label) return String(c.label);   // a source that names its own (comic issues)
  const num = c.number != null ? 'Chapter ' + (Number.isInteger(c.number) ? c.number : String(c.number)) : null;
  const t = c.title && String(c.title).trim();
  if (num && t && !/^(chapter|ch\.?)\s*\d/i.test(t)) return `${num} · ${t}`;
  return t || num || 'Oneshot';
}
