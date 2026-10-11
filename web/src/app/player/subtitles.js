/* Subtitles for the <video> path (debrid mp4, ad-free / anime HLS, /vt remux).

   Where tracks come from, per title:
     stream    the playing source's own `subs[]` from the extractor's resolve —
               timed for THIS stream, proxied + converted to VTT by the extractor
     index     /api/player/subs (the extractor's subtitle index lookup, so no
               client holds the index key). Anime past season 1 also sends the
               ABSOLUTE episode (`abs`) — the index files many long anime under
               one season numbered from 1 (SubtitleService.absoluteFallback)
     embedded  HLS subtitle renditions: hls.js `subtitleTracks`, or the text
               tracks Safari's native HLS exposes
   One menu row per language (English first, then the viewer's languages, then
   A–Z); clicking the active row again cycles to that language's next version.
   Prefs (state.js getPrefs/setPrefs): prefs.subLang set = captions turn on by
   themselves, in the first of [subLang, ...subLangs] the title has; absent =
   off. "Off" is remembered per title (prefs.subOff). prefs.subSize (S/M/L)
   sizes both renderers. The offset nudge (±0.5 s) applies to fetched files.

   How a fetched file is drawn: parsed (SRT or VTT) into cues, then
     - as a WebVTT <track> (a blob: of the converted cues) — native rendering,
       stage fullscreen, iPhone's native fullscreen;
     - on an overlay div clocked from the <video> where a <track> isn't
       reliable: Safari playing HLS natively (its own text-track handling owns
       the element there) and browsers without VTTCue.
   The <track> deliberately has an EMPTY label: hls.js disables every labelled
   subtitle track it does not own whenever it toggles its own (hls.js
   filterSubtitleTracks / toggleTrackModes), which would switch ours off.

   Pure helpers first (test/player.mjs drives them); no DOM at import time. */

import { $, esc } from '../util.js';
import { getPrefs, setPrefs, subscribe } from '../state.js';
import { toast } from '../ui/toast.js';
import { onAction } from '../ui/actions.js';
import { isCurrentGen } from './session.js';
import { fetchIndexSubs, fetchSubfileProxy } from './playerapi.js';
import { hlsInstance } from './hls.js';

// ── Pure: languages ──────────────────────────────────────────────────────────

// [code, English name, aliases (ISO 639-2 B/T, names, regional tags)]
const LANG_TABLE = [
  ['en', 'English', 'eng'], ['es', 'Spanish', 'spa spl español espanol castilian'],
  ['fr', 'French', 'fre fra français francais'], ['de', 'German', 'ger deu deutsch'],
  ['it', 'Italian', 'ita italiano'], ['pt', 'Portuguese', 'por pob brazilian português portugues'],
  ['ru', 'Russian', 'rus'], ['ar', 'Arabic', 'ara'], ['ja', 'Japanese', 'jpn jp'],
  ['ko', 'Korean', 'kor'], ['zh', 'Chinese', 'chi zho chs cht mandarin cantonese'],
  ['nl', 'Dutch', 'dut nld'], ['pl', 'Polish', 'pol'], ['tr', 'Turkish', 'tur'],
  ['sv', 'Swedish', 'swe'], ['da', 'Danish', 'dan'], ['fi', 'Finnish', 'fin'],
  ['no', 'Norwegian', 'nor nob nno nb nn'], ['el', 'Greek', 'gre ell'], ['he', 'Hebrew', 'heb iw'],
  ['hi', 'Hindi', 'hin'], ['th', 'Thai', 'tha'], ['vi', 'Vietnamese', 'vie'],
  ['id', 'Indonesian', 'ind in'], ['ms', 'Malay', 'may msa'], ['cs', 'Czech', 'cze ces'],
  ['hu', 'Hungarian', 'hun'], ['ro', 'Romanian', 'rum ron'], ['uk', 'Ukrainian', 'ukr'],
  ['hr', 'Croatian', 'hrv'], ['sr', 'Serbian', 'srp'], ['bg', 'Bulgarian', 'bul'],
  ['sk', 'Slovak', 'slo slk'], ['sl', 'Slovenian', 'slv'], ['fa', 'Persian', 'per fas farsi'],
  ['bn', 'Bengali', 'ben'], ['ta', 'Tamil', 'tam'], ['te', 'Telugu', 'tel'], ['ur', 'Urdu', 'urd'],
  ['tl', 'Filipino', 'fil tgl tagalog'], ['et', 'Estonian', 'est'], ['lv', 'Latvian', 'lav'],
  ['lt', 'Lithuanian', 'lit'], ['is', 'Icelandic', 'ice isl'], ['ca', 'Catalan', 'cat'],
];
const ALIAS = new Map();
const NAME_OF = Object.create(null);
for (const [code, name, aliases] of LANG_TABLE) {
  NAME_OF[code] = name;
  for (const a of [code, name.toLowerCase(), ...aliases.split(' ')]) ALIAS.set(a, code);
}

