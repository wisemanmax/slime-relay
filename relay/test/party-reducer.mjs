// The Watch Party reducer (src/party-reducer.js): pure, so every rule is driven
// here with a hand-moved clock — seq ordering, the playback anchor, control
// permissions, items/queue, the straggler wait, membership, host migration.
// Run: node test/party-reducer.mjs
import assert from 'node:assert/strict';
import {
  fresh, reduce, expectedTime, memberPublic, peekView, validItem, clampTime, clampRate,
  CODE_RE, MAX_MEMBERS, genCode, stragglerDeadline,
} from '../src/party-reducer.js';

const T0 = 1_760_000_000_000;
const HOST = { id: 'm_host', name: 'Hana', emoji: '🍿', accentHex: '#37E29A', secret: 'host-secret', device: 'dev-host' };
const FIGHT_CLUB = { tmdbID: 550, kind: 'movie', title: 'Fight Club', posterPath: '/fc.jpg' };
const EP = (episode) => ({ tmdbID: 1396, kind: 'tv', season: 1, episode, title: 'Breaking Bad' });

const run = (s, msg, from, now) => reduce(s, msg, { now, from });
const of = (fx, t) => fx.filter((e) => e.msg?.t === t);
const one = (fx, t) => { const m = of(fx, t); assert.equal(m.length, 1, `exactly one ${t}`); return m[0]; };
const hello = (s, id, now, extra = {}) =>
  run(s, { t: 'member:hello', member: { id, name: id.slice(2), engine: 'av', ...extra }, newSecret: `sec-${id}` }, id, now);
// Apply and return the new state (asserting the message wasn't rejected).
function ok(s, msg, from, now) {
  const r = run(s, msg, from, now);
  assert.ok(!of(r.effects, 'error').length, `${msg.t} rejected: ${JSON.stringify(of(r.effects, 'error'))}`);
  return r;
}

// ── fresh ──
let s = fresh({ code: 'ABC234', now: T0, host: HOST });
assert.equal(s.v, 1);
assert.equal(s.code, 'ABC234');
assert.equal(s.seq, 0);
assert.equal(s.hostId, 'm_host');
// Wave 7 adds control: 'shared' — the same default as everyoneControls: true.
assert.deepEqual(s.settings, { control: 'shared', everyoneControls: true, waitForStragglers: false, stragglerTimeoutMs: 20000 });
assert.deepEqual(s.playback, { playing: false, mediaTime: 0, serverTimeAtUpdate: T0, rate: 1, seq: 0, by: null,
  cmd: null, reason: 'item', waitingFor: [] });
assert.equal(s.item, null);
assert.deepEqual(s.queue, []);
assert.equal(s.members.m_host.role, 'host');
assert.equal(s.members.m_host.connected, false, 'the host row connects with its hello');
assert.equal(s.members.m_host.secret, 'host-secret');
assert.deepEqual(peekView(s), { code: 'ABC234', item: null, memberCount: 0, members: [], everyoneControls: true,
  createdAt: T0, hostName: 'Hana', control: 'shared', hostPlatform: '', companions: 0 });   // last 3: Wave 7

// ── hello: the host resumes its row with the secret ──
let r = hello(s, 'm_host', T0 + 100, { secret: 'host-secret', name: 'Hana' });
const welcome = one(r.effects, 'welcome');
assert.equal(welcome.to, 'm_host');
assert.equal(welcome.msg.v, 1);
assert.equal(welcome.msg.serverTime, T0 + 100);
assert.deepEqual(welcome.msg.you, { id: 'm_host', role: 'host', secret: 'host-secret' });
assert.deepEqual(Object.keys(welcome.msg.room).sort(), ['code', 'hostId', 'item', 'members', 'playback', 'queue', 'settings']);
assert.ok(!('secret' in welcome.msg.room.members[0]) && !('device' in welcome.msg.room.members[0]), 'room view is public');
assert.equal(one(r.effects, 'roster').to, 'others');
s = r.state;
assert.equal(s.seq, 1);
assert.equal(s.members.m_host.connected, true);

