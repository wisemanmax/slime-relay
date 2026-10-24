// Watch Party room logic — PURE: no I/O, no clock, no randomness. The PartyRoom
// Durable Object (party.js) owns the sockets, storage and time, and hands every
// event to reduce(state, msg, { now, from }) → { state, effects }.
//
// Why pure: a hibernating Durable Object loses its memory between messages
// (the sockets stay open), so a room can't keep timers or closures. Every
// decision has to be a function of the stored state, one message and `now` —
// which also makes the whole protocol testable in plain node
// (test/party-reducer.mjs).
//
// Playback is an ANCHOR, not a ticking clock: mediaTime (seconds) was the
// position at serverTimeAtUpdate (server ms), advancing at `rate` while playing.
// Clients extrapolate with expectedTime() plus their ping-measured clock offset,
// so the server never ticks. Every state change bumps the room-wide `seq`;
// playback.seq is the seq of the last playback change, so a client can drop a
// state older than the one it already applied.
//
// Effects the DO carries out, in order:
//   { to: 'all' | 'others' | <memberId>, msg }   send (others = all but the sender's socket)
//   { close: <memberId> | '*', code, reason }     close those sockets
//   { alarm: <epoch ms> }                         make sure the DO wakes by then
//   { avatarPut: <memberId>, jpeg }               store that member's avatar (party-avatar.js avatarKey)
//   { avatarDrop: <memberId> }                    delete it (the member left / was kicked / swept)
//   { avatarsTo: <memberId>, avatars: [{id, rev}] } send {t:'avatar', id, rev, jpeg} for each stored one
//
// Roles (Wave 7): 'host' · 'member' · 'companion'. A companion (hello
// companion:true on a NEW seat — an iPhone next to the TV) chats, reacts and
// talks but never plays: its controls are refused, its report/ready dropped,
// the straggler wait never sees it, and it is never made host. Nor is a member
// whose platform is 'web' (the browser can't hold a room together).
//
// Client → server messages (msg.t) and who may send them:
//   play {at, c} · pause {at, c} · seek {to, playing, c} · rate {rate, c}
//   setItem {item, startAt} · queue {op:'add'|'remove'|'playNext', item?, index?}
//                    controllers: the host, or any non-companion while settings.control is 'shared'
//   report {pos, dur, playing, buffering, engine, synced} · ready {}   any non-companion
//   chat {text} · react {emoji} · typing {on} · leave {} · avatar {jpeg}   any member
//   role {role:'member'}                                       a companion ("Watch along")
//   settings {control?, everyoneControls?, waitForStragglers?} · transferHost {to}
//   kick {id} · end {}                                         host only
// Synthesized by the DO, never accepted from a socket: member:hello,
// member:disconnected, sweep, alarm:straggler.
//
// settings.control ('shared' | 'host') is the Wave 7 name for who may control;
// everyoneControls is kept beside it, always === (control === 'shared'),
// because the apps that shipped before Wave 7 decode and send only that.

import { validAvatar } from './party-avatar.js';

export const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
export const MAX_MEMBERS = 8;
export const MAX_QUEUE = 20;
// Member ids are 'm_' + hex, minted by the DO. The prefix also keeps ids such
// as '__proto__' or 'constructor' out of the members map.
export const MEMBER_ID_RE = /^m_[A-Za-z0-9]{1,32}$/;
export const GONE_MS = 60_000;        // a disconnected member is dropped after this
export const HOST_GRACE_MS = 30_000;  // a disconnected host keeps the role this long

// No I, O, 0 or 1: codes get read aloud and typed on TV remotes.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const KINDS = new Set(['movie', 'tv', 'anime']);
const ENGINES = new Set(['av', 'vlc', 'embed', 'none']);
const PLATFORMS = new Set(['ios', 'tvos', 'macos', 'web']);
const CONTROLS = new Set(['shared', 'host']);
const MAX_TIME = 7 * 86_400;          // seconds; nothing plays for a week
const CTRL = /[\u0000-\u001f\u007f]/g;
const ACCENT_RE = /^#?[0-9A-Fa-f]{3,8}$/;
const DEVICE_RE = /^[A-Za-z0-9._-]{1,80}$/;

