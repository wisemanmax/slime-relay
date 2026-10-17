// Watch Party end to end without a runtime: the Worker's /party routes, the
// PartyRoom Durable Object behind a fake namespace (storage over a Map, fake
// sockets, a movable clock), hibernation reloads, host migration by alarm, the
// /p join page, expiry, and the presence `party` field.
// WebSocketPair doesn't exist in node, so sockets are attached with
// room.accept(ws) (what the upgrade path calls); the upgrade itself is only
// checked for its 404 / 426 answers.
// Run: node test/party.mjs
import assert from 'node:assert/strict';
import worker, { PartyRoom } from '../src/worker.js';
import { CODE_RE } from '../src/party-reducer.js';

const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;

function makeKV() {
  const m = new Map();   // key -> { value, exp (ms, 0 = none) }
  const live = (k) => {
    const e = m.get(k);
    if (e && e.exp && e.exp <= Date.now()) { m.delete(k); return null; }
    return e || null;
  };
  return {
    m,
    async get(k) { return live(k)?.value ?? null; },
    async put(k, v, o = {}) { m.set(k, { value: String(v), exp: o.expirationTtl ? Date.now() + o.expirationTtl * 1000 : 0 }); },
    async delete(k) { m.delete(k); },
    async list({ prefix = '' } = {}) {
      return { keys: [...m.keys()].sort().filter((k) => k.startsWith(prefix) && live(k)).map((name) => ({ name })), list_complete: true };
    },
  };
}

function makeCtx() {
  const data = new Map();
  const sockets = [];
  let alarm = null;
  return {
    data, sockets,
    get alarmAt() { return alarm; },
    storage: {
      async get(k) { return data.has(k) ? structuredClone(data.get(k)) : undefined; },
      async put(k, v) { data.set(k, structuredClone(v)); },
      async delete(k) { return data.delete(k); },
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
    send(s) { if (this.closed) throw new Error('send on a closed socket'); this.sent.push(JSON.parse(s)); },
    close(code, reason) { if (!this.closed) this.closed = { code, reason }; },
    serializeAttachment(v) { this.att = structuredClone(v); },
    deserializeAttachment() { return structuredClone(this.att); },
    drain() { const out = this.sent; this.sent = []; return out; },
  };
}

const kv = makeKV();
const rooms = new Map();   // code -> { ctx, room } — one live instance per name, like the runtime
function roomFor(code) {
  if (!rooms.has(code)) { const ctx = makeCtx(); rooms.set(code, { ctx, room: new PartyRoom(ctx, env) }); }
  return rooms.get(code);
}
const env = {
  ADMIN_TOKEN: 'admin', USER_TOKEN: 'user', SERVERS: kv,
  PARTY: {
    idFromName: (name) => ({ name }),
    get: (id) => ({ fetch: (input, init) => roomFor(id.name).room.fetch(new Request(input, init)) }),
  },
};

let ipn = 0;
async function req(path, { method = 'GET', token = 'user', body, headers = {}, ip } = {}) {
  ipn++;   // a fresh client IP per call unless one is given (rate-limit tests)
  return worker.fetch(new Request(`https://relay.test${path}`, {
    method, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
               'cf-connecting-ip': ip ?? `10.7.${ipn >> 8}.${ipn & 255}`, ...headers },
  }), env);
}
const frame = (ws, msg) => (typeof msg === 'string' ? msg : JSON.stringify(msg));
const last = (ws, t) => ws.sent.filter((m) => m.t === t).at(-1);

// ── POST /party ──
assert.equal((await req('/party', { method: 'POST', token: 'nope', body: {} })).status, 401);
assert.equal((await req('/party', { method: 'POST', body: '{nope' })).status, 400);
assert.equal((await req('/party')).status, 405);
let r = await req('/party', { method: 'POST', body: { device: 'dev-a', name: 'Ann', emoji: '🍿', accentHex: '#37E29A' } });
assert.equal(r.status, 200);
const created = await r.json();
const CODE = created.code;
assert.match(CODE, CODE_RE);
assert.match(created.hostSecret, /^[0-9a-f]{32}$/);
assert.match(created.memberId, /^m_[0-9a-f]{12}$/);
assert.equal(created.joinUrl, `https://relay.test/p/${CODE}`);
assert.ok(Math.abs(created.expiresAt - (Date.now() + 86_400_000)) < 5000);
assert.equal(JSON.parse(kv.m.get(`party:${CODE}`).value).host, 'Ann', 'registered in KV for /party/rooms');
const { ctx } = rooms.get(CODE);
assert.ok(Math.abs(ctx.alarmAt - (Date.now() + 600_000)) < 5000, 'first alarm in 10 min');
assert.equal(ctx.data.get('state').members[created.memberId].secret, created.hostSecret);