// Wrong / missing secret for a known id: bad_hello + close 4002, nothing changes.
for (const secret of ['nope', undefined]) {
  r = hello(s, 'm_host', T0 + 200, secret === undefined ? {} : { secret });
  assert.deepEqual(r.effects, [{ to: 'm_host', msg: { t: 'error', code: 'bad_hello' } },
                               { close: 'm_host', code: 4002, reason: 'bad_hello' }]);
  assert.deepEqual(r.state, s);
}
assert.equal(of(hello(s, '__proto__', T0).effects, 'error')[0].msg.code, 'bad_hello', 'ids are m_-prefixed');

// Members join: B (av), C (embed), sanitized fields, fresh secrets.
r = hello(s, 'm_b', T0 + 1000, { name: '  Bob\u0007 the very long name indeed!!  ', emoji: '👨‍👩‍👧‍👦', accentHex: 'red', device: 'dev-b' });
assert.deepEqual(one(r.effects, 'welcome').msg.you, { id: 'm_b', role: 'member', secret: 'sec-m_b' });
s = r.state;
assert.equal(s.members.m_b.name, 'Bob  the very long name');
assert.equal(s.members.m_b.emoji, '👨‍👩‍👧‍👦', 'a 7-code-point ZWJ emoji fits');
assert.equal(s.members.m_b.accentHex, '');
assert.equal(s.members.m_b.device, 'dev-b');
s = hello(s, 'm_c', T0 + 2000, { engine: 'embed' }).state;
assert.equal(s.members.m_c.engine, 'embed');
assert.deepEqual(memberPublic(s.members.m_b).secret, undefined);
assert.deepEqual(memberPublic(s.members.m_b).device, undefined);
assert.equal(peekView(s).memberCount, 3);
assert.deepEqual(peekView(s).members.map((m) => m.name), ['Hana', 'Bob  the very long name', 'c']);

// ── seq: strictly increases on mutating messages, never on report ──
const seqs = [s.seq];
const T1 = T0 + 10_000;
for (const [msg, from, dt] of [
  [{ t: 'setItem', item: FIGHT_CLUB }, 'm_host', 0],
  [{ t: 'play', at: 10, c: 'cmd-1' }, 'm_b', 10],
  [{ t: 'seek', to: 50 }, 'm_c', 20],
  [{ t: 'rate', rate: 1.5 }, 'm_host', 30],
  [{ t: 'pause' }, 'm_b', 40],
  [{ t: 'queue', op: 'add', item: EP(1) }, 'm_host', 50],
  [{ t: 'settings', waitForStragglers: false }, 'm_host', 60],
]) {
  s = ok(s, msg, from, T1 + dt).state;
  assert.ok(s.seq > seqs.at(-1), `${msg.t} bumps seq`);
  seqs.push(s.seq);
}
r = ok(s, { t: 'report', pos: 51, dur: 8000, playing: false, buffering: false, engine: 'av', synced: true }, 'm_b', T1 + 70);
assert.equal(r.state.seq, s.seq, 'report does not bump seq');
assert.equal(r.state.members.m_b.synced, true);
assert.equal(r.state.members.m_b.pos, 51);
assert.equal(r.state.members.m_b.reportedAt, T1 + 70);
const memberMsg = one(r.effects, 'member');
assert.equal(memberMsg.to, 'others');
assert.equal(memberMsg.msg.id, 'm_b');
assert.ok(!('secret' in memberMsg.msg) && !('device' in memberMsg.msg));
s = r.state;
assert.equal(ok(s, { t: 'chat', text: 'hi' }, 'm_b', T1 + 80).state.seq, s.seq, 'chat does not bump seq');

// Transport echoes: state to all with by/cmd/reason.
r = ok(s, { t: 'play', at: 10, c: 'cmd-9' }, 'm_b', T1 + 100);
const st = one(r.effects, 'state');
assert.equal(st.to, 'all');
assert.equal(st.msg.seq, r.state.seq);
assert.deepEqual(st.msg.playback, { ...r.state.playback });
assert.equal(st.msg.playback.by, 'm_b');
assert.equal(st.msg.playback.cmd, 'cmd-9');
assert.equal(st.msg.playback.reason, 'user');
assert.equal(st.msg.playback.seq, r.state.seq);

