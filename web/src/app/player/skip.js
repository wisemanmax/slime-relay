/* Skip intro / recap / credits, as the apps do (SkipMarkers.swift,
   ChapterSkips.swift), from two crowd databases:
     - AniSkip, for anime (by MAL id + the cour's episode number — what
       /api/player/animeids returns): op / ed;
     - TheIntroDB (Wave 8), for everything — films and series by TMDB id
       (markers.js): intro, recap, credits, next-episode preview, filling every
       kind AniSkip didn't answer.
   A "Skip intro" / "Skip credits" … button shows during the window; it, or the
   `s` key, jumps to the window's end (credits that run to the end of the file
   jump to the end, where Up Next takes over). Best-effort: any failure is
   simply no button.

   AniSkip answers with access-control-allow-origin: *, so the browser asks it
   directly; /api/player/skip is the fallback when that request fails (an
   extension blocking the host, a network that does). TheIntroDB is asked the
   same way, falling back to /api/player/markers (the Worker's cached copy) —
   and straight there for the rest of the page once the browser couldn't reach
   it itself (CORS refused, blocked). */

import { $ } from '../util.js';
import { session, isCurrentGen, mediaTime, mediaDuration, videoVisible } from './session.js';
import { fetchSkipProxy } from './playerapi.js';
import { apiFetch } from '../api.js';
import { onAction } from '../ui/actions.js';
import { parseIntroDB, mergeMarkers, introDBUrl, introDBKey, END_KINDS } from './markers.js';

// ── Pure ─────────────────────────────────────────────────────────────────────

/** AniSkip v2 `results` -> [{start, end, kind:'intro'|'outro', label}], each
    checked against its OWN submission's episode length (an "ed" 2 s into a
    1420 s episode is a bad submission). */
export function parseAniSkip(json) {
  if (!json || json.found !== true || !Array.isArray(json.results)) return [];
  const out = [];
  for (const r of json.results) {
    const iv = r && r.interval;
    const start = iv && Number(iv.startTime), end = iv && Number(iv.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) continue;
    const type = String(r.skipType || 'op');
    const kind = /(^|-)ed$/.test(type) ? 'outro' : /(^|-)op$/.test(type) ? 'intro' : null;
    if (!kind) continue;
    const seg = { start: Math.max(0, start), end, kind, label: kind === 'outro' ? 'Skip outro' : 'Skip intro' };
    if (plausible(seg, Number(r.episodeLength) || 0)) out.push(seg);
  }
  return out.sort((a, b) => a.start - b.start);
}

/** An intro or recap starts in the first half; an outro, credits or preview in
    the last 40 %. 0 = unknown length. */
export function plausible(seg, duration) {
  if (!(duration > 0)) return true;
  return END_KINDS.has(seg.kind) ? seg.start >= duration * 0.6 : seg.start < duration * 0.5;
}

/** The window covering time t (the button hides in the last second, where a
    skip would land on the very frame it is already showing). A window with no
    end (credits to the end of the file) ends with the file. */
export function activeSkip(segs, t, duration) {
  for (const s of segs || []) {
    const end = Number.isFinite(s.end) ? s.end : duration > 0 ? duration : Infinity;
    if (t >= s.start && t < end - 1 && plausible(s, duration)) return s;
  }
  return null;
}

// ── Runtime ──────────────────────────────────────────────────────────────────

let segs = [];          // what the button offers: the two sources merged (mergeMarkers)
let aniSegs = [];       // AniSkip's, for the title playing
let introSegs = [];     // TheIntroDB's, for the title playing
let shown = null;
let seekTo = null;   // player.js hands its converter-aware seek in (no import cycle)
let introDirect = true;   // false once the browser couldn't reach TheIntroDB itself
const introCache = new Map();   // introDBKey -> windows (answers incl. "none"; failures aren't kept)

export function initSkip(seek) {
  seekTo = seek;
  const v = $('pvideo');
  if (v) v.addEventListener('timeupdate', refreshSkip);
}

export function resetSkip() { segs = []; aniSegs = []; introSegs = []; shown = null; renderButton(); }
function remerge() { segs = mergeMarkers(aniSegs, introSegs); refreshSkip(); }

