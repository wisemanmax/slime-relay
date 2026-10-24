// Per-device tokens end to end without a runtime (Wave 8 F1a, contracts.md §1):
// the Worker over a fake KV, the DeviceRegistry Durable Object over a fake
// storage (a Map, reloadable to simulate eviction), a movable clock, a stubbed
// DeepSeek and Watch Party. Invite → enrol → the token is the user role;
// /devices/me; one 403 for bad / used / expired codes; ≤ 5 open invites; the
// enrol rate limit; re-enrol; revoke within the cache window; forget; the
// /register reply's `tokens` and `deviceSeen`; lastSeen throttles;
// DEVICE_TOKENS_REQUIRED; what never reaches the registry; the dashboard panel
// (its script run in a vm); the QR encoder (decoded here); old apps, old
// extractors and a relay without the binding.
// Run: node test/devices.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import worker, { DeviceRegistry } from '../src/worker.js';
import {
  userAuth, deviceFleetBlock, isDeviceToken, newDeviceToken, newInviteCode, normalizeCode, displayCode,
  enrolLink, sha256Hex, devicesPanelHTML, _test,
} from '../src/devices.js';
import { devQR } from '../src/qr.js';

const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;
const advance = (ms) => { skew += ms; };
const MIN = 60_000;
const HEX64 = /^[0-9a-f]{64}$/;
const CODE = /^[A-HJ-NP-Z2-9]{8}$/;

let checks = 0, cases = 0;
const t = {};
for (const k of ['equal', 'notEqual', 'deepEqual', 'ok', 'match', 'doesNotMatch']) t[k] = (...a) => { checks++; assert[k](...a); };
async function test(name, fn) {
  try { await fn(); cases++; } catch (e) { console.error(`devices: case "${name}" failed`); throw e; }
}
const until = async (cond, what) => {
  for (let i = 0; i < 200; i++) { if (cond()) return; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error(`timed out waiting for ${what}`);
};

// ── Fakes ──
function makeKV() {
  const m = new Map();   // key -> { value, exp, metadata }
  const live = (k) => {
    const e = m.get(k);
    if (e && e.exp && e.exp <= Date.now()) { m.delete(k); return null; }
    return e || null;
  };
  return {
    m,
    async get(k) { return live(k)?.value ?? null; },
    async put(k, v, o = {}) { m.set(k, { value: String(v), exp: o.expirationTtl ? Date.now() + o.expirationTtl * 1000 : 0, metadata: o.metadata ?? null }); },
    async delete(k) { m.delete(k); },
    async list({ prefix = '' } = {}) {
      const keys = [];
      for (const k of [...m.keys()].sort()) { const e = k.startsWith(prefix) && live(k); if (e) keys.push({ name: k, ...(e.metadata ? { metadata: e.metadata } : {}) }); }
      return { keys, list_complete: true };
    },
  };
}
function makeStorage() {
  const data = new Map();
  const st = {
    data, putKeys: [],
    async get(k) { return data.has(k) ? structuredClone(data.get(k)) : undefined; },
    async put(k, v) {
      for (const [kk, vv] of typeof k === 'object' ? Object.entries(k) : [[k, v]]) { data.set(kk, structuredClone(vv)); st.putKeys.push(kk); }
    },
    async delete(k) {
      let n = 0;
      for (const kk of Array.isArray(k) ? k : [k]) if (data.delete(kk)) n++;
      return Array.isArray(k) ? n : n > 0;
    },
    async list({ prefix = '' } = {}) {
      return new Map([...data.keys()].sort().filter((x) => x.startsWith(prefix)).map((x) => [x, structuredClone(data.get(x))]));
    },
  };
  return st;
}

const HOUSE = 'w8-local-token';
const kv = makeKV();
let storage = makeStorage();
let reg = null;
let registryDown = false;
const registryCalls = [];
const env = {
  ADMIN_TOKEN: 'w8-local-admin', USER_TOKEN: HOUSE, FLEET_TOKEN: 'w8-local-fleet', SERVERS: kv, DEEPSEEK_API_KEY: 'sk-test',
  DEVICES: {
    idFromName: (name) => { assert.equal(name, 'registry', 'one registry instance'); return { name }; },
    get: () => ({
      fetch: async (input, init) => {
        registryCalls.push(new URL(input).pathname);
        if (registryDown) throw new Error('registry unreachable');
        return reg.fetch(new Request(input, init));
      },
    }),
  },
  PARTY: {   // a stand-in room: only the Worker's auth in front of it is under test here
    idFromName: (name) => ({ name }),
    get: () => ({ fetch: async () => new Response(JSON.stringify({ code: 'ABCDEF', memberCount: 0 }), { headers: { 'content-type': 'application/json' } }) }),
  },
};
const ADMIN = env.ADMIN_TOKEN, FLEET = env.FLEET_TOKEN;
const boot = () => { reg = new DeviceRegistry({ storage, blockConcurrencyWhile: (fn) => fn() }, env); };
function fresh() { storage = makeStorage(); boot(); _test.reset(); registryCalls.length = 0; registryDown = false; }
fresh();

globalThis.fetch = async (url) => {   // the assistant's upstream; nothing else may leave the process
  if (String(url).startsWith('https://api.deepseek.com/')) {
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] }), { status: 200 });
  }
  throw new Error(`unexpected network request: ${url}`);
};

let ipn = 0;
function req(path, { method = 'GET', token = HOUSE, body, ip } = {}) {
  ipn++;
  return worker.fetch(new Request(`https://relay.test${path}`, {
    method, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'cf-connecting-ip': ip ?? `10.8.${ipn >> 8 & 255}.${ipn & 255}`,
               ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  }), env);
}
const code = async (status, path, opts) => (await req(path, opts)).status === status;
async function invite(label) {
  const r = await req('/admin/devices/invite', { method: 'POST', token: ADMIN, body: label === undefined ? {} : { label } });
  return { status: r.status, body: await r.json(), headers: r.headers };
}
async function enrol(c, deviceId, extra = {}, { token = HOUSE, ip } = {}) {
  const r = await req('/devices/enroll', { method: 'POST', token, ip,
    body: { code: c, deviceId, name: 'Test device', platform: 'ios', app: 'SlimeWatch 8.1 (70)', ...extra } });
  const text = await r.text();
  return { status: r.status, body: JSON.parse(text), text, headers: r.headers };
}
async function enrolNew(deviceId, extra) {
  const inv = await invite();
  assert.equal(inv.status, 201);
  const e = await enrol(inv.body.code, deviceId, extra);
  assert.equal(e.status, 200, `enrol ${deviceId}: ${e.text}`);
  return e.body.token;
}
const register = (extra = {}, token = FLEET) => req('/register', { method: 'POST', token,
  body: { id: 'home-8787', name: 'Home Mac', os: 'test', address: 'http://mac.test:8787', load: 0, capacity: 4, version: 1, ...extra } });