// ── expectedTime continuity across rate changes and pause/play ──
const T2 = T0 + 100_000;
s = ok(s, { t: 'rate', rate: 1 }, 'm_host', T2 - 1).state;
s = ok(s, { t: 'play', at: 10 }, 'm_host', T2).state;
assert.equal(expectedTime(s.playback, T2 + 5000), 15);
s = ok(s, { t: 'rate', rate: 2 }, 'm_host', T2 + 5000).state;
assert.equal(s.playback.mediaTime, 15, 'rate re-anchors at the current position');
assert.equal(s.playback.rate, 2);
assert.equal(s.playback.playing, true);
assert.equal(expectedTime(s.playback, T2 + 7000), 19);
s = ok(s, { t: 'pause' }, 'm_b', T2 + 7000).state;
assert.equal(s.playback.mediaTime, 19, 'pause with no `at` freezes the expected position');
assert.equal(expectedTime(s.playback, T2 + 60_000), 19, 'paused time does not move');
s = ok(s, { t: 'play', at: 'garbage' }, 'm_b', T2 + 20_000).state;
assert.equal(s.playback.mediaTime, 19, 'an invalid `at` defaults to the expected position');
assert.equal(expectedTime(s.playback, T2 + 21_000), 21, 'rate survives pause/play');
s = ok(s, { t: 'rate', rate: 5 }, 'm_host', T2 + 21_000).state;
assert.equal(s.playback.rate, 2, 'rate clamps to 2');
s = ok(s, { t: 'rate', rate: 0.1 }, 'm_host', T2 + 21_000).state;
assert.equal(s.playback.rate, 0.5, 'rate clamps to 0.5');
assert.equal(s.playback.mediaTime, 21);
assert.equal(one(run(s, { t: 'rate', rate: 'fast' }, 'm_host', T2).effects, 'error').msg.code, 'bad_msg');
s = ok(s, { t: 'seek', to: 100, playing: false }, 'm_host', T2 + 22_000).state;
assert.deepEqual([s.playback.mediaTime, s.playback.playing], [100, false]);
s = ok(s, { t: 'seek', to: -5 }, 'm_host', T2 + 22_000).state;
assert.equal(s.playback.mediaTime, 0, 'negative times clamp to 0');
s = ok(s, { t: 'rate', rate: 1 }, 'm_host', T2 + 22_000).state;

// ── Control permissions ──
s = ok(s, { t: 'settings', everyoneControls: false }, 'm_host', T2 + 30_000).state;
assert.equal(s.settings.everyoneControls, false);
for (const msg of [{ t: 'play' }, { t: 'pause', at: 3 }, { t: 'seek', to: 9 }, { t: 'rate', rate: 2 }]) {
  r = run(s, msg, 'm_b', T2 + 31_000);
  assert.deepEqual(r.effects, [
    { to: 'm_b', msg: { t: 'error', code: 'forbidden', re: msg.t } },
    { to: 'm_b', msg: { t: 'state', seq: s.seq, playback: s.playback } },
  ], `${msg.t}: forbidden + the current state to snap back to`);
  assert.deepEqual(r.state, s, `${msg.t}: state untouched`);
}
assert.equal(one(run(s, { t: 'setItem', item: EP(2) }, 'm_b', T2).effects, 'error').msg.code, 'forbidden');
assert.equal(one(run(s, { t: 'queue', op: 'add', item: EP(2) }, 'm_b', T2).effects, 'error').msg.code, 'forbidden');
assert.equal(one(run(s, { t: 'settings', everyoneControls: true }, 'm_b', T2).effects, 'error').msg.code, 'forbidden');
r = ok(s, { t: 'pause', at: 42 }, 'm_host', T2 + 32_000);
assert.equal(r.state.playback.mediaTime, 42, 'a locked room still obeys the host');
s = ok(r.state, { t: 'settings', everyoneControls: true }, 'm_host', T2 + 33_000).state;
s = ok(s, { t: 'play', at: 42 }, 'm_b', T2 + 34_000).state;
assert.equal(s.playback.by, 'm_b', 'unlocked: members control again');

// ── setItem ──
s = ok(s, { t: 'report', synced: true }, 'm_b', T2 + 35_000).state;
s = ok(s, { t: 'report', synced: true }, 'm_c', T2 + 35_000).state;
r = run(s, { t: 'setItem', item: { ...FIGHT_CLUB, title: 'Renamed' } }, 'm_host', T2 + 36_000);
assert.deepEqual(r.effects, [], 'same item (tmdbID/kind/season/episode) is a no-op');
assert.equal(r.state.seq, s.seq);
r = ok(s, { t: 'setItem', item: EP(1), startAt: 30 }, 'm_b', T2 + 36_000);
assert.deepEqual(r.effects.map((e) => [e.to, e.msg.t]), [['all', 'item'], ['all', 'state']]);
const itemMsg = r.effects[0].msg;
assert.deepEqual(itemMsg.item, { tmdbID: 1396, kind: 'tv', season: 1, episode: 1, absoluteEpisode: null,
  title: 'Breaking Bad', posterPath: null });