/** The ONE key a track is filed under: "en", "eng", "en-US", "English" and
    "English (SDH)" are all "en". Unknown codes keep their 2–3 letter base;
    a nameless unknown is "und"; an unknown name is grouped by itself. */
export function langKey(lang, name) {
  const l = String(lang || '').trim().toLowerCase().replace(/_/g, '-');
  const base = l.split('-')[0];
  if (ALIAS.has(l)) return ALIAS.get(l);
  if (ALIAS.has(base)) return ALIAS.get(base);
  const n = String(name || '').trim().toLowerCase();
  if (ALIAS.has(n)) return ALIAS.get(n);
  const first = n.split(/[\s(,/–-]+/)[0];
  if (first && ALIAS.has(first)) return ALIAS.get(first);
  if (/^[a-z]{2,3}$/.test(base) && base !== 'und') return base;
  if (n && !/^(subtitles?|captions?|track|und|unknown)\b/.test(n)) return 'x-' + n.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
  return 'und';
}
/** A row's display name. */
export function langName(lk, fallback) {
  if (NAME_OF[lk]) return NAME_OF[lk];
  if (lk === 'und') return 'Unknown language';
  return String(fallback || lk).replace(/\s*\(\d+\)\s*$/, '').trim() || lk.toUpperCase();
}

/* Within a language: the stream's own tracks first (timed for this stream),
   then the index's (in the index's order), then embedded renditions — except
   on Safari's native HLS, where the embedded rendition leads (it draws in
   iPhone's native fullscreen and PiP, which no page element can). */
const ORIGIN_RANK = { stream: 0, index: 1 };

/** Tracks -> [{lk, name, tracks}] one per language: English first, then
    `leading` (the viewer's languages, a code or a list, in order), then A–Z,
    "Unknown" last. Fetched tracks are de-duplicated by URL. Pure. */
export function groupTracks(tracks, opts = {}) {
  const groups = new Map(), urls = new Set();
  for (const tr of tracks || []) {
    if (!tr) continue;
    if (tr.t !== 'emb') { if (!tr.url || urls.has(tr.url)) continue; urls.add(tr.url); }
    const lk = tr.lk || langKey(tr.lang, tr.name);
    if (!groups.has(lk)) groups.set(lk, { lk, name: langName(lk, tr.name), tracks: [] });
    groups.get(lk).tracks.push(Object.assign({}, tr, { lk }));
  }
  const rank = (tr) => (tr.t === 'emb' ? (opts.embFirst ? -1 : 2) : (ORIGIN_RANK[tr.origin] ?? 1));
  for (const g of groups.values()) g.tracks.sort((a, b) => rank(a) - rank(b));   // stable: keeps source order
  const lead = (Array.isArray(opts.leading) ? opts.leading : [opts.leading]).filter(Boolean).map(l => langKey(l));
  const weight = (g) => { if (g.lk === 'en') return 0; const i = lead.indexOf(g.lk); return i >= 0 ? 1 + i / 1000 : g.lk === 'und' ? 3 : 2; };
  return [...groups.values()].sort((a, b) => weight(a) - weight(b) || a.name.localeCompare(b.name));
}

// ── Pure: cues ───────────────────────────────────────────────────────────────

const TS = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/;
function parseTimestamp(s) {
  const m = TS.exec(String(s).trim().split(/\s+/)[0] || '');
  if (!m) return null;
  const h = +(m[1] || 0), mi = +m[2], se = +m[3], ms = +(m[4] + '00').slice(0, 3);
  if (mi > 59 || se > 59) return null;
  return h * 3600 + mi * 60 + se + ms / 1000;
}
const stripTags = (s) => s.replace(/\{\\[^}]*\}/g, '').replace(/<[^>]*>/g, '');
const decodeEntities = (s) => s.replace(/&(amp|lt|gt|nbsp|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', nbsp: ' ', quot: '"', '#39': "'" }[e]));

/** SRT or WebVTT text -> [{start, end, text}] sorted by start. Tolerates a BOM,
    CRLF, cue numbers / identifiers, NOTE / STYLE blocks, `,` or `.` millis,
    VTT's optional hours and cue settings; inline tags (and ASS {\an8}) are
    stripped. Malformed cues are skipped, never fatal. */
export function parseCues(raw) {
  const text = String(raw || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/^[ \t]+$/gm, '');
  const cues = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n').filter(l => l !== '');
    if (!lines.length) continue;
    if (/^(WEBVTT|NOTE|STYLE|REGION)\b/.test(lines[0]) && !lines[0].includes('-->')) {
      if (!/^WEBVTT/.test(lines[0])) continue;
      lines.shift();
      while (lines.length && !lines[0].includes('-->')) lines.shift();   // header metadata
      if (!lines.length) continue;
    }
    const ti = lines.findIndex(l => l.includes('-->'));
    if (ti < 0 || ti > 1) continue;
    const [a, b] = lines[ti].split('-->');
    const start = parseTimestamp(a), end = parseTimestamp(b);
    if (start == null || end == null || !(end > start)) continue;
    const body = decodeEntities(stripTags(lines.slice(ti + 1).join('\n'))).trim();
    if (body) cues.push({ start, end, text: body });
  }
  return cues.sort((x, y) => x.start - y.start);
}

const pad = (n, w) => String(n).padStart(w, '0');
/** Seconds -> a WebVTT timestamp, hh:mm:ss.mmm. */
export function vttTime(t) {
  const ms = Math.max(0, Math.round(t * 1000));
  return pad(Math.floor(ms / 3600000), 2) + ':' + pad(Math.floor(ms / 60000) % 60, 2) + ':' + pad(Math.floor(ms / 1000) % 60, 2) + '.' + pad(ms % 1000, 3);
}
const escVtt = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/-->/g, '--&gt;');
/** Cues -> a WebVTT document. */
export function cuesToVtt(cues) {
  return 'WEBVTT\n\n' + (cues || []).map(c => vttTime(c.start) + ' --> ' + vttTime(c.end) + '\n' + escVtt(c.text)).join('\n\n') + '\n';
}
/** SRT (or VTT) text -> WebVTT text. */
export const srtToVtt = (text) => cuesToVtt(parseCues(text));