const list = async () => (await (await req('/admin/devices', { token: ADMIN })).json());
const stored = (id) => storage.data.get(`dev:${id}`);
const storageText = () => JSON.stringify([...storage.data]);
const direct = (path, body) => reg.fetch(new Request(`https://devices${path}`, body === undefined ? undefined
  : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
const presence = (token) => req('/presence', { method: 'POST', token, body: { id: 'dev-p', name: 'P', title: 'Show', kind: 'Series', platform: 'iPhone' } });
const assist = (token) => req('/assist', { method: 'POST', token, body: { messages: [{ role: 'user', content: 'something funny' }] } });

// ── Cases ──

await test('formats: tokens, hashes, codes', async () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const tok = newDeviceToken();
    t.match(tok, /^swd1_[A-Za-z0-9_-]{43}$/);
    t.ok(isDeviceToken(tok));
    seen.add(tok);
  }
  t.equal(seen.size, 50, 'tokens are random');
  t.ok(!isDeviceToken(`swd1_${'A'.repeat(42)}`) && !isDeviceToken(`swd1_${'A'.repeat(44)}`) && !isDeviceToken(`swd1_${'A'.repeat(42)}=`));
  t.ok(!isDeviceToken(`swd2_${'A'.repeat(43)}`) && !isDeviceToken(HOUSE) && !isDeviceToken(null));
  t.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'sha256 lowercase hex');
  const symbols = new Set();
  for (let i = 0; i < 200; i++) { const c = newInviteCode(); t.match(c, CODE); for (const ch of c) symbols.add(ch); }
  t.equal(symbols.size, 32, 'every symbol of the party alphabet is drawn');
  t.equal(normalizeCode(' k7q4-mz2p '), 'K7Q4MZ2P');
  t.equal(normalizeCode('K7Q4MZ2P'), 'K7Q4MZ2P');
  for (const bad of ['K7Q4MZ2', 'K7Q4MZ2PX', 'K7Q4MZ2O', 'K7Q4MZ21', '', 12345678, null, 'K7Q4MZ2P'.repeat(5)]) t.equal(normalizeCode(bad), null);
  t.equal(displayCode('K7Q4MZ2P'), 'K7Q4-MZ2P');
  t.equal(enrolLink('K7Q4MZ2P'), 'slimewatch://enrol?code=K7Q4MZ2P');
});

await test('invite: admin only, the reply shape, hashes only in storage', async () => {
  fresh();
  for (const tok of [HOUSE, `swd1_${'B'.repeat(43)}`, '', FLEET]) t.ok(await code(401, '/admin/devices/invite', { method: 'POST', token: tok, body: {} }));
  const before = Date.now();
  const inv = await invite('x'.repeat(60));
  t.equal(inv.status, 201);
  t.deepEqual(Object.keys(inv.body).sort(), ['code', 'display', 'expiresAt', 'link', 'qr']);
  t.match(inv.body.code, CODE);
  t.equal(inv.body.display, `${inv.body.code.slice(0, 4)}-${inv.body.code.slice(4)}`);
  t.equal(inv.body.link, `slimewatch://enrol?code=${inv.body.code}`);
  t.deepEqual(inv.body.qr, devQR(inv.body.link).map((r) => r.map((b) => (b ? '1' : '0')).join('')), 'qr: the link, as rows of 0/1');
  t.ok(inv.body.qr.length === 29 && inv.body.qr.every((r) => /^[01]{29}$/.test(r)));
  t.ok(Math.abs(inv.body.expiresAt - (before + 15 * MIN)) < 5000, 'valid for 15 minutes');
  t.equal(inv.headers.get('cache-control'), 'no-store');
  const l = await list();
  t.deepEqual(l.devices, []);
  t.equal(l.invites.length, 1);
  t.equal(l.invites[0].hint, `${inv.body.code.slice(0, 2)}…`);
  t.equal(l.invites[0].label, 'x'.repeat(40), 'label capped at 40');
  t.ok(!JSON.stringify(l).includes(inv.body.code), 'the list never shows a full code');
  t.ok(!storageText().includes(inv.body.code), 'storage never holds the code');
  t.ok(storage.data.has(`inv:${await sha256Hex(inv.body.code)}`), 'stored under its sha256');
  t.equal((await invite()).status, 201, 'no label is fine');
  t.ok(await code(400, '/admin/devices/invite', { method: 'POST', token: ADMIN, body: '{nope' }));
  t.ok(await code(405, '/admin/devices/invite', { token: ADMIN }));
  t.ok(await code(404, '/admin/devices/nope', { method: 'POST', token: ADMIN, body: {} }));
  t.ok(await code(404, '/admin/devicesX', { token: ADMIN }));
  t.ok(await code(404, '/devices/nope'));
});

await test('at most 5 open invites; expired ones free a slot', async () => {
  fresh();
  for (let i = 0; i < 5; i++) t.equal((await invite()).status, 201);
  const sixth = await invite();
  t.equal(sixth.status, 429);
  t.deepEqual(sixth.body, { error: 'too-many-invites' });
  advance(15 * MIN + 1000);
  t.equal((await invite()).status, 201, 'expired invites are pruned');
  t.equal([...storage.data.keys()].filter((k) => k.startsWith('inv:')).length, 1, 'and deleted from storage');
  t.equal((await list()).invites.length, 1);
});

