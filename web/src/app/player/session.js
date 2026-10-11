// Shared player state + the small bar/overlay helpers every player module uses.
// Mutable on purpose (one player, one session): player.js owns the writes.
//
//   session.ctx       { it, kind, s, e } of the title playing, or null (closed / live TV)
//   session.debrid    debrid candidates for ctx  -> select values 'rd:<i>'
//                     ({ url, quality, label, vt? } — vt: the file needs the Mac's remux)
//   session.direct    extractor streams (anime rungs + ad-free) -> select values 'dx:<i>'
//   session.resumeAt  saved position (s) to seek to once the <video> has metadata
//   session.gen       title generation, bumped by every play / playLive / close. An
//                     async step captures it before awaiting and drops its result
//                     when it is no longer current — a resolve that finishes after
//                     the viewer moved on can never touch the new title.
//   session.anime     the title's anime mapping ({anime, anilistId, malId, episode,
//                     abs}) once /api/player/animeids answers; null before / for live
//   session.vt        the playing /vt converter session ({ id, play, epoch, duration,
//                     baseOffset }), else null
//   session.steps     the automatic ladder for ctx (player.js) and session.step, the
//                     rung it is on

import { $ } from '../util.js';

/** A generation counter. next() starts a new generation and returns its token;
    isCurrent(token) is true until anything newer starts. Pure. */
export function createGen() {
  let n = 0;
  return { next: () => ++n, current: () => n, isCurrent: (t) => t === n };
}

const titleGen = createGen();
export const session = {
  ctx: null, debrid: [], direct: [], resumeAt: 0,
  gen: 0, anime: null, vt: null, steps: [], step: 0,
};
/** Start a new title generation (play / playLive / close). */
export function nextGen() { session.gen = titleGen.next(); return session.gen; }
/** True while `token` (from nextGen / session.gen) is still the title on screen. */
export const isCurrentGen = (token) => titleGen.isCurrent(token);

export function setLoading(on, msg) {
  const l = $('ploading');
  if (msg) l.textContent = msg; l.classList.toggle('on', !!on);
}
export function setHint(html) { $('phint').innerHTML = html; }
export function setBadge(on) { $('pbadge').style.display = on ? '' : 'none'; }
/** The SUB / DUB pill next to the debrid badge; anything else hides it. */
export function setAudioBadge(audio) {
  const b = $('paudio'); if (!b) return;
  b.textContent = audio === 'dub' ? 'DUB' : audio === 'sub' ? 'SUB' : '';
  b.style.display = b.textContent ? '' : 'none';
}
export const isPlayerOpen = () => $('player').classList.contains('open');
/** True when the <video> path (debrid / ad-free / live) is the visible one, not an embed iframe. */
export const videoVisible = () => { const v = $('pvideo'); return !!v && v.style.display !== 'none'; };

/** Absolute media time of the title: a /vt converter epoch starts at 0
    locally, so its base offset is added back. */
export function mediaTime(v) {
  v = v || $('pvideo');
  const t = (v && v.currentTime) || 0;
  return session.vt ? session.vt.baseOffset + t : t;
}
/** The title's length: the converter's probe duration (a rolling HLS reports
    Infinity / NaN), else the element's own. 0 = unknown. */
export function mediaDuration(v) {
  v = v || $('pvideo');
  if (session.vt && session.vt.duration > 0) return session.vt.duration;
  const d = v && v.duration;
  return Number.isFinite(d) && d > 0 ? d : 0;
}