/** Every cue moved by `delta` seconds; cues pushed wholly before 0 are dropped. */
export function shiftCues(cues, delta) {
  if (!delta) return cues.slice();
  const out = [];
  for (const c of cues) { const end = c.end + delta; if (end > 0) out.push({ start: Math.max(0, c.start + delta), end, text: c.text }); }
  return out;
}

/** The cue on screen at t (cues sorted by start; overlapping speakers allowed):
    the latest-starting cue still running. */
export function activeCue(cues, t) {
  let lo = 0, hi = cues.length - 1, idx = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (cues[mid].start <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
  for (let i = idx; i >= 0 && i > idx - 12; i--) if (cues[i].end >= t) return cues[i];
  return null;
}

/** Bytes -> text: a UTF-16 BOM, then strict UTF-8, then Windows-1252 (older
    scene subs), so accented languages don't come back as mojibake. */
export function decodeSubtitle(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8);
  if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch (_) {}
  try { return new TextDecoder('windows-1252').decode(u8); } catch (_) { return new TextDecoder().decode(u8); }
}

/** The languages to try, best first, when captions turn on by themselves:
    prefs.subLang, then prefs.subLangs; `fallback` (English for anime SUB)
    when the viewer named none. Pure. */
export function wantedLangs(prefs, fallback) {
  const out = [];
  for (const l of [prefs && prefs.subLang, ...((prefs && Array.isArray(prefs.subLangs)) ? prefs.subLangs : []), fallback]) {
    const k = l ? langKey(l) : '';
    if (k && k !== 'und' && !out.includes(k)) out.push(k);
  }
  return out;
}
/** prefs.subSize -> 'S' | 'M' | 'L'. Pure. */
export const subSizeOf = (prefs) => (prefs && ['S', 'M', 'L'].includes(prefs.subSize) ? prefs.subSize : 'M');