await test('enrol: the household token, one 403 for bad / used / expired codes', async () => {
  fresh();
  const inv = await invite('Kitchen');
  const e = await enrol(inv.body.code, 'DEV-A', { name: 'Ann\u0007’s iPhone' });
  t.equal(e.status, 200);
  t.deepEqual(Object.keys(e.body).sort(), ['deviceId', 'issuedAt', 'name', 'token']);
  t.equal(e.body.deviceId, 'DEV-A');
  t.equal(e.body.name, 'Ann’s iPhone', 'control characters stripped');
  t.ok(isDeviceToken(e.body.token));
  t.ok(Math.abs(e.body.issuedAt - Date.now()) < 5000);
  t.equal(e.headers.get('cache-control'), 'no-store', 'the token is shown once');
  t.match(e.text, /"token":"swd1_[A-Za-z0-9_-]{43}"/, 'compact JSON: one line, so test tooling can mask the token by pattern');
  t.ok(!storageText().includes(e.body.token), 'storage never holds the token');
  t.equal(stored('DEV-A').sha256, await sha256Hex(e.body.token));
  t.equal(stored('DEV-A').label, 'Kitchen');
  t.equal(stored('DEV-A').platform, 'ios');
  const BAD = { error: 'bad-code' };
  const used = await enrol(inv.body.code, 'DEV-B');
  t.equal(used.status, 403); t.deepEqual(used.body, BAD);
  const unknown = await enrol(newInviteCode(), 'DEV-B');
  t.equal(unknown.status, 403); t.deepEqual(unknown.body, BAD);
  const malformed = await enrol('nope', 'DEV-B');
  t.equal(malformed.status, 403); t.deepEqual(malformed.body, BAD);
  const late = await invite();
  advance(15 * MIN + 1000);
  const expired = await enrol(late.body.code, 'DEV-B');
  t.equal(expired.status, 403); t.deepEqual(expired.body, BAD);
  // Any case, with or without the dash.
  const inv2 = await invite();
  const dashed = `${inv2.body.code.slice(0, 4)}-${inv2.body.code.slice(4)}`.toLowerCase();
  const e2 = await enrol(` ${dashed} `, 'DEV-B', { platform: 'android', name: '', app: 'a'.repeat(60) });
  t.equal(e2.status, 200);
  t.equal(stored('DEV-B').platform, 'other', 'unknown platform → other');
  t.equal(stored('DEV-B').name, 'DEV-B', 'empty name → the device id');
  t.equal(stored('DEV-B').app.length, 40, 'app capped at 40');
  // Who may enrol: the household token or admin; never a device token, never nobody.
  const inv3 = await invite();
  t.equal((await enrol(inv3.body.code, 'DEV-C', {}, { token: e.body.token })).status, 401);
  t.equal((await enrol(inv3.body.code, 'DEV-C', {}, { token: '' })).status, 401);
  t.equal((await enrol(inv3.body.code, 'DEV-C', {}, { token: FLEET })).status, 401);
  // A bad deviceId is a 400 and does NOT burn the code.
  for (const id of ['../x', '', 'x'.repeat(81), 'a b']) t.equal((await enrol(inv3.body.code, id)).status, 400);
  t.equal((await enrol(inv3.body.code, 'DEV-C', {}, { token: ADMIN })).status, 200, 'admin can enrol; the code survived the 400s');
  t.ok(await code(400, '/devices/enroll', { method: 'POST', body: '{nope' }));
  t.ok(await code(405, '/devices/enroll'));
  t.equal((await list()).devices.length, 3);
});

await test('enrol rate limit: 10 a minute per IP', async () => {
  fresh();
  advance(MIN - (Date.now() % MIN) + 50);   // start of a minute window: no boundary mid-loop
  for (let i = 0; i < 10; i++) t.equal((await enrol('nope', 'DEV-R', {}, { ip: '10.250.0.1' })).status, 403);
  t.equal((await enrol('nope', 'DEV-R', {}, { ip: '10.250.0.1' })).status, 429);
  const inv = await invite();
  t.equal((await enrol(inv.body.code, 'DEV-R', {}, { ip: '10.250.0.1' })).status, 429, 'even a good code');
  t.equal((await enrol(inv.body.code, 'DEV-R', {}, { ip: '10.250.0.2' })).status, 200, 'another IP is not limited');
});

let TOKEN_A = '';
await test('a device token is the user role on /route, /presence, /assist, /party; /devices/me', async () => {
  fresh();
  TOKEN_A = await enrolNew('DEV-A', { name: 'Ann', platform: 'tvos' });
  const bogus = `swd1_${'Z'.repeat(43)}`;
  t.ok(await code(200, '/route', { token: TOKEN_A }));
  t.ok(await code(401, '/route', { token: bogus }));
  t.equal((await presence(TOKEN_A)).status, 200);
  t.equal((await presence(bogus)).status, 401);
  t.ok(await code(200, '/presence?id=dev-p', { method: 'DELETE', token: TOKEN_A }));
  const a = await assist(TOKEN_A);
  t.equal(a.status, 200, '/assist (DeepSeek stubbed)');
  t.equal((await a.json()).message.content, 'ok');
  t.equal((await assist(bogus)).status, 401);
  t.ok(await code(200, '/party/ABCDEF', { token: TOKEN_A }), 'a party peek');
  t.ok(await code(401, '/party/ABCDEF', { token: bogus }));
  t.ok(await code(426, `/party/ABCDEF/ws?key=${encodeURIComponent(TOKEN_A)}`, { token: '' }), 'the ?key= form authenticates (then wants an upgrade)');
  // Still not admin, still not a server.
  t.ok(await code(401, '/presence', { token: TOKEN_A }));
  t.ok(await code(401, '/servers', { token: TOKEN_A }));
  t.ok(await code(401, '/admin/devices', { token: TOKEN_A }));
  t.match(await (await req('/', { token: TOKEN_A })).text(), /Admin access required/);
  t.equal((await register({}, TOKEN_A)).status, 401);
  const savedFleet = env.FLEET_TOKEN;
  delete env.FLEET_TOKEN;   // the staged fallback: the user role registers until FLEET_TOKEN is set…
  t.equal((await register({}, HOUSE)).status, 200, '…the household token, as before');
  t.equal((await register({}, TOKEN_A)).status, 401, '…but never a device token');
  env.FLEET_TOKEN = savedFleet;
  // /devices/me
  const me = await req('/devices/me', { token: TOKEN_A });
  t.equal(me.status, 200);
  const meBody = await me.json();
  t.deepEqual(Object.keys(meBody).sort(), ['deviceId', 'enrolledAt', 'name', 'platform']);
  t.equal(meBody.deviceId, 'DEV-A'); t.equal(meBody.name, 'Ann'); t.equal(meBody.platform, 'tvos');
  t.equal(meBody.enrolledAt, stored('DEV-A').createdAt);
  for (const tok of [HOUSE, ADMIN, bogus, '']) t.ok(await code(401, '/devices/me', { token: tok }));
  t.ok(await code(405, '/devices/me', { method: 'POST', token: TOKEN_A, body: {} }));
});