/** Load AniSkip's markers for the title playing (anime only). play() has reset
    the lists already; TheIntroDB's may have landed first and must survive. */
export async function loadSkip(gen, ids) {
  if (!ids || !ids.anime || !(ids.malId > 0)) return;
  const ep = Math.max(1, ids.episode || 1);
  let json = null;
  try {
    const u = `https://api.aniskip.com/v2/skip-times/${ids.malId}/${ep}?types[]=op&types[]=ed&episodeLength=0`;
    const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
    if (r.ok) json = await r.json();
    else if (r.status === 404) json = { found: false };   // AniSkip's "no markers" — not a failure
  } catch (_) { json = null; }
  if (json == null) json = await fetchSkipProxy(ids.malId, ep);
  if (!isCurrentGen(gen)) return;
  aniSegs = parseAniSkip(json);
  remerge();
}

/** TheIntroDB's windows for {it, kind, s, e} (every title, Wave 8). Called by
    play() for each title; asks once per title / episode per page load. */
export async function loadIntroDB(gen, ctx) {
  const url = introDBUrl(ctx);
  if (!url) return;
  const key = introDBKey(ctx);
  if (introCache.has(key)) { introSegs = introCache.get(key); remerge(); return; }
  let json = null;
  if (introDirect) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (r.ok) json = await r.json();
      else if (r.status === 404) json = {};   // "media not found": a real answer (nothing known)
    } catch (e) {
      // A TypeError is the browser refusing the request (CORS, a blocker), not
      // a slow answer: use the Worker's copy for the rest of the page.
      if (e && e.name === 'TypeError') introDirect = false;
      json = null;
    }
  }
  if (json == null) json = await introDBProxy(ctx);
  if (json == null) return;   // unreachable both ways: no button, asked again next time
  const found = parseIntroDB(json, { tmdb: ctx.it.id, isMovie: ctx.kind === 'movie' });
  if (introCache.size >= 200) introCache.delete(introCache.keys().next().value);
  introCache.set(key, found);
  if (!isCurrentGen(gen)) return;
  introSegs = found;
  remerge();
}

/** /api/player/markers — the Worker's cached copy of TheIntroDB's answer. */
async function introDBProxy(ctx) {
  const q = 'tmdb=' + encodeURIComponent(ctx.it.id) + '&kind=' + ctx.kind + (ctx.kind === 'tv' ? '&s=' + ctx.s + '&e=' + ctx.e : '');
  try {
    const r = await apiFetch('/api/player/markers?' + q, { signal: AbortSignal.timeout(9000) });
    return r.ok ? await r.json() : null;
  } catch (_) { return null; }
}

/** Where a window's skip lands: its end, or — credits that run to the end of
    the file — just short of the end, so the <video>'s own 'ended' starts Up
    Next (or the room's next item). null = can't skip it from here: an unknown
    length, or a converter session (a seek that far restarts the Mac's job at
    the very end, which it answers with a failure). */
export function skipTarget(seg, duration, converting) {
  if (!seg) return null;
  if (Number.isFinite(seg.end)) return seg.end;
  return duration > 0 && !converting ? Math.max(0, duration - 0.5) : null;
}

export function refreshSkip() {
  const dur = mediaDuration();
  let next = (session.ctx && videoVisible()) ? activeSkip(segs, mediaTime(), dur) : null;
  if (next && skipTarget(next, dur, !!session.vt) == null) next = null;
  if (next === shown) return;
  shown = next; renderButton();
}

function renderButton() {
  const b = $('pskip'); if (!b) return;
  b.textContent = shown ? shown.label + ' ⏭' : '';
  b.classList.toggle('on', !!shown);
}

/** The `s` key / the button. True when there was something to skip. */
export function skipNow() {
  if (!shown || !seekTo) return false;
  const to = skipTarget(shown, mediaDuration(), !!session.vt);
  if (to == null) return false;
  shown = null; renderButton();
  seekTo(to);
  return true;
}

onAction('player-skip', () => skipNow());