// Code collision: with randomness pinned, every code is AAAAAA — the second
// create retries 3 times, then gives up.
const realGRV = crypto.getRandomValues;
crypto.getRandomValues = (a) => a.fill(0);
let inits = 0;
const countedGet = env.PARTY.get;
env.PARTY.get = (id) => ({ fetch: (input, init) => { if (String(input).endsWith('/init')) inits++; return countedGet(id).fetch(input, init); } });
assert.equal((await req('/party', { method: 'POST', body: { name: 'Zed' } })).status, 200);
inits = 0;
r = await req('/party', { method: 'POST', body: { name: 'Zed' } });
assert.equal(r.status, 503);
assert.equal(inits, 4, 'one try + 3 retries on 409');
env.PARTY.get = countedGet;
crypto.getRandomValues = realGRV;
rooms.delete('AAAAAA');
kv.m.delete('party:AAAAAA');

// Per-IP create limit: 10/min.
for (let i = 0; i < 10; i++) assert.equal((await req('/party', { method: 'POST', body: {}, ip: '10.200.0.1' })).status, 200);
assert.equal((await req('/party', { method: 'POST', body: {}, ip: '10.200.0.1' })).status, 429);

// ── GET /party/:code (peek) ──
r = await req(`/party/${CODE}`);
assert.equal(r.status, 200);
assert.deepEqual(await r.json(), { code: CODE, item: null, memberCount: 0, members: [], everyoneControls: true,
  createdAt: ctx.data.get('state').createdAt, hostName: 'Ann' });
assert.equal((await req(`/party/${CODE.toLowerCase()}`)).status, 200, 'codes are case-insensitive');
assert.equal((await req('/party/no!pe')).status, 400);
assert.equal((await req('/party/ABCDEO')).status, 400, 'O is not in the alphabet');
assert.equal((await req('/party/ZZZZZZ')).status, 404);
assert.equal((await req(`/party/${CODE}`, { token: '' })).status, 401);
for (let i = 0; i < 60; i++) await req('/party/ZZZZZZ', { ip: '10.200.0.2' });
assert.equal((await req(`/party/${CODE}`, { ip: '10.200.0.2' })).status, 429, 'peek limit 60/min');

// ── WebSocket route (the upgrade itself needs the runtime) ──
assert.equal((await req('/party/ZZZZZZ/ws', { headers: { upgrade: 'websocket' } })).status, 404, 'no live room');
assert.equal((await req(`/party/${CODE}/ws`)).status, 426, 'not an upgrade');
assert.equal((await req(`/party/${CODE}/ws`, { token: 'nope', headers: { upgrade: 'websocket' } })).status, 401);
assert.equal((await req('/party/bad/ws', { headers: { upgrade: 'websocket' } })).status, 400);

// ── The room: a fresh instance reloads from storage (a hibernation wake) ──
let room = new PartyRoom(ctx, env);
await room.ready;
rooms.get(CODE).room = room;
assert.equal(room.state.code, CODE);

const wsA = makeWS('A'), wsB = makeWS('B');
room.accept(wsA);
room.accept(wsB);
await room.webSocketMessage(wsA, frame(wsA, { t: 'ping', c: 1 }));
assert.deepEqual(wsA.drain(), [{ t: 'error', code: 'hello_required' }]);
await room.webSocketMessage(wsA, '{not json');
assert.deepEqual(wsA.drain(), [{ t: 'error', code: 'bad_msg' }]);
await room.webSocketMessage(wsA, 'x'.repeat(5000));
assert.deepEqual(wsA.drain(), [{ t: 'error', code: 'bad_msg' }], 'oversized frame');

// Host connects with the id + secret POST /party returned.
await room.webSocketMessage(wsA, frame(wsA, { t: 'hello', v: 1, device: 'dev-a', name: 'Ann', emoji: '🍿',
  accentHex: '#37E29A', engine: 'av', memberId: created.memberId, secret: created.hostSecret }));
