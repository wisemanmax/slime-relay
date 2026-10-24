// Wave 8 (W8-F1a): replace this placeholder with the real cases (contracts.md §1:
// invite → enrol → the device token works on /route, /presence, /party; revoke →
// refused within the cache window; DEVICE_TOKENS_REQUIRED; the /register reply's
// `tokens`; the dashboard panel; old clients and old extractors unaffected).
// Run: node test/devices.mjs
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { userAuth, deviceFleetBlock } from '../src/devices.js';

function makeKV() {
  const m = new Map();
  return { async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, String(v)); },
           async delete(k) { m.delete(k); }, async list() { return { keys: [], list_complete: true }; } };
}
const env = { ADMIN_TOKEN: 'admin', USER_TOKEN: 'user', FLEET_TOKEN: 'fleet', SERVERS: makeKV() };
let n = 0;
const req = (path, { method = 'GET', token = 'user', body } = {}) => worker.fetch(new Request(`https://relay.test${path}`, {
  method, body: body === undefined ? undefined : JSON.stringify(body),
  headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': `10.8.0.${++n}`, ...(body ? { 'content-type': 'application/json' } : {}) },
}), env);

assert.equal(await userAuth(env, 'user', '/route'), true, 'USER_TOKEN is the user role');
assert.equal(await userAuth(env, 'swd1_' + 'A'.repeat(43), '/route'), false, 'scaffold: no device tokens yet');
assert.equal((await req('/route')).status, 200, '/route still answers the household token');
assert.equal((await req('/devices/enroll', { method: 'POST', body: {} })).status, 404, 'scaffold: no enrolment route yet');
const reg = await req('/register', { method: 'POST', token: 'fleet', body: { id: 'mac', name: 'Mac', address: 'http://mac.test:8787', load: 0, capacity: 4 } });
assert.deepEqual(await reg.json(), { ok: true }, '/register replies { ok } until F1a/F6a add their blocks');
assert.deepEqual(await deviceFleetBlock(env, {}), {});
console.log('devices: 6 scaffold checks passed');
