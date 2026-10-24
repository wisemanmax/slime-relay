// Watch Party on the web (Wave 7, P5), run by check.mjs: the pure rules, the
// room client against a fake WebSocket and a fake clock, the player binder
// against a fake <video>, the page renderers' escaping, the Worker's
// /api/party routes and the /p/<code> redirect, and the web client's rules
// driven through the relay's REAL reducer (relay/src/party-reducer.js, pure).
// Nothing here opens a socket, plays media or touches the network. Returns
// the number of assertions; throws (node:assert) on the first failure.

import assert from 'node:assert/strict';
import * as R from '../src/app/party/rules.js';
import { createPartyClient } from '../src/app/party/client.js';
import { createBinder } from '../src/app/party/bind.js';
import { joinPageHTML, membersHTML, chatHTML, statusText } from '../src/app/views/party.js';
import { partyRoutes } from '../src/worker/party.js';
import worker from '../src/worker.js';
import { BUILD_ID } from '../src/generated/page.js';
import { createStore, memoryStorage } from '../src/app/state.js';
import { initActions } from '../src/app/ui/actions.js';
import { session as playerSession } from '../src/app/player/session.js';
import { viewParty } from '../src/app/views/party.js';

// ── Fakes ───────────────────────────────────────────────────────────────────────
function fakeTimers(start = 1_700_000_000_000) {
  let t = start, seq = 0;
  const q = new Map();
  const T = {
    now: () => t,
    setTimeout(fn, ms) { const id = ++seq; q.set(id, { at: t + (ms || 0), fn, every: 0 }); return id; },
    clearTimeout(id) { q.delete(id); },
    setInterval(fn, ms) { const id = ++seq; q.set(id, { at: t + ms, fn, every: ms }); return id; },
    clearInterval(id) { q.delete(id); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [id, x] of q) if (x.at <= end && (!next || x.at < next[1].at)) next = [id, x];
        if (!next) break;
        const [id, x] = next;
        t = x.at;
        if (x.every) x.at += x.every; else q.delete(id);
        x.fn();
      }
      t = end;
    },
  };
  return T;
}
function fakeSocketClass() {
  class WS {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.binary = 0; this.closed = null; WS.all.push(this); }
    send(d) { if (this.readyState !== 1) throw new Error('not open'); if (typeof d === 'string') this.sent.push(JSON.parse(d)); else this.binary++; }
    close(code, reason) { this.readyState = 3; this.closed = { code, reason }; }
    open() { this.readyState = 1; if (this.onopen) this.onopen({}); }
    recv(m) { if (this.onmessage) this.onmessage({ data: typeof m === 'string' || m instanceof ArrayBuffer || ArrayBuffer.isView(m) ? m : JSON.stringify(m) }); }
    drop(code = 1006) { this.readyState = 3; if (this.onclose) this.onclose({ code }); }
    get last() { return this.sent[this.sent.length - 1]; }
    of(t) { return this.sent.filter((m) => m.t === t); }
  }
  WS.all = [];
  WS.latest = () => WS.all[WS.all.length - 1];
  return WS;
}
const stores = () => ({
  local: createStore(memoryStorage(), { device: { storage: 'sw_party_device', def: '', local: true } }),
  seats: createStore(memoryStorage(), { seat: { storage: 'sw_party_seat', def: null, local: true } }),
});
function makeClient(o = {}) {
  const T = o.T || fakeTimers();
  const WS = o.WS || fakeSocketClass();
  const s = o.stores || stores();
  const events = [];
  const client = createPartyClient({
    code: 'XK7Q2M', url: 'wss://watch.example/api/party/XK7Q2M/ws', WebSocket: WS, local: s.local, seats: s.seats,
    identity: () => ({ name: 'Ann', accentHex: '#37e29a' }), engine: () => o.engine || 'none', app: 'web abc123',
    now: T.now, timers: T, random: () => 0, peek: o.peek, onEvent: (t, d) => events.push([t, d]),
  });
  return { client, T, WS, s, events, ev: (t) => events.filter((e) => e[0] === t).map((e) => e[1]) };
}
const pb0 = (now, o = {}) => ({ playing: false, mediaTime: 0, serverTimeAtUpdate: now, rate: 1, seq: 0, by: null, cmd: null, reason: 'item', waitingFor: [], ...o });
const member = (id, name, role = 'member', o = {}) => ({ id, name, emoji: '', accentHex: '37e29a', role, platform: 'ios', avatarRev: 0, engine: 'av', synced: false, connected: true, ...o });
function welcome(T, o = {}) {
  return {
    t: 'welcome', v: 1, seq: o.seq ?? 3, serverTime: T.now() + (o.offset ?? 0), you: { id: 'm_web', role: 'member', secret: o.secret ?? 's3cret' },
    room: { code: 'XK7Q2M', hostId: o.hostId === undefined ? 'm_host' : o.hostId, settings: o.settings || { control: 'shared', everyoneControls: true, waitForStragglers: false },
            item: o.item ?? null, playback: o.playback || pb0(T.now() + (o.offset ?? 0)), queue: o.queue || [],
            members: o.members || [member('m_host', 'Host', 'host'), member('m_web', 'Ann', 'member', { platform: 'web', engine: 'none' })] },
  };
}
const ITEM = { tmdbID: 1399, kind: 'tv', season: 1, episode: 2, absoluteEpisode: null, title: 'Game of Thrones', posterPath: '/got.jpg' };
const voiceFrame = (header, audio = 64) => {
  const h = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + h.length + audio);
  out[0] = 0x56; out[1] = 1; out[2] = h.length >> 8; out[3] = h.length & 255; out.set(h, 4);
  return out;
};

/** A <video> whose clock runs on the fake timers while it plays. */
class FakeVideo {
  constructor(T) {
    this.T = T; this._base = 0; this._at = T.now(); this._paused = true; this._rate = 1;
    Object.assign(this, { ended: false, duration: 3600, readyState: 4, attrs: { src: 'blob:x' }, plays: 0, pauses: 0, playResult: null }); this.l = {};
  }
  get currentTime() { return this._paused ? this._base : this._base + (this.T.now() - this._at) / 1000 * this._rate; }
  set currentTime(v) { this._base = v; this._at = this.T.now(); }
  get paused() { return this._paused; }
  set paused(p) { const c = this.currentTime; this._paused = p; this.currentTime = c; }
  get playbackRate() { return this._rate; }
  set playbackRate(r) { const c = this.currentTime; this._rate = r; this.currentTime = c; }
  addEventListener(k, f) { (this.l[k] ||= []).push(f); }
  removeEventListener(k, f) { this.l[k] = (this.l[k] || []).filter((x) => x !== f); }
  emit(k) { for (const f of this.l[k] || []) f({}); }
  getAttribute(k) { return this.attrs[k] || null; }
  play() { this.plays++; this.paused = false; return this.playResult || Promise.resolve(); }
  pause() { this.pauses++; this.paused = true; }
}
function makeBinder(c, T) {
  const v = new FakeVideo(T);
  const session = { ctx: null, cur: '', vt: null, momentAt: null, resumeAt: 0, anime: null, party: null };
  const out = { v, session, plays: [], seeks: [], toasts: [], phases: [], seekEnd: Infinity };
  // player.seekTo: the party hook first, then the element, clamped to what's seekable.
  out.seekTo = (t) => { if (session.party && session.party.seekIntent(t) === false) return; const to = Math.min(t, out.seekEnd); out.seeks.push(to); v.currentTime = to; };
  out.binder = createBinder({
    client: c, session, video: () => v, now: T.now, timers: T,
    play: (it, kind, s, e, at) => { out.plays.push({ it, kind, s, e, at }); session.ctx = { it, kind, s, e }; session.cur = ''; session.momentAt = at; },
    seekTo: out.seekTo, mediaTime: (el) => (session.vt ? session.vt.baseOffset : 0) + el.currentTime, mediaDuration: (el) => el.duration,
    videoVisible: () => session.cur !== '' && !/^[a-z]+$/.test(session.cur), toast: (text, o) => out.toasts.push({ text, o }),
    onPhase: (p) => out.phases.push(p),
  });
  out.binder.attach();
  /** The source starts: frames decode at `at`, playing. */
  out.start = (at, cur = 'rd:0') => { session.cur = cur; v.emit('loadstart'); v.currentTime = at; v.paused = false; v.emit('playing'); };
  return out;
}
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Just enough DOM for views/party.js: elements exist once some innerHTML /
    insertAdjacentHTML names their id, and leave with their parent's content. */