let [welcomeA] = wsA.drain();
assert.equal(welcomeA.t, 'welcome');
assert.equal(welcomeA.v, 1);
assert.equal(typeof welcomeA.serverTime, 'number');
assert.deepEqual(welcomeA.you, { id: created.memberId, role: 'host', secret: created.hostSecret });
assert.equal(welcomeA.room.code, CODE);
assert.equal(welcomeA.room.hostId, created.memberId);
assert.deepEqual(welcomeA.room.members.map((m) => [m.name, m.connected]), [['Ann', true]]);
assert.ok(!('secret' in welcomeA.room.members[0]));
const A = created.memberId;

// A guest joins: new id + secret; the host hears the roster.
await room.webSocketMessage(wsB, frame(wsB, { t: 'hello', v: 1, device: 'dev-b', name: 'Bob', engine: 'vlc' }));
const [welcomeB] = wsB.drain();
assert.equal(welcomeB.t, 'welcome');
assert.equal(welcomeB.you.role, 'member');
assert.match(welcomeB.you.id, /^m_[0-9a-f]{12}$/);
assert.match(welcomeB.you.secret, /^[0-9a-f]{32}$/);
const B = welcomeB.you.id;
const rosterA = wsA.drain();
assert.deepEqual(rosterA.map((m) => m.t), ['roster']);
assert.deepEqual(rosterA[0].members.map((m) => m.name), ['Ann', 'Bob']);
assert.equal((await (await req(`/party/${CODE}`)).json()).memberCount, 2);

// A hello with A's id and a wrong secret: only the impostor socket is told off.
const wsX = makeWS('X');
room.accept(wsX);
await room.webSocketMessage(wsX, frame(wsX, { t: 'hello', memberId: A, secret: 'wrong', name: 'Mallory' }));
assert.deepEqual(wsX.drain(), [{ t: 'error', code: 'bad_hello' }]);
assert.equal(wsX.closed.code, 4002);
assert.equal(wsA.closed, null, 'the real member keeps its socket');
assert.deepEqual(wsA.drain(), []);
assert.equal(room.state.members[A].name, 'Ann');

// ping / sync / client-sent system messages
await room.webSocketMessage(wsA, frame(wsA, { t: 'ping', c: 7 }));
const pong = wsA.drain()[0];
assert.equal(pong.t, 'pong');
assert.equal(pong.c, 7);
assert.ok(Math.abs(pong.s - Date.now()) < 1000);
await room.webSocketMessage(wsB, frame(wsB, { t: 'sync' }));
assert.deepEqual(wsB.drain(), [{ t: 'state', seq: room.state.seq, playback: room.state.playback }]);
for (const t of ['sweep', 'member:hello', 'member:disconnected', 'alarm:straggler', 'hello']) {
  await room.webSocketMessage(wsB, frame(wsB, { t, id: A }));
  assert.equal(wsB.drain()[0].code, 'bad_msg', `${t} can't come from a socket`);
}

// A seek from A reaches B as a state with a higher seq.
let seq0 = room.state.seq;
await room.webSocketMessage(wsA, frame(wsA, { t: 'seek', to: 120, playing: true, c: 'a1' }));
const stB = last(wsB, 'state');
assert.ok(stB.seq > seq0);
assert.equal(stB.playback.mediaTime, 120);
assert.equal(stB.playback.playing, true);
assert.equal(stB.playback.by, A);
assert.equal(stB.playback.cmd, 'a1');
assert.ok(last(wsA, 'state'), 'the sender gets the echo too');
assert.equal(ctx.data.get('state').seq, room.state.seq, 'a seq change is persisted at once');
wsA.drain(); wsB.drain();

// Locked room: the host's settings reach B; B's pause is refused.
await room.webSocketMessage(wsA, frame(wsA, { t: 'settings', everyoneControls: false }));
assert.equal(last(wsB, 'settings').settings.everyoneControls, false);
wsA.drain(); wsB.drain();
seq0 = room.state.seq;
await room.webSocketMessage(wsB, frame(wsB, { t: 'pause', c: 'b1' }));
const refused = wsB.drain();
assert.deepEqual(refused[0], { t: 'error', code: 'forbidden', re: 'pause' });
assert.equal(refused[1].t, 'state');
assert.equal(refused[1].playback.playing, true);
assert.deepEqual(wsA.drain(), [], 'nobody else hears a refused command');
assert.equal(room.state.seq, seq0);

