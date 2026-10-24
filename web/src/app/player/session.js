// Shared player state + the small bar/overlay helpers every player module uses.
// Mutable on purpose (one player, one session): player.js owns the writes.
//
//   session.ctx       { it, kind, s, e } of the title playing, or null (closed / live TV)
//   session.debrid    debrid candidates for ctx  -> select values 'rd:<i>'
//                     ({ url, quality, label, vt? } — vt: the file needs the Mac's remux)
//   session.direct    extractor streams (anime rungs + ad-free) -> select values 'dx:<i>'
//   session.resumeAt  saved position (s) to seek to once the <video> has metadata
//   session.momentAt  a shared moment's start (s, '#title/…/t/<n>'), else null: when
//                     set it wins over resumeAt and is honoured exactly (startPoint)
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
//   session.party     Wave 7: a Watch Party binder's hooks (party/bind.js) while this
//                     browser is in a room, else null — { seekIntent(t) -> false =
//                     refused (the room is host-only), holdsEnd() -> true = the room
//                     decides what plays next, so no Up Next autoplay }

import { $ } from '../util.js';

/** A generation counter. next() starts a new generation and returns its token;
    isCurrent(token) is true until anything newer starts. Pure. */
export function createGen() {
  let n = 0;
  return { next: () => ++n, current: () => n, isCurrent: (t) => t === n };
}

const titleGen = createGen();
export const session = {
  ctx: null, debrid: [], direct: [], resumeAt: 0, momentAt: null,
  gen: 0, anime: null, vt: null, steps: [], step: 0,
  party: null,   // W7 (party/bind.js)
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
/** A shared moment's start against the title's length (s): `at` when it is
    inside it, 0 (the top) at or past the end. A length that isn't known (0,
    NaN, Infinity: not loaded yet, or live-shaped) trusts `at`. -> null when
    `at` isn't a moment at all (absent, negative, not a finite number), so the
    caller's own rule applies. Pure. */
export function momentStart(at, duration) {
  if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) return null;
  return Number.isFinite(duration) && duration > 0 && at >= duration ? 0 : at;
}

/** Where the <video> starts a title, in seconds (0 = the top) once its length
    is known: a moment exactly (momentStart — any 0 <= moment < duration), else
    the saved resume point, and that only past the first 30 s and before the
    last minute (a barely started or finished title starts over; an unbounded
    length never resumes). Pure. */
export function startPoint(moment, resume, duration) {
  const m = momentStart(moment, duration);
  if (m !== null) return m;
  return resume > 30 && Number.isFinite(duration) && resume < duration - 60 ? resume : 0;
}

/** The title's length: the converter's probe duration (a rolling HLS reports
    Infinity / NaN), else the element's own. 0 = unknown. */
export function mediaDuration(v) {
  v = v || $('pvideo');
  if (session.vt && session.vt.duration > 0) return session.vt.duration;
  const d = v && v.duration;
  return Number.isFinite(d) && d > 0 ? d : 0;
}
