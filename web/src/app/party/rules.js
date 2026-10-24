/* Wave 7 (P5, roadmap 7.4) — the web's Watch Party rules, PURE: no DOM and no
   WebSocket at import (unit-checked from node by test/party.mjs). The room's
   protocol is the relay's (contracts.md § wire format and § web client):
   only TMDB identity and media time cross the wire, the room's clock is an
   anchor (mediaTime at serverTimeAtUpdate, advancing at rate while playing),
   and the web is always an ordinary member — never host, never a companion.

   The numbers are the apps' (PartyDrift.swift, PartyClock.swift,
   PartySession.swift) so a browser and an iPhone in one room correct alike:
   AVPlayer's drift profile for the <video>, the converter's 8 s settle, the
   2 s align window, ping/pong min-RTT clock, 1-2-4-8-15 s reconnect backoff
   given up after a minute. Every word the web says about control is P4's
   (PartyControlRules.swift), so the three apps and the browser agree. */

/** Room codes: six characters, no 0/O/1/I (the relay's alphabet). */
export const PARTY_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;

/** A code as typed or linked ('xk7q2m', ' XK7Q2M ') -> 'XK7Q2M', or '' when it isn't one. */
export function normalCode(raw) {
  const c = String(raw || '').trim().toUpperCase();
  return PARTY_CODE_RE.test(c) ? c : '';
}

/** The room clock at relay time `serverNowMs` (party-reducer.js expectedTime). */
export function expectedTime(playback, serverNowMs) {
  if (!playback) return 0;
  return playback.mediaTime + (playback.playing ? Math.max(0, serverNowMs - playback.serverTimeAtUpdate) / 1000 * playback.rate : 0);
}

// ── Control (contracts §1 "control acceptance rule"; PartyControlRules) ─────────

/** The room's mode: `settings.control` when present (an unknown value reads as
    host-only — the side that never lets a refused command through), else the
    pre-Wave-7 `everyoneControls`. */
export function controlMode(settings) {
  if (!settings || typeof settings !== 'object') return 'host';
  if (typeof settings.control === 'string') return settings.control === 'shared' ? 'shared' : 'host';
  return settings.everyoneControls === true ? 'shared' : 'host';
}

/** The member record for `id` in a room mirror ({members:[…]}), or null. */
export function memberOf(room, id) {
  if (!room || !Array.isArray(room.members) || !id) return null;
  return room.members.find((m) => m && m.id === id) || null;
}

/** Whether this member's play / pause / seek / setItem / queue would move the
    room: the host always, an ordinary member only in a shared room, a
    companion never (the web never is one, but the rule is the relay's). */
export function canControl(room, myId) {
  const me = memberOf(room, myId);
  if (!me || me.role === 'companion') return false;
  if (me.role === 'host' || room.hostId === myId) return true;
  return controlMode(room.settings) === 'shared';
}

export const REFUSED_TOAST = 'Only the host can control playback';
/** The one line every non-host sees about control (P4's memberLine). */
export const controlLine = (mode) => (mode === 'host' ? 'The host controls playback' : 'Everyone can control playback');
/** The toast when the room's mode changes, or null when it didn't (P4's changedToast). */
export function controlChangedToast(before, after) {
  const a = controlMode(before), b = controlMode(after);
  if (a === b) return null;
  return b === 'host' ? 'The host now controls playback' : 'Everyone can control playback now';
}

// ── The clock (PartyClock.swift) ────────────────────────────────────────────────

/** NTP-lite over ping/pong: offset = s − (c + rtt/2); the sample with the
    SMALLEST round trip is the least queued, so it wins (not the mean). All
    times in ms; the caller supplies them (no clock in here). */
export function createClock(keep = 8) {
  let samples = [];
  const best = () => samples.reduce((b, x) => (!b || x.rtt < b.rtt ? x : b), null);
  return {
    add(c, s, r) {
      if (![c, s, r].every(Number.isFinite)) return;
      const rtt = Math.max(0, r - c);
      samples.push({ offset: s - (c + rtt / 2), rtt });
      if (samples.length > keep) samples = samples.slice(samples.length - keep);
    },
    reset() { samples = []; },
    get hasSync() { return samples.length > 0; },
    /** Relay minus local, ms (0 until the first sample). */
    get offset() { const b = best(); return b ? b.offset : 0; },
    get rtt() { const b = best(); return b ? b.rtt : null; },
    serverNow(localNowMs) { return localNowMs + this.offset; },
  };
}