/** Is title `key` remembered as captions-off? */
export const titleOff = (prefs, key) => !!(key && prefs && Array.isArray(prefs.subOff) && prefs.subOff.includes(key));
/** prefs.subOff with `key` added (most recent first, capped) or removed. */
export function withTitleOff(list, key, off) {
  const rest = (Array.isArray(list) ? list : []).filter(k => k !== key);
  return off ? [key, ...rest].slice(0, 200) : rest;
}

// ── Runtime ──────────────────────────────────────────────────────────────────

const S = {
  gen: 0, key: '', mode: 'file', embed: false,
  stream: [], index: [], emb: [], indexState: 'idle',
  groups: [], sel: null, userChose: false, force: false, forceOverridesOff: false,
  offset: 0, timeBase: 0, drawn: null, applyTok: 0,
  trackEl: null, blobUrl: '', overlayCues: null, raf: 0, shownText: '',
};
const ours = new WeakSet();          // TextTracks we created (never "embedded")
const cueCache = new Map();          // url -> Promise<cues>
const failed = new Set();            // urls that loaded nothing
let menuOpen = false;

const prefsNow = () => getPrefs();   // defaults filled in (subLangs ['en'], subSize 'M', …)

/** One-time wiring (initPlayer). */
export function initSubtitles() {
  const v = $('pvideo'); if (!v) return;
  // Safari's native HLS (and some mp4s) surface their own tracks.
  if (v.textTracks && v.textTracks.addEventListener) {
    v.textTracks.addEventListener('addtrack', () => { if (S.mode !== 'hls.js') { refreshEmbedded(); } });
  }
  v.addEventListener('timeupdate', drawOverlay);
  v.addEventListener('seeked', drawOverlay);
  v.addEventListener('play', startLoop);
  applySize();
  // Settings can change the size (or languages) while the player is open.
  subscribe((st, meta) => { if (meta.keys.includes('prefs')) applySize(); });
  // Clicking anywhere outside the menu (and its button) closes it.
  document.addEventListener('click', (e) => {
    if (!menuOpen) return;
    const t = e.target;
    if (t && t.closest && (t.closest('#pccmenu') || t.closest('#pcc'))) return;
    toggleMenu(false);
  }, true);
}

/** A new title (ctx) — or live TV / closed (ctx null). */
export function resetSubtitles(gen, ctx) {
  S.gen = gen; S.key = ctx ? ctx.kind + ':' + ctx.it.id : '';
  S.stream = []; S.index = []; S.emb = []; S.indexState = ctx ? 'idle' : 'done';
  S.sel = null; S.userChose = false; S.force = false; S.forceOverridesOff = false;
  S.offset = 0; S.timeBase = 0; S.drawn = null; S.embed = false;
  clearDraw(); toggleMenu(false); rebuild();
}

/** A source started. mode: 'file' (mp4 / webm) | 'hls.js' | 'native-hls'; subs:
    the resolve's own tracks; embed: an iframe (captions live inside it). */
