/* Skip intro / outro for anime, from the AniSkip crowd database (by MAL id +
   the cour's episode number — what /api/player/animeids returns), as the apps
   do (SkipMarkers.swift, ChapterSkips.swift). A "Skip intro" / "Skip outro"
   button shows during the window; it, or the `s` key, jumps to the window's
   end. Best-effort: any failure is simply no button.

   AniSkip answers with access-control-allow-origin: *, so the browser asks it
   directly; /api/player/skip is the fallback when that request fails (an
   extension blocking the host, a network that does). */

import { $ } from '../util.js';
import { session, isCurrentGen, mediaTime, mediaDuration, videoVisible } from './session.js';
import { fetchSkipProxy } from './playerapi.js';
import { onAction } from '../ui/actions.js';

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

/** An intro starts in the first half, an outro in the last 40 %. 0 = unknown length. */
export function plausible(seg, duration) {
  if (!(duration > 0)) return true;
  return seg.kind === 'outro' ? seg.start >= duration * 0.6 : seg.start < duration * 0.5;
}

/** The window covering time t (the button hides in the last second, where a
    skip would land on the very frame it is already showing). */
export function activeSkip(segs, t, duration) {
  for (const s of segs || []) if (t >= s.start && t < s.end - 1 && plausible(s, duration)) return s;
  return null;
}

// ── Runtime ──────────────────────────────────────────────────────────────────

let segs = [];
let shown = null;
let seekTo = null;   // player.js hands its converter-aware seek in (no import cycle)

export function initSkip(seek) {
  seekTo = seek;
  const v = $('pvideo');
  if (v) v.addEventListener('timeupdate', refreshSkip);
}

export function resetSkip() { segs = []; shown = null; renderButton(); }

/** Load the markers for the title playing (anime only). */
export async function loadSkip(gen, ids) {
  resetSkip();
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
  segs = parseAniSkip(json);
  refreshSkip();
}

export function refreshSkip() {
  const next = (session.ctx && videoVisible()) ? activeSkip(segs, mediaTime(), mediaDuration()) : null;
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
  const to = shown.end;
  shown = null; renderButton();
  seekTo(to);
  return true;
}

onAction('player-skip', () => skipNow());
