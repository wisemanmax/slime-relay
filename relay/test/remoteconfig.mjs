// Remote config on the relay (Wave 8, F6a; contracts.md §3): the closed set and
// the ten shared vectors (§3.3), publish / canary / promote / rollback / restore
// and what each does to version, configVersion, lastKnownGood, canary and the
// history; admin only; the /register reply's `config` (absent until something
// is published); and the dashboard's Remote fixes panel, run in a vm against the
// worker like routing.mjs does.
// Run: node test/remoteconfig.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import worker from '../src/worker.js';
import {
  checkBlock, checkEntry, checkRule, applyAction, readDoc, blockOf, rcParseRules, configFleetBlock,
  configPanelHTML, configPanelScript, RULE_KEYS, CODECS, CONTAINERS, PLATFORMS,
} from '../src/remoteconfig.js';

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };

// ── The shared vectors (contracts.md §3.3) — identical in
// SlimeWatchExtractor/test/remoteconfig-smoke.js; the apps' RemoteConfigTests
// take the same JSON. V1 is §3.1 with a concrete device id. ──
const CANARY_DEVICE = '8F2C5E1A-4B7D-4E21-9C3F-0A1B2C3D4E5F';
const V1 = { v: 1, version: 17,
  active: { configVersion: 12, forceVLCFor: [{ title: 'tv:1399' }, { codec: 'hevc', container: 'mp4', platform: 'tvos' }],
            note: 'GoT S1: black frames on AVPlayer', issuedAt: 1761300000000 },
  canary: { configVersion: 13, forceVLCFor: [{ title: 'movie:603' }], devices: [CANARY_DEVICE],
            note: 'try on the living-room TV', issuedAt: 1761310000000 } };
const V2 = { v: 1, version: 1, active: { configVersion: 1, forceVLCFor: [] } };
const withRules = (rules) => ({ v: 1, version: 2, active: { configVersion: 2, forceVLCFor: rules } });
const withDevices = (devices) => ({ ...V1, canary: { ...V1.canary, devices } });
const VECTORS = [
  ['V1', V1, true],
  ['V2', V2, true],
  ['V3', withRules([{ engine: 'avplayer' }]), false],
  ['V4', withRules([{ codec: 'HEVC' }]), false],
  ['V5', withRules([{}]), false],
  ['V6a', withRules([{ title: 'tv:0' }]), false],
  ['V6b', withRules([{ title: 'show:1399' }]), false],
  ['V7', withRules(Array.from({ length: 51 }, (_, i) => ({ title: `tv:${i + 1}` }))), false],
  ['V8a', withDevices([]), false],
  ['V8b', withDevices(Array.from({ length: 11 }, (_, i) => `DEV-${String(i + 1).padStart(2, '0')}`)), false],
  ['V9', { ...V2, v: 2 }, false],
  ['V10', { v: 1, version: 3, active: { configVersion: 3, forceVLCFor: [{ title: 'tv:1399', platform: 'ios' }] } }, true],
].map(([id, block, valid]) => [id, JSON.parse(JSON.stringify(block)), valid]);

for (const [id, block, valid] of VECTORS) {
  const err = checkBlock(block);
  ok(valid ? err === '' : err !== '', `${id}: ${valid ? 'valid' : 'rejected'} (${err || 'ok'})`);
}
// The "expect" clauses that are about the apps' matching: the reference
// semantics RemoteConfigRules.select / forcesVLC implement (keys ANDed, rules
// ORed, a key the stream doesn't know never matches).
const select = (b, device) => (b.canary && b.canary.devices.includes(device) ? b.canary : b.active || null);
const forces = (entry, facts) => !!entry && entry.forceVLCFor.some((r) => Object.keys(r).every((k) => facts[k] !== undefined && facts[k] === r[k]));
const v = Object.fromEntries(VECTORS.map(([id, b]) => [id, b]));
eq(select(v.V1, CANARY_DEVICE).configVersion, 13, 'V1: the listed device follows the canary');
eq(select(v.V1, 'LIVING-ROOM-2').configVersion, 12, 'V1: any other device follows active');
ok(forces(select(v.V1, 'X'), { title: 'tv:1399', platform: 'ios' }), 'V1: active forces tv:1399 anywhere');
ok(forces(select(v.V1, 'X'), { title: 'movie:1', codec: 'hevc', container: 'mp4', platform: 'tvos' }), 'V1: the hevc+mp4+tvos rule');
ok(!forces(select(v.V1, 'X'), { title: 'movie:1', codec: 'hevc', container: 'mkv', platform: 'tvos' }), 'V1: one key off → no force');
ok(!forces(select(v.V1, 'X'), { title: 'movie:1', codec: null, container: 'mp4', platform: 'tvos' }), 'V1: unknown codec never matches a codec rule');
ok(!forces(v.V2.active, { title: 'tv:1399', codec: 'hevc', container: 'mkv', platform: 'tvos' }), 'V2: forces nothing');
ok(!forces(v.V10.active, { title: 'tv:1399', platform: 'tvos' }), 'V10: AND — a tvOS stream of tv:1399 is NOT forced');
ok(forces(v.V10.active, { title: 'tv:1399', platform: 'ios' }), 'V10: the iPhone stream of tv:1399 is');