assert.equal(itemMsg.by, 'm_b');
assert.deepEqual(itemMsg.queue, r.state.queue);
assert.equal(itemMsg.seq, r.state.seq);
assert.deepEqual(r.state.playback, { playing: false, mediaTime: 30, serverTimeAtUpdate: T2 + 36_000, rate: 1,
  seq: r.state.seq, by: 'm_b', cmd: null, reason: 'item', waitingFor: [] });
assert.ok(Object.values(r.state.members).every((m) => m.synced === false), 'a new item clears synced');
s = r.state;
assert.equal(ok(s, { t: 'setItem', item: EP(2) }, 'm_host', T2).state.playback.mediaTime, 0, 'startAt defaults to 0');
assert.notEqual(ok(s, { t: 'setItem', item: EP(2) }, 'm_host', T2).state.seq, s.seq, 'another episode is a new item');
for (const bad of [
  { ...FIGHT_CLUB, kind: 'music' }, { ...FIGHT_CLUB, tmdbID: 0 }, { ...FIGHT_CLUB, tmdbID: '550' },
  { ...EP(1), season: 'one' }, { ...EP(1), episode: -1 }, null, 'Fight Club',
]) {
  r = run(s, { t: 'setItem', item: bad }, 'm_host', T2);
  assert.equal(one(r.effects, 'error').msg.code, 'bad_msg', `rejects ${JSON.stringify(bad)}`);
  assert.deepEqual(r.state, s);
}

// ── Queue ──
assert.equal(s.queue.length, 1);
s = ok(s, { t: 'queue', op: 'add', item: EP(2) }, 'm_host', T2 + 40_000).state;
r = ok(s, { t: 'queue', op: 'remove', index: 0 }, 'm_host', T2 + 40_001);
assert.deepEqual(r.effects.map((e) => e.msg.t), ['queue']);
assert.deepEqual(r.state.queue.map((i) => i.episode), [2]);
s = r.state;
r = ok(s, { t: 'queue', op: 'playNext' }, 'm_host', T2 + 40_002);
assert.deepEqual(r.effects.map((e) => e.msg.t), ['item', 'state']);
assert.equal(r.state.item.episode, 2);
assert.deepEqual(r.state.queue, []);
s = r.state;
assert.equal(one(run(s, { t: 'queue', op: 'playNext' }, 'm_host', T2).effects, 'error').msg.code, 'queue_empty');
assert.equal(one(run(s, { t: 'queue', op: 'remove', index: 3 }, 'm_host', T2).effects, 'error').msg.code, 'bad_msg');
let q = s;
for (let i = 1; i <= 20; i++) q = ok(q, { t: 'queue', op: 'add', item: EP(i + 10) }, 'm_host', T2).state;
assert.equal(q.queue.length, 20);
assert.equal(one(run(q, { t: 'queue', op: 'add', item: EP(99) }, 'm_host', T2).effects, 'error').msg.code, 'queue_full');

