// Wave 7 (W7-P1) — the relay half of "Party everywhere": companion seats
// (chat-only phones that never play and never host), room avatars (validated,
// stored per member for the room's life, fanned out, replayed after every
// welcome), control mode (settings.control kept in step with the old
// everyoneControls), the peek / join page additions, and the backward
// compatibility the shipped apps rely on (an old client's hello and settings,
// a room stored before Wave 7, ignorable frames and fields).
// Part 1 drives the pure reducer; part 2 the PartyRoom DO and the Worker routes
// over the same kind of fakes as test/party.mjs (storage over a Map, fake
// sockets, a movable clock). Run: node test/party-w7.mjs
import assert from 'node:assert/strict';
import { AVATAR_MAX_BYTES, AVATAR_MAX_B64, AVATAR_FRAME_MAX, avatarKey, validAvatar } from '../src/party-avatar.js';
import { fresh, reduce, peekView, memberPublic, fullRoomView, stragglerDeadline } from '../src/party-reducer.js';
import worker, { PartyRoom } from '../src/worker.js';

// Every assertion is counted (the summary line), every section named.
let checks = 0, cases = 0;
const A = {};
for (const k of ['ok', 'equal', 'notEqual', 'deepEqual', 'match']) A[k] = (...a) => { checks++; return assert[k](...a); };
const section = () => { cases++; };

// The frame types a pre-Wave 7 app decodes; Wave 7 adds only `avatar` (an old
// app maps any other `t` to .unknown and ignores it).
const OLD_FRAMES = new Set(['welcome', 'state', 'item', 'queue', 'roster', 'member', 'host', 'settings', 'chat', 'react',
  'typing', 'pong', 'error', 'closed']);
const OLD_MEMBER_KEYS = ['id', 'name', 'emoji', 'accentHex', 'role', 'engine', 'synced', 'pos', 'dur', 'playing',
  'buffering', 'reportedAt', 'connected', 'joinedAt', 'lastSeen'];
const seenFrames = new Set();
const settingsSeen = [];   // every settings object any frame carried
function note(m) {
  if (!m || typeof m !== 'object') return;
  seenFrames.add(m.t);
  if (m.t === 'settings') settingsSeen.push(m.settings);
  if (m.t === 'welcome') settingsSeen.push(m.room.settings);
}

// A JPEG-looking payload of n bytes (FF D8 FF E0 …), base64.
const jpeg = (n, fill = 7) => { const b = Buffer.alloc(n, fill); b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xe0; return b.toString('base64'); };
const PIC = jpeg(900, 1), PIC2 = jpeg(1200, 2), PIC3 = jpeg(700, 3);

// ═════════════════════ Part 1 — the pure reducer ═════════════════════

const T0 = 1_770_000_000_000;
const HOST = { id: 'm_tv', name: 'Living room', emoji: '📺', accentHex: '#37E29A', secret: 'tv-secret', device: 'dev-tv' };
const run = (s, msg, from, now) => { const r = reduce(s, msg, { now, from }); for (const e of r.effects) note(e.msg); return r; };
const of = (fx, t) => fx.filter((e) => e.msg?.t === t);
const one = (fx, t) => { const m = of(fx, t); assert.equal(m.length, 1, `exactly one ${t}`); return m[0]; };
const code = (r) => one(r.effects, 'error').msg.code;
const hello = (s, id, now, extra = {}) =>
  run(s, { t: 'member:hello', member: { id, name: id.slice(2), engine: 'av', ...extra }, newSecret: `sec-${id}` }, id, now);
function ok(s, msg, from, now) {
  const r = run(s, msg, from, now);
  assert.ok(!of(r.effects, 'error').length, `${msg.t} rejected: ${JSON.stringify(of(r.effects, 'error'))}`);
  return r;
}

// ── validAvatar + the limits ──
section();
A.equal(AVATAR_MAX_BYTES, 6144);
A.equal(AVATAR_MAX_B64, 8192);
A.ok(AVATAR_FRAME_MAX > AVATAR_MAX_B64);
A.equal(avatarKey('m_ab12'), 'avatar:m_ab12');
A.equal(validAvatar(PIC), PIC, 'a small JPEG passes unchanged');
A.equal(validAvatar(jpeg(AVATAR_MAX_BYTES)).length, AVATAR_MAX_B64, '6144 bytes is the most');
A.equal(validAvatar(jpeg(AVATAR_MAX_BYTES + 1)), null, '6145 bytes is too big');
A.equal(validAvatar('not base64 !!'), null);
A.equal(validAvatar(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]).toString('base64')), null, 'a PNG is not a JPEG');
A.equal(validAvatar(Buffer.from([0xff, 0xd8]).toString('base64')), null, 'shorter than the SOI marker');
for (const bad of ['', 42, null, undefined, {}, ['/9j/'], '/9j/4==', '/9j/4', '/9j-4A__', `${PIC}=`, 'x'.repeat(AVATAR_FRAME_MAX + 1)]) {
  A.equal(validAvatar(bad), null, `rejects ${String(JSON.stringify(bad)).slice(0, 30)}`);
}
A.ok(PIC3.endsWith('=='));
A.equal(validAvatar(PIC3.replace(/=+$/, '')), PIC3, 'missing padding is added');
A.equal(validAvatar(`${PIC.slice(0, 76)}\r\n${PIC.slice(76)}`), PIC, 'line breaks are dropped');