// ── More of the closed set (relay-local; the same rules, edge by edge) ──
const valid = (b) => checkBlock(JSON.parse(JSON.stringify(b))) === '';
ok(valid({ v: 1, version: 4, canary: V1.canary }), 'no active (canary first) is valid');
ok(valid({ v: 1, version: 5 }), 'no slots at all (rolled back to built-in) is valid');
ok(valid({ v: 1, version: 5, active: null, canary: null }), 'null slots read as absent');
ok(valid(withRules(Array.from({ length: 50 }, (_, i) => ({ title: `movie:${i + 1}` })))), '50 rules is the limit');
ok(valid(withDevices(Array.from({ length: 10 }, (_, i) => `D${i}`))), '10 canary devices is the limit');
ok(valid(withRules([{ title: 'tv:999999999' }])), 'a 9-digit TMDB id');
ok(!valid(withRules([{ title: 'tv:1234567890' }])), 'a 10-digit id is not');
ok(valid({ ...V2, active: { ...V2.active, note: 'x'.repeat(120) } }), 'note of 120');
ok(!valid({ ...V2, active: { ...V2.active, note: 'x'.repeat(121) } }), 'note of 121');
ok(!valid({ ...V2, active: { ...V2.active, note: 7 } }), 'note must be text');
ok(!valid({ ...V2, active: { ...V2.active, devices: ['A'] } }), 'devices is for a canary only');
ok(!valid({ ...V1, canary: { ...V1.canary, devices: undefined } }), 'a canary must list devices');
ok(!valid(withDevices(['ok', 'not ok!'])), 'a device id outside DEVICE_RE');
ok(!valid({ ...V2, extra: 1 }), 'unknown block key');
ok(!valid({ ...V2, active: { ...V2.active, engine: 'vlc' } }), 'unknown entry key');
for (const bad of [0, -1, 1.5, '1', null]) ok(!valid({ ...V2, version: bad }), `version ${JSON.stringify(bad)}`);
for (const bad of [0, '1', 2.5]) ok(!valid({ ...V2, active: { ...V2.active, configVersion: bad } }), `configVersion ${JSON.stringify(bad)}`);
ok(!valid({ v: 1, version: 1, active: { configVersion: 1 } }), 'forceVLCFor is required');
ok(!valid({ ...V2, active: { ...V2.active, issuedAt: -1 } }) && !valid({ ...V2, active: { ...V2.active, issuedAt: 1.5 } }), 'issuedAt is epoch ms');
ok(!valid(withRules([['title', 'tv:1']])) && !valid(withRules(['tv:1'])), 'a rule is an object');
ok(!valid(withRules([{ codec: 264 }])) && !valid(withRules([{ platform: 'android' }])) && !valid(withRules([{ container: 'MKV' }])), 'values from the enums only');
ok(checkBlock(JSON.parse('{"v":1,"version":1,"__proto__":{"x":1}}')) !== '', 'a __proto__ key is an unknown key');
ok(checkBlock([]) !== '' && checkBlock(null) !== '' && checkBlock('{"v":1}') !== '', 'non-objects');
ok(checkRule({ title: 'tv:1', codec: 'av1', container: 'webm', platform: 'macos' }) === '', 'all four keys in one rule');
eq([RULE_KEYS, CODECS, CONTAINERS, PLATFORMS].map((a) => a.length), [4, 7, 8, 3], 'the enums (RemoteConfigRules.swift)');
ok(!/HEVC|engine|avplayer/.test(checkBlock(v.V3) + checkBlock(v.V4)), 'reasons never quote the payload');
ok(checkEntry({ configVersion: 1, forceVLCFor: [{ title: 'tv:1' }], devices: ['A'] }, '', true) === '', 'canary entry');