export function subtitlesSource(gen, { mode = 'file', subs = [], embed = false } = {}) {
  if (!isCurrentGen(gen)) return;
  S.mode = mode; S.embed = embed;
  S.stream = embed ? [] : (subs || []).filter(x => x && typeof x.url === 'string' && /^https?:/i.test(x.url))
    .map(x => ({ t: 'ext', origin: 'stream', lang: x.lang, name: x.name, url: x.url }));
  S.emb = [];
  if (embed) { toggleMenu(false); clearDraw(); }
  rebuild();
  if (!embed) refreshEmbedded();
  applySelection();
}

/** Ask the subtitle index once per title (after a <video> source started). */
export async function loadIndexSubtitles(gen, ctx, abs) {
  if (!ctx || S.indexState !== 'idle' || !isCurrentGen(gen)) return;
  S.indexState = 'loading'; renderMenu();
  const list = await fetchIndexSubs(ctx, abs);
  if (!isCurrentGen(gen)) return;
  S.index = list.map(x => ({ t: 'ext', origin: 'index', lang: x.lang, name: x.name, url: x.url }));
  S.indexState = 'done';
  rebuild();
}

/** The /vt converter's epoch start: its local clock is absolute - base. */
export function setSubtitleTimeBase(t) {
  if (S.timeBase === t) return;
  S.timeBase = t || 0; redraw();
}

/** Captions on because the audio is foreign (anime SUB): the viewer's
    languages (wantedLangs), else English. overridesOff: even on a title remembered "off"
    (a dub request that came back as the sub). null withdraws an AUTO pick it
    made — a pick the viewer made is never touched. */
export function forceCaptions(on, overridesOff) {
  if (!on) {
    S.force = false; S.forceOverridesOff = false;
    if (S.sel && S.sel.byForce) { S.sel = null; applySelection(); renderMenu(); }
    return;
  }
  S.force = true;   // the viewer's languages (wantedLangs), English when they named none
  S.forceOverridesOff = !!overridesOff;
  maybeAuto();
}

export function closeSubtitles() { resetSubtitles(0, null); }

// hls.js hands its renditions over once the manifest is parsed.
export function watchHls(hls) {
  const H = window.Hls; if (!hls || !H) return;
  const upd = () => { if (hlsInstance() === hls) { refreshEmbedded(); applyEmbedded(); } };
  hls.on(H.Events.MANIFEST_PARSED, upd);
  hls.on(H.Events.SUBTITLE_TRACKS_UPDATED, upd);
}

function refreshEmbedded() {
  if (S.embed) return;
  const hls = hlsInstance();
  let emb = [];
  if (S.mode === 'hls.js' && hls) {
    emb = (hls.subtitleTracks || []).map((t, i) => ({ t: 'emb', id: t.id != null ? t.id : i, lang: t.lang, name: t.name }));
    // The extractor's master carries the resolve's own tracks as renditions:
    // the same files we already list as "stream" — one entry is enough.
    const seen = new Set(S.stream.map(x => langKey(x.lang, x.name) + '|' + String(x.name || '').toLowerCase()));
    emb = emb.filter(x => !seen.has(langKey(x.lang, x.name) + '|' + String(x.name || '').toLowerCase()));
  } else if (S.mode !== 'hls.js') {
    const v = $('pvideo');
    for (const tt of Array.from((v && v.textTracks) || [])) {
      if (ours.has(tt) || !(tt.kind === 'subtitles' || tt.kind === 'captions')) continue;
      emb.push({ t: 'emb', tt, lang: tt.language, name: tt.label || tt.language });
    }
  }
  const same = emb.length === S.emb.length && emb.every((x, i) => x.name === S.emb[i].name && x.lang === S.emb[i].lang && x.tt === S.emb[i].tt);
  S.emb = emb;
  if (!same) rebuild();
  applyEmbedded();
}