function miniDom() {
  const byId = new Map();
  class El {
    constructor(tag = 'div', id = '') {
      Object.assign(this, { tagName: tag.toUpperCase(), id, dataset: {}, style: {}, attrs: {}, kids: [], parent: null, _html: '', textContent: '',
        listeners: {}, scrollHeight: 0, scrollTop: 0, clientHeight: 0, value: '' });
      const cls = new Set();
      this.classList = { add: (...c) => c.forEach((x) => cls.add(x)), remove: (...c) => c.forEach((x) => cls.delete(x)), contains: (c) => cls.has(c),
        toggle: (c, on) => { const v = on === undefined ? !cls.has(c) : !!on; if (v) cls.add(c); else cls.delete(c); return v; } };
    }
    get innerHTML() { return this._html; }
    set innerHTML(h) { for (const k of this.kids) k.detach(); this.kids = []; this._html = String(h); adopt(this, this._html); }
    insertAdjacentHTML(pos, h) { const host = pos === 'beforeend' || pos === 'afterbegin' ? this : this.parent; if (host) { host._html += h; adopt(host, h); } }
    appendChild(c) { c.parent = this; this.kids.push(c); return c; }
    remove() { this.detach(); if (this.parent) this.parent.kids = this.parent.kids.filter((k) => k !== this); }
    detach() { if (this.id && byId.get(this.id) === this) byId.delete(this.id); for (const k of this.kids) k.detach(); }
    querySelector(sel) {
      const act = sel.match(/^\[data-act="([^"]+)"\]$/), cl = sel.match(/^\.([a-z-]+)$/);
      const walk = (el) => { for (const k of el.kids) { if ((act && k.dataset.act === act[1]) || (cl && k.classList.contains(cl[1]))) return k; const f = walk(k); if (f) return f; } return null; };
      return walk(this);
    }
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
    removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== f); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    play() { return Promise.reject(Object.assign(new Error('no source'), { name: 'NotSupportedError' })); }
    pause() {}
  }
  function adopt(host, html) {
    for (const m of html.matchAll(/<(\w+)\b[^>]*?\sid="([^"]+)"[^>]*>/g)) {
      const el = new El(m[1], m[2]);
      for (const [, k, v] of m[0].matchAll(/data-([a-z-]+)="([^"]*)"/g)) el.dataset[k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
      el.parent = host; host.kids.push(el); byId.set(m[2], el);
    }
  }
  const body = new El('body');
  body.innerHTML = '<main id="main"></main><div id="player"></div><div id="toasts"></div>';
  const player = byId.get('player');
  const close = new El('button'); close.dataset.act = 'player-close'; player.appendChild(close);
  const stage = new El('div'); stage.classList.add('stage'); player.appendChild(stage);
  player.insertAdjacentHTML('beforeend', '<video id="pvideo"></video>');
  return {
    get: (id) => byId.get(id) || null, body,
    document: { getElementById: (id) => byId.get(id) || null, createElement: (t) => new El(t), body, addEventListener() {}, visibilityState: 'visible', fullscreenElement: null },
    toasts: () => byId.get('toasts').kids.map((t) => t.kids[0] && t.kids[0].textContent),
  };
}