// ── The textarea parser (syntax only; the route checks the closed set) ──
eq(rcParseRules('title=tv:1399 platform=tvos\n\n# a comment\ncodec=hevc, container=mp4 # trailing\r\n'),
  { rules: [{ title: 'tv:1399', platform: 'tvos' }, { codec: 'hevc', container: 'mp4' }], lines: [1, 4] }, 'parse lines');
eq(rcParseRules(''), { rules: [], lines: [] }, 'empty = no rules');
ok(/line 2: write key=value/.test(rcParseRules('title=tv:1\ntitle tv:2').error), 'missing =');
ok(/line 1: title appears twice/.test(rcParseRules('title=tv:1 title=tv:2').error), 'a key twice');
ok(/line 1/.test(rcParseRules('__proto__=x').error), '__proto__ is not a key');

// ── Pure transitions ──
const T0 = 1_761_000_000_000;
let d = readDoc(null).doc;
eq([d.version, d.lastConfigVersion, d.active, d.canary, d.lastKnownGood, d.history], [0, 0, null, null, null, []], 'empty doc');
const step = (action, body, now = T0) => { const r = applyAction(d, action, body, now); assert.ok(r.doc, `${action}: ${r.error}`); d = r.doc; return d; };
step('publish', { forceVLCFor: [{ platform: 'tvos', title: 'tv:1' }], note: '  hi\nthere\u0007 ' });
eq(d.active, { configVersion: 1, forceVLCFor: [{ title: 'tv:1', platform: 'tvos' }], note: 'hi there', issuedAt: T0 }, 'publish: keys in fixed order, note one line');
eq(applyAction(d, 'publish', { forceVLCFor: [], devices: ['A'] }).status, 400, 'publish takes no devices');
eq(applyAction(d, 'nope', {}).status, 404, 'unknown action');
eq(readDoc('{"version":"x"}').error ? 1 : 0, 1, 'a doc without a numeric version is unreadable');
eq(readDoc('not json').error ? 1 : 0, 1, 'bad json is unreadable');
eq(readDoc(JSON.stringify({ version: 3, active: { configVersion: 9, forceVLCFor: [] }, lastConfigVersion: 2 })).doc.lastConfigVersion, 9,
  'the counter never trails an issued configVersion');

// ── Routes, through the worker ──
function makeKV() {
  const m = new Map();
  return {
    m,
    async get(k) { const e = m.get(k); if (e && e.exp && e.exp <= Date.now()) { m.delete(k); return null; } return e ? e.value : null; },
    async put(k, val, o = {}) { m.set(k, { value: String(val), exp: o.expirationTtl ? Date.now() + o.expirationTtl * 1000 : 0, metadata: o.metadata ?? null }); },
    async delete(k) { m.delete(k); },
    async list({ prefix = '' } = {}) {
      return { keys: [...m.keys()].sort().filter((k) => k.startsWith(prefix) && (!m.get(k).exp || m.get(k).exp > Date.now()))
        .map((name) => ({ name, ...(m.get(name).metadata ? { metadata: m.get(name).metadata } : {}) })), list_complete: true };
    },
  };
}
const kv = makeKV();
const env = { ADMIN_TOKEN: 'admin', USER_TOKEN: 'user', FLEET_TOKEN: 'fleet', SERVERS: kv };
let ipn = 0;
function req(path, { method = 'GET', token = 'admin', body, ip } = {}) {
  ipn++;
  return worker.fetch(new Request(`https://relay.test${path}`, {
    method, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': ip || `10.7.${ipn >> 8}.${ipn & 255}`,
               ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  }), env);
}
const post = (action, body, o = {}) => req(`/admin/config/${action}`, { method: 'POST', body, ...o });
const getDoc = async () => { const r = await req('/admin/config'); assert.equal(r.status, 200); return (await r.json()).doc; };
const REG = { id: 'mac-8787', name: 'Home Mac', os: 'test', address: 'http://10.0.0.5:8787', load: 0, capacity: 4 };
const register = async () => { const r = await req('/register', { method: 'POST', token: 'fleet', body: REG }); assert.equal(r.status, 200); return r.json(); };
const stored = () => JSON.parse(kv.m.get('rc:doc')?.value || 'null');

// Nothing published: no `config` in the heartbeat reply, an empty doc.
let reply = await register();
ok(reply.ok === true && !('config' in reply), 'no doc → the /register reply is the old one (no config)');
eq(await configFleetBlock(env), {}, 'configFleetBlock: {} without a doc');
eq(await getDoc(), { version: 0, active: null, canary: null, lastKnownGood: null, history: [] }, 'GET: the empty doc');