// Another hibernation wake mid-party: the new instance carries on.
room = new PartyRoom(ctx, env);
await room.ready;
rooms.get(CODE).room = room;
assert.equal(room.state.seq, seq0);
assert.equal(room.state.settings.everyoneControls, false);

// Report budget: one per 2 s, except a playing/buffering flip always passes.
skew += 5000;
await room.webSocketMessage(wsB, frame(wsB, { t: 'report', pos: 121, dur: 7000, playing: true, buffering: false, engine: 'vlc', synced: true }));
assert.equal(last(wsA, 'member').pos, 121);
wsA.drain();
await room.webSocketMessage(wsB, frame(wsB, { t: 'report', pos: 122, playing: true, buffering: false }));
assert.deepEqual(wsA.drain(), [], 'a surplus report is dropped');
await room.webSocketMessage(wsB, frame(wsB, { t: 'report', pos: 122.5, playing: true, buffering: true }));
assert.equal(last(wsA, 'member').buffering, true, 'a buffering flip is never dropped');
wsA.drain();
assert.deepEqual(wsB.drain(), [], 'reports are not echoed to the sender');

// Command budget: 30 per 10 s per socket.
skew += 11_000;
for (let i = 0; i < 30; i++) await room.webSocketMessage(wsA, frame(wsA, { t: 'seek', to: i }));
assert.ok(!wsA.sent.some((m) => m.t === 'error'));
wsA.drain();
await room.webSocketMessage(wsA, frame(wsA, { t: 'seek', to: 99 }));
const limited = wsA.drain();
assert.deepEqual(limited.map((m) => m.t), ['error', 'state']);
assert.equal(limited[0].code, 'rate_limited');
assert.equal(room.state.playback.mediaTime, 29);
wsB.drain();

// Chat + react fan out to everyone (and aren't stored).
await room.webSocketMessage(wsB, frame(wsB, { t: 'chat', text: 'popcorn?' }));
assert.equal(last(wsA, 'chat').text, 'popcorn?');
assert.equal(last(wsB, 'chat').name, 'Bob');
assert.ok(!JSON.stringify(ctx.data.get('state')).includes('popcorn'));
wsA.drain(); wsB.drain();

// Kick: D joins, the host kicks D → D is told and closed with 4003.
const wsD = makeWS('D');
room.accept(wsD);
await room.webSocketMessage(wsD, frame(wsD, { t: 'hello', name: 'Dee', engine: 'embed' }));
const D = wsD.drain()[0].you.id;
wsA.drain(); wsB.drain();
await room.webSocketMessage(wsA, frame(wsA, { t: 'kick', id: D }));
assert.deepEqual(wsD.drain(), [{ t: 'closed', reason: 'kicked' }]);
assert.deepEqual(wsD.closed, { code: 4003, reason: 'kicked' });
assert.ok(!last(wsB, 'roster').members.some((m) => m.id === D));
await room.webSocketClose(wsD, 4003, 'kicked', true);   // the runtime's close event: harmless
wsA.drain(); wsB.drain();

// ── The host drops; 31 s later the alarm hands the room to B ──
await room.webSocketClose(wsA, 1006, '', false);
assert.ok(wsA.closed, 'the close handshake is answered');
const offline = last(wsB, 'roster');
assert.equal(offline.members.find((m) => m.id === A).connected, false);
assert.ok(ctx.alarmAt <= Date.now() + 35_000, 'an alarm within 35 s of a disconnect');
wsB.drain();
skew += 31_000;
await room.alarm();
const moved = last(wsB, 'host');
assert.deepEqual(moved, { t: 'host', seq: moved.seq, hostId: B, reason: 'migrated' });
assert.equal(room.state.hostId, B);
assert.equal(room.state.members[B].role, 'host');
assert.ok(last(wsB, 'roster'));
assert.ok(Math.abs(ctx.alarmAt - (Date.now() + 60_000)) < 1000, 'next sweep in 60 s');
assert.equal(ctx.data.get('state').hostId, B);
wsB.drain();

// A socket that never says hello is closed by the alarm after 30 s.
const wsQuiet = makeWS('quiet');
room.accept(wsQuiet);
skew += 31_000;
await room.alarm();
assert.equal(wsQuiet.closed.code, 4002);
wsB.drain();