await test('lastSeen from the relay: one registry read per 30 s, one write per 5 min', async () => {
  fresh();
  const tok = await enrolNew('DEV-S');
  const writes = () => storage.putKeys.filter((k) => k === 'dev:DEV-S').length;
  const authCalls = () => registryCalls.filter((p) => p === '/auth').length;
  t.equal(writes(), 1, 'the enrolment');
  const enrolledAt = stored('DEV-S').lastSeenAt;
  t.equal(stored('DEV-S').lastSeenFrom, 'relay');
  for (let i = 0; i < 5; i++) t.ok(await code(200, '/route', { token: tok }));
  t.equal(authCalls(), 1, 'positive answers are cached in the isolate');
  advance(31_000);
  t.ok(await code(200, '/route', { token: tok }));
  t.equal(authCalls(), 2, 'after 30 s the registry is asked again');
  t.equal(writes(), 1, 'but lastSeen is not rewritten inside 5 min');
  advance(5 * MIN);
  t.ok(await code(200, '/route', { token: tok }));
  t.equal(writes(), 2);
  t.ok(stored('DEV-S').lastSeenAt >= enrolledAt + 5 * MIN);
  t.equal(stored('DEV-S').lastSeenFrom, 'relay');
});

await test('re-enrolling the same deviceId replaces its token', async () => {
  fresh();
  const t1 = await enrolNew('DEV-X');
  t.ok(await code(200, '/route', { token: t1 }));
  const v1 = (await (await register()).json()).tokens.version;
  const t2 = await enrolNew('DEV-X', { name: 'Reinstalled' });
  t.notEqual(t1, t2);
  t.ok(await code(401, '/route', { token: t1 }), 'the old token is refused at once');
  t.ok(await code(200, '/route', { token: t2 }));
  t.equal(stored('DEV-X').sha256, await sha256Hex(t2));
  t.equal(stored('DEV-X').name, 'Reinstalled');
  t.equal((await list()).devices.length, 1, 'one record');
  const block = (await (await register()).json()).tokens;
  t.equal(block.version, v1 + 1);
  t.deepEqual(block.devices, [{ id: 'DEV-X', sha256: await sha256Hex(t2) }]);
});

await test('revoke: refused at once in this isolate, past the 30 s cache elsewhere', async () => {
  fresh();
  const tok = await enrolNew('DEV-R1');
  t.ok(await code(200, '/route', { token: tok }));
  // Another isolate revokes (the registry directly; this isolate's cache is untouched).
  t.equal((await direct('/revoke', { id: 'DEV-R1' })).status, 200);
  advance(29_000);
  t.ok(await code(200, '/route', { token: tok }), 'still inside the cache window');
  advance(2_000);
  t.ok(await code(401, '/route', { token: tok }), 'refused past it');
  t.ok(await code(401, '/devices/me', { token: tok }));
  t.ok(await code(401, '/route', { token: tok }), 'negatives are never cached into a yes');
  // The dashboard's revoke drops this isolate's cache: refused on the very next call.
  const tok2 = await enrolNew('DEV-R2');
  t.ok(await code(200, '/route', { token: tok2 }));
  const r = await req('/admin/devices/revoke', { method: 'POST', token: ADMIN, body: { id: 'DEV-R2' } });
  t.equal(r.status, 200); t.deepEqual(await r.json(), { ok: true });
  t.ok(await code(401, '/route', { token: tok2 }));
  t.ok(await code(200, '/admin/devices/revoke', { method: 'POST', token: ADMIN, body: { id: 'DEV-R2' } }), 'idempotent');
  t.ok(await code(404, '/admin/devices/revoke', { method: 'POST', token: ADMIN, body: { id: 'nobody' } }));
  t.ok(await code(400, '/admin/devices/revoke', { method: 'POST', token: ADMIN, body: { id: '../x' } }));
  t.ok(await code(400, '/admin/devices/revoke', { method: 'POST', token: ADMIN, body: {} }));
  t.ok(await code(401, '/admin/devices/revoke', { method: 'POST', token: HOUSE, body: { id: 'DEV-R2' } }));
  t.ok(await code(405, '/admin/devices/revoke', { token: ADMIN }));
  const live = await enrolNew('DEV-LIVE');
  const l = await list();
  t.deepEqual(l.devices.map((d) => d.id), ['DEV-LIVE', 'DEV-R2', 'DEV-R1'], 'live first; revoked rows stay');
  t.ok(l.devices[1].revokedAt > 0 && l.devices[0].revokedAt === null);
  t.deepEqual(Object.keys(l.devices[0]).sort(),
    ['app', 'createdAt', 'id', 'label', 'lastSeenAt', 'lastSeenFrom', 'name', 'platform', 'revokedAt']);
  t.ok(!JSON.stringify(l).includes('sha256') && !JSON.stringify(l).includes(live), 'no hash, no token');
  t.equal(stored('DEV-R2').sha256, null, 'a revoked hash is dropped');
  // A revoked device the owner lets back in: a fresh code, the same id.
  const back = await enrolNew('DEV-R2');
  t.ok(await code(200, '/route', { token: back }));
  t.equal(stored('DEV-R2').revokedAt, null);
});