// ── Straggler wait ──
const T3 = T0 + 200_000;
s = ok(s, { t: 'play', at: 0 }, 'm_host', T3).state;
// Disabled by default.
r = ok(s, { t: 'report', buffering: true }, 'm_b', T3 + 1000);
assert.equal(r.state.playback.playing, true, 'off by default: buffering does not pause the room');
assert.deepEqual(r.effects.map((e) => e.msg?.t ?? 'alarm'), ['member']);
s = ok(r.state, { t: 'report', buffering: false }, 'm_b', T3 + 1500).state;
s = ok(s, { t: 'settings', waitForStragglers: true }, 'm_host', T3 + 2000).state;
assert.equal(s.settings.waitForStragglers, true);
// B starts buffering → the room waits for B.
r = ok(s, { t: 'report', buffering: true, pos: 2 }, 'm_b', T3 + 5000);
let seqBefore = s.seq;
s = r.state;
assert.deepEqual([s.playback.playing, s.playback.reason, s.playback.waitingFor], [false, 'waiting', ['m_b']]);
assert.equal(s.playback.mediaTime, 5, 'paused at the expected position (play at 0, 5 s later)');
assert.ok(s.seq > seqBefore);
assert.equal(one(r.effects, 'state').to, 'all');
assert.deepEqual(r.effects.filter((e) => 'alarm' in e), [{ alarm: T3 + 5000 + 20_000 }]);
assert.equal(stragglerDeadline(s), T3 + 25_000);
r = ok(s, { t: 'report', buffering: true }, 'm_b', T3 + 6000);
assert.equal(r.state.seq, s.seq, 'still buffering: no re-trigger');
assert.ok(!r.effects.some((e) => 'alarm' in e));
// B recovers → resume.
r = ok(s, { t: 'report', buffering: false }, 'm_b', T3 + 8000);
s = r.state;
assert.deepEqual([s.playback.playing, s.playback.reason, s.playback.waitingFor], [true, 'resume', []]);
assert.equal(s.playback.mediaTime, 5, 'resumes where it paused');
assert.equal(s.playback.serverTimeAtUpdate, T3 + 8000);
assert.equal(stragglerDeadline(s), null);
// ...or the alarm gives up on B.
s = ok(s, { t: 'report', buffering: true }, 'm_b', T3 + 9000).state;
assert.equal(s.playback.reason, 'waiting');
r = run(s, { t: 'alarm:straggler' }, null, T3 + 29_000);
assert.deepEqual([r.state.playback.playing, r.state.playback.reason], [true, 'resume']);
assert.equal(one(r.effects, 'state').to, 'all');
assert.equal(r.state.lastActivity, s.lastActivity, 'the DO waking itself is not room activity');
assert.deepEqual(run(r.state, { t: 'alarm:straggler' }, null, T3 + 30_000).effects, [], 'nothing to give up on');
s = r.state;
// ...or `ready` counts as recovered.
s = ok(s, { t: 'report', buffering: false }, 'm_b', T3 + 30_000).state;
s = ok(s, { t: 'report', buffering: true }, 'm_b', T3 + 31_000).state;
assert.equal(s.playback.reason, 'waiting');
s = ok(s, { t: 'ready' }, 'm_b', T3 + 32_000).state;
assert.deepEqual([s.playback.playing, s.playback.reason], [true, 'resume']);
// An embed member never stalls the room.
r = ok(s, { t: 'report', buffering: true }, 'm_c', T3 + 33_000);
assert.equal(r.state.playback.playing, true, 'embed buffering is ignored');
assert.equal(r.state.seq, s.seq);
s = ok(r.state, { t: 'report', buffering: false }, 'm_c', T3 + 33_500).state;
// Turning the setting off mid-wait releases the room.
s = ok(s, { t: 'report', buffering: true }, 'm_b', T3 + 34_000).state;
r = ok(s, { t: 'settings', waitForStragglers: false }, 'm_host', T3 + 35_000);
assert.deepEqual(r.effects.map((e) => e.msg.t), ['settings', 'state']);
assert.equal(r.state.playback.reason, 'resume');
s = ok(r.state, { t: 'report', buffering: false }, 'm_b', T3 + 35_500).state;

// ── Chat / react / typing ──
r = ok(s, { t: 'chat', text: `  ${'x'.repeat(500)}  ` }, 'm_b', T3 + 40_000);
const chatMsg = one(r.effects, 'chat');
assert.equal(chatMsg.to, 'all');
assert.equal(chatMsg.msg.text.length, 280, 'chat caps at 280');
assert.deepEqual([chatMsg.msg.from, chatMsg.msg.at], ['m_b', T3 + 40_000]);
assert.ok(!JSON.stringify(r.state).includes('xxxx'), 'chat is not stored');
assert.equal(r.state.seq, s.seq);
assert.equal(one(run(s, { t: 'chat', text: '   ' }, 'm_b', T3).effects, 'error').msg.code, 'bad_msg');
assert.equal(one(run(s, { t: 'chat', text: 42 }, 'm_b', T3).effects, 'error').msg.code, 'bad_msg');
assert.equal(one(ok(s, { t: 'react', emoji: '🔥' }, 'm_c', T3).effects, 'react').msg.emoji, '🔥');
assert.equal(one(run(s, { t: 'react', emoji: '' }, 'm_c', T3).effects, 'error').msg.code, 'bad_msg');
assert.equal(one(run(s, { t: 'react', emoji: 'way too long' }, 'm_c', T3).effects, 'error').msg.code, 'bad_msg');
r = ok(s, { t: 'typing', on: 1 }, 'm_c', T3 + 41_000);
assert.deepEqual(r.effects, [{ to: 'others', msg: { t: 'typing', from: 'm_c', name: 'c', on: true } }]);
assert.equal(r.state.lastActivity, s.lastActivity, 'typing is not activity');