function rebuild() {
  const prev = currentTrack();
  const p = prefsNow();
  S.groups = groupTracks([...S.stream, ...S.index, ...S.emb], { leading: [p.subLang, ...(p.subLangs || [])], embFirst: S.mode === 'native-hls' });
  if (S.sel) {
    const g = S.groups.find(x => x.lk === S.sel.lk);
    if (!g) S.sel = null;   // that language left with its source
    else {
      const keep = prev ? g.tracks.findIndex(x => sameTrack(x, prev)) : -1;
      S.sel = Object.assign({}, S.sel, { n: keep >= 0 ? keep : Math.min(S.sel.n, g.tracks.length - 1) });
      if (keep < 0) applySelection();
    }
  }
  maybeAuto();
  renderMenu();
  syncButton();
}
const sameTrack = (a, b) => a.t === b.t && (a.t === 'emb' ? (a.tt ? a.tt === b.tt : a.id === b.id) : a.url === b.url);

function currentTrack() {
  if (!S.sel) return null;
  const g = S.groups.find(x => x.lk === S.sel.lk);
  return (g && g.tracks[S.sel.n]) || null;
}

/* Captions turn on by themselves only when the viewer said so: prefs.subLang
   set (absent = off), or foreign audio (anime SUB). Never over a title the
   viewer turned off — except a dub that came back as the sub — and never
   once they picked something themselves for this title. The first language
   of [subLang, ...subLangs] that the title has wins. */
function wanted() {
  if (S.userChose) return null;
  const p = prefsNow();
  const off = titleOff(p, S.key);
  if (S.force && (S.forceOverridesOff || !off)) return { langs: wantedLangs(p, 'en'), byForce: true };
  if (off || !p.subLang) return null;
  return { langs: wantedLangs(p), byForce: false };
}
function maybeAuto() {
  if (S.sel || S.embed) return;
  const w = wanted(); if (!w) return;
  for (const lk of w.langs) {
    const g = S.groups.find(x => x.lk === lk); if (!g) continue;
    const n = g.tracks.findIndex(x => !(x.url && failed.has(x.url)));
    if (n < 0) continue;
    S.sel = { lk, n, byForce: w.byForce };
    applySelection(); renderMenu();
    return;
  }
}

/** prefs.subSize on both renderers (a data attribute the stylesheet keys on). */
function applySize() {
  const size = subSizeOf(prefsNow());
  const v = $('pvideo'), o = $('psubs');
  if (v && v.dataset) v.dataset.subsize = size;
  if (o && o.dataset) o.dataset.size = size;
}

// ── Drawing ──────────────────────────────────────────────────────────────────

async function applySelection() {
  const tok = ++S.applyTok;
  const tr = currentTrack();
  applyEmbedded();
  syncButton();
  if (!tr || tr.t === 'emb') { S.drawn = null; clearDraw(); return; }
  if (S.drawn && S.drawn.url === tr.url) { redraw(); return; }
  const gen = S.gen;
  const cues = await loadCues(tr.url);
  if (tok !== S.applyTok || gen !== S.gen) return;
  if (!cues || !cues.length) {
    failed.add(tr.url);
    const g = S.groups.find(x => x.lk === tr.lk);
    const next = g ? g.tracks.findIndex(x => !(x.url && failed.has(x.url)) && !sameTrack(x, tr)) : -1;
    if (next >= 0) { S.sel = Object.assign({}, S.sel, { n: next }); applySelection(); }
    else { S.sel = null; S.drawn = null; clearDraw(); toast('Couldn\'t load those subtitles', { id: 'captions' }); }
    renderMenu();
    return;
  }
  S.drawn = { url: tr.url, cues, lk: tr.lk };
  redraw();
}

/* hls.js / native renditions follow the selection: on only when an embedded
   track is the one chosen. That also turns off the rendition hls.js and
   Safari would otherwise auto-show (the extractor marks its first DEFAULT=YES)
   — captions stay off until the viewer, or their saved language, says. */