// ── Drift (PartyDrift.swift: AVPlayer and converter profiles) ───────────────────

export const PROFILES = Object.freeze({
  av: Object.freeze({ deadZone: 0.3, nudgeLimit: 2, nudgeRate: 0.05, seekLead: 0.15, settle: 1 }),
  converter: Object.freeze({ deadZone: 0.3, nudgeLimit: 2, nudgeRate: 0.05, seekLead: 0.15, settle: 8 }),
  embed: Object.freeze({ deadZone: Infinity, nudgeLimit: null, nudgeRate: 0, seekLead: 0, settle: 0 }),
});
export const profileFor = (engine) => PROFILES[engine] || PROFILES.av;

/** drift = local − expected (positive = this browser is ahead) ->
    { kind:'none' } | { kind:'nudge', rate } (a playbackRate multiplier) | { kind:'seek', lead }. */
export function driftCorrection(drift, p = PROFILES.av) {
  if (!Number.isFinite(drift)) return { kind: 'none' };
  const mag = Math.abs(drift);
  if (mag < p.deadZone) return { kind: 'none' };
  if (p.nudgeLimit != null && mag < p.nudgeLimit) return { kind: 'nudge', rate: drift > 0 ? 1 - p.nudgeRate : 1 + p.nudgeRate };
  return { kind: 'seek', lead: p.seekLead };
}

/** Engine commands this soon after the first frame are the player's own resume
    seek and first play, not the viewer's. */
export const ALIGN_WINDOW_MS = 2000;
export const inAlignWindow = (startedAtMs, nowMs) => startedAtMs == null || nowMs - startedAtMs <= ALIGN_WINDOW_MS;
/** Once the group clock is this close to the end of this browser's file, the cut differs: stop chasing. */
export const END_GUARD = 0.5;
/** Buffering held this long before the room hears of it (start-of-play blips aren't stragglers). */
export const BUFFERING_REPORT_MS = 1500;
/** A seek landing at least this far from where playback would have been is a jump, not an engine nudge. */
export const JUMP_SECONDS = 1.5;

/** One correction step for a started <video>, mirroring the apps' binder tick:
    play/pause parity first (never pausing a buffering follower into a stall),
    then nothing while a previous seek settles, then the paused room's exact
    position, the end guard, and the drift rule. Pure; the binder executes it.
      in:  { pb, expected, pos, dur, paused, buffering, holding, profile, kickOff }
      out: { phase|null, play, pause, seek: target|null, nudge: rate|null|undefined (undefined = leave), publishPlay } */
export function syncStep({ pb, expected, pos, dur, paused, buffering, holding, profile = PROFILES.av, kickOff = false }) {
  const out = { phase: null, play: false, pause: false, seek: null, nudge: undefined, publishPlay: false };
  if (!pb) return out;
  // We set this item and the room sits paused at its start: our first frame starts the group.
  if (kickOff) { out.play = paused; out.publishPlay = true; out.phase = 'aligning'; return out; }
  if (pb.playing === paused && !(pb.playing && buffering)) { if (pb.playing) out.play = true; else out.pause = true; }
  if (holding) return out;
  if (!pb.playing) {
    if (Math.abs(pos - pb.mediaTime) > 0.5) { out.seek = Math.max(0, pb.mediaTime); out.phase = 'catchingUp'; }
    else out.phase = 'inSync';
    out.nudge = null;
    return out;
  }
  if (dur > 0 && expected > dur - END_GUARD) { out.play = false; out.pause = !paused; out.nudge = null; out.phase = 'atEnd'; return out; }
  const c = driftCorrection(pos - expected, profile);
  if (c.kind === 'none') { out.nudge = null; out.phase = 'inSync'; }
  else if (c.kind === 'nudge') { out.nudge = c.rate; out.phase = 'inSync'; }   // sub-2 s and inaudible: still "in sync"
  else { out.seek = Math.max(0, expected + c.lead); out.nudge = null; out.phase = 'catchingUp'; }
  return out;
}

/** Whether a seek event landing at `landing` is a real jump from where the
    element would have been (`lastPos` `elapsedSec` ago at `rate`). */
export const isJump = (landing, lastPos, elapsedSec, rate = 1) =>
  Number.isFinite(landing) && Number.isFinite(lastPos) && Math.abs(landing - (lastPos + Math.max(0, elapsedSec) * rate)) > JUMP_SECONDS;