// ── Roles: hello, companions refused, report/ready dropped, chat allowed ──
section();
let s = fresh({ code: 'TVR234', now: T0, host: HOST });
let r = hello(s, 'm_tv', T0 + 10, { secret: 'tv-secret', platform: 'tvos' });
A.deepEqual(one(r.effects, 'welcome').msg.you, { id: 'm_tv', role: 'host', secret: 'tv-secret' });
s = r.state;
A.equal(s.members.m_tv.platform, 'tvos', 'the host resumes its row and records its platform');
r = hello(s, 'm_ph', T0 + 20, { platform: 'ios', companion: true });
A.deepEqual(one(r.effects, 'welcome').msg.you, { id: 'm_ph', role: 'companion', secret: 'sec-m_ph' });
A.equal(one(r.effects, 'roster').msg.members.find((m) => m.id === 'm_ph').role, 'companion');
s = r.state;
A.deepEqual([s.members.m_ph.platform, s.members.m_ph.avatarRev], ['ios', 0]);
s = hello(s, 'm_mac', T0 + 30, { platform: 'macos' }).state;
A.equal(s.members.m_mac.role, 'member');
s = hello(s, 'm_odd', T0 + 40, { platform: 'android', companion: 'yes' }).state;
A.deepEqual([s.members.m_odd.role, s.members.m_odd.platform], ['member', ''], 'unknown platform → "", companion must be true');
s = run(s, { t: 'leave' }, 'm_odd', T0 + 41).state;
s = ok(s, { t: 'setItem', item: { tmdbID: 1399, kind: 'tv', season: 1, episode: 1, title: 'GoT' } }, 'm_tv', T0 + 50).state;
for (const msg of [{ t: 'play', at: 1 }, { t: 'pause', at: 2 }, { t: 'seek', to: 9, playing: true }, { t: 'rate', rate: 1.5 }]) {
  r = run(s, msg, 'm_ph', T0 + 60);
  A.deepEqual(r.effects, [{ to: 'm_ph', msg: { t: 'error', code: 'forbidden', re: msg.t } },
                          { to: 'm_ph', msg: { t: 'state', seq: s.seq, playback: s.playback } }], `companion ${msg.t}: forbidden + snap back`);
  A.deepEqual(r.state, s);
}
r = run(s, { t: 'setItem', item: { tmdbID: 550, kind: 'movie', title: 'FC' } }, 'm_ph', T0 + 61);
A.deepEqual(r.effects, [{ to: 'm_ph', msg: { t: 'error', code: 'forbidden', re: 'setItem' } }]);
for (const op of [{ op: 'add', item: { tmdbID: 550, kind: 'movie', title: 'FC' } }, { op: 'playNext' }, { op: 'remove', index: 0 }]) {
  A.equal(code(run(s, { t: 'queue', ...op }, 'm_ph', T0 + 62)), 'forbidden', `companion queue ${op.op}`);
}
for (const msg of [{ t: 'report', pos: 5, dur: 100, playing: true, buffering: true, engine: 'av', synced: true }, { t: 'ready' }]) {
  r = run(s, msg, 'm_ph', T0 + 63);
  A.deepEqual(r.effects, [], `companion ${msg.t}: dropped quietly`);
  A.deepEqual(r.state, s, `companion ${msg.t}: nothing stored`);
}
A.equal(one(ok(s, { t: 'chat', text: 'hi from the couch' }, 'm_ph', T0 + 64).effects, 'chat').to, 'all');
A.equal(one(ok(s, { t: 'react', emoji: '😂' }, 'm_ph', T0 + 64).effects, 'react').msg.from, 'm_ph');
for (const msg of [{ t: 'settings', control: 'host' }, { t: 'kick', id: 'm_mac' }, { t: 'transferHost', to: 'm_mac' }, { t: 'end' }]) {
  A.equal(code(run(s, msg, 'm_ph', T0 + 65)), 'forbidden', `companion ${msg.t}`);
}

// ── role {role:'member'}: the only role change a member may ask for ──
section();
for (const [msg, from] of [[{ t: 'role', role: 'member' }, 'm_mac'], [{ t: 'role', role: 'member' }, 'm_tv'],
  [{ t: 'role', role: 'companion' }, 'm_mac'], [{ t: 'role', role: 'companion' }, 'm_tv'],
  [{ t: 'role', role: 'host' }, 'm_ph'], [{ t: 'role' }, 'm_ph'], [{ t: 'role', role: 'companion' }, 'm_ph']]) {
  r = run(s, msg, from, T0 + 70);
  A.equal(code(r), 'bad_msg', `${from} → ${msg.role}`);
  A.deepEqual(r.state, s);
}
r = ok(s, { t: 'role', role: 'member' }, 'm_ph', T0 + 71);
A.deepEqual(r.effects.map((e) => [e.to, e.msg.t]), [['all', 'roster']], 'promoted: roster to everyone, no host change');
A.equal(r.effects[0].msg.members.find((m) => m.id === 'm_ph').role, 'member');
A.ok(r.state.seq > s.seq);
A.equal(r.state.hostId, 'm_tv');
A.equal(ok(r.state, { t: 'seek', to: 30 }, 'm_ph', T0 + 72).state.playback.by, 'm_ph', 'a promoted phone controls (shared room)');
// A resumed seat keeps its role whatever its hello says; its platform updates.
r = hello(s, 'm_ph', T0 + 73, { secret: 'sec-m_ph', platform: 'macos', companion: false });
A.deepEqual([r.state.members.m_ph.role, r.state.members.m_ph.platform], ['companion', 'macos']);
r = hello(r.state, 'm_ph', T0 + 74, { secret: 'sec-m_ph' });
A.equal(r.state.members.m_ph.platform, 'macos', 'a hello without platform keeps the last one');
A.equal(hello(s, 'm_mac', T0 + 75, { secret: 'sec-m_mac', companion: true }).state.members.m_mac.role, 'member',
  'a member cannot become a companion by resuming');