function applyEmbedded() {
  const tr = currentTrack();
  const emb = tr && tr.t === 'emb' ? tr : null;
  const hls = hlsInstance();
  if (S.mode === 'hls.js' && hls) {
    const want = emb && emb.id != null ? emb.id : -1;
    try { if (hls.subtitleTrack !== want) hls.subtitleTrack = want; hls.subtitleDisplay = want >= 0; } catch (_) {}
    return;
  }
  const v = $('pvideo');
  for (const tt of Array.from((v && v.textTracks) || [])) {
    if (ours.has(tt) || !(tt.kind === 'subtitles' || tt.kind === 'captions')) continue;
    const mode = emb && emb.tt === tt ? 'showing' : 'disabled';
    if (tt.mode !== mode) tt.mode = mode;
  }
}

function loadCues(url) {
  if (cueCache.has(url)) return cueCache.get(url);
  const p = (async () => {
    let buf = null;
    try { const r = await fetch(url, { signal: AbortSignal.timeout(15000) }); if (r.ok) buf = await r.arrayBuffer(); } catch (_) {}
    if (!buf) buf = await fetchSubfileProxy(url);   // a host without CORS: the Worker (allowlisted hosts only)
    return buf ? parseCues(decodeSubtitle(buf)) : [];
  })();
  cueCache.set(url, p);
  p.then(c => { if (!c.length) cueCache.delete(url); });
  if (cueCache.size > 40) cueCache.delete(cueCache.keys().next().value);
  return p;
}

function useOverlay() { return S.mode === 'native-hls' || typeof globalThis.VTTCue === 'undefined'; }

function clearDraw() {
  if (S.trackEl) { try { S.trackEl.track.mode = 'disabled'; } catch (_) {} S.trackEl.remove(); S.trackEl = null; }
  if (S.blobUrl) { URL.revokeObjectURL(S.blobUrl); S.blobUrl = ''; }
  S.overlayCues = null; cancelAnimationFrame(S.raf); S.raf = 0;
  setOverlayText('');
}

function redraw() {
  clearDraw();
  if (!S.drawn) return;
  // Cue times are media (absolute) times; the element runs on its local clock.
  const shifted = shiftCues(S.drawn.cues, S.offset - S.timeBase);
  if (useOverlay()) { S.overlayCues = shifted; drawOverlay(); startLoop(); return; }
  const v = $('pvideo'); if (!v) return;
  S.blobUrl = URL.createObjectURL(new Blob([cuesToVtt(shifted)], { type: 'text/vtt' }));
  const el = document.createElement('track');
  el.kind = 'subtitles';
  if (/^[a-z]{2,3}$/.test(S.drawn.lk)) el.srclang = S.drawn.lk;
  el.label = '';   // see the header: an unlabelled track is invisible to hls.js
  el.src = S.blobUrl; el.default = true;
  v.appendChild(el);
  ours.add(el.track);
  el.track.mode = 'showing';
  el.addEventListener('load', () => { if (S.trackEl === el) el.track.mode = 'showing'; });
  S.trackEl = el;
}

function setOverlayText(t) {
  if (t === S.shownText) return;
  S.shownText = t;
  const o = $('psubs'); if (!o) return;
  o.textContent = t; o.classList.toggle('on', !!t);
}
function drawOverlay() {
  if (!S.overlayCues) return;
  const v = $('pvideo');
  const c = v ? activeCue(S.overlayCues, v.currentTime) : null;
  setOverlayText(c ? c.text : '');
}
// timeupdate fires ~4×/s: fine for a <track>, late for an overlay, so the
// overlay also follows animation frames while the video plays.
function startLoop() {
  if (!S.overlayCues || S.raf) return;
  const tick = () => {
    const v = $('pvideo');
    if (!S.overlayCues || !v || v.paused) { S.raf = 0; return; }
    drawOverlay(); S.raf = requestAnimationFrame(tick);
  };
  S.raf = requestAnimationFrame(tick);
}

// ── Menu ─────────────────────────────────────────────────────────────────────

function syncButton() {
  const b = $('pcc'); if (!b) return;
  b.style.display = S.embed || !S.gen ? 'none' : '';
  b.classList.toggle('on', !!S.sel);
}

