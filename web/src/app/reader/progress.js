/* Reading progress + Saved, over the store's `reading` key (pure; unit-checked).

   getState().reading is an object keyed by `<source>:<id>`:
     {
       title, cover,          what the shelves show (cover = a URL an <img> loads as-is, token-free)
       chapter,               the chapter id on that source (null = saved but never opened)
       page,                  0-based page within it
       updatedAt,             ms epoch of the last change (state.js re-stamps it on every
                              local write; sync merges entry by entry on it)
       saved,                 on the Saved shelf
       -- extras (optional) --
       kind,                  'manga' | 'comic'
       source, id,            the parts of the key, so nothing ever parses it
       comic,                 comics: the id /comic/pages wants (BatCave's numeric id differs from its slug)
       chapterLabel,          "Chapter 12" / "#4"
       chapterNum,            the chapter NUMBER: resume survives a change of source by it
       pages,                 the chapter's page count (page = pages-1 means finished)
       readAt, savedAt,       ms epoch: Continue Reading / Saved order (a save must not
                              reorder Continue Reading, so neither uses updatedAt)
       mode,                  the reader mode chosen for this title ('ltr'|'rtl'|'vertical'|'strip')
     }
   Every write builds a new object and goes through setState({ reading }). */

import { getState, setState } from '../state.js';
import { normalizeTitle } from '../views/reading-match.js';

const app = { getState: () => getState(), setState: (p, m) => setState(p, m) };

export const READING_CAP = 150;   // entries kept besides saved ones
export const readingKey = (source, id) => String(source) + ':' + String(id);

const readingOf = (store) => (store.getState().reading || {});

/** Keep every saved entry plus the `cap` most recently changed others. */
export function pruneReading(map, cap = READING_CAP) {
  const loose = Object.entries(map).filter(([, e]) => !(e && e.saved))
    .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
  if (loose.length <= cap) return map;
  const drop = new Set(loose.slice(cap).map(([k]) => k));
  return Object.fromEntries(Object.entries(map).filter(([k]) => !drop.has(k)));
}

const meta = (info) => {
  const out = {};
  for (const k of ['kind', 'source', 'id', 'comic', 'title', 'cover']) if (info[k] != null && info[k] !== '') out[k] = info[k];
  return out;
};

/** Where the reader is: { kind, source, id, comic?, title, cover, chapter, chapterLabel, chapterNum, page, pages }. */
export function recordProgress(info, store = app, now = Date.now()) {
  const map = readingOf(store);
  const key = readingKey(info.source, info.id);
  const prev = map[key] || {};
  const entry = {
    ...prev, ...meta(info),
    chapter: info.chapter, chapterLabel: info.chapterLabel || null,
    chapterNum: info.chapterNum == null ? null : info.chapterNum,
    page: Math.max(0, Math.floor(info.page || 0)), pages: info.pages || null,
    saved: !!prev.saved, readAt: now, updatedAt: now,
  };
  store.setState({ reading: pruneReading({ ...map, [key]: entry }) });
  return entry;
}

/** Save / unsave a title. Unsaving a title that was never opened removes its
    record (the store tombstones the removal, so sync carries it to the other
    devices instead of resurrecting it); one with progress keeps it, unsaved. */
export function setSaved(info, saved, store = app, now = Date.now()) {
  const map = readingOf(store);
  const key = readingKey(info.source, info.id);
  const prev = map[key] || { chapter: null, page: 0 };
  if (!saved && !prev.chapter) {
    const next = { ...map };
    delete next[key];
    store.setState({ reading: next });
    return null;
  }
  const entry = { ...prev, ...meta(info), saved: !!saved, updatedAt: now };
  if (saved) entry.savedAt = now;
  store.setState({ reading: pruneReading({ ...map, [key]: entry }) });
  return entry;
}
export const isSaved = (source, id, store = app) => !!(readingOf(store)[readingKey(source, id)] || {}).saved;
export const readingEntry = (source, id, store = app) => readingOf(store)[readingKey(source, id)] || null;

/** The reader mode chosen for one title. */
export function setReaderMode(info, mode, store = app, now = Date.now()) {
  const map = readingOf(store);
  const key = readingKey(info.source, info.id);
  const prev = map[key] || { chapter: null, page: 0, saved: false };
  store.setState({ reading: { ...map, [key]: { ...prev, ...meta(info), mode, updatedAt: now } } });
}

const withKey = ([key, e]) => ({ key, ...e, source: e.source || key.slice(0, key.indexOf(':')), id: e.id || key.slice(key.indexOf(':') + 1) });
/** Continue Reading: opened titles, most recently read first. */
export function continueShelf(reading) {
  return Object.entries(reading || {}).filter(([, e]) => e && e.chapter)
    .map(withKey).sort((a, b) => (b.readAt || b.updatedAt || 0) - (a.readAt || a.updatedAt || 0));
}
/** Saved: most recently saved first. */
export function savedShelf(reading) {
  return Object.entries(reading || {}).filter(([, e]) => e && e.saved)
    .map(withKey).sort((a, b) => (b.savedAt || b.updatedAt || 0) - (a.savedAt || a.updatedAt || 0));
}

/** Where "Continue" opens in `chapters` (reading order): the saved chapter by
    id, else by number (a progress record from another source of the same
    title); a finished chapter moves on to the next. -> { index, page } | null */
export function resumeTarget(entry, chapters) {
  if (!entry || !entry.chapter || !chapters || !chapters.length) return null;
  let index = chapters.findIndex(c => c.id === entry.chapter);
  const byId = index >= 0;
  if (!byId && entry.chapterNum != null) index = chapters.findIndex(c => c.number != null && Math.abs(c.number - entry.chapterNum) < 1e-4);
  if (index < 0) return null;
  const finished = entry.pages > 0 && entry.page >= entry.pages - 1;
  if (finished && index + 1 < chapters.length) return { index: index + 1, page: 0 };
  return { index, page: byId && !finished ? entry.page || 0 : 0 };
}

/** A progress record for the same title read on ANOTHER source (normalised
    title match) — the newest one. Lets a series page offer "Continue ch. N"
    after switching "Read from". */
export function crossSourceEntry(reading, title, exceptKey) {
  const n = normalizeTitle(title);
  if (!n) return null;
  return continueShelf(reading).find(e => e.key !== exceptKey && e.kind !== 'comic' && normalizeTitle(e.title) === n) || null;
}