// Admin only, every route, every other credential.
for (const token of ['user', 'fleet', 'nope', '']) {
  ok((await req('/admin/config', { token })).status === 401, `GET /admin/config as ${token || 'nobody'} → 401`);
  for (const a of ['publish', 'canary', 'promote', 'rollback', 'restore']) {
    ok((await post(a, { forceVLCFor: [] }, { token })).status === 401, `${a} as ${token || 'nobody'} → 401`);
  }
}
ok(stored() === null, 'refused calls wrote nothing');
eq((await req('/admin/config/frobnicate', { method: 'POST' })).status, 404, 'unknown action → 404');
eq((await req('/admin/config/publish')).status, 405, 'GET on an action → 405');
eq((await req('/admin/config', { method: 'POST', body: {} })).status, 405, 'POST on the doc → 405');
eq((await req('/admin/configuration')).status, 404, 'a lookalike path → 404');

// Bad bodies → 400 with a reason; nothing stored, version unchanged.
for (const [body, re, why] of [
  ['{oops', /bad json/, 'malformed json'],
  [[], /JSON object/, 'an array body'],
  [{ note: 'x' }, /forceVLCFor must be an array/, 'no rules'],
  [{ forceVLCFor: [{ engine: 'avplayer' }] }, /forceVLCFor\[0\]: unknown key/, 'V3 via the route'],
  [{ forceVLCFor: [{ codec: 'HEVC' }] }, /codec must be one of/, 'V4 via the route'],
  [{ forceVLCFor: [{}] }, /names no key/, 'V5 via the route'],
  [{ forceVLCFor: [{ title: 'tv:0' }] }, /title must be/, 'V6 via the route'],
  [{ forceVLCFor: Array.from({ length: 51 }, (_, i) => ({ title: `tv:${i + 1}` })) }, /at most 50 rules/, 'V7 via the route'],
  [{ forceVLCFor: [], note: 'x'.repeat(121) }, /note must be text of at most 120/, 'note too long'],
  [{ forceVLCFor: [], note: 5 }, /note must be text/, 'note not text'],
  [{ forceVLCFor: [], extra: true }, /publish takes only forceVLCFor, note/, 'unknown body field'],
]) {
  const r = await post('publish', body);
  const j = await r.json();
  ok(r.status === 400 && re.test(j.error), `publish rejects ${why} (${r.status} ${j.error})`);
}
ok(stored() === null, 'rejected publishes wrote nothing');
eq((await post('publish', 'x'.repeat(70 * 1024))).status, 413, 'a body over 64 KiB → 413');

// publish → version 1, configVersion 1, no last-known-good, in the heartbeat.
let r = await post('publish', { forceVLCFor: [{ title: 'tv:1399' }], note: 'GoT S1' });
eq(r.status, 200, 'publish → 200');
let doc = (await r.json()).doc;
ok(doc.version === 1 && doc.active.configVersion === 1 && doc.lastKnownGood === null && doc.canary === null, 'publish #1');
eq(doc.history.map((h) => [h.version, h.action, h.configVersion]), [[1, 'publish', 1]], 'one history line');
reply = await register();
eq(Object.keys(reply.config), ['v', 'version', 'active'], 'the block carries only v, version, active (no canary yet)');
ok(reply.config.v === 1 && reply.config.version === 1 && checkBlock(reply.config) === '', 'the heartbeat block passes the closed set');
eq(reply.config.active.forceVLCFor, [{ title: 'tv:1399' }], 'its rules');
ok(!('history' in reply.config) && !('lastKnownGood' in reply.config), 'no history, no last-known-good to extractors');
eq(reply.ok, true, 'ok stays');

// publish again → LKG ← active.
doc = (await (await post('publish', { forceVLCFor: [{ codec: 'hevc', platform: 'tvos' }] })).json()).doc;
ok(doc.version === 2 && doc.active.configVersion === 2 && doc.lastKnownGood.configVersion === 1, 'publish #2: LKG ← v1');
ok(!('note' in doc.active), 'an empty note is left out');