export async function runPartyChecks() {
  let n = 0;
  const eq = (a, b, m) => { assert.deepEqual(a, b, m); n++; };
  const ok = (v, m) => { assert.ok(v, m); n++; };
  const near = (a, b, tol, m) => { assert.ok(Math.abs(a - b) <= tol, `${m}: ${a} vs ${b}`); n++; };

  // ── 1. Rules ──────────────────────────────────────────────────────────────────
  ok(R.PARTY_CODE_RE.test('XK7Q2M') && !R.PARTY_CODE_RE.test('XK7Q2O') && !R.PARTY_CODE_RE.test('XK7Q21'), 'room code alphabet (no O / 1)');
  eq([R.normalCode(' xk7q2m '), R.normalCode('XK7Q2'), R.normalCode('<b>'), R.normalCode(null)], ['XK7Q2M', '', '', ''], 'normalCode');
  eq(R.expectedTime({ playing: true, mediaTime: 10, serverTimeAtUpdate: 0, rate: 1 }, 5000), 15, 'clock extrapolates while playing');
  eq(R.expectedTime({ playing: true, mediaTime: 10, serverTimeAtUpdate: 0, rate: 1.5 }, 2000), 13, 'at the room rate');
  eq(R.expectedTime({ playing: false, mediaTime: 10, serverTimeAtUpdate: 0, rate: 1 }, 9000), 10, 'a paused room stays put');
  eq(R.expectedTime(null, 1), 0, 'no playback -> 0');
  {
    const room = (control, extra = {}) => ({ hostId: 'h', settings: { ...control }, members: [{ id: 'h', role: 'host' }, { id: 'w', role: 'member' }, { id: 'c', role: 'companion' }], ...extra });
    eq(R.canControl(room({ control: 'host', everyoneControls: false }), 'h'), true, 'host controls in host mode');
    eq(R.canControl(room({ control: 'host', everyoneControls: false }), 'w'), false, 'member refused in host mode');
    eq(R.canControl(room({ control: 'shared', everyoneControls: true }), 'w'), true, 'member controls a shared room');
    eq(R.canControl(room({ control: 'shared', everyoneControls: true }), 'c'), false, 'a companion never controls');
    eq([R.canControl(room({ everyoneControls: true }), 'w'), R.canControl(room({ everyoneControls: false }), 'w')], [true, false], 'missing control -> everyoneControls (a pre-Wave-7 relay)');
    eq(R.canControl(room({ control: 'party-mode', everyoneControls: true }), 'w'), false, 'an unknown control value reads as host-only');
    eq([R.canControl(null, 'w'), R.canControl(room({ control: 'shared' }), 'nobody'), R.canControl(room({ control: 'shared' }), null)], [false, false, false], 'no room / not a member');
    eq(R.canControl(room({ control: 'host' }, { hostId: null, members: [{ id: 'w', role: 'member' }] }), 'w'), false, 'a hostless host-only room: nobody controls');
    eq(R.canControl(room({ control: 'shared' }, { hostId: null, members: [{ id: 'w', role: 'member' }] }), 'w'), true, 'a hostless shared room still works');
    eq([R.controlChangedToast({ control: 'shared' }, { control: 'host' }), R.controlChangedToast({ everyoneControls: false }, { control: 'shared' }), R.controlChangedToast({ control: 'host' }, { everyoneControls: false })],
      ['The host now controls playback', 'Everyone can control playback now', null], 'control change toasts (P4\'s words)');
    eq([R.controlLine('host'), R.controlLine('shared'), R.REFUSED_TOAST], ['The host controls playback', 'Everyone can control playback', 'Only the host can control playback'], 'control wording');
  }
  {
    const c = R.createClock();
    eq([c.hasSync, c.offset], [false, 0], 'clock: nothing until a sample');
    c.add(1000, 6040, 1080);   // rtt 80 -> offset 5000
    eq([c.offset, c.rtt], [5000, 80], 'offset = s - (c + rtt/2)');
    c.add(2000, 7300, 2400);   // rtt 400, offset 5100: worse sample
    eq(c.offset, 5000, 'the smallest round trip wins, not the mean');
    c.add(3000, 8010, 3020);   // rtt 20, offset 5000
    eq([c.offset, c.rtt, c.serverNow(10)], [5000, 20, 5010], 'a better sample replaces it');
  }
  {
    const P = R.PROFILES;
    eq([R.driftCorrection(0.2, P.av), R.driftCorrection(-0.29, P.av)], [{ kind: 'none' }, { kind: 'none' }], 'drift < 0.3 s: nothing');
    eq([R.driftCorrection(1, P.av), R.driftCorrection(-1.9, P.av)], [{ kind: 'nudge', rate: 0.95 }, { kind: 'nudge', rate: 1.05 }], '< 2 s: a ±5 % nudge (ahead slows down)');
    eq([R.driftCorrection(2.5, P.av), R.driftCorrection(-40, P.av)], [{ kind: 'seek', lead: 0.15 }, { kind: 'seek', lead: 0.15 }], 'else a seek with a 0.15 s lead');
    eq([P.converter.settle, P.av.settle, R.driftCorrection(5, P.converter).kind], [8, 1, 'seek'], 'the converter seeks the same and settles 8 s');
    eq([R.driftCorrection(500, P.embed), R.driftCorrection(NaN, P.av)], [{ kind: 'none' }, { kind: 'none' }], 'an embed is never corrected; NaN is nothing');
    eq([R.inAlignWindow(1000, 3000), R.inAlignWindow(1000, 3001), R.inAlignWindow(null, 5)], [true, false, true], 'the 2 s align window from the first frame');
    const pb = { playing: true, mediaTime: 100, rate: 1, reason: 'user' };
    const step = (o) => R.syncStep({ pb, expected: 100, pos: 100, dur: 3600, paused: false, buffering: false, holding: false, ...o });
    eq(step({}).phase, 'inSync', 'in sync');
    eq(step({ paused: true }).play, true, 'parity: the room plays, so play');
    eq(step({ paused: true, buffering: true }).play, false, 'never fights a buffering follower');
    eq(step({ pos: 101 }).nudge, 0.95, 'nudge');
    eq([step({ pos: 90 }).seek, step({ pos: 90 }).phase], [100.15, 'catchingUp'], 'seek ahead by the lead');
    eq(step({ pos: 90, holding: true }).seek, null, 'nothing while a seek settles');
    eq(R.syncStep({ pb: { ...pb, playing: false }, expected: 100, pos: 100.4, dur: 3600, paused: false }).pause, true, 'parity: the room paused');
    eq(R.syncStep({ pb: { ...pb, playing: false }, expected: 100, pos: 99, dur: 3600, paused: true }).seek, 100, 'paused room: exact position, no lead');
    eq([step({ expected: 3599.7, pos: 3599.7 }).phase, step({ expected: 3599.7, pos: 3599.7 }).pause], ['atEnd', true], 'end guard: a shorter cut stops chasing');
    eq(R.syncStep({ pb: { ...pb, playing: false, reason: 'item' }, expected: 0, pos: 3, dur: 3600, paused: true, kickOff: true }), { phase: 'aligning', play: true, pause: false, seek: null, nudge: undefined, publishPlay: true }, 'kick-off');
    eq([R.isJump(130, 100, 1, 1), R.isJump(101.2, 100, 1, 1), R.isJump(100.1, 100, 0, 0)], [true, false, false], 'a jump vs an engine nudge');
    const m = R.createEchoMask();
    m.expectPlay(1000); m.expectSeek(1000, 2000); m.expectRate(0.95);
    eq([m.isPlay(1200), m.isPlay(1300), m.isPause(1200), m.isSeek(2999), m.isSeek(3000), m.isRate(0.95), m.isRate(1)], [true, false, false, true, false, true, false], 'echo mask: own commands only, once');
  }
  {
    const t = R.webTitle({ tmdbID: 30984, kind: 'anime', season: 1, episode: 3, title: 'Bleach', posterPath: '/b.jpg' });
    eq(t, { it: { id: 30984, media_type: 'tv', name: 'Bleach', poster_path: '/b.jpg' }, kind: 'tv', s: 1, e: 3 }, 'anime -> a TMDB tv title');
    eq(R.webTitle({ tmdbID: 550, kind: 'movie', season: null, episode: null, title: 'Fight Club', posterPath: null }).kind, 'movie', 'movie');
    eq(R.webTitle({ tmdbID: 1399, kind: 'tv', season: 0, episode: 2, title: 'GoT' }).s, 0, 'specials keep season 0');
    eq([R.webTitle(null), R.webTitle({ tmdbID: -1, kind: 'tv' }), R.webTitle({ tmdbID: 5, kind: 'book' })], [null, null, null], 'not an item');
    const ctx = { it: { id: 1399, name: 'Game of Thrones', poster_path: '/got.jpg' }, kind: 'tv', s: 1, e: 2 };
    eq(R.partyItem(ctx), { tmdbID: 1399, kind: 'tv', season: 1, episode: 2, title: 'Game of Thrones', posterPath: '/got.jpg' }, 'player ctx -> room item');
    eq(R.partyItem(ctx, true).kind, 'anime', 'an anime-mapped title goes out as anime');
    eq(R.partyItem({ it: { id: 550, title: 'Fight Club' }, kind: 'movie', s: 1, e: 1 }), { tmdbID: 550, kind: 'movie', season: null, episode: null, title: 'Fight Club', posterPath: null }, 'a film has no episode');
    ok(R.sameEpisode(ctx, { ...ITEM, kind: 'anime' }) && R.sameEpisode(ctx, ITEM), 'anime and tv are one TMDB title');
    ok(!R.sameEpisode(ctx, { ...ITEM, episode: 3 }) && !R.sameEpisode(ctx, null), 'another episode');
    ok(R.sameEpisode({ it: { id: 550 }, kind: 'movie', s: 1, e: 1 }, { tmdbID: 550, kind: 'movie', season: null, episode: null }), 'a film ignores s/e');
    eq([R.itemLabel(ITEM), R.itemLabel({ tmdbID: 550, kind: 'movie', title: 'Fight Club' })], ['Game of Thrones · S1 E2', 'Fight Club'], 'labels');
  }
  {
    eq([R.memberInitial('🦊 max'), R.memberInitial('  '), R.memberInitial('🍿'), R.memberInitial('élan')], ['M', '?', '🍿', 'É'], 'initial (P3\'s rule)');
    eq(R.placeholder({ name: 'ann', emoji: '', accentHex: '37e29a' }), { color: '#37e29a', label: 'A', emoji: false }, 'web member: colour + initial');
    eq(R.placeholder({ name: 'Kai', emoji: '🐙', accentHex: '#FF9500' }), { color: '#FF9500', label: '🐙', emoji: true }, 'app member: colour + emoji');
    eq(R.accentCss('red;background:url(x)'), '#5f6b63', 'a colour that isn\'t hex never reaches a style attribute');
    eq(R.avatarSrc('/9j/4AAQSkZJRg=='), 'data:image/jpeg;base64,/9j/4AAQSkZJRg==', 'a JPEG avatar');
    eq([R.avatarSrc('iVBORw0KGgo='), R.avatarSrc('/9j/" onerror="x'), R.avatarSrc('/9j/' + 'A'.repeat(8200)), R.avatarSrc(null)], [null, null, null, null], 'not a JPEG / not base64 / too big');
    eq([R.acceptsAvatar(2, 1), R.acceptsAvatar(2, 2), R.acceptsAvatar(1, 2), R.acceptsAvatar(0, undefined)], [true, true, false, true], 'newest rev wins');
    eq([R.chatText('  hi\u0007there  '), Array.from(R.chatText('😀'.repeat(300))).length, R.chatText('   ')], ['hi there', 280, ''], 'chat clamp (code points)');
    const h = R.voiceHeader(voiceFrame({ t: 'voice', secs: 3.2, mime: 'audio/aac', from: 'm_k', name: 'Kai', at: 5 }));
    eq(h, { secs: 3.2, from: 'm_k', name: 'Kai', at: 5 }, 'voice header');
    eq([R.voiceHeader(new Uint8Array([0x57, 1, 0, 2, 0x7b, 0x7d])), R.voiceHeader(new Uint8Array([0x56, 1, 0, 40]))], [null, null], 'not a voice frame');
    eq(R.voiceText(h), 'Voice clip · 4 s (plays in the app)', 'a voice clip is a line, never played');
    eq([R.closedText('ended'), R.closedText('kicked'), R.closedText('expired'), R.closedText('?')], ['The host ended the party.', 'You were removed from the party.', 'The party expired.', 'The party closed.'], 'closed reasons');
    eq([0, 1, 2, 3, 4, 9].map((a) => R.backoffMs(a)), [1000, 2000, 4000, 8000, 15000, 15000], 'reconnect backoff 1-2-4-8-15 s');
    eq(R.backoffMs(0, 1), 1500, 'plus up to 0.5 s of jitter');
    eq([R.acceptsSeq('state', 5, 5), R.acceptsSeq('state', 6, 5), R.acceptsSeq('roster', 2, 5), R.acceptsSeq('item', 4, 5)], [false, true, true, false], 'seq gate');
    ok(R.DEVICE_RE.test(R.newDeviceId(() => 0.5)) && /^[A-Za-z0-9._-]{1,80}$/.test(R.newDeviceId()), 'device id fits the relay\'s DEVICE_RE');
  }

  // ── 2. The client against a fake WebSocket ──────────────────────────────────────
  {
    const { client, T, WS, s, events, ev } = makeClient();
    client.connect();
    const ws = WS.latest();
    eq([ws.url, client.state.phase], ['wss://watch.example/api/party/XK7Q2M/ws', 'connecting'], 'connects through this Worker');
    ws.open();
    const hello = ws.sent[0];
    eq(Object.keys(hello), ['t', 'v', 'device', 'name', 'emoji', 'accentHex', 'engine', 'platform', 'app'], 'hello fields (no seat yet)');
    eq([hello.t, hello.v, hello.name, hello.emoji, hello.accentHex, hello.engine, hello.platform, hello.app], ['hello', 1, 'Ann', '', '37e29a', 'none', 'web', 'web abc123'], 'hello: profile name, colour without #, no emoji, platform web');
    ok(R.DEVICE_RE.test(hello.device) && s.local.getState().device === hello.device, 'device id kept in localStorage');
    eq(ws.sent[1].t, 'ping', 'a ping right after hello');
    ok(!('companion' in hello), 'never asks to be a companion');
    const item = ITEM;
    ws.recv(welcome(T, { offset: 5000, item, playback: pb0(T.now() + 5000 - 2000, { playing: true, mediaTime: 600, reason: 'user', seq: 3 }) }));
    eq([client.state.phase, client.state.myId, client.state.lastSeq], ['joined', 'm_web', 3], 'welcome -> joined');
    eq(s.seats.getState().seat, { code: 'XK7Q2M', memberId: 'm_web', secret: 's3cret' }, 'the seat is kept for this tab');
    near(client.expected(), 602, 0.05, 'expected time from the welcome clock sample');
    // pong: rtt 20 beats the welcome's assumed 50
    T.advance(100);
    ws.recv({ t: 'pong', c: T.now() - 20, s: T.now() - 10 + 5000 });
    near(client.clock.offset, 5000, 0.5, 'pong -> clock offset');
    ok(client.canControl(), 'shared room: this member controls');
    // seq ordering
    ws.recv({ t: 'state', seq: 5, playback: pb0(client.serverNow(), { playing: true, mediaTime: 700, by: 'm_host', reason: 'user', seq: 5 }) });
    ws.recv({ t: 'state', seq: 4, playback: pb0(client.serverNow(), { mediaTime: 1, seq: 4 }) });
    ws.recv({ t: 'state', seq: 5, playback: pb0(client.serverNow(), { mediaTime: 2, seq: 5 }) });
    eq(client.state.room.playback.mediaTime, 700, 'a state at or below lastSeq is dropped');
    ws.recv({ t: 'roster', seq: 7, members: [...client.state.room.members, member('m_kai', 'Kai')] });
    ws.recv({ t: 'state', seq: 6, playback: pb0(client.serverNow(), { mediaTime: 3, seq: 6 }) });
    eq([client.state.lastSeq, client.state.room.playback.mediaTime], [7, 700], 'roster raises lastSeq; an older state is dropped after it');
    ok(client.state.chat.some((l) => l.kind === 'system' && l.text === 'Kai joined'), 'roster diff -> "Kai joined"');
    ws.recv({ t: 'item', seq: 7, item: { ...ITEM, episode: 9 }, queue: [], by: 'm_host' });
    eq(client.state.room.item.episode, 2, 'an item at or below lastSeq is dropped');
    ws.recv({ t: 'state', seq: 8, playback: pb0(client.serverNow(), { playing: false, mediaTime: 710, by: 'm_host', reason: 'user', seq: 8 }) });
    ok(ev('notice').some((d) => d.text === 'Host paused'), 'someone else\'s pause -> "Host paused"');
    // publish (shared): optimistic + sent with a command id
    ok(client.publish('seek', 1234, { playing: true }), 'a member\'s seek in a shared room is sent');
    const seek = ws.last;
    eq([seek.t, seek.to, seek.playing, typeof seek.c], ['seek', 1234, true, 'string'], 'seek frame with a command id');
    eq([client.state.room.playback.mediaTime, client.state.room.playback.by], [1234, 'm_web'], 'the local mirror moves at once');
    // forbidden -> back to the relay's last word
    ws.recv({ t: 'error', code: 'forbidden', re: 'seek' });
    eq([client.state.room.playback.mediaTime, ev('snapback').pop().toast], [710, 'Only the host can control playback'], 'forbidden -> snap back + toast');
    ws.recv({ t: 'error', code: 'rate_limited', re: 'chat' });
    eq(ev('snapback').length, 1, 'a rate-limited chat is not a snap back');
    // host mode
    ws.recv({ t: 'settings', seq: 9, settings: { control: 'host', everyoneControls: false, waitForStragglers: false, stragglerTimeoutMs: 20000 } });
    ok(ev('notice').some((d) => d.text === 'The host now controls playback'), 'mode change -> toast');
    const sentBefore = ws.sent.length;
    eq([client.canControl(), client.publish('play', 1), client.setItem({ ...ITEM, episode: 4 }, 0), ws.sent.length], [false, false, false, sentBefore], 'host mode: refused locally, nothing sent');
    // host frames: companions keep their role; a null host is accepted
    ws.recv({ t: 'roster', seq: 10, members: [member('m_host', 'Host', 'host'), member('m_web', 'Ann'), member('m_c', 'Cam', 'companion')] });
    ws.recv({ t: 'host', seq: 11, hostId: null, reason: 'migrated' });
    eq([client.state.room.hostId, client.state.room.members.map((m) => m.role)], [null, ['member', 'member', 'companion']], 'host null: nobody hosts, the companion stays one');
    ok(ev('notice').some((d) => /no host/.test(d.text)), 'a hostless room says so');
    // chat, typing, avatars, voice
    ws.recv({ t: 'chat', from: 'm_web', name: 'Ann', text: 'hi', at: 5 });
    ws.recv({ t: 'chat', from: 'm_kai', name: 'Kai', text: '<b>yo</b>', at: 6 });
    eq(client.state.chat.filter((l) => l.kind === 'message').map((l) => [l.name, l.text]), [['You', 'hi'], ['Kai', '<b>yo</b>']], 'chat lines (own echo is "You")');
    ok(client.chat('x'.repeat(400)) && ws.last.text.length === 280, 'outgoing chat clamped to 280');
    ok(!client.chat('   '), 'an empty message is not sent');
    ws.recv({ t: 'typing', from: 'm_kai', name: 'Kai', on: true });
    eq(client.state.typing, ['Kai'], 'typing');
    T.advance(6100);
    eq(client.state.typing, [], 'a lost "off" expires');
    ws.recv({ t: 'avatar', id: 'm_kai', rev: 2, jpeg: '/9j/AAAA' });
    ws.recv({ t: 'avatar', id: 'm_kai', rev: 1, jpeg: '/9j/BBBB' });
    ws.recv({ t: 'avatar', id: 'm_x', rev: 1, jpeg: 'PHN2Zz4=' });
    eq([client.state.avatars.m_kai.src, client.state.avatars.m_x], ['data:image/jpeg;base64,/9j/AAAA', undefined], 'avatars: newest rev, JPEG only');
    ws.recv(voiceFrame({ t: 'voice', secs: 4, mime: 'audio/aac', from: 'm_kai', name: 'Kai', at: 9 }));
    ws.recv(voiceFrame({ t: 'voice', secs: 2, mime: 'audio/aac', from: 'm_kai', name: 'Kai', at: 9 }).buffer);
    eq(client.state.chat.filter((l) => l.kind === 'voice').map((l) => l.text), ['Voice clip · 4 s (plays in the app)', 'Voice clip · 2 s (plays in the app)'], 'binary voice frames -> lines (Uint8Array or ArrayBuffer)');
    // pings: two unanswered -> reconnect, resuming the seat
    const pingsBefore = ws.of('ping').length;
    T.advance(3800); T.advance(10000);   // the welcome was 6.2 s ago: pings at 10 s and 20 s
    eq(ws.of('ping').length, pingsBefore + 2, 'a ping every 10 s');
    T.advance(10000);
    eq(client.state.phase, 'reconnecting', 'two silent pings: the socket is gone');
    T.advance(999);
    eq(WS.all.length, 1, 'backoff: not before 1 s');
    T.advance(1);
    const ws2 = WS.latest();
    ok(ws2 !== ws, 'reconnect after 1 s');
    ws2.open();
    eq([ws2.sent[0].memberId, ws2.sent[0].secret], ['m_web', 's3cret'], 'resume: memberId + secret from sessionStorage');
    ws2.recv(welcome(T, { seq: 20 }));
    eq([client.state.phase, ev('welcome').pop().reconnected, ws2.of('sync').length], ['joined', true, 1], 'sync after a reconnect');
    client.visible();
    eq([ws2.of('ping').length, ws2.of('sync').length], [2, 2], 'back to the front: ping + sync');
    // never the frames the web must not send
    const sentTypes = new Set([...ws.sent, ...ws2.sent].map((m) => m.t));
    ok(!['settings', 'transferHost', 'kick', 'end', 'role', 'avatar'].some((t) => sentTypes.has(t)) && ws.binary === 0 && ws2.binary === 0, 'never settings/transferHost/kick/end/role/avatar or a binary frame');
    // leave
    client.leave();
    eq([ws2.last.t, ws2.closed && ws2.closed.code, client.state.phase, s.seats.getState().seat], ['leave', 1000, 'left', null], 'leave: frame, close, seat dropped');
    T.advance(30000);
    eq(WS.all.length, 2, 'no reconnect after leaving');
    ok(events.some((e) => e[0] === 'closed' && e[1].text === 'You left the party.'), 'left -> closed event');
  }
  {
    // closed / kicked / give up / bad_hello / dead room
    const a = makeClient();
    a.client.connect(); a.WS.latest().open(); a.WS.latest().recv(welcome(a.T));
    a.WS.latest().recv({ t: 'closed', reason: 'ended' });
    eq([a.client.state.phase, a.client.state.failure, a.s.seats.getState().seat], ['left', 'The host ended the party.', null], 'closed -> leaves');
    a.T.advance(20000);
    eq(a.WS.all.length, 1, 'no reconnect after closed');
    const k = makeClient();
    k.client.connect(); k.WS.latest().open(); k.WS.latest().recv(welcome(k.T));
    k.WS.latest().drop(4003);
    eq([k.client.state.phase, k.client.state.failure], ['left', 'You were removed from the party.'], 'close 4003 -> kicked');
    const g = makeClient();
    g.client.connect();
    const at = [];
    for (let i = 0; i < 10 && g.client.state.phase !== 'failed'; i++) { const w = g.WS.latest(); at.push(g.T.now()); w.drop(); g.T.advance(15000); }
    const t0 = at[0];
    eq(at.map((x) => x - t0).slice(0, 4), [0, 15000, 30000, 45000], 'retries keep coming');
    eq([g.client.state.phase, g.client.state.failure], ['failed', 'Lost the party connection.'], 'gives up a minute after the first drop');
    const w8 = makeClient();
    w8.client.connect(); w8.WS.latest().open();
    w8.T.advance(10000);
    eq(w8.client.state.phase, 'reconnecting', 'no welcome in 10 s -> retry');
    const st = stores();
    st.seats.setState({ seat: { code: 'XK7Q2M', memberId: 'm_old', secret: 'stale' } });
    const b = makeClient({ stores: st });
    b.client.connect(); b.WS.latest().open();
    eq(b.WS.latest().sent[0].memberId, 'm_old', 'a kept seat is offered');
    b.WS.latest().recv({ t: 'error', code: 'bad_hello' });
    const fresh = b.WS.latest();
    fresh.open();
    eq([b.WS.all.length, fresh.sent[0].memberId, st.seats.getState().seat], [2, undefined, null], 'bad_hello on a kept seat -> joins fresh, once');
    fresh.recv({ t: 'error', code: 'bad_hello' });
    eq([b.client.state.phase, b.client.state.failure], ['left', 'Couldn\'t join the party.'], 'a second bad_hello leaves');
    const peeks = [];
    const d = makeClient({ peek: async () => { peeks.push(1); return 404; } });
    d.client.connect(); d.WS.latest().open(); d.WS.latest().recv(welcome(d.T));
    d.WS.latest().drop(); d.T.advance(1000); d.WS.latest().drop();
    await flush();
    eq([peeks.length, d.client.state.phase, d.client.state.failure], [1, 'left', 'The party has ended.'], 'a room gone while away: the peek says 404 -> ended');
    const f = makeClient();
    f.client.connect(); f.WS.latest().open(); f.WS.latest().recv(welcome(f.T, { hostId: null }));
    eq([f.client.state.room.hostId, f.client.canControl()], [null, true], 'a welcome with no host is accepted');
    f.WS.latest().recv({ t: 'error', code: 'full' });
    eq(f.client.state.failure, 'That party is full.', 'full');
    // A relay from before Wave 7: settings without `control`, members without platform / avatarRev.
    const old = makeClient();
    old.client.connect(); old.WS.latest().open();
    const bare = ({ platform, avatarRev, ...m }) => m;
    old.WS.latest().recv(welcome(old.T, { settings: { everyoneControls: true, waitForStragglers: false, stragglerTimeoutMs: 20000 },
      members: [bare(member('m_host', 'Host', 'host')), bare(member('m_web', 'Ann'))] }));
    eq([old.client.state.phase, old.client.canControl(), R.controlMode(old.client.state.room.settings)], ['joined', true, 'shared'], 'old relay: everyoneControls true reads as shared');
    ok(membersHTML(old.client.state).includes('Host'), 'old relay: members without platform / avatarRev render');
    old.WS.latest().recv({ t: 'settings', seq: 4, settings: { everyoneControls: false, waitForStragglers: false, stragglerTimeoutMs: 20000 } });
    eq([old.client.canControl(), old.ev('notice').pop().text], [false, 'The host now controls playback'], 'old relay: the lock is the host mode');
    ok(joinPageHTML('XK7Q2M', { item: null, memberCount: 1, hostName: 'H', everyoneControls: false, members: [{ name: 'H', emoji: '', accentHex: '#fff' }] }).includes('The host controls playback'), 'old relay peek: everyoneControls false -> host line');
    const v = makeClient();
    v.client.connect(); v.WS.latest().open(); v.WS.latest().recv(welcome(v.T));
    v.client.close();
    eq(v.client.state.phase, 'reconnecting', 'page hide keeps the seat, closes the socket');
    v.client.visible();
    v.WS.latest().open();
    eq([v.WS.all.length, v.WS.latest().sent[0].memberId], [2, 'm_web'], 'back from the cache: resumes the seat');
  }

  // ── 3. The binder against a fake <video> ───────────────────────────────────────
  {
    const T = fakeTimers();
    const { client, WS } = makeClient({ T });
    client.connect(); const ws = WS.latest(); ws.open();
    const P = makeBinder(client, T);
    ws.recv(welcome(T, { item: ITEM, playback: pb0(T.now() - 10000, { playing: true, mediaTime: 600, reason: 'user', by: 'm_host', seq: 3 }) }));
    ok(P.binder.route(), 'joiner: routed to the room\'s item');
    const p0 = P.plays[0];
    eq([p0.it.id, p0.it.name, p0.kind, p0.s, p0.e], [1399, 'Game of Thrones', 'tv', 1, 2], 'play(it, kind, s, e)');
    near(p0.at, 610, 0.1, 'starts at the room\'s expected time, not its own resume point');
    T.advance(2000);
    near(P.session.momentAt, 612, 0.1, 'before the first frame the start point tracks the group clock');
    eq(P.binder.phase, 'aligning', 'aligning');
    P.start(605);   // the resume seek landed 7 s short
    P.binder.tick();
    near(P.seeks[0], 612.15, 0.05, 'first frame: a hard seek to expected + 0.15');
    eq([ws.of('seek').length, P.binder.phase], [0, 'catchingUp'], 'the binder\'s own seek is not published');
    P.v.emit('seeking');
    T.advance(400);
    eq(ws.of('seek').length, 0, 'its seeking echo is masked');
    T.advance(1500);   // settle
    P.v.currentTime = client.expected() + 1;
    P.binder.tick();
    eq([P.v.playbackRate, P.binder.phase], [0.95, 'inSync'], '1 s ahead: a 5 % nudge, still in sync');
    P.v.emit('ratechange');
    T.advance(10);
    eq(ws.of('rate').length, 0, 'the nudge\'s ratechange is masked');
    P.v.currentTime = client.expected(); P.binder.tick();
    eq(P.v.playbackRate, 1, 'back in the dead zone: the nudge is cleared');
    P.v.paused = true; P.v.emit('pause');
    eq(ws.of('pause').length, 0, 'still inside 2 s of the first frame: not the viewer\'s');
    P.v.paused = false; T.advance(200);
    // the viewer pauses (native controls), allowed in a shared room
    P.v.paused = true; P.v.emit('pause');
    const pz = ws.of('pause').pop();
    ok(pz && pz.at > 600 && typeof pz.c === 'string', 'a viewer pause is published');
    const r1 = ws.of('report').pop();
    eq([r1.engine, r1.playing], ['av', false], 'and reported at once');
    // the player's own commands within 2 s of a first frame are not published
    P.start(client.expected());
    const before = ws.sent.length;
    P.v.paused = true; P.v.emit('pause'); P.v.paused = false; P.v.emit('play');
    eq(ws.sent.filter((m, i) => i >= before && (m.t === 'pause' || m.t === 'play')).length, 0, 'align window: the player\'s own start-up moves stay local');
    T.advance(2100);
    // reports: on change at once, else every 5 s while playing
    ws.recv({ t: 'state', seq: 30, playback: pb0(client.serverNow(), { playing: true, mediaTime: client.expected(), by: 'm_host', reason: 'user', seq: 30 }) });
    const nReports = ws.of('report').length;
    T.advance(5100);
    ok(ws.of('report').length > nReports, 'a report every 5 s while playing');
    const rep = ws.of('report').pop();
    eq(Object.keys(rep), ['t', 'pos', 'dur', 'playing', 'buffering', 'engine', 'synced'], 'report fields');
    eq([rep.engine, rep.playing, rep.dur], ['av', true, 3600], 'report values');
    // the viewer scrubs: debounced, published where it lands
    P.v.currentTime += 300; P.v.emit('seeking');
    P.v.currentTime += 20; P.v.emit('seeking');
    const landed = P.v.currentTime;
    T.advance(350);
    eq(ws.of('seek').length, 1, 'a scrub is one seek…');
    near(ws.of('seek')[0].to, landed, 0.01, '…where it landed');
    // The engine clamps the binder's correction (not buffered that far yet): its echo is still the binder's.
    T.advance(1600);
    P.seekEnd = client.expected() - 10;
    P.v.currentTime = client.expected() - 30;
    P.binder.tick();
    near(P.v.currentTime, client.expected() - 10, 0.05, 'the engine clamped the binder\'s seek');
    P.v.emit('seeking'); T.advance(400);
    eq(ws.of('seek').length, 1, 'a clamped landing is masked, not published as the viewer\'s');
    P.seekEnd = Infinity; T.advance(2600);
    // host mode: refused locally, snapped back
    ws.recv({ t: 'settings', seq: 31, settings: { control: 'host', everyoneControls: false, waitForStragglers: false } });
    T.advance(1100);
    P.v.currentTime += 500; P.v.emit('seeking');
    T.advance(350);
    eq([ws.of('seek').length, P.toasts.pop().text], [1, 'Only the host can control playback'], 'host mode: a native-control seek is refused with the toast');
    near(P.v.currentTime, client.expected() + 0.15, 0.3, '…and snapped back to the room\'s clock');
    const seeksBefore = P.seeks.length;
    P.seekTo(client.expected() + 900);   // keys / skip button / converter bar
    eq([P.seeks.length, P.toasts.pop().text], [seeksBefore, 'Only the host can control playback'], 'player.seekTo is refused before anything moves');
    P.v.paused = true; P.v.emit('pause');
    eq([ws.of('pause').length, P.v.paused], [1, false], 'a refused pause plays on');
    eq(P.binder.holdsEnd(), true, 'host mode: the end of the file waits for the room');
    eq(P.toasts.pop().text, 'Up next when the host continues', '…and says so');
    // another title while in host mode -> back to the room's
    P.session.ctx = { it: { id: 550, title: 'Fight Club' }, kind: 'movie', s: 1, e: 1 };
    P.binder.tick();
    eq([P.plays.length, P.plays[P.plays.length - 1].it.id, ws.of('setItem').length], [2, 1399, 0], 'host mode: another title goes back to the room\'s');
    // embed
    P.session.cur = 'vidlink'; P.binder.tick();
    eq([P.binder.phase, ws.of('report').pop().engine, statusText(client.state, P.binder.phase)], ['embed', 'embed', 'Not synced'], 'embed: reported, "Not synced"');
    // autoplay refused by the browser
    P.start(client.expected());
    T.advance(2100);
    P.v.paused = true;
    P.v.playResult = Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' }));
    P.binder.tick();
    await flush();
    const ap = P.toasts.find((t) => t.o && t.o.id === 'party-autoplay');
    ok(ap && ap.o.action === 'Play', 'autoplay blocked -> a tap-to-play toast');
    // relay forbidden on an optimistic command -> snap back
    ws.recv({ t: 'settings', seq: 32, settings: { control: 'shared', everyoneControls: true, waitForStragglers: false } });
    P.v.playResult = null; P.v.paused = false; T.advance(1100);
    P.v.currentTime += 200; P.v.emit('seeking'); T.advance(350);
    ws.recv({ t: 'error', code: 'forbidden', re: 'seek' });
    P.binder.snapBack('Only the host can control playback');
    near(P.v.currentTime, client.expected() + 0.15, 0.3, 'relay forbidden: back to the room\'s clock');
    P.binder.detach();
    eq(P.session.party, null, 'detach removes the player hooks');
  }
  {
    // kick-off + converter settle
    const T = fakeTimers();
    const { client, WS } = makeClient({ T });
    client.connect(); const ws = WS.latest(); ws.open();
    ws.recv(welcome(T, { item: null }));
    const P = makeBinder(client, T);
    P.session.ctx = { it: { id: 550, title: 'Fight Club', poster_path: '/fc.jpg' }, kind: 'movie', s: 1, e: 1 };
    P.binder.tick();
    eq(ws.of('setItem').map((m) => m.item), [{ tmdbID: 550, kind: 'movie', season: null, episode: null, title: 'Fight Club', posterPath: '/fc.jpg' }], 'empty room + control: what we play becomes the room\'s item');
    ok(client.shouldKickOff(), 'the room waits for our first frame');
    P.start(0);
    P.binder.tick();
    eq([ws.of('play').length, ws.of('play')[0].at], [1, 0], 'kick-off: our first frame starts the group');
    eq(P.binder.holdsEnd(), false, 'shared + empty queue: Up Next may run (it becomes the room\'s item)');
    // converter: an 8 s settle between seeks
    P.session.vt = { baseOffset: 0 };
    ws.recv({ t: 'state', seq: 9, playback: pb0(client.serverNow(), { playing: true, mediaTime: 1000, by: 'm_host', reason: 'user', seq: 9 }) });
    P.v.currentTime = 10; P.binder.tick();
    const n1 = P.seeks.length;
    T.advance(7000); P.v.currentTime = 20; P.binder.tick();
    eq(P.seeks.length, n1, 'converter: no second seek inside 8 s');
    T.advance(1100); P.v.currentTime = 30; P.binder.tick();
    eq(P.seeks.length, n1 + 1, '…then it corrects again');
    P.binder.detach();
  }

  // ── 4. Renderers: everything another member sends is escaped ────────────────────
  {
    const evil = '<img src=x onerror=alert(1)>';
    const html = joinPageHTML('XK7Q2M', { item: { ...ITEM, title: evil }, hostName: evil, memberCount: 2, control: 'host',
      members: [{ name: evil, emoji: '', accentHex: 'zz;"', avatar: '/9j/AAAA' }, { name: 'Kai', emoji: '🐙', accentHex: '#FF9500' }] });
    ok(!html.includes('<img src=x') && html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'join page escapes titles and names');
    ok(html.includes('data:image/jpeg;base64,/9j/AAAA') && html.includes('🐙') && html.includes('The host controls playback') && html.includes('data-act="party-join" data-code="XK7Q2M"'), 'join page: photo, emoji placeholder, control line, Join');
    ok(html.includes('background:#5f6b63'), 'a bad colour falls back to grey');
    ok(joinPageHTML('XK7Q2M', null, { error: 'gone' }).includes('gone') && !joinPageHTML('XK7Q2M', null, { error: 'gone' }).includes('party-join'), 'an ended party has no Join');
    const st = { myId: 'm_web', avatars: { m_kai: { src: 'data:image/jpeg;base64,/9j/AA' } }, typing: [], phase: 'joined',
      room: { hostId: 'm_host', settings: { control: 'shared' }, playback: pb0(1), item: ITEM, queue: [],
              members: [member('m_web', 'Ann'), member('m_kai', evil, 'member', { synced: true }), member('m_host', 'Host', 'host', { engine: 'embed' })] } };
    const mh = membersHTML(st);
    ok(!mh.includes('<img src=x') && mh.indexOf('Host') < mh.indexOf('Ann') && mh.includes('(you)') && mh.includes('Not synced') && mh.includes('In sync'), 'members: escaped, host first, chips');
    const ch = chatHTML([{ id: 1, kind: 'message', from: 'm_kai', name: evil, text: evil }, { id: 2, kind: 'voice', from: 'm_kai', name: 'Kai', text: 'Voice clip · 3 s (plays in the app)' }, { id: 3, kind: 'system', text: 'Kai joined' }], 'm_web');
    ok(!ch.includes('<img src=x') && ch.includes('🎙') && ch.includes('Kai joined'), 'chat: escaped; voice and system lines');
    eq([statusText({ ...st, phase: 'reconnecting' }, 'inSync'), statusText(st, 'catchingUp'), statusText({ ...st, room: { ...st.room, item: null } }, 'unbound')], ['Reconnecting…', 'Catching up', 'Waiting for a pick'], 'status line');
  }

  // ── 5. The Worker: /api/party routes and the /p/ redirect ───────────────────────
  {
    const calls = [];
    const relay = { fetch: async (req) => { calls.push(req); return relay.answer(req); }, answer: () => new Response(JSON.stringify({ code: 'XK7Q2M', memberCount: 2 }), { status: 200 }) };
    const env = { SLIME_TOKEN: 'tok', RELAY: relay };
    const call = (path, init = {}, e = env) => partyRoutes(new Request('https://watch.example' + path, init), e, new URL('https://watch.example' + path));
    let r = await call('/api/party/xk7q2m?avatars=1', { headers: { 'cf-connecting-ip': '1.2.3.4', cookie: 'sw_auth=abc' } });
    const peekReq = calls.pop();
    eq([r.status, (await r.json()).memberCount, r.headers.get('x-web-build'), r.headers.get('cache-control')], [200, 2, BUILD_ID, 'no-store'], 'peek proxied (this build in x-web-build)');
    eq([peekReq.url, peekReq.headers.get('authorization'), peekReq.headers.get('cf-connecting-ip'), peekReq.headers.get('cookie')],
      ['https://relay.internal/party/XK7Q2M?avatars=1', 'Bearer tok', '1.2.3.4', null], 'peek: token added, ?avatars=1 passed, the visitor\'s IP, never the cookie');
    await call('/api/party/XK7Q2M?avatars=yes');
    eq(calls.pop().url, 'https://relay.internal/party/XK7Q2M', 'only avatars=1 passes');
    eq([(await call('/api/party/XK7Q2O')).status, (await call('/api/party/ABC')).status, (await call('/api/party/')).status], [400, 400, 404], 'a bad code -> 400');
    eq((await call('/api/party/XK7Q2M', { method: 'POST' })).status, 405, 'POST -> 405');
    eq((await call('/api/party/XK7Q2M', {}, { RELAY: relay })).status, 503, 'no token -> 503');
    relay.answer = () => new Response('{"error":"unauthorized"}', { status: 401 });
    r = await call('/api/party/XK7Q2M');
    eq([r.status, (await r.json()).error], [502, 'party-unauthorized'], 'relay 401 -> 502, never a 401');
    relay.answer = () => new Response('{"error":"not found"}', { status: 404 });
    eq((await call('/api/party/XK7Q2M')).status, 404, 'relay 404 passes through');
    relay.answer = () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); };
    eq((await call('/api/party/XK7Q2M')).status, 504, 'timeout -> 504');
    relay.answer = () => { throw new Error('down'); };
    eq((await call('/api/party/XK7Q2M')).status, 502, 'unreachable -> 502');
    const realFetch = globalThis.fetch;
    try {
      let target = null;
      globalThis.fetch = async (u, init) => { target = [String(u), new Headers(init.headers).get('authorization')]; return new Response('{"code":"XK7Q2M"}'); };
      await call('/api/party/XK7Q2M', {}, { SLIME_TOKEN: 'tok', RELAY_BASE: 'https://relay.example/' });
      eq(target, ['https://relay.example/party/XK7Q2M', 'Bearer tok'], 'no binding: RELAY_BASE');
    } finally { globalThis.fetch = realFetch; }
    // the socket
    const answer = { relaysAnswer: true };
    relay.answer = () => answer;
    const wsHeaders = { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZQ==', 'sec-websocket-version': '13',
      cookie: 'sw_auth=abc', 'cf-connecting-ip': '5.6.7.8', origin: 'https://watch.example' };
    r = await call('/api/party/xk7q2m/ws', { headers: wsHeaders });
    const wsReq = calls.pop();
    ok(r === answer, 'the relay\'s answer (101 + socket) is returned as is');
    eq([wsReq.url, wsReq.headers.get('upgrade'), wsReq.headers.get('authorization'), wsReq.headers.get('cf-connecting-ip'), wsReq.headers.get('sec-websocket-key'), wsReq.headers.get('cookie')],
      ['https://relay.internal/party/XK7Q2M/ws', 'websocket', 'Bearer tok', '5.6.7.8', 'dGhlIHNhbXBsZQ==', null], 'ws: upgrade + Authorization + cf-connecting-ip forwarded, cookie not');
    eq((await call('/api/party/XK7Q2M/ws', { headers: { ...wsHeaders, upgrade: '' } })).status, 426, 'not an upgrade -> 426');
    eq((await call('/api/party/XK7Q2M/ws', { headers: { ...wsHeaders, origin: 'https://evil.example' } })).status, 403, 'another site\'s page -> 403');
    eq((await call('/api/party/XK7Q2O/ws', { headers: wsHeaders })).status, 400, 'ws bad code -> 400');

    // Through the real Worker: behind the gate, and the /p/ redirect.
    const wenv = { SITE_PASSWORD: 'pw', SESSION_SECRET: 'sec', RELAY_BASE: 'https://relay.example/', SLIME_TOKEN: 'tok', RELAY: relay };
    const W = (path, init = {}, e = wenv) => worker.fetch(new Request('https://watch.example' + path, { redirect: 'manual', ...init }), e);
    const login = await W('/login', { method: 'POST', body: new URLSearchParams({ password: 'pw' }) });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    relay.answer = () => new Response('{"code":"XK7Q2M"}', { status: 200 });
    r = await W('/api/party/XK7Q2M');
    eq([r.status, r.headers.get('location')], [302, '/login'], '/api/party is behind the gate');
    eq((await W('/api/party/XK7Q2M', { headers: { cookie } })).status, 200, '…and answers when signed in');
    r = await W('/api/party/XK7Q2M/ws', { headers: { upgrade: 'websocket' } });
    eq(r.status, 302, 'the socket is behind the gate too');
    relay.answer = () => answer;
    ok((await W('/api/party/XK7Q2M/ws', { headers: { cookie, upgrade: 'websocket' } })) === answer, 'signed-in socket reaches the relay');
    const loc = async (path, headers = {}, e = wenv) => { const x = await W(path, { headers }, e); return [x.status, x.headers.get('location'), x.headers.get('cache-control')]; };
    eq(await loc('/p/xk7q2m'), [302, 'https://relay.example/p/XK7Q2M', 'no-store'], '/p/ signed out -> the relay\'s page');
    eq((await loc('/p/XK7Q2M/?utm=a'))[1], 'https://relay.example/p/XK7Q2M?utm=a', 'query kept');
    eq(await loc('/p/xk7q2m', { cookie }), [302, '/#party/XK7Q2M', 'no-store'], '/p/ signed in -> #party/<CODE>');
    eq((await loc('/p/XK7Q2M?companion=1', { cookie }))[1], 'https://relay.example/p/XK7Q2M?companion=1', 'companion=1 -> the relay\'s app-first page, even signed in');
    eq((await loc('/p/XK7Q2M?companion=1'))[1], 'https://relay.example/p/XK7Q2M?companion=1', 'companion=1 signed out too');
    eq((await loc('/p/XK7Q2M?companion=0', { cookie }))[1], '/#party/XK7Q2M', 'only companion=1 counts');
    eq((await loc('/p/XK7Q2O'))[1], '/login', 'a bad code: unchanged (the gate)');
    eq((await W('/p/XK7Q2O', { headers: { cookie } })).status, 200, 'a bad code signed in: unchanged (the app)');
    const noBase = { ...wenv, RELAY_BASE: '' };
    eq([(await loc('/p/XK7Q2M', {}, noBase))[1], (await loc('/p/XK7Q2M', { cookie }, noBase))[1]], ['/login', '/#party/XK7Q2M'], 'no RELAY_BASE: the gate as before, signed in still joins');
    r = await W('/login', { method: 'POST', body: new URLSearchParams({ password: 'pw', next: '#party/XK7Q2M' }) });
    eq(r.headers.get('location'), '/#party/XK7Q2M', 'the relay page\'s "Watch in the browser" lands back after login');
  }

  // ── 6. The web client's rules through the relay's real reducer ──────────────────
  {
    // relay/package.json has no "type": node warns once that it re-parsed the
    // reducer as a module. True and harmless here: keep the gate's output clean.
    const emit = process.emitWarning;
    process.emitWarning = function (w, ...rest) { if (!/Module type of .*party-reducer/.test(String((w && w.message) || w))) return emit.call(this, w, ...rest); };
    let red;
    try { red = await import('../../relay/src/party-reducer.js'); } finally { process.emitWarning = emit; }
    let s = red.fresh({ code: 'XK7Q2M', now: 1000, host: { id: 'm_host', name: 'Host', platform: 'ios', secret: 'hs' } });
    const step = (msg, from, now) => { const r = red.reduce(s, msg, { now, from }); s = r.state; return r.effects; };
    step({ t: 'member:hello', member: { id: 'm_host', name: 'Host', secret: 'hs', platform: 'ios' } }, 'm_host', 1100);
    const T = fakeTimers(2000);
    const { client, WS } = makeClient({ T });
    client.connect(); const ws = WS.latest(); ws.open();
    const h = ws.sent[0];
    let fx = step({ t: 'member:hello', member: { id: 'm_web', device: h.device, name: h.name, emoji: h.emoji, accentHex: h.accentHex, engine: h.engine, platform: h.platform }, newSecret: 'ws' }, 'm_web', T.now());
    // What the DO would put on the browser's socket: to it, to all, or to the others of someone else's frame.
    const deliver = (effects, from = 'm_web') => { for (const e of effects) if (e.msg && (e.to === 'm_web' || e.to === 'all' || (e.to === 'others' && from !== 'm_web'))) ws.recv(e.msg); };
    deliver(fx);
    const me = client.me();
    eq([client.state.phase, me.role, me.platform, s.settings.control], ['joined', 'member', 'web', 'shared'], 'reducer: the browser is an ordinary member of a shared room');
    ok(client.canControl(), 'web rules agree: may control');
    client.publish('pause', 42);
    fx = step(ws.last, 'm_web', T.now());
    const st = fx.find((e) => e.msg && e.msg.t === 'state');
    ok(st && st.to === 'all' && st.msg.playback.by === 'm_web' && st.msg.playback.mediaTime === 42, 'reducer accepts the web\'s pause in a shared room');
    deliver(fx);
    eq(client.state.room.playback.seq, st.msg.playback.seq, 'the echo becomes the reference');
    deliver(step({ t: 'settings', everyoneControls: false }, 'm_host', T.now()), 'm_host');
    eq([s.settings.control, client.canControl()], ['host', false], 'old-style settings frame -> host mode; web rules agree');
    ok(!client.publish('play', 42), 'refused locally first');
    // A stale client sends anyway:
    fx = step({ t: 'seek', to: 900, playing: false, c: 'x1' }, 'm_web', T.now());
    eq(fx.map((e) => e.msg && e.msg.t), ['error', 'state'], 'reducer: forbidden + the state to snap back');
    client.state.room.playback = { ...client.state.room.playback, mediaTime: 900 };
    deliver(fx);
    eq(client.state.room.playback.mediaTime, 42, 'the web snaps back to the relay\'s clock');
    fx = step({ t: 'leave' }, 'm_host', T.now());
    deliver(fx, 'm_host');
    eq([s.hostId === 'm_web', client.state.room.hostId], [false, null], 'the host leaves: the relay never hands the browser the room (host null)');
  }

  // ── 7. The page itself (views/party.js) over a minimal DOM ───────────────────────
  {
    const dom = miniDom();
    const keep = ['document', 'location', 'fetch', 'WebSocket'].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
    const keepStores = ['localStorage', 'sessionStorage'].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
    const keepSession = { ctx: playerSession.ctx, cur: playerSession.cur, vt: playerSession.vt, party: playerSession.party };
    const WS = fakeSocketClass();
    const def = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
    try {
      def('document', dom.document); def('WebSocket', WS);
      def('location', { hash: '#party/XK7Q2M', protocol: 'https:', host: 'watch.example', href: '' });
      def('localStorage', memoryStorage()); def('sessionStorage', memoryStorage());
      def('fetch', async () => new Response(JSON.stringify({ code: 'XK7Q2M', item: null, memberCount: 1, hostName: 'Host', control: 'shared', everyoneControls: true,
        members: [{ name: 'Host', emoji: '🐙', accentHex: '#FF9500', role: 'host', platform: 'tvos', avatarRev: 0 }] }), { headers: { 'content-type': 'application/json', 'x-web-build': 'b123' } }));
      Object.assign(playerSession, { ctx: null, cur: '', vt: null, party: null });   // the player is closed
      let clickHandler = null;
      initActions({ addEventListener: (t, f) => { clickHandler = f; } });
      const click = (dataset) => clickHandler({ target: { closest: () => ({ dataset }) } });

      await viewParty('xk7q2m');
      const join = dom.get('party-page').innerHTML;
      ok(join.includes('data-act="party-join" data-code="XK7Q2M"') && join.includes('<b>Host</b> is hosting') && join.includes('🐙') && join.includes('Everyone can control playback'), 'join page from the peek');
      click({ act: 'party-join', code: 'XK7Q2M' });
      const ws = WS.latest();
      eq(ws && ws.url, 'wss://watch.example/api/party/XK7Q2M/ws', 'Join opens the room socket through this Worker');
      ok(dom.get('player').classList.contains('partyon') && dom.get('ppanel') && dom.get('pparty') && dom.get('preact'), 'the party panel, badge and reaction layer are mounted on the player');
      ok(dom.get('party-page').innerHTML.includes('WATCH PARTY · XK7Q2M') && dom.get('pp-lob-in'), 'the lobby replaces the join page');
      ok(typeof playerSession.party.seekIntent === 'function', 'the binder hooks player.seekTo');
      ws.open();
      eq([ws.sent[0].platform, ws.sent[0].app, ws.sent[0].emoji, typeof ws.sent[0].name], ['web', 'web b123', '', 'string'], 'hello: platform web, this build (from the peek), no emoji');
      ws.recv(welcome({ now: () => Date.now() }, { item: null }));
      await sleep(40);
      ok(dom.toasts().some((t) => /waiting for someone to pick/.test(t)), 'joined an empty room: says so');
      ok(dom.get('pp-lob-members').innerHTML.includes('(you)') && dom.get('pp-pl-members').innerHTML.includes('Host'), 'who\'s here, in the lobby and beside the player');
      eq(dom.get('plob-status').textContent, 'Waiting for a pick · Everyone can control playback', 'status line');
      ws.recv({ t: 'chat', from: 'm_host', name: 'Host', text: '<script>x</script> hi', at: Date.now() });
      await sleep(40);
      ok(dom.get('pp-pl-chat').innerHTML.includes('&lt;script&gt;x&lt;/script&gt; hi') && !dom.get('pp-lob-chat').innerHTML.includes('<script>'), 'chat lands escaped in both panels');
      click({ act: 'party-react', emoji: '🔥' });
      eq(ws.last, { t: 'react', emoji: '🔥' }, 'a reaction button sends react');
      const input = dom.get('pp-lob-in');
      input.value = 'hello';
      input.listeners.keydown[0]({ key: 'Enter', isComposing: false, preventDefault() {} });
      eq([ws.of('chat').pop(), input.value], [{ t: 'chat', text: 'hello' }, ''], 'Enter in the composer sends the message');
      ws.recv({ t: 'item', seq: 9, item: ITEM, queue: [], by: 'm_host' });
      await sleep(40);
      ok(dom.toasts().some((t) => t === 'Host picked Game of Thrones · S1 E2'), 'a pick while the player is closed: a Watch toast, nothing opens');
      eq(playerSession.ctx, null, '…and the player stays closed');
      location.hash = '#home';
      ws.recv({ t: 'typing', from: 'm_host', name: 'Host', on: true });
      await sleep(40);
      ok(dom.get('ppill') && /Party XK7Q2M · 2/.test(dom.get('ppill').textContent), 'browsing elsewhere: the party pill');
      click({ act: 'party-panel' });
      ok(dom.get('player').classList.contains('partyhide'), 'the badge hides the panel');
      click({ act: 'party-leave' });
      await sleep(10);
      eq([ws.of('leave').length, !!dom.get('ppanel'), dom.get('player').classList.contains('partyon'), !!dom.get('ppill'), playerSession.party],
        [1, false, false, false, null], 'Leave: leave frame, panel / pill / hooks gone');
      ok(dom.toasts().some((t) => t === 'You left the party.'), '"You left the party."');
    } finally {
      for (const [k, d] of [...keep, ...keepStores]) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
      Object.assign(playerSession, keepSession);
    }
  }
  return n;
}