await test('forget only after revoke', async () => {
  fresh();
  await enrolNew('DEV-F');
  const live = await req('/admin/devices/forget', { method: 'POST', token: ADMIN, body: { id: 'DEV-F' } });
  t.equal(live.status, 409); t.deepEqual(await live.json(), { error: 'revoke first' });
  t.ok(await code(200, '/admin/devices/revoke', { method: 'POST', token: ADMIN, body: { id: 'DEV-F' } }));
  t.ok(await code(200, '/admin/devices/forget', { method: 'POST', token: ADMIN, body: { id: 'DEV-F' } }));
  t.deepEqual((await list()).devices, []);
  t.ok(!storage.data.has('dev:DEV-F'));
  t.ok(await code(404, '/admin/devices/forget', { method: 'POST', token: ADMIN, body: { id: 'DEV-F' } }));
  t.ok(await code(401, '/admin/devices/forget', { method: 'POST', token: HOUSE, body: { id: 'DEV-F' } }));
});

await test('/register carries the live token hashes; version orders them', async () => {
  fresh();
  let r = await register();
  t.equal(r.status, 200);
  let body = await r.json();
  t.equal(body.ok, true, 'an old extractor reads only ok');
  t.deepEqual(body.tokens, { v: 1, version: 0, devices: [] });
  const ta = await enrolNew('DEV-A');
  const tb = await enrolNew('DEV-B');
  body = await (await register()).json();
  t.equal(body.tokens.version, 2);
  t.deepEqual(new Set(body.tokens.devices.map((d) => JSON.stringify(d))),
    new Set([JSON.stringify({ id: 'DEV-A', sha256: await sha256Hex(ta) }), JSON.stringify({ id: 'DEV-B', sha256: await sha256Hex(tb) })]));
  t.ok(body.tokens.devices.every((d) => HEX64.test(d.sha256) && Object.keys(d).length === 2));
  t.ok(!JSON.stringify(body).includes('swd1_'), 'hashes only, never a token');
  await req('/admin/devices/revoke', { method: 'POST', token: ADMIN, body: { id: 'DEV-B' } });
  body = await (await register()).json();
  t.equal(body.tokens.version, 3);
  t.deepEqual(body.tokens.devices.map((d) => d.id), ['DEV-A'], 'live devices only');
  await req('/admin/devices/forget', { method: 'POST', token: ADMIN, body: { id: 'DEV-B' } });
  t.equal((await (await register()).json()).tokens.version, 4, 'forget bumps too');
  // A 10 s per-isolate cache: a second beat asks nothing; a change elsewhere shows up after it.
  const beats = () => registryCalls.filter((p) => p === '/beat').length;
  let n = beats();
  await register();
  t.equal(beats(), n, 'cached');
  await direct('/revoke', { id: 'DEV-A' });
  t.equal((await (await register()).json()).tokens.version, 4, 'another isolate’s revoke: not yet');
  advance(11_000);
  body = await (await register()).json();
  t.equal(body.tokens.version, 5);
  t.deepEqual(body.tokens.devices, []);
  // One extractor beats its LAN, Tailscale and tunnel paths at once: one registry read.
  advance(11_000);
  n = beats();
  const all = await Promise.all(['home-8787', 'home-8787-ts', 'home-8787-pub'].map((id) => register({ id })));
  t.ok(all.every((x) => x.status === 200));
  t.equal(beats(), n + 1, 'concurrent beats share one read');
  // Registry unreachable → no `tokens` (the extractor keeps its list), still ok.
  advance(11_000);
  registryDown = true;
  r = await register();
  t.equal(r.status, 200);
  body = await r.json();
  t.equal(body.ok, true);
  t.ok(!('tokens' in body), 'tokens omitted');
  registryDown = false;
  t.ok('tokens' in await (await register()).json(), 'and back once it answers');
});

await test('deviceSeen in the register body → lastSeen from the extractor (throttled)', async () => {
  fresh();
  await enrolNew('DEV-A');
  await enrolNew('DEV-GONE');
  await req('/admin/devices/revoke', { method: 'POST', token: ADMIN, body: { id: 'DEV-GONE' } });
  const t0 = stored('DEV-A').lastSeenAt;
  const gone = structuredClone(stored('DEV-GONE'));
  advance(6 * MIN);
  const seenAt = Date.now() - 1000;
  let body = await (await register({ deviceSeen: { 'DEV-A': seenAt, 'DEV-GONE': Date.now(), nobody: Date.now(), 'bad id!': Date.now() } })).json();
  t.ok(body.tokens, 'the reply still carries tokens');
  t.equal(stored('DEV-A').lastSeenAt, seenAt);
  t.equal(stored('DEV-A').lastSeenFrom, 'extractor');
  t.deepEqual(stored('DEV-GONE'), gone, 'a revoked device is not touched');
  t.ok(!storage.data.has('dev:nobody'), 'an unknown id creates nothing');
  const writes = () => storage.putKeys.filter((k) => k === 'dev:DEV-A').length;
  const w = writes();
  advance(2 * MIN);
  await register({ deviceSeen: { 'DEV-A': Date.now() } });
  t.equal(writes(), w, 'inside 5 min: no write');
  const b = registryCalls.length;
  advance(1000);
  await register({ deviceSeen: { 'DEV-A': Date.now() } });
  t.equal(registryCalls.length, b, 'nothing new to forward and the block cached: not even a registry call');
  advance(4 * MIN);
  await register({ deviceSeen: { 'DEV-A': Date.now() + 3_600_000 } });
  t.equal(writes(), w + 1);
  t.ok(stored('DEV-A').lastSeenAt <= Date.now(), 'a future time is clamped to now');
  t.ok(stored('DEV-A').lastSeenAt > t0);
  // Only the first 200 entries are read.
  advance(6 * MIN);
  const many = {};
  for (let i = 0; i < 210; i++) many[`x${i}`] = Date.now();
  many['DEV-A'] = Date.now();
  await register({ deviceSeen: many });
  t.equal(writes(), w + 1, 'entry 211 is ignored');
  // Junk never breaks a heartbeat.
  for (const junk of ['x', [1, 2], null, 42, { 'DEV-A': 'soon' }, { 'DEV-A': -5 }]) {
    const r = await register({ deviceSeen: junk });
    t.equal(r.status, 200);
    t.ok((await r.json()).tokens);
  }
  const raw = await req('/register', { method: 'POST', token: FLEET,
    body: '{"id":"home-8787","name":"Home Mac","address":"http://mac.test:8787","deviceSeen":{"__proto__":{"polluted":1}}}' });
  t.equal(raw.status, 200);
  t.equal(({}).polluted, undefined, 'no prototype pollution');
  t.equal(writes(), w + 1);
});