// canary → canary ← new configVersion; active and LKG untouched; devices checked.
for (const [devices, why] of [[[], 'no devices'], [Array.from({ length: 11 }, (_, i) => `D${i}`), '11 devices'], [['bad id!'], 'a bad id'], ['D1', 'not a list']]) {
  ok((await post('canary', { forceVLCFor: [{ title: 'movie:603' }], devices })).status === 400, `canary rejects ${why}`);
}
doc = (await (await post('canary', { forceVLCFor: [{ title: 'movie:603' }], devices: ['TV-1', 'TV-1', 'TV-2'], note: 'living room' })).json()).doc;
ok(doc.version === 3 && doc.canary.configVersion === 3 && doc.active.configVersion === 2 && doc.lastKnownGood.configVersion === 1, 'canary v3 beside active v2');
eq(doc.canary.devices, ['TV-1', 'TV-2'], 'devices de-duplicated, in order');
reply = await register();
ok(reply.config.version === 3 && reply.config.canary.configVersion === 3 && reply.config.canary.devices.length === 2, 'the heartbeat carries the canary');
eq(select(reply.config, 'TV-1').configVersion, 3, 'a canary device follows v3');
eq(select(reply.config, 'TV-9').configVersion, 2, 'the rest follow v2');

// rollback with a canary → only the canary goes.
doc = (await (await post('rollback')).json()).doc;
ok(doc.version === 4 && doc.canary === null && doc.active.configVersion === 2 && doc.lastKnownGood.configVersion === 1, 'rollback drops the canary only');
eq(doc.history.at(-1), { version: 4, at: doc.history.at(-1).at, action: 'rollback', target: 'canary', from: 3, configVersion: null }, 'its history line');

// promote: none → 409; with one → LKG ← active, active ← canary, canary ← null.
let rr = await post('promote');
ok(rr.status === 409 && /no canary/.test((await rr.json()).error), 'promote without a canary → 409');
await post('canary', { forceVLCFor: [{ title: 'movie:603' }], devices: ['TV-1'], note: 'try' });
doc = (await (await post('promote')).json()).doc;
ok(doc.version === 6 && doc.active.configVersion === 4 && doc.canary === null && doc.lastKnownGood.configVersion === 2, 'promote v4: LKG ← v2');
ok(!('devices' in doc.active) && doc.active.note === 'try', 'the promoted config has no devices, keeps its note');
reply = await register();
ok(reply.config.version === 6 && reply.config.active.configVersion === 4 && !('canary' in reply.config), 'every device now follows v4');

// rollback without a canary → active ← LKG (re-issued under a new version);
// again → 409 (already there; Restore goes further back).
doc = (await (await post('rollback')).json()).doc;
ok(doc.version === 7 && doc.active.configVersion === 2 && doc.lastKnownGood.configVersion === 2, 'rollback: active ← v2');
eq(doc.active.forceVLCFor, [{ codec: 'hevc', platform: 'tvos' }], 'v2 content re-issued');
eq([doc.history.at(-1).target, doc.history.at(-1).from, doc.history.at(-1).configVersion], ['active', 4, 2], 'history: v4 → v2');
reply = await register();
ok(reply.config.version === 7 && reply.config.active.configVersion === 2, 'the rollback reaches the heartbeat as a NEWER version');
rr = await post('rollback');
ok(rr.status === 409 && /already on the last known good/.test((await rr.json()).error), 'a second rollback → 409');
eq((await getDoc()).version, 7, 'a refused action does not bump the version');

// restore: unknown → 400, active → 409, else active ← that content (LKG ← active).
ok((await post('restore', { configVersion: 99 })).status === 400, 'restore of an unknown configVersion → 400');
ok((await post('restore', { configVersion: 'one' })).status === 400, 'restore needs an integer');
ok((await post('restore', { configVersion: 2 })).status === 409, 'restore of the active one → 409');
await post('canary', { forceVLCFor: [{ title: 'movie:1' }], devices: ['TV-1'] });
doc = (await (await post('restore', { configVersion: 1 })).json()).doc;
ok(doc.version === 9 && doc.active.configVersion === 1 && doc.lastKnownGood.configVersion === 2 && doc.canary === null, 'restore v1: LKG ← v2, canary cleared');
eq([doc.active.forceVLCFor, doc.active.note], [[{ title: 'tv:1399' }], 'GoT S1'], 'v1 content and note');
doc = (await (await post('restore', { configVersion: 5 })).json()).doc;
ok(doc.active.configVersion === 5 && doc.active.forceVLCFor[0].title === 'movie:1', 'a dropped canary is restorable from the history');

// configVersion is monotonic: never reused after rollbacks / restores.
doc = (await (await post('publish', { forceVLCFor: [] })).json()).doc;
ok(doc.active.configVersion === 6 && doc.version === 11, 'the next new config is v6 (not a reused number)');