// ── /p/:code — public join page ──
r = await req(`/p/${CODE}`, { token: '' });
assert.equal(r.status, 200);
assert.match(r.headers.get('content-type'), /text\/html/);
let html = await r.text();
assert.ok(html.includes(CODE));
assert.ok(html.includes(`href="slimewatch://party?code=${CODE}"`));
assert.ok(html.includes('Join the Watch Party in SlimeWatch'));
assert.ok(html.includes("Don't have SlimeWatch yet? Ask the host for a TestFlight invite."));
assert.ok(html.includes('Bob is hosting'), 'peeked host name');
assert.ok(!/<script|<link|src=/i.test(html), 'self-contained');
assert.equal((await req(`/p/${CODE.toLowerCase()}`, { token: '' })).status, 200);
assert.equal((await req('/p/nope', { token: '' })).status, 404);
html = await (await req('/p/ZZZZZZ', { token: '' })).text();
assert.ok(html.includes('may have ended'));

// Hostile names are escaped on the page.
r = await req('/party', { method: 'POST', body: { name: '<img src=x onerror=alert(1)>' } });
const evil = await r.json();
html = await (await req(`/p/${evil.code}`, { token: '' })).text();
assert.ok(!html.includes('<img'), 'no injected markup');
assert.ok(html.includes('&lt;img src=x onerror=alert is hosting'), 'escaped (and capped at 24 chars)');

// ── /party/rooms (admin) ──
assert.equal((await req('/party/rooms')).status, 401);
r = await req('/party/rooms', { token: 'admin' });
assert.equal(r.status, 200);
const listed = (await r.json()).rooms.find((x) => x.code === CODE);
assert.equal(listed.live, true);
assert.equal(listed.host, 'Ann');
assert.equal(listed.info.hostName, 'Bob');
assert.equal(listed.info.memberCount, 1);
assert.equal(listed.info.seq, room.state.seq);

// ── Presence carries the party code ──
assert.equal((await req('/presence', { method: 'POST', body: { id: 'dev-b', name: 'Bob', party: CODE } })).status, 200);
assert.equal((await req('/presence', { method: 'POST', body: { id: 'dev-c', name: 'Cy', party: 'nope<>' } })).status, 200);
assert.equal((await req('/presence', { method: 'POST', body: { id: 'dev-e', name: 'Eve', party: 7 } })).status, 200);
const sessions = (await (await req('/presence', { token: 'admin' })).json()).sessions;
const row = (id) => sessions.find((x) => x.id === id);
assert.equal(row('dev-b').party, CODE);
assert.equal(row('dev-c').party, '', 'not a code: dropped');
assert.equal(row('dev-e').party, '');

// ── DELETE /party/:code — host secret only ──
r = await req(`/party/${CODE}`, { method: 'DELETE', body: { secret: 'wrong' } });
assert.equal(r.status, 403);
r = await req(`/party/${CODE}?secret=${created.hostSecret}`, { method: 'DELETE' });
assert.equal(r.status, 403, 'the old host secret stopped working when the role moved');
assert.ok(kv.m.has(`party:${CODE}`));
r = await req(`/party/${CODE}`, { method: 'DELETE', body: { secret: welcomeB.you.secret } });
assert.equal(r.status, 200);
assert.deepEqual(await r.json(), { ok: true });
assert.deepEqual(wsB.drain(), [{ t: 'closed', reason: 'ended' }]);
assert.deepEqual(wsB.closed, { code: 4000, reason: 'ended' });
assert.ok(!kv.m.has(`party:${CODE}`), 'registry entry removed');
assert.equal(ctx.data.size, 0, 'storage wiped');
assert.equal(ctx.alarmAt, null, 'alarm cleared');
assert.equal((await req(`/party/${CODE}`)).status, 404);
assert.equal((await req(`/party/${CODE}/ws`, { headers: { upgrade: 'websocket' } })).status, 404);
assert.equal((await req(`/party/${CODE}`, { method: 'DELETE', body: { secret: welcomeB.you.secret } })).status, 404);

// ── Expiry: no sockets and 2 h without activity → the alarm deletes the room ──
const evilCtx = rooms.get(evil.code).ctx;
assert.ok(evilCtx.data.has('state'));
skew += 2 * 3_600_000 + 60_000;
assert.equal((await req(`/party/${evil.code}`)).status, 404, 'an idle room stops answering before its alarm');
await rooms.get(evil.code).room.alarm();
assert.equal(evilCtx.data.size, 0);
assert.equal(evilCtx.alarmAt, null);
assert.ok(!kv.m.has(`party:${evil.code}`));

console.log('party OK');