await test('DEVICE_TOKENS_REQUIRED: the household token only enrols', async () => {
  fresh();
  const tok = await enrolNew('DEV-A');
  env.DEVICE_TOKENS_REQUIRED = '1';
  t.ok(await code(401, '/route', { token: HOUSE }));
  t.equal((await presence(HOUSE)).status, 401);
  t.equal((await assist(HOUSE)).status, 401);
  t.ok(await code(401, '/party/ABCDEF', { token: HOUSE }));
  t.equal(await userAuth(env, HOUSE, '/route'), false);
  t.equal(await userAuth(env, HOUSE, '/devices/enroll'), true);
  const inv = await invite();
  t.equal((await enrol(inv.body.code, 'DEV-NEW')).status, 200, 'the household token still enrols');
  t.ok(await code(200, '/route', { token: tok }), 'device tokens route');
  t.ok(await code(200, '/route', { token: ADMIN }), 'admin unaffected');
  t.ok(await code(200, '/servers', { token: ADMIN }));
  t.equal((await register()).status, 200, 'servers register with FLEET_TOKEN, unaffected');
  env.DEVICE_TOKENS_REQUIRED = 'true';
  t.ok(await code(200, '/route', { token: HOUSE }), 'only "1" switches it on');
  delete env.DEVICE_TOKENS_REQUIRED;
  t.ok(await code(200, '/route', { token: HOUSE }), 'unset: today’s behaviour');
  t.equal((await presence(HOUSE)).status, 200);
});

await test('only well-formed swd1_ tokens reach the registry; strays change nothing', async () => {
  fresh();
  const tok = await enrolNew('DEV-A');
  registryCalls.length = 0;
  for (const stray of ['random-token', `swd1_${'A'.repeat(42)}`, `swd1_${'A'.repeat(43)}x`, `swd1_${'A'.repeat(42)}+`, `SWD1_${'A'.repeat(43)}`]) {
    t.equal(await userAuth(env, stray, '/route'), false);
    t.ok(await code(401, '/route', { token: stray }));
  }
  t.equal(registryCalls.length, 0, 'not one registry call');
  // A device token where no handler wants the user role costs nothing either.
  for (const path of ['/providers', '/', '/servers', '/pick']) await req(path, { token: tok });
  t.equal((await register({}, tok)).status, 401);
  t.equal(registryCalls.length, 0, 'no lookups on /providers, /, /servers, /pick, /register');
  // A random well-formed token is looked up (it might have just enrolled), refused, and leaves no trace.
  const puts = storage.putKeys.length, snapshot = storageText();
  const random = newDeviceToken();
  t.ok(await code(401, '/route', { token: random }));
  t.ok(await code(401, '/route', { token: random }));
  t.equal(registryCalls.filter((p) => p === '/auth').length, 2, 'looked up each time: negatives are never cached');
  t.equal(storage.putKeys.length, puts, 'no write');
  t.equal(storageText(), snapshot, 'the registry is unchanged');
});

await test('the registry reloads from storage (eviction) with everything intact', async () => {
  fresh();
  const tok = await enrolNew('DEV-A');
  const gone = await enrolNew('DEV-B');
  await req('/admin/devices/revoke', { method: 'POST', token: ADMIN, body: { id: 'DEV-B' } });
  const open = await invite('later');
  const v = (await (await register()).json()).tokens.version;
  boot();          // a new instance over the same storage
  _test.reset();   // and a fresh isolate
  t.ok(await code(200, '/route', { token: tok }));
  t.ok(await code(401, '/route', { token: gone }));
  t.equal((await (await register()).json()).tokens.version, v);
  t.equal((await list()).invites[0].label, 'later');
  t.equal((await enrol(open.body.code, 'DEV-C')).status, 200, 'an open invite survives');
});

await test('registry unreachable: device tokens refused (never cached), 503s, the household token unaffected', async () => {
  fresh();
  const tok = await enrolNew('DEV-A');
  _test.reset();
  registryDown = true;
  t.ok(await code(401, '/route', { token: tok }), 'fail closed');
  const me = await req('/devices/me', { token: tok });
  t.equal(me.status, 503, '/devices/me tells "try later" from "revoked"');
  t.deepEqual(await me.json(), { error: 'registry unavailable' });
  t.ok(await code(503, '/admin/devices', { token: ADMIN }));
  t.equal((await invite()).status, 503);
  t.equal((await enrol('ABCDEFGH', 'DEV-Z')).status, 503);
  t.ok(await code(503, '/admin/devices/revoke', { method: 'POST', token: ADMIN, body: { id: 'DEV-A' } }));
  t.ok(await code(200, '/route', { token: HOUSE }));
  t.equal((await presence(HOUSE)).status, 200);
  registryDown = false;
  t.ok(await code(200, '/route', { token: tok }), 'back when it answers');
});

await test('a relay without the DEVICES binding behaves as before', async () => {
  fresh();
  const tok = await enrolNew('DEV-A');
  const saved = env.DEVICES;
  delete env.DEVICES;
  _test.reset();
  t.ok(await code(200, '/route', { token: HOUSE }), 'an old app: the household token everywhere');
  t.equal((await presence(HOUSE)).status, 200);
  const body = await (await register()).json();
  t.equal(body.ok, true);
  t.ok(!('tokens' in body));
  t.deepEqual(await deviceFleetBlock(env, {}), {});
  t.ok(await code(401, '/route', { token: tok }));
  t.ok(await code(503, '/admin/devices', { token: ADMIN }));
  t.ok(await code(503, '/devices/enroll', { method: 'POST', body: { code: 'ABCDEFGH', deviceId: 'x' } }));
  t.ok(await code(503, '/devices/me', { token: tok }));
  env.DEVICES = saved;
});