// ── Host: never a companion, never the browser ──
section();
let h = fresh({ code: 'HST234', now: T0, host: HOST });
h = hello(h, 'm_tv', T0 + 1, { secret: 'tv-secret', platform: 'tvos' }).state;
h = hello(h, 'm_ph', T0 + 2, { platform: 'ios', companion: true }).state;
h = hello(h, 'm_web', T0 + 3, { platform: 'web' }).state;
A.equal(code(run(h, { t: 'transferHost', to: 'm_ph' }, 'm_tv', T0 + 4)), 'bad_msg', 'transfer to a companion');
A.equal(code(run(h, { t: 'transferHost', to: 'm_web' }, 'm_tv', T0 + 4)), 'bad_msg', 'transfer to the browser');
r = ok(h, { t: 'leave' }, 'm_tv', T0 + 5);
A.equal(r.state.hostId, null, 'only a companion and a web member left: nobody is made host');
A.deepEqual([r.state.members.m_ph.role, r.state.members.m_web.role], ['companion', 'member']);
A.deepEqual(r.effects.map((e) => e.close ?? e.msg.t), ['m_tv', 'host', 'roster']);
A.equal(one(r.effects, 'host').msg.hostId, null);
h = r.state;
A.deepEqual(run(h, { t: 'sweep' }, null, T0 + 120_000).effects, [], 'the sweep finds no one to hand it to');
A.equal(hello(h, 'm_ph2', T0 + 6, { platform: 'ios', companion: true }).state.hostId, null, 'a joining companion is not made host');
A.equal(hello(h, 'm_web2', T0 + 6, { platform: 'web' }).state.hostId, null, 'nor a joining browser');
r = ok(h, { t: 'role', role: 'member' }, 'm_ph', T0 + 7);
A.deepEqual(r.effects.map((e) => [e.to, e.msg.t]), [['all', 'host'], ['all', 'roster']]);
A.deepEqual(one(r.effects, 'host').msg, { t: 'host', seq: r.state.seq, hostId: 'm_ph', reason: 'migrated' });
A.deepEqual([r.state.hostId, r.state.members.m_ph.role, r.state.members.m_web.role], ['m_ph', 'host', 'member'],
  'the companion that watches along takes the empty host seat');
// setHost keeps companions: a transfer, and a sweep migration past an earlier-joined companion.
let k = fresh({ code: 'KEP234', now: T0, host: HOST });
k = hello(k, 'm_tv', T0 + 1, { secret: 'tv-secret', platform: 'tvos' }).state;
k = hello(k, 'm_ph', T0 + 2, { platform: 'ios', companion: true }).state;
k = hello(k, 'm_ipad', T0 + 3, { platform: 'ios' }).state;
r = ok(k, { t: 'transferHost', to: 'm_ipad' }, 'm_tv', T0 + 4);
A.deepEqual(['m_tv', 'm_ph', 'm_ipad'].map((id) => r.state.members[id].role), ['member', 'companion', 'host']);
k = run(k, { t: 'member:disconnected', id: 'm_tv' }, 'm_tv', T0 + 10).state;
r = run(k, { t: 'sweep' }, null, T0 + 10 + 31_000);
A.equal(r.state.hostId, 'm_ipad', 'migration skips the companion who joined first');
A.equal(r.state.members.m_ph.role, 'companion');

// ── Straggler wait: a companion never starts, holds or is named by it ──
section();
let w = fresh({ code: 'WAT234', now: T0, host: HOST });
w = hello(w, 'm_tv', T0 + 1, { secret: 'tv-secret', platform: 'tvos' }).state;
w = hello(w, 'm_ph', T0 + 2, { platform: 'ios', companion: true }).state;
w = hello(w, 'm_mac', T0 + 3, { platform: 'macos', engine: 'vlc' }).state;
w = ok(w, { t: 'settings', waitForStragglers: true }, 'm_tv', T0 + 4).state;
w = ok(w, { t: 'play', at: 0 }, 'm_tv', T0 + 5).state;
r = run(w, { t: 'report', buffering: true, playing: true }, 'm_ph', T0 + 6);
A.deepEqual([r.effects, r.state.playback.playing, r.state.playback.reason], [[], true, 'user'], 'companion buffering: nothing');
w = ok(w, { t: 'report', buffering: true }, 'm_mac', T0 + 7).state;
A.deepEqual([w.playback.reason, w.playback.waitingFor], ['waiting', ['m_mac']]);
for (const msg of [{ t: 'report', buffering: false }, { t: 'report', buffering: true }, { t: 'ready' }]) {
  r = run(w, msg, 'm_ph', T0 + 8);
  A.deepEqual(r.state.playback, w.playback, `companion ${msg.t} mid-wait changes nothing`);
  A.ok(!r.state.playback.waitingFor.includes('m_ph'));
}
A.equal(stragglerDeadline(w), T0 + 7 + 20_000);
w = ok(w, { t: 'report', buffering: false }, 'm_mac', T0 + 9).state;
A.deepEqual([w.playback.playing, w.playback.reason, w.playback.waitingFor], [true, 'resume', []]);

// ── Control mode ──
section();
let c = fresh({ code: 'CTL234', now: T0, host: HOST });
A.deepEqual([c.settings.control, c.settings.everyoneControls], ['shared', true], 'a new room is shared (= today)');
c = hello(c, 'm_tv', T0 + 1, { secret: 'tv-secret', platform: 'tvos' }).state;
c = hello(c, 'm_ph', T0 + 2, { platform: 'ios', companion: true }).state;
c = hello(c, 'm_mac', T0 + 3, { platform: 'macos' }).state;
A.equal(ok(c, { t: 'pause', at: 3 }, 'm_mac', T0 + 4).state.playback.by, 'm_mac', 'shared: a member controls');
A.equal(code(run(c, { t: 'pause', at: 3 }, 'm_ph', T0 + 4)), 'forbidden', 'shared: a companion never');
for (const msg of [{ t: 'settings', control: 'host' }, { t: 'settings', everyoneControls: false }]) {
  A.equal(code(run(c, msg, 'm_mac', T0 + 5)), 'forbidden', `member ${JSON.stringify(msg)}`);
}
r = ok(c, { t: 'settings', control: 'host' }, 'm_tv', T0 + 6);
A.deepEqual(one(r.effects, 'settings'), { to: 'all', msg: { t: 'settings', seq: r.state.seq,
  settings: { control: 'host', everyoneControls: false, waitForStragglers: false, stragglerTimeoutMs: 20000 } } });
c = r.state;
r = run(c, { t: 'seek', to: 40 }, 'm_mac', T0 + 7);
A.deepEqual(r.effects, [{ to: 'm_mac', msg: { t: 'error', code: 'forbidden', re: 'seek' } },
                        { to: 'm_mac', msg: { t: 'state', seq: c.seq, playback: c.playback } }], 'host mode: member refused + snap back');