/** The binder's own engine commands, recognised when their events come back
    (media events fire asynchronously, so a "while applying" flag can't tell
    them apart): the next play / pause within 1.5 s of one it issued, any
    'seeking' inside the window of a seek it made (where it lands is the
    engine's business — clamped to the seekable range, moved by hls.js — and
    one seek can fire several), and the playbackRate it set. */
export function createEchoMask() {
  let play = 0, pause = 0, seekUntil = 0, rate = null;
  return {
    expectPlay(now) { play = now + 1500; },
    expectPause(now) { pause = now + 1500; },
    expectSeek(now, windowMs = 1500) { seekUntil = now + windowMs; },
    expectRate(r) { rate = r; },
    isPlay(now) { if (now < play) { play = 0; return true; } return false; },
    isPause(now) { if (now < pause) { pause = 0; return true; } return false; },
    isSeek(now) { return now < seekUntil; },
    isRate(r) { return rate != null && Math.abs(r - rate) < 0.001; },
    clear() { play = 0; pause = 0; seekUntil = 0; },
  };
}

// ── Items: the room's TMDB identity <-> the web player's title ──────────────────

/** A room item -> what player.play() wants: { it, kind:'movie'|'tv', s, e }
    (anime is a TMDB tv id), or null for something that isn't an item. */
export function webTitle(item) {
  if (!item || !Number.isInteger(item.tmdbID) || item.tmdbID <= 0) return null;
  const movie = item.kind === 'movie';
  if (!movie && item.kind !== 'tv' && item.kind !== 'anime') return null;
  const title = typeof item.title === 'string' && item.title ? item.title : 'Untitled';
  const it = { id: item.tmdbID, media_type: movie ? 'movie' : 'tv', [movie ? 'title' : 'name']: title,
               poster_path: typeof item.posterPath === 'string' ? item.posterPath : null };
  if (movie) return { it, kind: 'movie', s: 1, e: 1 };
  const n = (v, d) => (Number.isInteger(v) && v >= 0 ? v : d);
  return { it, kind: 'tv', s: n(item.season, 1), e: Math.max(1, n(item.episode, 1)) };
}

/** The player's title (session.ctx { it, kind, s, e }) -> a room item. `anime`:
    the title's anime mapping said so (the apps send kind 'anime'). */
export function partyItem(ctx, anime = false) {
  if (!ctx || !ctx.it || !Number.isInteger(+ctx.it.id) || +ctx.it.id <= 0) return null;
  const movie = ctx.kind === 'movie';
  const t = String(ctx.it.title || ctx.it.name || '').slice(0, 120);
  return {
    tmdbID: +ctx.it.id, kind: movie ? 'movie' : anime ? 'anime' : 'tv',
    season: movie ? null : (Number.isInteger(ctx.s) ? ctx.s : 1), episode: movie ? null : (Number.isInteger(ctx.e) ? ctx.e : 1),
    title: t, posterPath: typeof ctx.it.poster_path === 'string' && ctx.it.poster_path ? ctx.it.poster_path : null,
  };
}

const idKind = (k) => (k === 'movie' ? 'movie' : 'tv');   // anime is a TMDB tv id
/** Same title and episode, whether each side is a room item or a player ctx. */
export function sameEpisode(a, b) {
  const norm = (x) => {
    if (!x) return null;
    if (x.it) return { id: +x.it.id, k: idKind(x.kind), s: x.s, e: x.e };
    return { id: x.tmdbID, k: idKind(x.kind), s: x.season, e: x.episode };
  };
  const p = norm(a), q = norm(b);
  if (!p || !q || p.id !== q.id || p.k !== q.k) return false;
  return p.k === 'movie' || (p.s === q.s && p.e === q.e);
}

/** "Dune" / "Severance · S1 E3". */
export function itemLabel(item) {
  if (!item) return '';
  const t = item.title || 'Untitled';
  return item.kind !== 'movie' && Number.isInteger(item.season) && Number.isInteger(item.episode) ? `${t} · S${item.season} E${item.episode}` : t;
}

// ── Members, avatars, chat ──────────────────────────────────────────────────────

/** The placeholder's letter (P3's PartyAvatarRules.initial): the name's first
    letter or digit, upper-cased; else its first character; blank -> '?'. */
export function memberInitial(name) {
  const s = String(name || '').trim();
  if (!s) return '?';
  const m = s.match(/[\p{L}\p{N}]/u);
  return (m ? m[0] : [...s][0]).toUpperCase();
}