// ── Bad / unknown / non-member messages ──
assert.equal(one(run(s, { t: 'explode' }, 'm_b', T3).effects, 'error').msg.code, 'bad_msg');
assert.equal(one(run(s, { t: 'constructor' }, 'm_b', T3).effects, 'error').msg.code, 'bad_msg');
assert.equal(one(run(s, null, 'm_b', T3).effects, 'error').msg.code, 'bad_msg');
assert.equal(one(run(s, { t: 'play' }, 'm_ghost', T3).effects, 'error').msg.code, 'not_member');

// ── transferHost ──
assert.equal(one(run(s, { t: 'transferHost', to: 'm_c' }, 'm_b', T3).effects, 'error').msg.code, 'forbidden');
assert.equal(one(run(s, { t: 'transferHost', to: 'm_ghost' }, 'm_host', T3).effects, 'error').msg.code, 'bad_msg');
r = ok(s, { t: 'transferHost', to: 'm_b' }, 'm_host', T3 + 42_000);
assert.deepEqual(one(r.effects, 'host').msg, { t: 'host', seq: r.state.seq, hostId: 'm_b', reason: 'transfer' });
assert.deepEqual([r.state.members.m_host.role, r.state.members.m_b.role], ['member', 'host']);
assert.equal(one(run(r.state, { t: 'settings', everyoneControls: false }, 'm_host', T3).effects, 'error').msg.code, 'forbidden');
s = ok(r.state, { t: 'transferHost', to: 'm_host' }, 'm_b', T3 + 43_000).state;
assert.equal(s.hostId, 'm_host');

// ── Host migration on sweep ──
// D joins last; then C (earlier joiner) and the host drop. The sweep must
// skip disconnected C and pick B (earliest-joined connected member).
s = hello(s, 'm_d', T3 + 44_000).state;
const TX = T0 + 300_000;
s = run(s, { t: 'member:disconnected', id: 'm_c' }, 'm_c', TX).state;
r = run(s, { t: 'member:disconnected', id: 'm_host' }, 'm_host', TX);
assert.equal(one(r.effects, 'roster').to, 'others');
assert.equal(one(r.effects, 'roster').msg.members.find((m) => m.id === 'm_host').connected, false);
s = r.state;
assert.equal(s.members.m_host.lastSeen, TX);
assert.deepEqual(run(s, { t: 'member:disconnected', id: 'm_host' }, 'm_host', TX + 1).effects, [], 'already disconnected');
r = run(s, { t: 'sweep' }, null, TX + 29_000);
assert.deepEqual(r.effects, [], 'within the host grace: nothing');
assert.equal(r.state.seq, s.seq);
r = run(s, { t: 'sweep' }, null, TX + 31_000);
assert.deepEqual(r.effects.map((e) => [e.to, e.msg.t]), [['all', 'host'], ['all', 'roster']]);
assert.deepEqual(r.effects[0].msg, { t: 'host', seq: r.state.seq, hostId: 'm_b', reason: 'migrated' });
assert.equal(r.state.hostId, 'm_b');
assert.deepEqual([r.state.members.m_host.role, r.state.members.m_b.role], ['member', 'host']);
assert.ok(r.state.seq > s.seq);
assert.equal(r.state.lastActivity, s.lastActivity, 'sweeps are not activity');
s = r.state;
r = run(s, { t: 'sweep' }, null, TX + 61_000);
assert.ok(!('m_host' in r.state.members) && !('m_c' in r.state.members), 'gone > 60 s: dropped');
assert.deepEqual(r.effects.map((e) => e.msg.t), ['roster']);
s = r.state;
// The old host comes back with its stale id + secret: a new member row.
r = hello(s, 'm_host', TX + 70_000, { secret: 'host-secret' });
assert.deepEqual(one(r.effects, 'welcome').msg.you, { id: 'm_host', role: 'member', secret: 'sec-m_host' });
s = r.state;

