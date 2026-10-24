// Wave 8 (W8-F6a): replace this placeholder with the real cases (contracts.md §3:
// the §3.3 vectors, publish / canary / promote / rollback / restore, monotonic
// versions, the /register reply's `config`, the dashboard panel, admin only).
// Run: node test/remoteconfig.mjs
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { configFleetBlock } from '../src/remoteconfig.js';

function makeKV() {
  const m = new Map();
  return { async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, String(v)); },
           async delete(k) { m.delete(k); }, async list() { return { keys: [], list_complete: true }; } };
}
const env = { ADMIN_TOKEN: 'admin', USER_TOKEN: 'user', FLEET_TOKEN: 'fleet', SERVERS: makeKV() };
let n = 0;
const req = (path, { method = 'GET', token = 'admin' } = {}) => worker.fetch(new Request(`https://relay.test${path}`, {
  method, headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': `10.7.0.${++n}` },
}), env);

assert.equal((await req('/admin/config')).status, 404, 'scaffold: no config routes yet');
assert.deepEqual(await configFleetBlock(env), {});
const dash = await (await req('/')).text();
assert.ok(dash.includes('Servers') && dash.includes('Now Watching'), 'the dashboard still renders');
console.log('remoteconfig: 3 scaffold checks passed');