A.equal(code(run(c, { t: 'setItem', item: { tmdbID: 550, kind: 'movie', title: 'FC' } }, 'm_mac', T0 + 7)), 'forbidden');
A.equal(code(run(c, { t: 'queue', op: 'add', item: { tmdbID: 550, kind: 'movie', title: 'FC' } }, 'm_mac', T0 + 7)), 'forbidden');
A.equal(ok(c, { t: 'seek', to: 40 }, 'm_tv', T0 + 8).state.playback.mediaTime, 40, 'host mode: the host controls');
A.equal(one(hello(c, 'm_new', T0 + 9).effects, 'welcome').msg.room.settings.control, 'host', 'the welcome carries control');
A.equal(ok(c, { t: 'settings', waitForStragglers: true }, 'm_tv', T0 + 10).state.settings.control, 'host', 'wait alone keeps control');
c = ok(c, { t: 'settings', control: 'shared' }, 'm_tv', T0 + 11).state;
A.deepEqual([c.settings.control, c.settings.everyoneControls], ['shared', true]);
A.equal(ok(c, { t: 'play', at: 40 }, 'm_mac', T0 + 12).state.playback.by, 'm_mac', 'back to shared');
// The old field still works and sets control; both given → control wins.
for (const [msg, want] of [
  [{ everyoneControls: false }, ['host', false]], [{ everyoneControls: true }, ['shared', true]],
  [{ control: 'shared', everyoneControls: false }, ['shared', true]], [{ control: 'host', everyoneControls: true }, ['host', false]],
  [{ control: 'bogus', everyoneControls: false }, ['host', false]],
]) {
  const st = ok(c, { t: 'settings', ...msg }, 'm_tv', T0 + 13).state.settings;
  A.deepEqual([st.control, st.everyoneControls], want, JSON.stringify(msg));
}
A.equal(code(run(c, { t: 'settings', control: 'bogus' }, 'm_tv', T0 + 14)), 'bad_msg');
A.equal(code(run(c, { t: 'settings', control: 'everyone' }, 'm_tv', T0 + 14)), 'bad_msg');

// ── Avatars (reducer side: validation, revisions, effects) ──
section();
let v = fresh({ code: 'AVA234', now: T0, host: HOST });
v = hello(v, 'm_tv', T0 + 1, { secret: 'tv-secret', platform: 'tvos' }).state;
v = hello(v, 'm_ph', T0 + 2, { platform: 'ios', companion: true }).state;
v = hello(v, 'm_mac', T0 + 3, { platform: 'macos' }).state;
r = ok(v, { t: 'avatar', jpeg: PIC }, 'm_ph', T0 + 4);
A.deepEqual(r.effects, [{ avatarPut: 'm_ph', jpeg: PIC },
                        { to: 'others', msg: { t: 'avatar', id: 'm_ph', rev: 1, jpeg: PIC } }], 'a companion may send one');
A.equal(r.state.members.m_ph.avatarRev, 1);
A.ok(r.state.seq > v.seq, 'seq moves so the DO persists the revision');
A.ok(!JSON.stringify(r.state).includes(PIC.slice(0, 40)), 'the JPEG never lives in the room object');
A.ok(!JSON.stringify(fullRoomView(r.state)).includes(PIC.slice(0, 40)));
v = r.state;
r = ok(v, { t: 'avatar', jpeg: PIC2 }, 'm_ph', T0 + 5);
A.equal(one(r.effects, 'avatar').msg.rev, 2, 'each accepted avatar bumps the revision');
v = r.state;
v = ok(v, { t: 'avatar', jpeg: PIC3 }, 'm_tv', T0 + 6).state;
for (const bad of [jpeg(AVATAR_MAX_BYTES + 1), 'not base64 !!', Buffer.from('GIF89a, not a JPEG').toString('base64'), 42, undefined]) {
  r = run(v, { t: 'avatar', jpeg: bad }, 'm_mac', T0 + 7);
  A.deepEqual(r.effects, [{ to: 'm_mac', msg: { t: 'error', code: 'bad_msg', re: 'avatar' } }]);
  A.deepEqual(r.state, v);
}
r = hello(v, 'm_late', T0 + 8, { platform: 'ios' });
A.deepEqual(r.effects.map((e) => e.msg?.t ?? (e.avatarsTo ? 'avatarsTo' : '?')), ['welcome', 'avatarsTo', 'roster'],
  'the stored avatars follow the welcome directly');
A.deepEqual(r.effects[1], { avatarsTo: 'm_late', avatars: [{ id: 'm_tv', rev: 1 }, { id: 'm_ph', rev: 2 }] }, 'in join order');
A.deepEqual(hello(fresh({ code: 'NOA234', now: T0, host: HOST }), 'm_x', T0).effects.map((e) => e.msg?.t ?? '?'),
  ['welcome', 'roster'], 'no avatars, no extra effect');
// Leaving, being kicked or swept deletes the stored avatar; no avatar, no delete.
A.deepEqual(ok(v, { t: 'leave' }, 'm_ph', T0 + 9).effects.filter((e) => 'avatarDrop' in e), [{ avatarDrop: 'm_ph' }]);
A.deepEqual(ok(v, { t: 'leave' }, 'm_mac', T0 + 9).effects.filter((e) => 'avatarDrop' in e), []);
A.deepEqual(ok(v, { t: 'kick', id: 'm_ph' }, 'm_tv', T0 + 9).effects.filter((e) => 'avatarDrop' in e), [{ avatarDrop: 'm_ph' }]);
const sw = run(v, { t: 'member:disconnected', id: 'm_ph' }, 'm_ph', T0 + 10).state;
r = run(sw, { t: 'sweep' }, null, T0 + 10 + 61_000);
A.ok(!('m_ph' in r.state.members));
A.deepEqual(r.effects.filter((e) => 'avatarDrop' in e), [{ avatarDrop: 'm_ph' }]);

// ── Peek (pure) ──
section();
let pk = peekView(v);
A.deepEqual(Object.keys(pk).sort(), ['code', 'companions', 'control', 'createdAt', 'everyoneControls', 'hostName',
  'hostPlatform', 'item', 'memberCount', 'members']);