// ── The dashboard: run the page's own script against the worker ──
async function dashboard({ confirmAnswer = true } = {}) {
  const r = await req('/', { token: ADMIN });
  t.equal(r.status, 200);
  const html = await r.text();
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const els = {}, listeners = {};
  let docListeners = 0;
  const document = {
    activeElement: null,
    getElementById: (id) => (els[id] ??= { id, innerHTML: '', textContent: '', hidden: true, value: '', contains: () => false }),
    addEventListener: (type, fn) => { listeners[type] = fn; docListeners++; },
  };
  const ctx = vm.createContext({
    document, console, setTimeout, clearTimeout, setInterval: () => 0, confirm: () => confirmAnswer,
    fetch: (path, init) => worker.fetch(new Request(`https://relay.test${path}`, init), env), relayNow: () => Date.now(),
  });
  vm.runInContext('Date.now = relayNow;', ctx);   // the page and the worker share the test's movable clock
  vm.runInContext(script, ctx);
  await until(() => /devc|No enrolled|unavailable/.test(els.devList?.innerHTML || ''), 'the device list');
  const click = (dataset) => els.devPanel.onclick({ target: { closest: () => ({ dataset }) } });
  return { html, els, listeners, docListeners, click, el: document.getElementById };
}

await test('the dashboard panel: list, add a device (code + QR), revoke, forget', async () => {
  fresh();
  await enrolNew('DEV-OK', { name: 'Living room TV', platform: 'tvos', app: 'SlimeWatch TV 8.1' });
  await enrolNew('x"><img src=x onerror=alert(1)>'.replace(/[^A-Za-z0-9._-]/g, '_'), { name: '<img src=x onerror=alert(1)>', app: '"><svg onload=alert(2)>' });
  await enrolNew('DEV-OLD');
  await req('/admin/devices/revoke', { method: 'POST', token: ADMIN, body: { id: 'DEV-OLD' } });
  const d = await dashboard();
  t.match(d.html, /<h2 class="sec">Devices<\/h2>/);
  t.match(d.html, /id="devPanel"/);
  t.match(d.html, /data-dev="invite">Add a device<\/button>/);
  t.equal(d.docListeners, 2, 'the panel adds no document listener (the page keeps its click + change)');
  t.ok(!/function devQR|__name/.test(d.html), 'no function source shipped to the page (the bundler would rewrite it)');
  t.equal(typeof d.listeners.click, 'function');
  t.equal(typeof d.els.devPanel.onclick, 'function', 'the panel wires its own element');
  const w = d.els.devList.innerHTML;
  t.equal((w.match(/class="wcard devc/g) || []).length, 3);
  t.match(w, /Living room TV/);
  t.match(w, /Apple TV/);
  t.match(w, /SlimeWatch TV 8\.1/);
  t.ok(!/<img|<svg/i.test(w), 'hostile names and apps are escaped');
  t.match(w, /&lt;img src=x onerror=alert\(1\)&gt;/);
  t.match(w, /data-dev="revoke" data-dev-id="DEV-OK"/);
  t.match(w, /<span class="badge">revoked<\/span>/);
  t.match(w, /data-dev="forget" data-dev-id="DEV-OLD"/);
  t.ok(!/data-dev="revoke" data-dev-id="DEV-OLD"/.test(w), 'a revoked row offers Forget, not Revoke');
  t.ok(!/data-act=/.test(w + devicesPanelHTML()), 'never data-act (the page posts those to /admin/action)');
  t.match(w, /seen \d+s ago · relay/);
  // Add a device → the code large, the link and a QR.
  d.el('devLabel').value = 'Kitchen iPad';
  await d.click({ dev: 'invite' });
  t.equal(d.els.devInvite.hidden, false);
  const box = d.els.devInvite.innerHTML;
  const shown = box.match(/class="devcode"[^>]*>([A-Z2-9]{4}-[A-Z2-9]{4})</);
  t.ok(shown, 'the code, shown as XXXX-XXXX');
  t.match(box, new RegExp(`slimewatch://enrol\\?code=${shown[1].replace('-', '')}`));
  t.match(box, /<svg class="devqr" viewBox="0 0 37 37"/, 'a version-3 QR with its quiet zone');
  t.equal(d.el('devLabel').value, '', 'the label field is cleared');
  await until(() => /Open codes: /.test(d.els.devOpen.innerHTML), 'the open-codes line');
  t.match(d.els.devOpen.innerHTML, /\(Kitchen iPad\), 15 min left/);
  t.equal((await enrol(shown[1], 'DEV-KITCHEN')).status, 200, 'the shown code enrols');
  t.equal(stored('DEV-KITCHEN').label, 'Kitchen iPad');
  await d.click({ dev: 'hide' });
  t.equal(d.els.devInvite.hidden, true);
  // Revoke (after the confirm), then Forget.
  await d.click({ dev: 'revoke', devId: 'DEV-OK', devName: 'Living room TV' });
  t.ok(stored('DEV-OK').revokedAt > 0);
  await until(() => /data-dev="forget" data-dev-id="DEV-OK"/.test(d.els.devList.innerHTML), 'the revoked row');
  await d.click({ dev: 'forget', devId: 'DEV-OK' });
  t.ok(!storage.data.has('dev:DEV-OK'));
  await until(() => !/DEV-OK/.test(d.els.devList.innerHTML), 'the forgotten row to go');
  // Forget on a live device → the page's flash line.
  await d.click({ dev: 'forget', devId: 'DEV-KITCHEN' });
  t.equal(d.els.flash.textContent, 'Change failed: revoke first');
  t.equal(d.els.flash.hidden, false);
  // A declined confirm sends nothing.
  const d2 = await dashboard({ confirmAnswer: false });
  await d2.click({ dev: 'revoke', devId: 'DEV-KITCHEN' });
  t.equal(stored('DEV-KITCHEN').revokedAt, null);
  // The registry down → the list says so (no flash on a background refresh).
  registryDown = true;
  const d3 = await dashboard();
  t.match(d3.els.devList.innerHTML, /Device list unavailable \(registry unavailable\)\./);
  t.ok(!d3.els.flash || d3.els.flash.hidden, 'no flash for a refresh');
  registryDown = false;
  // No registry at all (an old wrangler.toml) → the same, and the rest of the page still runs.
  const saved = env.DEVICES;
  delete env.DEVICES;
  const d4 = await dashboard();
  t.match(d4.els.devList.innerHTML, /Device list unavailable \(devices not configured\)\./);
  env.DEVICES = saved;
});

await test('the 500-device cap (the /register list never exceeds it)', async () => {
  fresh();
  const hex = (n, salt) => (salt + n.toString(16)).padStart(64, '0');
  let enrolled = 0;
  for (let i = 0; i < 500; i++) {   // through the registry directly (no rate limits), counted as one check
    assert.equal((await direct('/invite', { codeHash: hex(i, 'c'), hint: 'AB…', label: '' })).status, 201);
    const r = await direct('/enroll', { codeHash: hex(i, 'c'), id: `D${i}`, sha256: hex(i, 'f'), name: 'n', platform: 'ios', app: '' });
    if (r.status === 200) enrolled++;
  }
  t.equal(enrolled, 500);
  await direct('/invite', { codeHash: hex(999, 'c'), hint: 'AB…', label: '' });
  const full = await direct('/enroll', { codeHash: hex(999, 'c'), id: 'D-EXTRA', sha256: hex(999, 'f'), name: 'n', platform: 'ios', app: '' });
  t.equal(full.status, 409);
  t.deepEqual(await full.json(), { error: 'too many devices' });
  const again = await direct('/enroll', { codeHash: hex(999, 'c'), id: 'D7', sha256: hex(1999, 'f'), name: 'n', platform: 'ios', app: '' });
  t.equal(again.status, 200, 're-enrolling an existing device is still allowed at the cap');
  t.equal((await (await register()).json()).tokens.devices.length, 500);
});

await test('the QR encoder: version, patterns, format, data and Reed–Solomon (decoded here)', async () => {
  // An independent reader: function-module map, format bits, unmask, zig-zag, syndromes.
  const EXP = new Array(512), LOG = new Array(256);
  for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11D; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
  const MASK = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0, (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
    (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0];
  const SPEC = { 21: [16, 10], 25: [28, 16], 29: [44, 26] };
  function read(m) {
    const n = m.length, at = (x, y) => (m[y][x] ? 1 : 0);
    const pos1 = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
    const pos2 = [...Array(8)].map((_, i) => [n - 1 - i, 8]).concat([...Array(7)].map((_, i) => [8, n - 7 + i]));
    const bits = (pos) => pos.reduce((acc, [x, y], i) => acc | (at(x, y) << i), 0);
    const f = bits(pos1) ^ 0x5412;
    let r = f >>> 10;
    for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const isFn = (x, y) => (x <= 8 && y <= 8) || (x >= n - 8 && y <= 8) || (x <= 8 && y >= n - 8) || x === 6 || y === 6 ||
      (n > 21 && Math.abs(x - (n - 7)) <= 2 && Math.abs(y - (n - 7)) <= 2);
    const mask = (f >>> 10) & 7, stream = [];
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let v = 0; v < n; v++) for (let j = 0; j < 2; j++) {
        const x = right - j, y = ((right + 1) & 2) === 0 ? n - 1 - v : v;
        if (!isFn(x, y)) stream.push(at(x, y) ^ (MASK[mask](x, y) ? 1 : 0));
      }
    }
    const [nd, ne] = SPEC[n];
    const cw = [];
    for (let i = 0; i < (nd + ne) * 8; i += 8) cw.push(stream.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
    const syndromesZero = [...Array(ne)].every((_, j) => cw.reduce((s, c) => gmul(s, EXP[j]) ^ c, 0) === 0);
    const dataBits = cw.slice(0, nd).flatMap((c) => [...Array(8)].map((_, i) => (c >>> (7 - i)) & 1));
    const num = (from, len) => dataBits.slice(from, from + len).reduce((a, b) => (a << 1) | b, 0);
    const len = num(4, 8);
    const text = String.fromCharCode(...[...Array(len)].map((_, i) => num(12 + 8 * i, 8)));
    return { bchOK: ((f >>> 10) << 10 | (r & 0x3ff)) === f, ecl: f >>> 13, copiesAgree: bits(pos1) === bits(pos2), mode: num(0, 4), text,
             syndromesZero, darkModule: m[n - 8][8] };
  }
  const finderOK = (m, cx, cy) => {
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      if (m[cy + dy][cx + dx] !== (d !== 2)) return false;
    }
    return true;
  };
  for (const text of ['slimewatch://enrol?code=K7Q4MZ2P', 'slimewatch://enrol?code=23456789', 'hi', 'https://relay.test/p/ABCDEF']) {
    const m = devQR(text);
    const n = m.length;
    t.equal(n, text.length <= 14 ? 21 : text.length <= 26 ? 25 : 29, `version for ${text.length} bytes`);
    t.ok(m.every((row) => row.length === n));
    t.ok(finderOK(m, 3, 3) && finderOK(m, n - 4, 3) && finderOK(m, 3, n - 4), 'three finder patterns');
    t.ok([...Array(n - 16)].every((_, i) => m[6][8 + i] === ((8 + i) % 2 === 0) && m[8 + i][6] === ((8 + i) % 2 === 0)), 'timing patterns');
    const q = read(m);
    t.ok(q.bchOK, 'format BCH');
    t.equal(q.ecl, 0, 'error correction level M');
    t.ok(q.copiesAgree, 'both format copies');
    t.ok(q.darkModule, 'the dark module');
    t.equal(q.mode, 4, 'byte mode');
    t.equal(q.text, text, 'the data reads back');
    t.ok(q.syndromesZero, 'Reed–Solomon syndromes are all zero');
  }
  t.equal(devQR('x'.repeat(42)).length, 29);
  t.equal(devQR('x'.repeat(43)), null, 'longer than version 3-M holds');
  t.equal(devQR('\uD800'), null, 'unencodable text');
});

await test('nothing in devices.js logs', async () => {
  const src = fs.readFileSync(new URL('../src/devices.js', import.meta.url), 'utf8');
  t.ok(!/console\./.test(src), 'no console calls: a token or hash can never reach the Worker logs');
  t.ok(src.split('\n').length <= 800 && fs.readFileSync(new URL('../src/qr.js', import.meta.url), 'utf8').split('\n').length <= 800, '≤ 800 lines');
});

console.log(`devices OK (${cases} cases, ${checks} checks)`);
