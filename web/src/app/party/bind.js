/* Wave 7 (P5, roadmap 7.4) — glue between the room and the player overlay
   (player.js / session.js): apply the room's item and clock to the <video>,
   publish this viewer's play / pause / seek when the room allows it, report
   presence. The browser's half of PartyTransportBinder.swift.

   Remote -> local, on every room `state` and a 2 Hz tick: play/pause parity,
   then rules.syncStep — < 0.3 s nothing, < 2 s a ±5 % playbackRate nudge,
   else a seek with a 0.15 s lead (the converter seeks through player.seekTo,
   which knows its epochs, and settles 8 s). Before the first frame the
   player's start point (session.momentAt) is aimed at the group's clock, so a
   joiner never starts at its own resume point. The embed iframe can't be
   driven: it reports engine "embed" and the badge says "Not synced"; item
   changes and chat still arrive.

   Local -> remote: the <video>'s own play / pause / seeking / ratechange
   events (native controls, keys, the skip button) and player.seekTo's hook
   (session.party.seekIntent — a converter seek far away restarts generation
   before the element sees anything). The binder's own commands come back as
   events too, so they're masked (rules.createEchoMask); anything within 2 s
   of the first frame is the player's resume / first play. A refused command
   (host mode, or the relay's `forbidden`) toasts "Only the host can control
   playback" and snaps back to the room's clock at once; a seekTo is refused
   before it happens.

   createBinder(deps) is DOM-free (test/party.mjs drives it with a fake
   <video>); bindParty(client, opts) wires it to the real player. */

import {
  syncStep, profileFor, createEchoMask, inAlignWindow, isJump, sameEpisode, webTitle, partyItem,
  BUFFERING_REPORT_MS, REPORT_EVERY_MS, REFUSED_TOAST,
} from './rules.js';
import { play, seekTo } from '../player/player.js';
import { session as playerSession, mediaTime, mediaDuration, videoVisible } from '../player/session.js';
import { toast } from '../ui/toast.js';
import { $ } from '../util.js';

const TICK_MS = 500;
const SEEK_DEBOUNCE_MS = 300;   // a scrub fires many 'seeking' events: publish where it lands
const ctxKey = (c) => (c && c.it ? `${c.kind}:${c.it.id}:${c.s}:${c.e}` : '');