A.deepEqual([pk.hostPlatform, pk.control, pk.everyoneControls, pk.companions, pk.memberCount], ['tvos', 'shared', true, 1, 3]);
A.deepEqual(pk.members.map((m) => [m.name, m.role, m.platform, m.avatarRev]),
  [['tv', 'host', 'tvos', 1], ['ph', 'companion', 'ios', 2], ['mac', 'member', 'macos', 0]]);
A.ok(pk.members.every((m) => !('id' in m) && !('avatar' in m)), 'no ids, no photos');
pk = peekView(v, { m_ph: 'B64', m_mac: 'X' });
A.deepEqual(pk.members.map((m) => m.avatar), [undefined, 'B64', 'X'], 'avatars only from the map the DO read');
A.equal(peekView({ ...v, hostId: null }).hostPlatform, null, 'no host → null');

// ── Backward compatibility (reducer) ──
section();
// 1. An old app's hello and settings.
let o = fresh({ code: 'OLD234', now: T0, host: { id: 'm_old', name: 'Old', secret: 'old-secret' } });
r = run(o, { t: 'member:hello', member: { id: 'm_old', device: 'd', name: 'Old', emoji: '🍿', accentHex: '#fff', engine: 'av',
  secret: 'old-secret' } }, 'm_old', T0 + 1);
A.deepEqual(one(r.effects, 'welcome').msg.you, { id: 'm_old', role: 'host', secret: 'old-secret' });
o = r.state;
r = run(o, { t: 'member:hello', member: { id: 'm_b64', device: 'e', name: 'Phone b64', engine: 'vlc' }, newSecret: 'x' }, 'm_b64', T0 + 2);
A.deepEqual([r.state.members.m_b64.role, r.state.members.m_b64.platform], ['member', ''], 'old hello → ordinary member, platform ""');
o = r.state;
r = ok(o, { t: 'settings', everyoneControls: true }, 'm_old', T0 + 3);
A.deepEqual(one(r.effects, 'settings').msg.settings, { control: 'shared', everyoneControls: true, waitForStragglers: false,
  stragglerTimeoutMs: 20000 });
A.equal(ok(o, { t: 'play', at: 5 }, 'm_b64', T0 + 4).state.playback.by, 'm_b64', 'a new room obeys any member, as today');
A.deepEqual(Object.keys(memberPublic(o.members.m_b64)).sort(), [...OLD_MEMBER_KEYS, 'platform', 'avatarRev'].sort(),
  'the member record only gains platform + avatarRev');
// 2. A room object stored by the relay before Wave 7.
const OLD_ROOM = (everyoneControls) => ({
  v: 1, code: 'PRE234', createdAt: T0, lastActivity: T0, seq: 7, hostId: 'm_h',
  settings: { everyoneControls, waitForStragglers: true, stragglerTimeoutMs: 20000 },
  item: { tmdbID: 550, kind: 'movie', season: null, episode: null, absoluteEpisode: null, title: 'FC', posterPath: null },
  playback: { playing: true, mediaTime: 10, serverTimeAtUpdate: T0, rate: 1, seq: 6, by: 'm_h', cmd: null, reason: 'user', waitingFor: [] },
  queue: [],
  members: Object.fromEntries(['m_h', 'm_m'].map((id, i) => [id, {
    id, device: `dev-${id}`, name: id, emoji: '', accentHex: '', role: i ? 'member' : 'host', engine: 'av', synced: true,
    pos: 10, dur: 7000, playing: true, buffering: false, reportedAt: T0, connected: true, joinedAt: T0 + i, lastSeen: T0, secret: `s-${id}` }])),
});
const pre = OLD_ROOM(false);
pk = peekView(pre);
A.deepEqual([pk.control, pk.everyoneControls, pk.hostPlatform, pk.companions], ['host', false, '', 0], 'a stored room peeks as is');
A.deepEqual(pk.members.map((m) => [m.role, m.platform, m.avatarRev]), [['host', '', 0], ['member', '', 0]]);
r = run(pre, { t: 'report', pos: 11, buffering: true }, 'm_m', T0 + 1000);
A.deepEqual(r.state.settings, { control: 'host', everyoneControls: false, waitForStragglers: true, stragglerTimeoutMs: 20000 },
  'migrated on the first reduce');
A.ok(Object.values(r.state.members).every((m) => m.platform === '' && m.avatarRev === 0));
A.deepEqual([r.state.playback.reason, r.state.playback.waitingFor], ['waiting', ['m_m']], 'the straggler wait still works');
A.deepEqual(r.effects.filter((e) => 'alarm' in e), [{ alarm: T0 + 1000 + 20_000 }]);
r = run(r.state, { t: 'ready' }, 'm_m', T0 + 2000);
A.deepEqual([r.state.playback.playing, r.state.playback.reason], [true, 'resume']);
A.equal(code(run(r.state, { t: 'pause' }, 'm_m', T0 + 3000)), 'forbidden', 'everyoneControls:false → host mode');
A.equal(ok(r.state, { t: 'pause' }, 'm_h', T0 + 3000).state.playback.playing, false);
A.equal(run(OLD_ROOM(true), { t: 'sweep' }, null, T0).state.settings.control, 'shared', 'everyoneControls:true → shared');
const once = reduce(OLD_ROOM(true), { t: 'sweep' }, { now: T0 }).state;
A.deepEqual(reduce(once, { t: 'sweep' }, { now: T0 }).state, once, 'the upgrade is idempotent');

// ═════════════════════ Part 2 — the Durable Object + Worker routes ═════════════════════

const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;