// Rolling back past the first publish → no active (built-in); then nothing left.
const kv2 = makeKV();
const env2 = { ...env, SERVERS: kv2 };
const post2 = (a, body) => worker.fetch(new Request(`https://relay.test/admin/config/${a}`, {
  method: 'POST', body: body === undefined ? undefined : JSON.stringify(body),
  headers: { authorization: 'Bearer admin', 'cf-connecting-ip': `10.8.0.${++ipn & 255}` },
}), env2);
eq((await post2('rollback')).status, 409, 'nothing to roll back on an empty doc');
await post2('canary', { forceVLCFor: [{ title: 'tv:7' }], devices: ['TV-1'] });
let blk = (await configFleetBlock(env2)).config;
ok(blk && !('active' in blk) && blk.canary.configVersion === 1 && checkBlock(blk) === '', 'canary first: a block with no active');
await post2('promote');
doc = (await (await post2('rollback')).json()).doc;
ok(doc.active === null && doc.lastKnownGood === null && doc.version === 3, 'rollback past the first publish → built-in');
blk = (await configFleetBlock(env2)).config;
eq(blk, { v: 1, version: 3 }, 'the fleet block says "nothing forced" under a newer version');
eq((await post2('rollback')).status, 409, 'then nothing is left to roll back');

// History cap (≤ 50, newest last) and version +1 per action.
for (let i = 0; i < 45; i++) await post('canary', { forceVLCFor: [{ title: `tv:${i + 1}` }], devices: ['TV-1'] }, { ip: `10.6.${i}.1` });
doc = await getDoc();
ok(doc.history.length === 50 && doc.version === 56 && doc.history.at(-1).version === 56 && doc.history[0].version === 7, 'history keeps the newest 50');
ok(doc.history.every((h, i, a) => i === 0 || h.version === a[i - 1].version + 1), 'one line per version, in order');
ok(stored().lastConfigVersion === 51, 'the counter is stored with the doc');

// Rate limit on writes: 30 a minute per IP.
let last = 0;
for (let i = 0; i < 31; i++) last = (await post('rollback', undefined, { ip: '10.5.5.5' })).status;
ok(last === 429, `the 31st write in a minute from one IP → 429 (${last})`);
ok((await req('/admin/config', { ip: '10.5.5.5' })).status === 200, 'reads are not limited');

// A broken doc: the heartbeat keeps working without `config`; the routes say why.
const kv3 = makeKV();
await kv3.put('rc:doc', '{"version":4,"active":{"configVersion":1,"forceVLCFor":[{"engine":"avplayer"}]}}');
const env3 = { ...env, SERVERS: kv3 };
eq(await configFleetBlock(env3), {}, 'a doc outside the closed set never reaches the fleet');
const rg = await worker.fetch(new Request('https://relay.test/register', { method: 'POST', body: JSON.stringify(REG),
  headers: { authorization: 'Bearer fleet', 'content-type': 'application/json', 'cf-connecting-ip': '10.4.0.1' } }), env3);
ok(rg.status === 200 && !('config' in (await rg.json())), '/register still answers');
const g3 = await worker.fetch(new Request('https://relay.test/admin/config', { headers: { authorization: 'Bearer admin' } }), env3);
ok(g3.status === 500 && /unreadable/.test((await g3.json()).error), 'GET explains the unreadable doc');
eq(await configFleetBlock({ SERVERS: { get: async () => { throw new Error('kv down'); } } }), {}, 'KV down → {}');
eq(blockOf({ version: 2, active: null, canary: null }), { v: 1, version: 2 }, 'blockOf leaves empty slots out');

// ── Dashboard: the panel renders and its script runs against the worker ──
const html = configPanelHTML();
ok(/Remote fixes/.test(html) && /id="rcRules"/.test(html) && /id="rcDevices"/.test(html) && /id="rcNote"/.test(html), 'panel fields');
ok(['publish', 'canary', 'promote', 'rollback'].every((a) => html.includes(`data-rc="${a}"`)), 'Publish · Canary · Promote · Roll back');
ok(!/data-act|onclick|onerror|onload/i.test(html + configPanelScript()), 'no inline handlers; never the page\'s data-act');
new vm.Script(configPanelScript());   // compiles on its own

const kvD = makeKV();
const envD = { ...env, SERVERS: kvD };
const beat = (id, name) => worker.fetch(new Request('https://relay.test/presence', { method: 'POST',
  body: JSON.stringify({ id, name, title: 'Show', kind: 'Series', platform: 'tvOS', paused: false }),
  headers: { authorization: 'Bearer user', 'content-type': 'application/json', 'cf-connecting-ip': `10.3.0.${++ipn & 255}` } }), envD);