// ── Small helpers (exported ones are part of the module's contract) ──

export function expectedTime(p, now) {
  return p.mediaTime + (p.playing ? ((now - p.serverTimeAtUpdate) / 1000) * p.rate : 0);
}

// A finite number clamped to [0, a week]; anything else is `fallback`.
export function clampTime(x, fallback = 0) {
  return typeof x === 'number' && Number.isFinite(x) ? Math.min(Math.max(x, 0), MAX_TIME) : fallback;
}

export function clampRate(x, fallback = 1) {
  return typeof x === 'number' && Number.isFinite(x) ? Math.min(Math.max(x, 0.5), 2) : fallback;
}

export function genCode(randomFn = Math.random) {
  let code = '';
  for (let i = 0; i < 6; i++) code += ALPHABET[(Math.abs(Math.floor(randomFn() * ALPHABET.length)) % ALPHABET.length) || 0];
  return code;
}

// Constant-time string compare for member secrets.
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Trimmed, control characters removed, at most `max` code points (an emoji is
// never cut in half by a UTF-16 slice).
function text(x, max) {
  if (typeof x !== 'string') return '';
  const cps = Array.from(x.replace(CTRL, ' ').trim());
  return (cps.length > max ? cps.slice(0, max) : cps).join('').trim();
}
// 1–8 code points or '' — truncating an emoji sequence would break it.
function emoji(x) {
  if (typeof x !== 'string') return '';
  const e = x.trim();
  const n = Array.from(e).length;
  return n >= 1 && n <= 8 && !/[\u0000-\u001f\u007f]/.test(e) ? e : '';
}
const accent = (x) => (typeof x === 'string' && ACCENT_RE.test(x) ? x : '');
const device = (x) => (typeof x === 'string' && DEVICE_RE.test(x) ? x : '');
const platform = (x) => (PLATFORMS.has(x) ? x : '');
const own = (o, k) => typeof k === 'string' && Object.hasOwn(o, k);
const byJoined = (a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1);

// A normalized queue/now-playing item, or null when it isn't one.
export function validItem(x) {
  if (!x || typeof x !== 'object') return null;
  if (!Number.isInteger(x.tmdbID) || x.tmdbID <= 0 || x.tmdbID > 1e9) return null;
  if (!KINDS.has(x.kind)) return null;
  const n = (v) => (v === undefined || v === null ? null : Number.isInteger(v) && v >= 0 && v <= 1e6 ? v : undefined);
  const season = n(x.season), episode = n(x.episode), absoluteEpisode = n(x.absoluteEpisode);
  if (season === undefined || episode === undefined || absoluteEpisode === undefined) return null;
  return {
    tmdbID: x.tmdbID, kind: x.kind, season, episode, absoluteEpisode,
    title: text(x.title, 120),
    posterPath: typeof x.posterPath === 'string' && x.posterPath && x.posterPath.length <= 200 ? x.posterPath : null,
  };
}
const sameItem = (a, b) => !!a && !!b && a.tmdbID === b.tmdbID && a.kind === b.kind &&
  a.season === b.season && a.episode === b.episode;

// Who may be handed the host role: never a companion (no playback), never the
// browser (a tab that sleeps can't hold the room).
const canHost = (m) => m.role !== 'companion' && m.platform !== 'web';
// 'shared' | 'host' — also for a room stored before Wave 7 (no `control` yet).
const controlOf = (settings) => (CONTROLS.has(settings.control) ? settings.control
  : settings.everyoneControls === false ? 'host' : 'shared');

export function memberPublic(m) {
  const { secret, device: _device, ...pub } = m;
  return pub;
}
const roster = (s) => Object.values(s.members).sort(byJoined).map(memberPublic);

export function fullRoomView(s) {
  return { code: s.code, hostId: s.hostId, settings: s.settings, item: s.item,
           playback: s.playback, queue: s.queue, members: roster(s) };
}

// What a would-be joiner (or the /p/ page) sees before connecting. Still no
// member ids. `avatars` ({memberId: base64}, read from storage by the DO for
// GET /party/:code?avatars=1 only) adds `avatar` to the members that have one.
// Reads a room stored before Wave 7 as it is (the DO peeks without reducing).
export function peekView(s, avatars = null) {
  const here = Object.values(s.members).filter((m) => m.connected).sort(byJoined);
  const host = own(s.members, s.hostId) ? s.members[s.hostId] : null;
  const control = controlOf(s.settings);
  return {
    code: s.code, item: s.item, memberCount: here.length,
    members: here.map((m) => ({
      name: m.name, emoji: m.emoji, accentHex: m.accentHex,
      role: m.role, platform: m.platform ?? '', avatarRev: m.avatarRev ?? 0,
      ...(avatars && own(avatars, m.id) ? { avatar: avatars[m.id] } : {}),
    })),
    everyoneControls: control === 'shared', control, createdAt: s.createdAt,
    hostName: host ? host.name : null,
    hostPlatform: host ? host.platform ?? '' : null,
    companions: here.filter((m) => m.role === 'companion').length,
  };
}

// When a straggler wait gives up (epoch ms), or null when nobody is awaited.
export function stragglerDeadline(s) {
  return s.playback.reason === 'waiting' ? s.playback.serverTimeAtUpdate + s.settings.stragglerTimeoutMs : null;
}

function newMember(src, role, now, secret, connected) {
  return {
    id: src.id, device: device(src.device), name: text(src.name, 24) || 'Guest', emoji: emoji(src.emoji),
    accentHex: accent(src.accentHex), role, engine: ENGINES.has(src.engine) ? src.engine : 'none',
    platform: platform(src.platform), avatarRev: 0,
    synced: false, pos: 0, dur: 0, playing: false, buffering: false, reportedAt: 0,
    connected, joinedAt: now, lastSeen: now, secret,
  };
}

// The host's row starts disconnected: it connects (hello with memberId +
// hostSecret) right after POST /party, and if it never does, the sweep hands the
// room to whoever is there.
export function fresh({ code, now, host }) {
  const h = newMember(host, 'host', now, host.secret, false);
  return {
    v: 1, code, createdAt: now, lastActivity: now, seq: 0, hostId: h.id,
    // 'shared' = today's everyoneControls: true, so a new room behaves for a
    // shipped app exactly as before; the host may switch it to 'host'.
    settings: { control: 'shared', everyoneControls: true, waitForStragglers: false, stragglerTimeoutMs: 20_000 },
    item: null,
    playback: { playing: false, mediaTime: 0, serverTimeAtUpdate: now, rate: 1, seq: 0, by: null,
                cmd: null, reason: 'item', waitingFor: [] },
    queue: [],
    members: { [h.id]: h },
  };
}

// ── The reducer ──

const SYSTEM = new Set(['member:hello', 'member:disconnected', 'sweep', 'alarm:straggler']);
// Not "activity" for the 2 h idle expiry: the DO's own wake-ups, and typing.
const QUIET = new Set(['sweep', 'alarm:straggler', 'typing']);

export function reduce(state, msg, { now, from = null } = {}) {
  const s = upgrade(structuredClone(state));
  const c = { now, from, fx: [], me: null };
  const t = msg && typeof msg === 'object' && typeof msg.t === 'string' ? msg.t : undefined;
  const handler = t === undefined ? undefined : HANDLERS.get(t);
  if (!handler) return done(s, [err(from, 'bad_msg', t)]);
  if (!SYSTEM.has(t)) {
    if (s.ended) return done(s, [err(from, 'closed', t)]);
    if (!own(s.members, from)) return done(s, [err(from, 'not_member', t)]);
    c.me = s.members[from];
  }
  // A handler returns true when it changed the room (false = rejected / no-op).
  if (handler(s, msg, c) && !QUIET.has(t)) s.lastActivity = now;
  return done(s, c.fx);
}
// Effects are cloned so a later reduce can never alias what was already sent.
const done = (state, effects) => ({ state, effects: structuredClone(effects) });

// A room stored before Wave 7 (settings without `control`, members without
// platform / avatarRev) gains them the first time it is reduced; for any other
// room this only keeps everyoneControls in step with control.
function upgrade(s) {
  if (!CONTROLS.has(s.settings.control)) {
    const { control: _old, everyoneControls: _e, ...rest } = s.settings;
    const control = controlOf(s.settings);
    s.settings = { control, everyoneControls: control === 'shared', ...rest };
  }
  s.settings.everyoneControls = s.settings.control === 'shared';
  for (const m of Object.values(s.members)) {
    if (typeof m.platform !== 'string') m.platform = '';
    if (!Number.isInteger(m.avatarRev) || m.avatarRev < 0) m.avatarRev = 0;
  }
  return s;
}

function err(to, code, re) { return { to, msg: re ? { t: 'error', code, re } : { t: 'error', code } }; }
function deny(c, code, re) { c.fx.push(err(c.from, code, re)); return false; }
const stateMsg = (s) => ({ t: 'state', seq: s.seq, playback: s.playback });
const rosterMsg = (s) => ({ t: 'roster', seq: s.seq, members: roster(s) });
// The host always; an ordinary member only while the room is shared; a
// companion never.
const canControl = (s, m) => m.role === 'host' || (m.role === 'member' && s.settings.control === 'shared');
const isHost = (m) => m.role === 'host';
const isCompanion = (m) => m.role === 'companion';
// The client's command id, echoed in playback.cmd so it can match its own echo.
function cmdOf(msg) {
  const x = msg.c;
  return (typeof x === 'string' && x.length <= 64) || (typeof x === 'number' && Number.isFinite(x)) ? x : null;
}

function setPlayback(s, c, patch, reason, by, cmd = null) {
  s.seq += 1;
  s.playback = { ...s.playback, ...patch, serverTimeAtUpdate: c.now, seq: s.seq, by, cmd, reason,
                 waitingFor: patch.waitingFor ?? [] };
  c.fx.push({ to: 'all', msg: stateMsg(s) });
}

// Companions keep their role: only the old host steps down to member.
function setHost(s, id) {
  for (const m of Object.values(s.members)) m.role = m.id === id ? 'host' : isCompanion(m) ? 'companion' : 'member';
  s.hostId = id;
}
// Host → the connected member who joined first (other than `exclude`) and may
// host (canHost: no companion, no browser). With nobody such connected the role
// stays put; a hostId naming nobody becomes null.
function migrateHost(s, exclude = null) {
  const next = Object.values(s.members).filter((m) => m.connected && m.id !== exclude && canHost(m)).sort(byJoined)[0];
  if (next) setHost(s, next.id);
  else if (!own(s.members, s.hostId)) s.hostId = null;
  return !!next;
}
// The sweep's test for a host that has to be replaced: gone, or away longer
// than the grace period.
function hostVacant(s, now) {
  const h = own(s.members, s.hostId) ? s.members[s.hostId] : null;
  return !h || (!h.connected && now - h.lastSeen > HOST_GRACE_MS);
}
const hostMsg = (s, reason) => ({ t: 'host', seq: s.seq, hostId: s.hostId, reason });
// Deleting a member's row also deletes its stored avatar (the DO's storage).
const dropAvatar = (c, m) => { if (m && m.avatarRev > 0) c.fx.push({ avatarDrop: m.id }); };

// ── Transport ──

function transport(s, msg, c) {
  if (!canControl(s, c.me)) {
    c.fx.push(err(c.from, 'forbidden', msg.t), { to: c.from, msg: stateMsg(s) });   // snap the sender back
    return false;
  }
  const p = s.playback;
  const here = expectedTime(p, c.now);
  let patch;
  if (msg.t === 'play') patch = { playing: true, mediaTime: clampTime(msg.at, here) };
  else if (msg.t === 'pause') patch = { playing: false, mediaTime: clampTime(msg.at, here) };
  else if (msg.t === 'seek') {
    patch = { mediaTime: clampTime(msg.to, here), playing: typeof msg.playing === 'boolean' ? msg.playing : p.playing };
  } else {   // rate: re-anchor at the current position so the change doesn't jump time
    if (typeof msg.rate !== 'number' || !Number.isFinite(msg.rate)) return deny(c, 'bad_msg', msg.t);
    patch = { mediaTime: here, rate: clampRate(msg.rate) };
  }
  setPlayback(s, c, patch, 'user', c.from, cmdOf(msg));
  return true;
}

// ── Now playing + queue ──

function applyItem(s, c, item, startAt, cmd) {
  s.seq += 1;
  s.item = item;
  for (const m of Object.values(s.members)) m.synced = false;
  s.playback = { playing: false, mediaTime: startAt, serverTimeAtUpdate: c.now, rate: 1, seq: s.seq,
                 by: c.from, cmd, reason: 'item', waitingFor: [] };
  c.fx.push({ to: 'all', msg: { t: 'item', seq: s.seq, item, queue: s.queue, by: c.from } },
            { to: 'all', msg: stateMsg(s) });
}

function setItem(s, msg, c) {
  if (!canControl(s, c.me)) return deny(c, 'forbidden', msg.t);
  const item = validItem(msg.item);
  if (!item) return deny(c, 'bad_msg', msg.t);
  if (sameItem(item, s.item)) return false;   // a second tap on the same episode is a no-op
  applyItem(s, c, item, clampTime(msg.startAt, 0), cmdOf(msg));
  return true;
}

function queueOp(s, msg, c) {
  if (!canControl(s, c.me)) return deny(c, 'forbidden', msg.t);
  if (msg.op === 'add') {
    const item = validItem(msg.item);
    if (!item) return deny(c, 'bad_msg', msg.t);
    if (s.queue.length >= MAX_QUEUE) return deny(c, 'queue_full', msg.t);
    s.queue.push(item);
  } else if (msg.op === 'remove') {
    if (!Number.isInteger(msg.index) || msg.index < 0 || msg.index >= s.queue.length) return deny(c, 'bad_msg', msg.t);
    s.queue.splice(msg.index, 1);
  } else if (msg.op === 'playNext') {
    if (!s.queue.length) return deny(c, 'queue_empty', msg.t);
    const next = s.queue.shift();
    if (!sameItem(next, s.item)) { applyItem(s, c, next, 0, cmdOf(msg)); return true; }
    // Already playing it: it just leaves the queue.
  } else {
    return deny(c, 'bad_msg', msg.t);
  }
  s.seq += 1;
  c.fx.push({ to: 'all', msg: { t: 'queue', seq: s.seq, queue: s.queue } });
  return true;
}

// ── Member telemetry + the straggler wait ──

// A companion plays nothing: its report/ready are dropped quietly (no fan-out,
// no error), which also keeps it out of the straggler wait.
function report(s, msg, c) {
  const m = c.me;
  if (isCompanion(m)) return false;
  const was = m.buffering;
  m.pos = clampTime(msg.pos, m.pos);
  m.dur = clampTime(msg.dur, m.dur);
  for (const k of ['playing', 'buffering', 'synced']) if (typeof msg[k] === 'boolean') m[k] = msg[k];
  if (ENGINES.has(msg.engine)) m.engine = msg.engine;
  m.reportedAt = c.now;
  m.lastSeen = c.now;
  c.fx.push({ to: 'others', msg: { t: 'member', ...memberPublic(m) } });
  straggle(s, c, m, was);
  return true;
}

function ready(s, msg, c) {
  const m = c.me;
  if (isCompanion(m)) return false;
  const was = m.buffering;
  m.buffering = false;
  m.lastSeen = c.now;
  c.fx.push({ to: 'others', msg: { t: 'member', ...memberPublic(m) } });
  straggle(s, c, m, was);
  return true;
}

// waitForStragglers: a member that STARTS buffering while the room plays pauses
// everyone until it recovers (or the timeout alarm fires). Embeds are exempt:
// a web player's buffering can't be observed reliably, so it would stall the
// room for nothing.
function straggle(s, c, m, wasBuffering) {
  const p = s.playback;
  if (s.settings.waitForStragglers && p.playing && m.buffering && !wasBuffering && m.engine !== 'embed') {
    setPlayback(s, c, { playing: false, mediaTime: expectedTime(p, c.now), waitingFor: [m.id] }, 'waiting', m.id);
    c.fx.push({ alarm: c.now + s.settings.stragglerTimeoutMs });
  } else if (p.reason === 'waiting' && !m.buffering && p.waitingFor.includes(m.id)) {
    unwait(s, c, m.id);
  }
}
function unwait(s, c, id) {
  const p = s.playback;
  if (p.reason !== 'waiting' || !p.waitingFor.includes(id)) return;
  const left = p.waitingFor.filter((x) => x !== id);
  if (left.length) s.playback = { ...p, waitingFor: left };
  else resume(s, c);
}
const resume = (s, c) => setPlayback(s, c, { playing: true }, 'resume', null);

function stragglerTimeout(s, msg, c) {
  if (s.playback.reason !== 'waiting') return false;
  resume(s, c);
  return true;
}

// ── Social (relayed, never stored) ──

function chat(s, msg, c) {
  const body = text(msg.text, 280);
  if (!body) return deny(c, 'bad_msg', msg.t);
  c.fx.push({ to: 'all', msg: { t: 'chat', from: c.from, name: c.me.name, text: body, at: c.now } });
  return true;
}

function react(s, msg, c) {
  const e = emoji(msg.emoji);
  if (!e) return deny(c, 'bad_msg', msg.t);
  c.fx.push({ to: 'all', msg: { t: 'react', from: c.from, name: c.me.name, emoji: e, at: c.now } });
  return true;
}

function typing(s, msg, c) {
  c.fx.push({ to: 'others', msg: { t: 'typing', from: c.from, name: c.me.name, on: !!msg.on } });
  return false;
}

// ── Host controls ──

// `control` and the old `everyoneControls` both set who may control (when a
// frame carries both, `control` wins); the two always move together.
function settings(s, msg, c) {
  if (!isHost(c.me)) return deny(c, 'forbidden', msg.t);
  const control = CONTROLS.has(msg.control) ? msg.control
    : typeof msg.everyoneControls === 'boolean' ? (msg.everyoneControls ? 'shared' : 'host') : null;
  const wait = typeof msg.waitForStragglers === 'boolean' ? msg.waitForStragglers : null;
  if (control === null && wait === null) return deny(c, 'bad_msg', msg.t);
  if (control !== null) { s.settings.control = control; s.settings.everyoneControls = control === 'shared'; }
  if (wait !== null) s.settings.waitForStragglers = wait;
  s.seq += 1;
  c.fx.push({ to: 'all', msg: { t: 'settings', seq: s.seq, settings: s.settings } });
  // Turning the wait off mid-wait releases the room now, not at the timeout.
  if (!s.settings.waitForStragglers && s.playback.reason === 'waiting') resume(s, c);
  return true;
}

function transferHost(s, msg, c) {
  if (!isHost(c.me)) return deny(c, 'forbidden', msg.t);
  if (!own(s.members, msg.to) || msg.to === c.from || !canHost(s.members[msg.to])) return deny(c, 'bad_msg', msg.t);
  setHost(s, msg.to);
  s.seq += 1;
  c.fx.push({ to: 'all', msg: { t: 'host', seq: s.seq, hostId: s.hostId, reason: 'transfer' } });
  return true;
}

function kick(s, msg, c) {
  if (!isHost(c.me)) return deny(c, 'forbidden', msg.t);
  if (!own(s.members, msg.id) || msg.id === c.from) return deny(c, 'bad_msg', msg.t);
  dropAvatar(c, s.members[msg.id]);
  delete s.members[msg.id];
  s.seq += 1;
  c.fx.push({ to: msg.id, msg: { t: 'closed', reason: 'kicked' } },
            { close: msg.id, code: 4003, reason: 'kicked' },
            { to: 'all', msg: rosterMsg(s) });
  unwait(s, c, msg.id);
  return true;
}

function end(s, msg, c) {
  if (!isHost(c.me)) return deny(c, 'forbidden', msg.t);
  s.ended = true;
  s.seq += 1;
  c.fx.push({ to: 'all', msg: { t: 'closed', reason: 'ended' } }, { close: '*', code: 4000, reason: 'ended' });
  return true;
}

function leave(s, msg, c) {
  const wasHost = s.hostId === c.from;
  delete s.members[c.from];
  s.seq += 1;
  c.fx.push({ close: c.from, code: 1000, reason: 'left' });
  dropAvatar(c, c.me);
  if (wasHost) {
    migrateHost(s);
    c.fx.push({ to: 'others', msg: { t: 'host', seq: s.seq, hostId: s.hostId, reason: 'migrated' } });
  }
  c.fx.push({ to: 'others', msg: rosterMsg(s) });
  unwait(s, c, c.from);
  return true;
}

// "Watch along": a companion becomes an ordinary member — the only role change
// a member may ask for. A room left without a host (it went while only
// companions were here) is handed over now, by the sweep's rule.
function role(s, msg, c) {
  if (msg.role !== 'member' || !isCompanion(c.me)) return deny(c, 'bad_msg', msg.t);
  c.me.role = 'member';
  s.seq += 1;
  const before = s.hostId;
  if (hostVacant(s, c.now)) migrateHost(s, before);
  if (s.hostId !== before) c.fx.push({ to: 'all', msg: hostMsg(s, 'migrated') });
  c.fx.push({ to: 'all', msg: rosterMsg(s) });
  return true;
}

// A member's room avatar: validated here, stored by the DO (avatarPut) for the
// room's life, announced to the others. Only its revision rides in the member
// record, so roster/state frames stay small; seq moves so the DO persists it
// (a reload must never hand out a revision the clients already hold).
function avatar(s, msg, c) {
  const jpeg = validAvatar(msg.jpeg);
  if (!jpeg) return deny(c, 'bad_msg', msg.t);
  c.me.avatarRev += 1;
  s.seq += 1;
  c.fx.push({ avatarPut: c.from, jpeg },
            { to: 'others', msg: { t: 'avatar', id: c.from, rev: c.me.avatarRev, jpeg } });
  return true;
}

// ── Connection lifecycle (synthesized by the DO) ──

// msg.member: the hello frame's fields plus the DO-chosen id (and the secret the
// client presented, when resuming). msg.newSecret: a fresh secret for a new row.
// A known id must present its secret; an unknown id joins as a new member (a
// resume after the sweep dropped the row gets a new secret, same id).
function hello(s, msg, c) {
  const src = msg.member && typeof msg.member === 'object' ? msg.member : {};
  const id = src.id;
  const reject = (code, close) => {
    c.fx.push(err(id, code), { close: id, code: close, reason: code });
    return false;
  };
  if (typeof id !== 'string' || !MEMBER_ID_RE.test(id)) return reject('bad_hello', 4002);
  if (s.ended) return reject('closed', 4000);
  let m;
  if (own(s.members, id)) {
    m = s.members[id];
    if (!safeEqual(src.secret, m.secret)) return reject('bad_hello', 4002);
    m.connected = true;
    m.lastSeen = c.now;
    m.name = text(src.name, 24) || m.name;
    m.emoji = emoji(src.emoji) || m.emoji;
    m.accentHex = accent(src.accentHex) || m.accentHex;
    if (ENGINES.has(src.engine)) m.engine = src.engine;
    if (device(src.device)) m.device = device(src.device);
    m.platform = platform(src.platform) || m.platform;   // the role stays: hello.companion only shapes a NEW seat
  } else {
    if (Object.keys(s.members).length >= MAX_MEMBERS) return reject('full', 4001);
    if (typeof msg.newSecret !== 'string' || !msg.newSecret) return reject('bad_hello', 4002);
    m = newMember({ ...src, id }, src.companion === true ? 'companion' : 'member', c.now, msg.newSecret, true);
    s.members[id] = m;
  }
  s.seq += 1;
  // A room whose host is gone (left, swept) is handed to whoever is here.
  const hostless = !own(s.members, s.hostId) && migrateHost(s);
  c.fx.push({ to: id, msg: { t: 'welcome', v: 1, seq: s.seq, serverTime: c.now,
                             you: { id, role: m.role, secret: m.secret }, room: fullRoomView(s) } });
  // Right after the welcome: every stored avatar of the room's members (the
  // DO reads them from storage; this socket alone receives them).
  const avatars = Object.values(s.members).filter((x) => x.avatarRev > 0).sort(byJoined)
    .map((x) => ({ id: x.id, rev: x.avatarRev }));
  if (avatars.length) c.fx.push({ avatarsTo: id, avatars });
  if (hostless) c.fx.push({ to: 'others', msg: { t: 'host', seq: s.seq, hostId: s.hostId, reason: 'migrated' } });
  c.fx.push({ to: 'others', msg: rosterMsg(s) });
  return true;
}

// The member's last socket closed. The row stays (a phone switching networks
// reconnects within seconds); the sweep drops it after GONE_MS.
function disconnected(s, msg, c) {
  if (!own(s.members, msg.id) || !s.members[msg.id].connected) return false;
  const m = s.members[msg.id];
  m.connected = false;
  m.lastSeen = c.now;
  s.seq += 1;
  c.fx.push({ to: 'others', msg: rosterMsg(s) });
  unwait(s, c, m.id);   // never wait on someone who isn't there
  return true;
}

function sweep(s, msg, c) {
  let changed = false;
  for (const m of Object.values(s.members)) {
    if (!m.connected && c.now - m.lastSeen > GONE_MS) { dropAvatar(c, m); delete s.members[m.id]; changed = true; }
  }
  const before = s.hostId;
  if (hostVacant(s, c.now)) migrateHost(s, before);
  const hostMoved = s.hostId !== before;
  if (!changed && !hostMoved) return false;
  s.seq += 1;
  if (hostMoved) c.fx.push({ to: 'all', msg: { t: 'host', seq: s.seq, hostId: s.hostId, reason: 'migrated' } });
  c.fx.push({ to: 'all', msg: rosterMsg(s) });
  return true;
}

const HANDLERS = new Map(Object.entries({
  play: transport, pause: transport, seek: transport, rate: transport,
  setItem, queue: queueOp, report, ready, chat, react, typing, role, avatar,
  settings, transferHost, kick, end, leave,
  'member:hello': hello, 'member:disconnected': disconnected,
  sweep, 'alarm:straggler': stragglerTimeout,
}));