function makeKV() {
  const m = new Map();
  return {
    m,
    async get(key) { const e = m.get(key); return e && (!e.exp || e.exp > Date.now()) ? e.value : null; },
    async put(key, val, opts = {}) { m.set(key, { value: String(val), exp: opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : 0 }); },
    async delete(key) { m.delete(key); },
    async list({ prefix = '' } = {}) { return { keys: [...m.keys()].filter((x) => x.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
  };
}
function makeCtx() {
  const data = new Map(), sockets = [];
  let alarm = null;
  return {
    data, sockets,
    storage: {
      async get(key) { return data.has(key) ? structuredClone(data.get(key)) : undefined; },
      async put(key, val) { data.set(key, structuredClone(val)); },
      async delete(key) { return data.delete(key); },
      async deleteAll() { data.clear(); },
      async setAlarm(t) { alarm = Number(t); },
      async getAlarm() { return alarm; },
      async deleteAlarm() { alarm = null; },
    },
    acceptWebSocket(ws) { sockets.push(ws); },
    getWebSockets() { return sockets.filter((ws) => !ws.closed); },
    blockConcurrencyWhile(fn) { return fn(); },
  };
}
function makeWS(name) {
  return {
    name, sent: [], closed: null, att: null,
    send(x) {
      if (this.closed) throw new Error('send on a closed socket');
      const m = typeof x === 'string' ? JSON.parse(x) : { t: 'binary' };
      note(m);
      this.sent.push(m);
    },
    close(cc, reason) { if (!this.closed) this.closed = { code: cc, reason }; },
    serializeAttachment(val) { this.att = structuredClone(val); },
    deserializeAttachment() { return structuredClone(this.att); },
    drain() { const out = this.sent; this.sent = []; return out; },
  };
}
const kv = makeKV();
const rooms = new Map();
const roomFor = (cd) => { if (!rooms.has(cd)) { const cx = makeCtx(); rooms.set(cd, { ctx: cx, room: new PartyRoom(cx, env) }); } return rooms.get(cd); };
const env = {
  ADMIN_TOKEN: 'admin', USER_TOKEN: 'user', SERVERS: kv,
  PARTY: { idFromName: (name) => ({ name }), get: (id) => ({ fetch: (input, init) => roomFor(id.name).room.fetch(new Request(input, init)) }) },
};
let ipn = 0;
async function req(path, { method = 'GET', token = 'user', body } = {}) {
  ipn++;   // a fresh client IP per call: the per-IP limits never trip
  return worker.fetch(new Request(`https://relay.test${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'cf-connecting-ip': `10.9.${ipn >> 8}.${ipn & 255}` },
  }), env);
}
const say = (room, ws, msg) => room.webSocketMessage(ws, typeof msg === 'string' ? msg : JSON.stringify(msg));
const last = (ws, t) => ws.sent.filter((m) => m.t === t).at(-1);
async function join(room, name, extra) {
  skew += 5;   // distinct joinedAt: join order is what the room sorts by (ties go by random id)
  const ws = makeWS(name);
  room.accept(ws);
  await say(room, ws, { t: 'hello', v: 1, device: `dev-${name}`, name, engine: 'av', app: 'test', ...extra });
  return ws;
}

// ── A room: a TV host, a phone companion, an old app, a Mac ──
section();
let res = await req('/party', { method: 'POST', body: { device: 'dev-tv', name: 'Living room', emoji: '📺' } });
const made = await res.json();
const CODE = made.code;
const { ctx } = rooms.get(CODE);
let room = rooms.get(CODE).room;
const wsTV = await join(room, 'TV', { memberId: made.memberId, secret: made.hostSecret, platform: 'tvos' });
A.equal(wsTV.sent[0].you.role, 'host');
const TV = made.memberId;
const wsPh = await join(room, 'Phone', { platform: 'ios', companion: true });
const welcomePh = wsPh.sent[0];
A.deepEqual([welcomePh.t, welcomePh.you.role], ['welcome', 'companion']);
A.equal(welcomePh.room.members.find((m) => m.id === TV).platform, 'tvos');
const PH = welcomePh.you.id;
const wsOld = await join(room, 'OldPhone', {});   // a b64 app: no platform, no companion
const OLD = wsOld.sent[0].you.id;
A.deepEqual([wsOld.sent[0].you.role, room.state.members[OLD].platform], ['member', '']);
const wsMac = await join(room, 'Mac', { platform: 'macos' });
const MAC = wsMac.sent[0].you.id;
const all = [wsTV, wsPh, wsOld, wsMac];
for (const ws of all) ws.drain();

// The peek: who's hosting from what, how many companions.
let peek = await (await req(`/party/${CODE}`)).json();
A.deepEqual([peek.hostPlatform, peek.control, peek.everyoneControls, peek.companions, peek.memberCount], ['tvos', 'shared', true, 1, 4]);
A.deepEqual(peek.members.map((m) => [m.name, m.role, m.platform, m.avatarRev]),
  [['TV', 'host', 'tvos', 0], ['Phone', 'companion', 'ios', 0], ['OldPhone', 'member', '', 0], ['Mac', 'member', 'macos', 0]]);

// Companion controls refused (with the snap-back), its report dropped; an old member controls (shared).
await say(room, wsPh, { t: 'pause', c: 'p1' });
let got = wsPh.drain();
A.deepEqual(got.map((m) => m.t), ['error', 'state']);
A.deepEqual(got[0], { t: 'error', code: 'forbidden', re: 'pause' });
await say(room, wsPh, { t: 'report', pos: 3, playing: true, buffering: true, engine: 'av' });
A.deepEqual([wsTV.drain(), wsPh.drain()], [[], []], 'a companion report reaches nobody');
await say(room, wsOld, { t: 'seek', to: 60, playing: true, c: 'o1' });
A.equal(last(wsTV, 'state').playback.by, OLD, 'an old app controls a new (shared) room');
for (const ws of all) ws.drain();

// ── Avatars through the DO ──
section();
await say(room, wsPh, { t: 'avatar', jpeg: PIC });
A.equal(ctx.data.get(avatarKey(PH)), PIC, 'stored under avatar:<memberId>');
A.equal(ctx.data.get('state').members[PH].avatarRev, 1, 'the revision is persisted at once');
for (const ws of [wsTV, wsOld, wsMac]) A.deepEqual(ws.drain(), [{ t: 'avatar', id: PH, rev: 1, jpeg: PIC }]);
A.deepEqual(wsPh.drain(), [], 'the sender gets no echo');
await say(room, wsPh, { t: 'avatar', jpeg: PIC2 });
A.deepEqual(last(wsTV, 'avatar'), { t: 'avatar', id: PH, rev: 2, jpeg: PIC2 });
await say(room, wsPh, { t: 'avatar', jpeg: PIC3 });
A.deepEqual(wsPh.drain(), [{ t: 'error', code: 'rate_limited', re: 'avatar' }], '3rd in 60 s');
A.equal(room.state.members[PH].avatarRev, 2);
A.equal(ctx.data.get(avatarKey(PH)), PIC2);
for (const ws of all) ws.drain();
// Bad ones → bad_msg (each spends budget, hence the minute between).
await say(room, wsMac, { t: 'avatar', jpeg: jpeg(AVATAR_MAX_BYTES + 1) });
await say(room, wsMac, { t: 'avatar', jpeg: 'not base64 !!' });
skew += 61_000;
await say(room, wsMac, { t: 'avatar', jpeg: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]).toString('base64') });
A.deepEqual(wsMac.drain(), Array(3).fill({ t: 'error', code: 'bad_msg', re: 'avatar' }), 'too big / not base64 / not JPEG');
A.ok(!ctx.data.has(avatarKey(MAC)));
A.deepEqual(wsTV.drain(), [], 'a refused avatar reaches nobody');
// Frame caps: a 9 KB avatar frame passes, a 5 KB chat frame still doesn't.
const bigPic = jpeg(AVATAR_MAX_BYTES, 9);
const bigFrame = `{"t":"avatar","jpeg":"${bigPic}"${' '.repeat(900)}}`;
A.ok(bigFrame.length > 9000 && bigFrame.length <= AVATAR_FRAME_MAX);
await say(room, wsTV, bigFrame);
A.equal(ctx.data.get(avatarKey(TV)), bigPic, 'a 9 KB avatar frame is accepted');
A.deepEqual(last(wsMac, 'avatar'), { t: 'avatar', id: TV, rev: 1, jpeg: bigPic });
await say(room, wsMac, JSON.stringify({ t: 'chat', text: 'x'.repeat(5000) }));
A.deepEqual(wsMac.sent.at(-1), { t: 'error', code: 'bad_msg' }, 'a 5 KB chat frame is still refused');
await say(room, wsMac, `{"t":"avatar","jpeg":"${bigPic}"${' '.repeat(AVATAR_FRAME_MAX)}}`);
A.deepEqual(wsMac.sent.at(-1), { t: 'error', code: 'bad_msg' }, 'over 9216 even for an avatar');
for (const ws of all) ws.drain();

// A joiner gets every stored avatar right after its welcome — also after a hibernation wake.
room = new PartyRoom(ctx, env);
await room.ready;
rooms.get(CODE).room = room;
A.equal(room.state.members[PH].avatarRev, 2, 'revisions survive a reload');
const wsLate = await join(room, 'Late', { platform: 'ios' });
A.deepEqual(wsLate.sent.slice(0, 3).map((m) => [m.t, m.id, m.rev]),
  [['welcome', undefined, undefined], ['avatar', TV, 1], ['avatar', PH, 2]], 'welcome, then the avatars in join order');
A.deepEqual([wsLate.sent[1].jpeg, wsLate.sent[2].jpeg], [bigPic, PIC2]);
A.equal(wsLate.sent.length, 3, 'nothing else to the joiner');
A.deepEqual(wsTV.drain().map((m) => m.t), ['roster'], 'the others hear the roster only');
const LATE = wsLate.sent[0].you.id;
all.push(wsLate);

// Peek: ?avatars=1 adds the photos on the user route only; the /p/ page never shows one.
peek = await (await req(`/party/${CODE}?avatars=1`)).json();
A.deepEqual(peek.members.map((m) => m.avatar ?? null), [bigPic, PIC2, null, null, null]);
A.ok(peek.members.every((m) => !('id' in m)), 'still no ids');
A.ok((await (await req(`/party/${CODE}`)).json()).members.every((m) => !('avatar' in m)), 'no photos without ?avatars=1');
A.equal((await req(`/party/${CODE}?avatars=1`, { token: '' })).status, 401, 'the photo peek needs the user token');
let html = await (await req(`/p/${CODE}?avatars=1`, { token: '' })).text();
A.ok(!html.includes(PIC2.slice(0, 40)) && !html.includes(bigPic.slice(0, 40)) && !html.includes('/9j/'), 'the public page has no JPEG');

// ── Control through the DO: host mode refuses the Mac and the old app, obeys the TV ──
section();
await say(room, wsTV, { t: 'settings', control: 'host' });
A.deepEqual(last(wsOld, 'settings').settings, { control: 'host', everyoneControls: false, waitForStragglers: false, stragglerTimeoutMs: 20000 });
for (const ws of all) ws.drain();
await say(room, wsMac, { t: 'seek', to: 5, c: 'm1' });
A.deepEqual(wsMac.drain().map((m) => m.code ?? m.t), ['forbidden', 'state']);
await say(room, wsOld, { t: 'play', c: 'o2' });
A.deepEqual(wsOld.drain().map((m) => m.code ?? m.t), ['forbidden', 'state'], 'an old app in host mode gets what it already handles');
await say(room, wsTV, { t: 'seek', to: 5, c: 't1' });
A.equal(last(wsMac, 'state').playback.by, TV);
await say(room, wsMac, { t: 'settings', control: 'shared' });
A.deepEqual(wsMac.sent.at(-1), { t: 'error', code: 'forbidden', re: 'settings' });
await say(room, wsTV, { t: 'settings', everyoneControls: true });   // the old field, from an old host
A.equal(last(wsMac, 'settings').settings.control, 'shared');
A.equal((await (await req(`/party/${CODE}`)).json()).control, 'shared');
for (const ws of all) ws.drain();
// Watch along through the DO.
await say(room, wsPh, { t: 'role', role: 'member' });
A.equal(last(wsTV, 'roster').members.find((m) => m.id === PH).role, 'member');
A.equal(last(wsPh, 'roster').members.find((m) => m.id === PH).role, 'member', 'the phone hears it too');
await say(room, wsMac, { t: 'role', role: 'companion' });
A.deepEqual(wsMac.sent.at(-1), { t: 'error', code: 'bad_msg', re: 'role' });
for (const ws of all) ws.drain();

// ── Avatar keys go with the member (leave, kick, sweep) and with the room ──
section();
await say(room, wsLate, { t: 'avatar', jpeg: PIC3 });
await say(room, wsMac, { t: 'avatar', jpeg: PIC });
await say(room, wsOld, { t: 'avatar', jpeg: PIC2 });
A.ok([LATE, MAC, OLD].every((id) => ctx.data.has(avatarKey(id))));
await say(room, wsLate, { t: 'leave' });
A.ok(!ctx.data.has(avatarKey(LATE)), 'leave deletes it');
await say(room, wsTV, { t: 'kick', id: MAC });
A.ok(!ctx.data.has(avatarKey(MAC)), 'kick deletes it');
await room.webSocketClose(wsOld, 1006, '', false);
A.ok(ctx.data.has(avatarKey(OLD)), 'a disconnect keeps it (the phone may come right back)');
skew += 61_000;
await room.alarm();
A.ok(!(OLD in room.state.members) && !ctx.data.has(avatarKey(OLD)), 'the sweep deletes it');
A.ok(ctx.data.has(avatarKey(PH)) && ctx.data.has(avatarKey(TV)));
await say(room, wsTV, { t: 'end' });
A.equal(ctx.data.size, 0, 'the room is destroyed with every avatar:* key');
// A new room under the code of a dead one starts without the dead room's avatars.
const ctxDead = makeCtx();
await ctxDead.storage.put('state', { ...fresh({ code: 'DED234', now: Date.now(), host: HOST }), ended: true });
await ctxDead.storage.put(avatarKey('m_gone'), PIC);
const roomDead = new PartyRoom(ctxDead, env);
await roomDead.ready;
res = await roomDead.fetch(new Request('https://party/init', { method: 'POST', body: JSON.stringify({ code: 'DED234', host: { name: 'New' } }) }));
A.equal(res.status, 200);
A.deepEqual([...ctxDead.data.keys()], ['state'], 'init over a dead room clears its leftovers');

// ── /p/:code — companion link, browser link, escaping ──
section();
const P = (await (await req('/party', { method: 'POST', body: { name: 'Den' } })).json()).code;
html = await (await req(`/p/${P}`, { token: '' })).text();
A.ok(html.includes(`href="slimewatch://party?code=${P}"`), 'plain link as before');
A.ok(!html.includes('companion=1') && !html.includes('Watch in the browser'), 'no WEB_BASE → no browser link');
html = await (await req(`/p/${P}?companion=1`, { token: '' })).text();
A.ok(html.includes(`href="slimewatch://party?code=${P}&amp;companion=1"`), 'the app button keeps companion=1');
env.WEB_BASE = 'https://watch.byheir.com/';
html = await (await req(`/p/${P}?companion=1`, { token: '' })).text();
A.ok(html.includes(`<a class="btn2" href="https://watch.byheir.com/#party/${P}">Watch in the browser</a>`));
A.ok(!/<script|<link|src=/i.test(html), 'still self-contained');
env.WEB_BASE = 'javascript:alert(1)';
A.ok(!(await (await req(`/p/${P}`, { token: '' })).text()).includes('Watch in the browser'), 'only an http(s) base');
env.WEB_BASE = 'https://x.test/"><b>';
html = await (await req(`/p/${P}`, { token: '' })).text();
A.ok(html.includes('href="https://x.test/&quot;&gt;&lt;b&gt;/#party/') && !html.includes('"><b>'), 'escaped');
env.WEB_BASE = 'https://watch.byheir.com';
A.equal((await req('/p/nope?companion=1', { token: '' })).status, 404);
delete env.WEB_BASE;

// ── A room stored by the pre-Wave 7 relay, loaded by the new DO ──
section();
const ctxOld = makeCtx();
const stored = { ...OLD_ROOM(true), createdAt: Date.now(), lastActivity: Date.now() };
for (const m of Object.values(stored.members)) { m.connected = false; m.joinedAt = Date.now(); m.lastSeen = Date.now(); }
stored.members.m_m.joinedAt += 1;
await ctxOld.storage.put('state', stored);
rooms.set('PRE234', { ctx: ctxOld, room: new PartyRoom(ctxOld, env) });
const roomOld = rooms.get('PRE234').room;
await roomOld.ready;
peek = await (await req('/party/PRE234')).json();
A.deepEqual([peek.control, peek.everyoneControls, peek.hostName, peek.memberCount], ['shared', true, 'm_h', 0], 'it peeks');
const wsH = await join(roomOld, 'H', { memberId: 'm_h', secret: 's-m_h' });   // its shipped host app resumes
A.deepEqual([wsH.sent[0].you.role, wsH.sent[0].room.settings.control, wsH.sent[0].room.settings.everyoneControls],
  ['host', 'shared', true]);
A.deepEqual(ctxOld.data.get('state').settings, { control: 'shared', everyoneControls: true, waitForStragglers: true,
  stragglerTimeoutMs: 20000 }, 'stored migrated');
const wsM = await join(roomOld, 'M', { memberId: 'm_m', secret: 's-m_m' });
A.equal(wsM.sent[0].you.role, 'member');
await say(roomOld, wsH, { t: 'play', at: 10, c: 'h1' });
skew += 3000;
await say(roomOld, wsM, { t: 'report', pos: 11, playing: true, buffering: true, engine: 'av' });
A.deepEqual(last(wsH, 'state').playback.waitingFor, ['m_m'], 'its straggler wait still works');
skew += 3000;
await say(roomOld, wsM, { t: 'ready' });
A.equal(last(wsH, 'state').playback.reason, 'resume');
await say(roomOld, wsH, { t: 'end' });
A.equal(ctxOld.data.size, 0);

// ── What old apps receive ──
section();
A.ok([...seenFrames].every((t) => OLD_FRAMES.has(t) || t === 'avatar'), `only known frames + avatar: ${[...seenFrames]}`);
A.ok(seenFrames.has('avatar'));
A.ok(settingsSeen.length >= 10);
for (const st of settingsSeen) {
  A.ok(typeof st.everyoneControls === 'boolean' && typeof st.waitForStragglers === 'boolean', 'settings decodable by old apps');
  A.equal(st.everyoneControls, st.control === 'shared', 'everyoneControls mirrors control');
}

console.log(`party-w7 OK (${cases} cases, ${checks} checks)`);