await beat('dev-1', 'Ann');
await beat('x"><img src=x onerror=alert(1)>', 'Eve');
const page = await (await worker.fetch(new Request('https://relay.test/', { headers: { authorization: 'Bearer admin' } }), envD)).text();
ok(page.indexOf('Remote fixes') > page.indexOf('id="grid"'), 'the section sits after the Servers grid');
const script = page.match(/<script>([\s\S]*)<\/script>/)[1];

function fakeDom() {
  const els = {};
  const docListeners = {};
  const make = (id) => ({ id, innerHTML: '', textContent: '', value: '', hidden: true, disabled: false, listeners: {},
    addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }, contains: () => false, scrollIntoView() { this.scrolled = true; } });
  return { els, docListeners, document: {
    activeElement: null, getElementById: (id) => (els[id] ??= make(id)),
    addEventListener: (t, fn) => { docListeners[t] = fn; },
  } };
}
const dom = fakeDom();
for (const id of ['rc', 'rcTop', 'rcState', 'rcHistory', 'rcRules', 'rcNote', 'rcDevices', 'rcPromote', 'rcRollback', 'rcMsg',
  'watchers', 'grid', 'flash', 'count', 'acount']) dom.document.getElementById(id);   // the page's elements exist up front
const confirms = [];
let answer = true;
const ctx = vm.createContext({
  document: dom.document, console, clearTimeout, setInterval: () => 0,
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  confirm: (q) => { confirms.push(q); return answer; },
  fetch: (path, init) => worker.fetch(new Request(`https://relay.test${path}`, init), envD),
});
vm.runInContext(script, ctx);
const until = async (cond, what) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise((res) => setTimeout(res, 5)); assert.ok(cond(), what); };
const E = dom.els;
await until(() => /rccard/.test(E.rcState.innerHTML) && /wcard/.test(E.watchers.innerHTML), 'panel and watchers render');
ok(/Nothing published/.test(E.rcState.innerHTML) && /No changes yet/.test(E.rcHistory.innerHTML), 'empty state');
ok(E.rcPromote.disabled && E.rcRollback.disabled, 'Promote and Roll back disabled with nothing to act on');
ok(/data-rc="here" data-rc-device="dev-1">Canary here/.test(E.watchers.innerHTML), '"Canary here" on a Now Watching card');
eq((E.watchers.innerHTML.match(/Canary here/g) || []).length, 1, 'no button for a device id the relay would refuse');
ok(!/<img/i.test(E.watchers.innerHTML), 'hostile presence stays escaped');
ok(E.watchers.listeners.click?.length === 1 && E.rc.listeners.click?.length === 1, 'listeners on #watchers and #rc');
ok(typeof dom.docListeners.click === 'function', 'the page keeps its own document listener');

const click = (el, dataset) => el.listeners.click[0]({ target: { closest: (sel) => (sel === 'button[data-rc]' ? { dataset, disabled: false } : null) } });
const docVersion = async () => readDoc(await kvD.get('rc:doc')).doc.version;
click(E.watchers, { rc: 'here', rcDevice: 'dev-1' });
click(E.watchers, { rc: 'here', rcDevice: 'dev-1' });
ok(E.rcDevices.value === 'dev-1' && E.rcTop.scrolled && /Canary devices: 1/.test(E.rcMsg.textContent), '"Canary here" fills the devices field once');
click(E.watchers, { rc: 'here', rcDevice: 'bad id!' });
eq(E.rcDevices.value, 'dev-1', 'a malformed id is not added');