/** A member's colour as a CSS hex ('#…'), whether it came with a '#' or not. */
export function accentCss(hex) {
  return typeof hex === 'string' && /^#?[0-9a-f]{3,8}$/i.test(hex) ? (hex[0] === '#' ? hex : '#' + hex) : '#5f6b63';
}

/** The settled placeholder: the member's colour with its emoji, or its initial
    when it has none (every web member). */
export function placeholder(m) {
  const emoji = m && typeof m.emoji === 'string' ? m.emoji.trim() : '';
  return { color: accentCss(m && m.accentHex), label: emoji || memberInitial(m && m.name), emoji: !!emoji };
}

/** A room avatar's base64 as a data: URL, or null unless it is a JPEG the
    relay would have accepted (base64 alphabet only — it goes into an
    attribute — at most 8192 chars, starting FF D8 FF = '/9j/'). */
export function avatarSrc(b64) {
  if (typeof b64 !== 'string' || !b64 || b64.length > 8192 || !/^\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
  return 'data:image/jpeg;base64,' + b64;
}
/** Newest rev wins; an equal rev replaces (P3's accepts). */
export const acceptsAvatar = (rev, current) => current == null || (Number.isFinite(rev) && rev >= current);

export const MAX_CHAT = 280;
/** Chat text as the relay keeps it: control characters out, trimmed, at most 280 code points. */
export function chatText(raw) {
  const cps = Array.from(String(raw || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim());
  return (cps.length > MAX_CHAT ? cps.slice(0, MAX_CHAT) : cps).join('').trim();
}
export const REACTIONS = ['😂', '❤️', '🔥', '👏', '😮', '😢'];

/** A binary voice frame's header ([0x56][1][u16 len][JSON]{t:'voice', secs, from, name, at}),
    or null. The audio itself is never decoded or played on the web. */
export function voiceHeader(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4 || bytes[0] !== 0x56 || bytes[1] !== 1) return null;
  const len = (bytes[2] << 8) | bytes[3];
  if (len < 2 || 4 + len > bytes.length) return null;
  let h;
  try { h = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + len))); } catch { return null; }
  if (!h || h.t !== 'voice') return null;
  const secs = Number(h.secs);
  return { secs: secs > 0 && secs <= 60 ? secs : 0, from: typeof h.from === 'string' ? h.from : null,
           name: typeof h.name === 'string' ? h.name.slice(0, 24) : '', at: Number.isFinite(h.at) ? h.at : null };
}
/** The chat line a voice clip becomes. */
export const voiceText = (h) => 'Voice clip' + (h && h.secs ? ` · ${Math.ceil(h.secs)} s` : '') + ' (plays in the app)';

/** Why the party ended for this browser. */
export function closedText(reason) {
  if (reason === 'ended') return 'The host ended the party.';
  if (reason === 'kicked') return 'You were removed from the party.';
  if (reason === 'expired' || reason === 'idle') return 'The party expired.';
  if (reason === 'full') return 'That party is full.';
  return 'The party closed.';
}

// ── The connection ──────────────────────────────────────────────────────────────

export const PING_MS = 10000;
export const WELCOME_MS = 10000;
export const GIVE_UP_MS = 60000;
export const REPORT_EVERY_MS = 5000;
const STEPS = [1000, 2000, 4000, 8000, 15000];
/** Reconnect delay for the attempt'th retry (0-based), with up to 0.5 s of jitter. */
export const backoffMs = (attempt, rand = 0) => STEPS[Math.min(Math.max(0, attempt), STEPS.length - 1)] + Math.round(Math.max(0, Math.min(1, rand)) * 500);

/** Frames that carry a room-wide seq the client must not go back on
    (state / item / queue are dropped at <= lastSeq; the rest only raise it). */
export const SEQ_GATED = new Set(['state', 'item', 'queue']);
export const acceptsSeq = (t, seq, lastSeq) => !SEQ_GATED.has(t) || (Number.isFinite(seq) && seq > lastSeq);

/** This browser's device id: 'web-' + 16 [a-z0-9] (the relay's DEVICE_RE allows it). */
export function newDeviceId(rand = Math.random) {
  const A = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = 'web-';
  for (let i = 0; i < 16; i++) s += A[Math.floor(rand() * A.length) % A.length];
  return s;
}
export const DEVICE_RE = /^web-[a-z0-9]{8,40}$/;

/** "1:02:05" / "4:07". */
export function clockLabel(t) {
  t = Math.max(0, Math.floor(Number(t) || 0));
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}