export function toggleMenu(open) {
  const m = $('pccmenu'); if (!m) return;
  menuOpen = open == null ? !menuOpen : !!open;
  m.classList.toggle('on', menuOpen);
  if (menuOpen) renderMenu();
}

function renderMenu() {
  const m = $('pccmenu'); if (!m || !menuOpen) return;
  const cur = currentTrack();
  const rows = S.groups.map(g => {
    const on = S.sel && S.sel.lk === g.lk;
    const many = g.tracks.length > 1;
    const note = on && many ? ` <span class="ccn">${S.sel.n + 1}/${g.tracks.length} · tap for another</span>`
      : many ? ` <span class="ccn">${g.tracks.length} versions</span>` : '';
    return `<button class="ccrow${on ? ' on' : ''}" data-act="cc-pick" data-k="${esc(g.lk)}">${esc(g.name)}${note}</button>`;
  }).join('');
  const searching = S.indexState === 'loading' ? '<div class="ccnote">Searching for more…</div>' : '';
  const none = !S.groups.length && S.indexState !== 'loading' ? '<div class="ccnote">No subtitles found for this title.</div>' : '';
  const canShift = cur && cur.t !== 'emb';
  const off = (S.offset > 0 ? '+' : '') + S.offset.toFixed(1) + ' s';
  m.innerHTML = '<div class="cchead">Subtitles</div>' +
    `<button class="ccrow${S.sel ? '' : ' on'}" data-act="cc-pick" data-k="">Off</button>` + rows + searching + none +
    (canShift ? `<div class="ccoff"><span>Timing</span><button data-act="cc-offset" data-d="-0.5" title="Earlier">−0.5</button><b>${off}</b><button data-act="cc-offset" data-d="0.5" title="Later">+0.5</button></div>` : '');
}

/* A pick is remembered: a language becomes prefs.subLang and leads
   prefs.subLangs (Settings keeps subLang == subLangs[0]); "Off" adds the
   title to prefs.subOff. setPrefs merges, and the store stamps the change. */
function pick(lk) {
  S.userChose = true;
  const p = prefsNow();
  if (!lk) {
    S.sel = null;
    if (S.key && !titleOff(p, S.key)) setPrefs({ subOff: withTitleOff(p.subOff, S.key, true) });
  } else {
    const g = S.groups.find(x => x.lk === lk); if (!g) return;
    const n = S.sel && S.sel.lk === lk && g.tracks.length > 1 ? (S.sel.n + 1) % g.tracks.length : 0;
    S.sel = { lk, n, byForce: false };
    const patch = {};
    if (!/^x-|^und$/.test(lk) && p.subLang !== lk) {
      patch.subLang = lk;
      patch.subLangs = [lk, ...(p.subLangs || []).filter(x => langKey(x) !== lk)].slice(0, 8);
    }
    if (titleOff(p, S.key)) patch.subOff = withTitleOff(p.subOff, S.key, false);
    if (Object.keys(patch).length) setPrefs(patch);
  }
  applySelection(); renderMenu();
}

function nudge(d) {
  S.offset = Math.max(-60, Math.min(60, Math.round((S.offset + d) * 10) / 10));
  redraw(); renderMenu();
  toast('Subtitle timing ' + (S.offset > 0 ? '+' : '') + S.offset.toFixed(1) + ' s' + (S.offset > 0 ? ' (later)' : S.offset < 0 ? ' (earlier)' : ''), { id: 'cc-offset', timeout: 1600 });
}

/** The `c` key and the CC button. */
export function captionsKey({ video }) {
  if (!video || S.embed) { toast('This source is an embed — use its own captions button.', { id: 'captions' }); return; }
  toggleMenu();
}

onAction('player-cc', () => { if (S.embed) captionsKey({ video: null }); else toggleMenu(); });
onAction('cc-pick', (el) => pick(el.dataset.k || ''));
onAction('cc-offset', (el) => nudge(+el.dataset.d || 0));