E.rcRules.value = 'title=tv:1399';
E.rcDevices.value = '';
click(E.rc, { rc: 'canary' });
await until(() => !E.flash.hidden, 'flash');
ok(/add at least one device/.test(E.flash.textContent) && confirms.length === 0, 'a canary needs a device');
E.flash.hidden = true;
E.rcDevices.value = 'dev-1';
E.rcRules.value = 'title tv:1399';
click(E.rc, { rc: 'canary' });
ok(/line 1: write key=value/.test(E.flash.textContent) && confirms.length === 0, 'a syntax error is caught before confirm');
E.rcRules.value = 'title=tv:1399 platform=tvos\n\n# next one is wrong\ncodec=HEVC';
click(E.rc, { rc: 'canary' });
await until(() => /line 4/.test(E.flash.textContent), 'route error');
ok(/line 4: codec must be one of/.test(E.flash.textContent) && (await docVersion()) === 0, 'the route\'s reason names the textarea line; nothing stored');
answer = false;
E.rcRules.value = 'title=tv:1399 platform=tvos';
click(E.rc, { rc: 'canary' });
await new Promise((res) => setTimeout(res, 30));
ok(confirms.length === 2 && (await docVersion()) === 0, 'Cancel at the confirm sends nothing');
answer = true;
E.rcNote.value = '<img src=x onerror=alert(1)>';
click(E.rc, { rc: 'canary' });
await until(() => /Canary started/.test(E.rcMsg.textContent), 'canary');
ok(/Canary 1 rule\(s\) on 1 device\(s\): dev-1\?/.test(confirms.at(-1)), 'one confirm, naming what it does');
ok(/&lt;img src=x onerror=alert\(1\)&gt;/.test(E.rcState.innerHTML) && !/<img/i.test(E.rcState.innerHTML), 'the note is escaped');
ok(/title=tv:1399 platform=tvos/.test(E.rcState.innerHTML) && /devices: dev-1/.test(E.rcState.innerHTML), 'the canary card');
ok(!E.rcPromote.disabled && !E.rcRollback.disabled, 'Promote and Roll back enabled');
vm.runInContext('refresh()', ctx);
await until(() => /in canary v1/.test(E.watchers.innerHTML), 'canary tag');
ok(/in canary v1/.test(E.watchers.innerHTML), 'the card says it is in the canary');

click(E.rc, { rc: 'promote' });
await until(() => /Promoted/.test(E.rcMsg.textContent), 'promote');
ok(/Promote canary v1 to EVERY device\?/.test(confirms.at(-1)), 'promote confirm');
let sd = readDoc(await kvD.get('rc:doc')).doc;
ok(sd.active.configVersion === 1 && sd.canary === null, 'promoted');
E.rcRules.value = 'codec=hevc container=mkv';
E.rcNote.value = '';
click(E.rc, { rc: 'publish' });
await until(() => /Published/.test(E.rcMsg.textContent), 'publish');
ok(/Publish 1 rule\(s\) to EVERY device\? It replaces v1\./.test(confirms.at(-1)), 'publish confirm');
sd = readDoc(await kvD.get('rc:doc')).doc;
ok(sd.active.configVersion === 2 && sd.lastKnownGood.configVersion === 1, 'published v2 over v1');
click(E.rc, { rc: 'rollback' });
await until(() => /Rolled back/.test(E.rcMsg.textContent), 'rollback');
ok(/Roll EVERY device back from v2 to v1 \(last known good\)\?/.test(confirms.at(-1)), 'rollback confirm');
ok(/rolled back v2 → v1/.test(E.rcHistory.innerHTML), 'history line');
ok(/data-rc="restore" data-rc-cv="2"/.test(E.rcHistory.innerHTML) && !/data-rc-cv="1"/.test(E.rcHistory.innerHTML), 'Restore offered for v2, not for the active v1');
click(E.rc, { rc: 'restore', rcCv: '2' });
await until(() => /Restored v2/.test(E.rcMsg.textContent), 'restore');
sd = readDoc(await kvD.get('rc:doc')).doc;
ok(sd.active.configVersion === 2 && sd.version === 5, 'restored v2');
click(E.rc, { rc: 'edit', rcSlot: 'active' });
eq(E.rcRules.value, 'codec=hevc container=mkv', '"Edit a copy" fills the textarea');
click(E.rc, { rc: 'edit', rcSlot: '__proto__' });
eq(E.rcRules.value, 'codec=hevc container=mkv', 'edit only reads the three slots');
eq(E.rcHistory.innerHTML.match(/class="rch1"/g).length, 5, 'history lines (≤ 10 shown)');

// The minimal fake routing.mjs uses (no element listeners, no confirm) must not throw.
const els2 = {};
vm.runInContext(script, vm.createContext({
  document: { activeElement: null, getElementById: (id) => (els2[id] ??= { id, innerHTML: '', textContent: '', hidden: true, contains: () => false }), addEventListener() {} },
  console, setTimeout, clearTimeout, setInterval: () => 0,
  fetch: (path, init) => worker.fetch(new Request(`https://relay.test${path}`, init), envD),
}));
await until(() => /rccard/.test(els2.rcState?.innerHTML || ''), 'renders under the minimal fake');
ok(true, 'the minimal fake runs the panel');

console.log(`remoteconfig: ${checks} checks passed`);