export function createBinder(d) {
  const { client, session } = d;
  const now = d.now || (() => Date.now());
  const T = d.timers || globalThis;
  const mask = createEchoMask();
  const b = {
    phase: 'unbound', started: false, startedAt: null, holdOffUntil: 0,
    nudge: null, chosenRate: 1, lastPos: 0, lastPosAt: 0, tickPos: -1, stuck: 0, bufferingSince: null,
    lastReport: 0, lastReportKey: '', lastCtxKey: '', applying: false, seekTimer: null, pendingSeek: null,
    ticker: null, autoplayToast: false,
  };
  const video = () => d.video();
  const room = () => client.state.room;
  const joined = () => client.state.phase === 'joined' && !!room();
  const setPhase = (p) => { if (b.phase !== p) { b.phase = p; if (d.onPhase) d.onPhase(p); } };

  /** Which engine is up: 'none' (loading / closed / live TV) | 'av' | 'converter' | 'embed'. */
  function engine() {
    if (!session.ctx) return 'none';
    const cur = String(session.cur || '');
    if (cur && !cur.startsWith('rd:') && !cur.startsWith('dx:') && cur !== 'live') return 'embed';
    if (session.vt) return 'converter';
    return cur && d.videoVisible() ? 'av' : 'none';
  }
  const syncable = (e) => e === 'av' || e === 'converter';
  const wireEngine = () => { const e = engine(); return !bound() ? 'none' : e === 'embed' ? 'embed' : syncable(e) ? 'av' : 'none'; };
  /** The player is on the room's title. */
  const bound = () => joined() && !!session.ctx && sameEpisode(session.ctx, room().item);
  const pos = () => d.mediaTime(video());

  // ── Remote -> local ──
  function tick() {
    if (!joined()) return;
    noteCtx();
    const e = engine();
    if (!bound()) { setPhase('unbound'); clearNudge(); report(); return; }
    if (e === 'embed') { setPhase('embed'); report(); return; }
    if (!syncable(e) || !b.started) {
      // Before the first frame: the player starts where the group is by then
      // (armResume / the converter's open read momentAt), never at our resume point.
      session.momentAt = Math.max(0, client.expected());
      setPhase('aligning'); report(); return;
    }
    const v = video(), t = now(), pb = room().playback;
    if (!pb) { report(); return; }
    const p = pos();
    trackBuffering(v, p, pb, t);
    // The room's speed is everyone's speed.
    if (pb.rate > 0 && Math.abs(pb.rate - b.chosenRate) > 0.01) b.chosenRate = pb.rate;
    if (Math.abs((v.playbackRate || 1) - b.chosenRate * (b.nudge || 1)) > 0.001) applyRate();
    const step = syncStep({ pb, expected: client.expected(), pos: p, dur: d.mediaDuration(v), paused: v.paused,
                            buffering: b.bufferingSince != null, holding: t < b.holdOffUntil,
                            profile: profileFor(e), kickOff: client.shouldKickOff() && client.canControl() });
    if (step.play) remotePlay(v);
    if (step.pause) remotePause(v);
    if (step.publishPlay) { client.publish('play', p); setPhase('inSync'); report(true); return; }
    if (step.nudge !== undefined) setNudge(step.nudge);
    if (step.seek != null) hardSeek(step.seek, e);
    if (step.phase) setPhase(step.phase);
    report();
  }

  function remotePlay(v) {
    mask.expectPlay(now());
    let r;
    try { r = v.play(); } catch (_) { r = null; }
    if (r && typeof r.catch === 'function') r.catch((err) => { if (err && err.name === 'NotAllowedError') autoplayBlocked(); });
  }
  function remotePause(v) { mask.expectPause(now()); try { v.pause(); } catch (_) {} }
  /** The browser refused to start sound without a tap: ask for one (the tap is the gesture). */
  function autoplayBlocked() {
    if (b.autoplayToast || !d.toast) return;
    b.autoplayToast = true;
    d.toast('The party is playing — tap to join in', { id: 'party-autoplay', action: 'Play', onClose: () => { b.autoplayToast = false; },
      onAction: () => { mask.expectPlay(now()); const r = video().play(); if (r && r.catch) r.catch(() => {}); } });
  }
  function hardSeek(target, e) {
    clearNudge();
    mask.expectSeek(now(), 2000);
    b.applying = true;
    try { d.seekTo(target); } finally { b.applying = false; }
    b.holdOffUntil = now() + profileFor(e).settle * 1000;
    b.lastPos = target; b.lastPosAt = now(); b.tickPos = -1; b.stuck = 0;
    setPhase('catchingUp');
  }
  function applyRate() {
    const v = video(), r = b.chosenRate * (b.nudge || 1);
    mask.expectRate(r);
    try { v.playbackRate = r; } catch (_) {}
  }
  function setNudge(r) { if (b.nudge === r) return; b.nudge = r; applyRate(); }
  function clearNudge() { if (b.nudge != null) setNudge(null); }

  function trackBuffering(v, p, pb, t) {
    const shouldPlay = pb.playing && !v.paused;
    b.stuck = shouldPlay && b.tickPos >= 0 && Math.abs(p - b.tickPos) < 0.01 ? b.stuck + 1 : 0;
    b.tickPos = p;
    const buf = (shouldPlay && v.readyState != null && v.readyState < 3) || b.stuck >= 3;
    if (buf) { if (b.bufferingSince == null) b.bufferingSince = t; } else b.bufferingSince = null;
  }

  // ── The room's title on this player ──
  /** The viewer started another title while in the room: with control it
      becomes the room's item (the apps' rule), else back to the room's. */
  function noteCtx() {
    const ctx = session.ctx, key = ctxKey(ctx);
    if (key === b.lastCtxKey) return;
    b.lastCtxKey = key;
    if (!ctx || !joined() || sameEpisode(ctx, room().item)) return;
    if (client.canControl()) {
      const m = session.momentAt;
      const startAt = typeof m === 'number' && m > 0 ? m : (session.resumeAt > 30 ? session.resumeAt : 0);
      client.setItem(partyItem(ctx, !!(session.anime && session.anime.anime)), startAt);
    } else if (room().item) {
      if (d.toast) d.toast(REFUSED_TOAST, { id: 'party-refused' });
      route();
    }
  }
  /** Put the player on the room's item, starting at the group's clock. */
  function route() {
    const r = room(), t = r && webTitle(r.item);
    if (!t || (session.ctx && sameEpisode(session.ctx, r.item))) return false;
    b.lastCtxKey = ctxKey({ it: t.it, kind: t.kind, s: t.s, e: t.e });
    d.play(t.it, t.kind, t.s, t.e, Math.max(0, client.expected()));
    return true;
  }

  // ── Local -> remote ──
  /** Is an engine event the viewer's? Not before / just after the first frame,
      not on another title, not on a torn-down element. */
  function accept() {
    const v = video();
    if (!bound() || !b.started || !syncable(engine())) return false;
    if (inAlignWindow(b.startedAt, now())) return false;
    return !!d.videoVisible() && !!(v.getAttribute && v.getAttribute('src'));
  }
  function refused() {
    if (d.toast) d.toast(REFUSED_TOAST, { id: 'party-refused' });
    T.clearTimeout(b.seekTimer); b.seekTimer = null; b.pendingSeek = null;
    b.holdOffUntil = 0;
    applyRate();
    tick();   // snap back to the room's clock now
  }
  function intent(kind, value) {
    if (!client.canControl()) return refused();
    const v = video(), e = engine();
    if (kind === 'play') client.publish('play', pos());
    else if (kind === 'pause') client.publish('pause', pos());
    else if (kind === 'seek') { b.holdOffUntil = now() + profileFor(e).settle * 1000; client.publish('seek', value, { playing: !v.paused }); }
    else if (kind === 'rate') { b.chosenRate = value; b.nudge = null; mask.expectRate(value); client.publish('rate', pos(), { rate: value }); }
    b.lastPos = kind === 'seek' ? value : pos(); b.lastPosAt = now();
    report(true);
  }
  const on = {
    play() { if (!mask.isPlay(now()) && accept()) intent('play'); },
    pause() {
      const v = video(), dur = d.mediaDuration(v);
      if (v.ended || (dur > 0 && pos() >= dur - 0.3)) return;   // the end of the file pauses too
      if (!mask.isPause(now()) && accept()) intent('pause');
    },
    seeking() {
      const v = video(), p = pos(), t = now();
      if (mask.isSeek(t) || !accept()) return;
      // Not a jump (hls.js stepping over a gap) — unless a scrub is already under way.
      if (b.pendingSeek == null && !isJump(p, b.lastPos, (t - b.lastPosAt) / 1000, v.paused ? 0 : (v.playbackRate || 1))) return;
      b.pendingSeek = p;
      b.holdOffUntil = t + 1500;   // don't pull the scrubber back mid-drag
      T.clearTimeout(b.seekTimer);
      b.seekTimer = T.setTimeout(() => { b.seekTimer = null; const s = b.pendingSeek; b.pendingSeek = null; if (s != null && bound()) intent('seek', s); }, SEEK_DEBOUNCE_MS);
    },
    ratechange() { const v = video(); if (!mask.isRate(v.playbackRate) && accept()) intent('rate', v.playbackRate); },
    loadstart() { b.started = false; b.startedAt = null; b.nudge = null; b.tickPos = -1; b.bufferingSince = null; },
    playing() {
      b.bufferingSince = null; b.stuck = 0;
      if (b.started) return;
      b.started = true; b.startedAt = now(); b.holdOffUntil = 0;
      b.lastPos = pos(); b.lastPosAt = now();
    },
    waiting() { if (b.bufferingSince == null) b.bufferingSince = now(); },
    canplay() { b.bufferingSince = null; },
    timeupdate() { b.lastPos = pos(); b.lastPosAt = now(); },
  };
  on.emptied = on.loadstart;

  /** player.seekTo's hook: false = refused before anything moves. */
  function seekIntent(t) {
    if (b.applying || !accept()) return true;
    if (!client.canControl()) { refused(); return false; }
    mask.expectSeek(now(), 1500);   // its 'seeking' echo is already published
    intent('seek', Math.max(0, t));
    return true;
  }
  /** End of file in a party: the room decides what's next (the apps' playbackReachedEnd). */
  function holdsEnd() {
    if (!bound()) return false;
    const queued = (room().queue || []).length > 0, me = client.me();
    // Only a relay from before Wave 7 ever makes the browser host (the last one
    // left); then it advances the queue as the apps' host does.
    if (queued && me && me.role === 'host' && client.playNext()) return true;
    if (queued || !client.canControl()) {
      if (d.toast) d.toast('Up next when the host continues', { id: 'party-end' });
      return true;
    }
    return false;   // autoplay's next episode becomes the room's item (noteCtx)
  }

  // ── Presence ──
  function report(force = false) {
    if (!joined()) return;
    const v = video(), isBound = bound(), e = engine(), t = now();
    const live = isBound && syncable(e) && b.started;
    const playing = live && !v.paused && !v.ended;
    const buffering = live && b.bufferingSince != null && t - b.bufferingSince >= BUFFERING_REPORT_MS;
    const synced = live && (b.phase === 'inSync' || (b.phase === 'catchingUp' && t < b.holdOffUntil));
    const engineWire = wireEngine();
    const key = [playing, buffering, synced, engineWire].join('|');
    const due = playing && t - b.lastReport >= REPORT_EVERY_MS;
    if (!force && !due && key === b.lastReportKey) return;
    b.lastReport = t; b.lastReportKey = key;
    client.report({ pos: live ? pos() : 0, dur: live ? d.mediaDuration(v) : 0, playing, buffering, engine: engineWire, synced });
  }

  const api = {
    get phase() { return b.phase; },
    engine, wireEngine, bound, tick, route, report, seekIntent, holdsEnd,
    /** The room moved the clock (a new `state`): correct now, not next tick. */
    remoteStateChanged() { b.holdOffUntil = 0; tick(); },
    /** The relay refused our command: the client already restored the room's clock. */
    snapBack(text) { if (d.toast) d.toast(text || REFUSED_TOAST, { id: 'party-refused' }); b.holdOffUntil = 0; applyRate(); tick(); },
    attach() {
      const v = video();
      if (v && v.addEventListener) for (const [k, f] of Object.entries(on)) v.addEventListener(k, f);
      session.party = { seekIntent, holdsEnd };
      b.started = !!(v && !v.paused && v.readyState >= 3); b.startedAt = b.started ? now() - 5000 : null;
      b.lastCtxKey = ctxKey(session.ctx);
      T.clearInterval(b.ticker);
      b.ticker = T.setInterval(tick, TICK_MS);
    },
    detach() {
      const v = video();
      if (v && v.removeEventListener) for (const [k, f] of Object.entries(on)) v.removeEventListener(k, f);
      if (session.party && session.party.seekIntent === seekIntent) session.party = null;
      T.clearInterval(b.ticker); b.ticker = null;
      T.clearTimeout(b.seekTimer); b.seekTimer = null;
      if (v && b.nudge != null) { b.nudge = null; try { v.playbackRate = b.chosenRate; } catch (_) {} }
      setPhase('unbound');
    },
    /** For the checks. */
    _b: b, _mask: mask,
  };
  return api;
}

// ── The real player ─────────────────────────────────────────────────────────────

let current = null;

/** Bind `client` to the player overlay. opts.onPhase(phase) for the badge. */
export function bindParty(client, opts = {}) {
  unbindParty();
  current = createBinder({
    client, session: playerSession, video: () => $('pvideo'), play, seekTo, toast,
    mediaTime, mediaDuration, videoVisible, onPhase: opts.onPhase,
  });
  current.attach();
  return current;
}
export function unbindParty() { if (current) { current.detach(); current = null; } }
export const partyBinder = () => current;