// ── kick ──
assert.equal(one(run(s, { t: 'kick', id: 'm_d' }, 'm_d', TX).effects, 'error').msg.code, 'forbidden');
assert.equal(one(run(s, { t: 'kick', id: 'm_b' }, 'm_b', TX).effects, 'error').msg.code, 'bad_msg', 'not yourself');
r = ok(s, { t: 'kick', id: 'm_d' }, 'm_b', TX + 71_000);
assert.ok(r.effects.some((e) => e.close === 'm_d' && e.code === 4003 && e.reason === 'kicked'), 'kick closes the socket');
assert.deepEqual(one(r.effects, 'closed'), { to: 'm_d', msg: { t: 'closed', reason: 'kicked' } });
assert.ok(!one(r.effects, 'roster').msg.members.some((m) => m.id === 'm_d'));
assert.ok(!('m_d' in r.state.members));
s = r.state;

// ── leave (host) migrates immediately ──
r = ok(s, { t: 'leave' }, 'm_b', TX + 72_000);
assert.ok(!('m_b' in r.state.members));
assert.equal(r.state.hostId, 'm_host');
assert.deepEqual(r.effects.map((e) => e.close ?? e.msg.t), ['m_b', 'host', 'roster']);
s = r.state;

// ── Room full: the 9th member is turned away ──
let full = s;
for (let i = 0; Object.keys(full.members).length < MAX_MEMBERS; i++) full = hello(full, `m_x${i}`, TX + 80_000 + i).state;
assert.equal(Object.keys(full.members).length, 8);
r = hello(full, 'm_ninth', TX + 90_000);
assert.deepEqual(r.effects, [{ to: 'm_ninth', msg: { t: 'error', code: 'full' } },
                             { close: 'm_ninth', code: 4001, reason: 'full' }]);
assert.deepEqual(r.state, full);
assert.ok(one(hello(full, 'm_host', TX + 90_000, { secret: 'sec-m_host' }).effects, 'welcome'), 'a full room still resumes members');

// ── end ──
assert.equal(one(run(s, { t: 'end' }, 'm_x0', TX).effects, 'error').msg.code, 'not_member');
r = ok(s, { t: 'end' }, 'm_host', TX + 95_000);
assert.deepEqual(r.effects, [{ to: 'all', msg: { t: 'closed', reason: 'ended' } }, { close: '*', code: 4000, reason: 'ended' }]);
assert.equal(r.state.ended, true);
assert.equal(one(run(r.state, { t: 'play' }, 'm_host', TX).effects, 'error').msg.code, 'closed');
assert.equal(one(hello(r.state, 'm_new', TX).effects, 'error').msg.code, 'closed');

// ── Pure helpers ──
assert.deepEqual(validItem({ tmdbID: 1, kind: 'anime', season: 1, episode: 3, absoluteEpisode: 27, title: 't'.repeat(200),
  posterPath: 'x'.repeat(201) }), { tmdbID: 1, kind: 'anime', season: 1, episode: 3, absoluteEpisode: 27,
  title: 't'.repeat(120), posterPath: null });
assert.equal(validItem({ tmdbID: 1.5, kind: 'movie' }), null);
assert.equal(clampTime(-1), 0);
assert.equal(clampTime(NaN, 7), 7);
assert.equal(clampTime('5', 7), 7);
assert.equal(clampTime(1e12), 7 * 86_400);
assert.equal(clampRate(3), 2);
assert.equal(clampRate(0), 0.5);
assert.equal(clampRate(undefined), 1);
assert.equal(expectedTime({ playing: true, mediaTime: 5, serverTimeAtUpdate: 1000, rate: 0.5 }, 5000), 7);

// ── genCode ──
for (let i = 0; i < 2000; i++) {
  const code = genCode();
  assert.equal(code.length, 6);
  assert.match(code, CODE_RE);
  assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
}
assert.equal(genCode(() => 0), 'AAAAAA');
assert.equal(genCode(() => 0.99999), '999999');
assert.equal(genCode(() => 1), 'AAAAAA', 'a randomFn returning 1 stays in range');
assert.ok(!CODE_RE.test('ABCDE1') && !CODE_RE.test('ABCDEO') && !CODE_RE.test('abc234') && !CODE_RE.test('ABC2345'));

console.log('party-reducer OK');
