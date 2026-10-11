// Per-device routing: /route?device=, the assign/avoid/unavoid/clear-device
// admin actions, presence `server` + `routing`, seen:/pruning, and the
// dashboard's Server control (rendered by running the page's own script).
// In-memory KV with TTLs, list() + metadata, and a movable clock.
// Run: node test/routing.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import worker from '../src/worker.js';

const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;
const DAY = 86_400_000;

function makeKV() {
  const m = new Map();   // key -> { value, exp (ms, 0 = none), metadata }
  const live = (k) => {
    const e = m.get(k);
    if (e && e.exp && e.exp <= Date.now()) { m.delete(k); return null; }
    return e || null;
  };
  return {
    m, puts: [],
    async get(k) { return live(k)?.value ?? null; },
    async put(k, v, o = {}) {
      this.puts.push(k);
      m.set(k, { value: String(v), exp: o.expirationTtl ? Date.now() + o.expirationTtl * 1000 : 0, metadata: o.metadata ?? null });
    },
    async delete(k) { m.delete(k); },
    async list({ prefix = '' } = {}) {
      const keys = [];
      for (const k of [...m.keys()].sort()) {
        const e = k.startsWith(prefix) && live(k);
        if (e) keys.push({ name: k, ...(e.metadata ? { metadata: e.metadata } : {}) });
      }
      return { keys, list_complete: true };
    },
  };
}

const kv = makeKV();
const env = { ADMIN_TOKEN: 'admin', USER_TOKEN: 'user', FLEET_TOKEN: 'fleet', SERVERS: kv };

let ipn = 0;
async function req(path, { method = 'GET', token = 'user', body } = {}) {
  ipn++;   // a fresh client IP per call keeps the per-IP limiters out of the way
  return worker.fetch(new Request(`https://relay.test${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': `10.9.${ipn >> 8}.${ipn & 255}`,
               ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  }), env);
}
const register = (id, name, load, capacity = 4) => req('/register', { method: 'POST', token: 'fleet',
  body: { id, name, os: 'test', address: `http://${id}.test:8080`, load, capacity } });
const act = (body) => req('/admin/action', { method: 'POST', token: 'admin', body });
async function route(device) {
  const r = await req(device === undefined ? '/route' : `/route?device=${encodeURIComponent(device)}`);
  assert.equal(r.status, 200);
  const { servers } = await r.json();
  return { list: servers.map((a) => a.replace(/^http:\/\/|\.test:8080$/g, '')), note: r.headers.get('x-slime-route-note') };
}
const policy = () => JSON.parse(kv.m.get('policy')?.value || '{}');
const beat = (id, extra = {}) => req('/presence', { method: 'POST',
  body: { id, name: 'Viewer', title: 'Show', kind: 'Series', platform: 'iPhone', paused: false, ...extra } });

// Fleet. Shared rank (least loaded first): oracle (0/4), home (1/4), pc (2/4).
for (const [id, name, load] of [['home', 'Home Mac', 1], ['oracle', 'Oracle', 0], ['pc', 'Friend PC', 2]]) {
  assert.equal((await register(id, name, load)).status, 200);
}
const SHARED = ['oracle', 'home', 'pc'];

// ── /route without a device (or with one that has no policy) is unchanged ──
assert.deepEqual(await route(), { list: SHARED, note: null });
assert.deepEqual(await route('dev-1'), { list: SHARED, note: null });
assert.deepEqual(await route('../../etc'), { list: SHARED, note: null }, 'malformed id = shared list, not an error');
assert.deepEqual(await route(''), { list: SHARED, note: null });
assert.equal((await req('/route', { token: 'nope' })).status, 401);

// ── Admin action validation ──
assert.equal((await req('/admin/action', { method: 'POST', token: 'user', body: { action: 'assign', device: 'dev-1', server: 'pc' } })).status, 401);
for (const [body, why] of [
  [{ action: 'assign', device: 'bad id!', server: 'pc' }, 'device charset'],
  [{ action: 'assign', device: 'x'.repeat(81), server: 'pc' }, 'device > 80 chars'],
  [{ action: 'assign', device: '', server: 'pc' }, 'empty device'],
  [{ action: 'assign', device: 42, server: 'pc' }, 'non-string device'],
  [{ action: 'assign', server: 'pc' }, 'missing device'],
  [{ action: 'assign', device: 'dev-1', server: 'nope' }, 'unknown server'],
  [{ action: 'assign', device: 'dev-1', server: 7 }, 'non-string server'],
  [{ action: 'avoid', device: 'dev-1', server: null }, 'avoid needs a server'],
  [{ action: 'avoid', device: 'dev-1', server: 'nope' }, 'avoid unknown server'],
  [{ action: 'unavoid', device: 'dev-1', server: 'nope' }, 'unavoid unknown server'],
  [{ action: 'clear-device', device: 'a/b' }, 'clear bad device'],
  [{ action: 'reroute', device: 'dev-1' }, 'unknown action'],
]) {
  const r = await act(body);
  assert.equal(r.status, 400, why);
}
assert.equal(Object.keys(policy().devices || {}).length, 0, 'rejected actions wrote nothing');
assert.equal((await act({ action: 'assign', device: 'x'.repeat(80), server: null })).status, 200, '80 chars is allowed');

// ── Pin: the pinned server first, then the shared ranking ──
let r = await act({ action: 'assign', device: 'dev-1', server: 'pc' });
assert.equal(r.status, 200);
const body1 = await r.json();
assert.equal(body1.policy.devices['dev-1'].server, 'pc');
assert.deepEqual(body1.policy.devices['dev-1'].avoid, []);
assert.ok(body1.policy.devices['dev-1'].seenAt > 0);
assert.deepEqual(await route('dev-1'), { list: ['pc', 'oracle', 'home'], note: null });
assert.deepEqual(await route(), { list: SHARED, note: null }, 'other callers unaffected');
assert.deepEqual(await route('dev-2'), { list: SHARED, note: null });

// ── Avoid: removed from that device's list ──
assert.equal((await act({ action: 'avoid', device: 'dev-1', server: 'home' })).status, 200);
assert.deepEqual(await route('dev-1'), { list: ['pc', 'oracle'], note: null });

// ── Pinned server disabled, then down: fall through to the (avoid-filtered) list ──
assert.equal((await act({ action: 'disable', id: 'pc' })).status, 200);
assert.deepEqual(await route('dev-1'), { list: ['oracle'], note: null });
assert.equal(policy().devices['dev-1'].server, 'pc', 'a fleet action keeps device rules');
assert.equal((await act({ action: 'enable', id: 'pc' })).status, 200);
kv.m.delete('srv:pc');   // heartbeat expired
assert.deepEqual(await route('dev-1'), { list: ['oracle'], note: null });
assert.equal((await register('pc', 'Friend PC', 2)).status, 200);
assert.deepEqual(await route('dev-1'), { list: ['pc', 'oracle'], note: null });

// ── A pin beats the fleet-wide Prefer for that device only ──
assert.equal((await act({ action: 'prefer', id: 'home' })).status, 200);
assert.deepEqual(await route(), { list: ['home', 'oracle', 'pc'], note: null });
assert.deepEqual(await route('dev-1'), { list: ['pc', 'oracle'], note: null });
assert.equal((await act({ action: 'unprefer' })).status, 200);

// ── Avoiding everything: availability beats policy ──
for (const s of SHARED) assert.equal((await act({ action: 'avoid', device: 'dev-2', server: s })).status, 200);
assert.deepEqual(await route('dev-2'), { list: SHARED, note: 'avoid-exhausted' });
// ...but a live pin with everything else avoided is just the pin.
assert.equal((await act({ action: 'assign', device: 'dev-3', server: 'oracle' })).status, 200);
assert.equal((await act({ action: 'avoid', device: 'dev-3', server: 'home' })).status, 200);
assert.equal((await act({ action: 'avoid', device: 'dev-3', server: 'pc' })).status, 200);
assert.deepEqual(await route('dev-3'), { list: ['oracle'], note: null });
// ...and once that pin is down too, nothing is left: full list + note.
kv.m.delete('srv:oracle');
assert.deepEqual(await route('dev-3'), { list: ['home', 'pc'], note: 'avoid-exhausted' });
assert.equal((await register('oracle', 'Oracle', 0)).status, 200);

// ── Pin/avoid of the same server replace each other ──
assert.equal((await act({ action: 'avoid', device: 'dev-4', server: 'pc' })).status, 200);
assert.equal((await act({ action: 'assign', device: 'dev-4', server: 'pc' })).status, 200);
assert.deepEqual(policy().devices['dev-4'], { ...policy().devices['dev-4'], server: 'pc', avoid: [] });
assert.equal((await act({ action: 'avoid', device: 'dev-4', server: 'pc' })).status, 200);
assert.equal(policy().devices['dev-4'].server, null);
assert.deepEqual(policy().devices['dev-4'].avoid, ['pc']);
assert.equal((await act({ action: 'avoid', device: 'dev-4', server: 'pc' })).status, 200, 'avoid is idempotent');
assert.deepEqual(policy().devices['dev-4'].avoid, ['pc']);
// unavoid of the last rule leaves nothing: the entry goes (Automatic).
assert.equal((await act({ action: 'unavoid', device: 'dev-4', server: 'pc' })).status, 200);
assert.equal(policy().devices['dev-4'], undefined);
// unavoid accepts a retired server that is still in the avoid list.
assert.equal((await act({ action: 'avoid', device: 'dev-5', server: 'pc' })).status, 200);
kv.m.delete('srv:pc');
assert.equal((await act({ action: 'unavoid', device: 'dev-5', server: 'pc' })).status, 200);
assert.equal(policy().devices['dev-5'], undefined);
assert.equal((await register('pc', 'Friend PC', 2)).status, 200);
// assign null = Automatic: drops the pin, keeps avoids.
assert.equal((await act({ action: 'assign', device: 'dev-6', server: 'pc' })).status, 200);
assert.equal((await act({ action: 'avoid', device: 'dev-6', server: 'home' })).status, 200);
assert.equal((await act({ action: 'assign', device: 'dev-6', server: null })).status, 200);
assert.deepEqual([policy().devices['dev-6'].server, policy().devices['dev-6'].avoid], [null, ['home']]);
assert.equal((await act({ action: 'clear-device', device: 'dev-6' })).status, 200);
assert.equal(policy().devices['dev-6'], undefined);
assert.equal((await act({ action: 'clear-device', device: 'never-set' })).status, 200, 'clearing nothing is fine');
// Prototype-ish ids are plain keys.
assert.equal((await act({ action: 'assign', device: '__proto__', server: 'pc' })).status, 200);
assert.equal((await act({ action: 'assign', device: 'constructor', server: 'home' })).status, 200);
assert.deepEqual(await route('__proto__'), { list: ['pc', 'oracle', 'home'], note: null });
assert.deepEqual(await route('constructor'), { list: ['home', 'oracle', 'pc'], note: null });
assert.deepEqual(await route('toString'), { list: SHARED, note: null });
assert.equal((await act({ action: 'clear-device', device: '__proto__' })).status, 200);
assert.equal((await act({ action: 'clear-device', device: 'constructor' })).status, 200);
assert.equal(Object.getPrototypeOf(policy()), Object.prototype);

// ── /servers adds the devices map ──
r = await req('/servers', { token: 'admin' });
assert.equal(r.status, 200);
const fleetView = await r.json();
assert.equal(fleetView.servers.length, 3);
assert.deepEqual(Object.keys(fleetView.devices).sort(), ['dev-1', 'dev-2', 'dev-3'], 'Automatic-with-no-avoid devices are not stored');
assert.equal(fleetView.devices['dev-1'].server, 'pc');
assert.deepEqual(fleetView.devices['dev-1'].avoid, ['home']);
assert.equal((await req('/servers')).status, 401);

// ── Presence: `server` round trip + routing summary ──
const policyPuts = () => kv.puts.filter((k) => k === 'policy').length;
const policyPutsBefore = policyPuts();
assert.equal((await beat('dev-1', { server: 'Friend PC' })).status, 200);
assert.equal((await beat('dev-2', { server: 'Home Mac' })).status, 200);
assert.equal((await beat('dev-7')).status, 200);                                    // no server field
assert.equal((await beat('dev-8', { server: 'S'.repeat(200) })).status, 200);       // capped
assert.equal((await beat('dev-9', { server: { evil: 1 } })).status, 200);           // non-string ignored
r = await req('/presence', { token: 'admin' });
const pres = await r.json();
const row = (id) => pres.sessions.find((s) => s.id === id);
assert.equal(pres.active, 5);
assert.equal(row('dev-1').server, 'Friend PC');
assert.equal(row('dev-1').routing, 'pinned:Friend PC');
assert.equal(row('dev-2').server, 'Home Mac');
assert.equal(row('dev-2').routing, 'avoid:Oracle,Home Mac,Friend PC');
assert.equal(row('dev-7').server, '');
assert.equal(row('dev-7').routing, 'auto');
assert.equal(row('dev-8').server.length, 80);
assert.equal(row('dev-9').server, '');
assert.equal((await req('/presence')).status, 401);
// A pin to a server that's gone is summarized by id.
kv.m.delete('srv:pc');
assert.equal((await (await req('/presence', { token: 'admin' })).json()).sessions.find((s) => s.id === 'dev-1').routing, 'pinned:pc');
assert.equal((await register('pc', 'Friend PC', 2)).status, 200);

// ── seen:<id> — written only for devices with a policy, throttled ──
assert.ok(kv.m.has('seen:dev-1') && kv.m.has('seen:dev-2'));
assert.ok(!kv.m.has('seen:dev-7'), 'no policy, no seen key');
assert.equal(kv.m.get('seen:dev-1').metadata.at, Number(kv.m.get('seen:dev-1').value));
let before = kv.puts.filter((k) => k === 'seen:dev-1').length;
await beat('dev-1', { server: 'Friend PC' });
assert.equal(kv.puts.filter((k) => k === 'seen:dev-1').length, before, 'second beat within 6 h does not rewrite');
assert.equal(policyPuts(), policyPutsBefore, 'presence beats never write the policy key');

// ── Pruning: 30 days with no presence and no owner change ──
// dev-1 keeps beating; dev-2 / dev-3 / the 80-char device go quiet.
skew = 20 * DAY;
for (const s of SHARED) await register(s, { home: 'Home Mac', oracle: 'Oracle', pc: 'Friend PC' }[s], 0);
await beat('dev-1');   // > 6 h since the last seen write: refreshes seen:dev-1
skew = 31 * DAY;
for (const s of SHARED) await register(s, { home: 'Home Mac', oracle: 'Oracle', pc: 'Friend PC' }[s], 0);
assert.equal((await act({ action: 'unprefer' })).status, 200);   // any owner write folds + prunes
let devs = policy().devices;
assert.deepEqual(Object.keys(devs).sort(), ['dev-1'], 'quiet devices pruned, the beating one kept');
assert.ok(devs['dev-1'].seenAt >= realNow() + 20 * DAY - 60_000, 'seenAt folded from seen:dev-1');
// An owner change counts as a touch even with no presence yet.
assert.equal((await act({ action: 'assign', device: 'new-dev', server: 'oracle' })).status, 200);
skew = 55 * DAY;   // seen:dev-1 (written at day 20, 30-day TTL) has now expired
for (const s of SHARED) await register(s, { home: 'Home Mac', oracle: 'Oracle', pc: 'Friend PC' }[s], 0);
assert.equal((await act({ action: 'unprefer' })).status, 200);
devs = policy().devices;
assert.deepEqual(Object.keys(devs).sort(), ['new-dev'], 'dev-1 pruned 30+ days after its last beat; new-dev (touched day 31) kept');
// A hand-written stale entry with no seen key is also dropped on the next write.
kv.m.set('policy', { value: JSON.stringify({ disabled: [], preferred: null, devices: {
  old: { server: 'home', avoid: [], seenAt: Date.now() - 31 * DAY },
  'not valid!': { server: 'home', avoid: [], seenAt: Date.now() },
  empty: { server: null, avoid: [], seenAt: Date.now() },
  'new-dev': devs['new-dev'],
} }), exp: 0, metadata: null });
assert.equal((await act({ action: 'unprefer' })).status, 200);
assert.deepEqual(Object.keys(policy().devices), ['new-dev']);
assert.equal((await act({ action: 'clear-device', device: 'new-dev' })).status, 200);
skew = 0;
for (const s of SHARED) kv.m.delete(`srv:${s}`);
for (const k of [...kv.m.keys()]) if (k.startsWith('pres:') || k.startsWith('seen:')) kv.m.delete(k);
await register('home', 'Home Mac', 1); await register('oracle', 'Oracle', 0); await register('pc', 'Friend PC', 2);

// ── Dashboard: run the page's own script against the worker ──
async function renderDashboard() {
  const r = await req('/', { token: 'admin' });
  assert.equal(r.status, 200);
  const html = await r.text();
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const els = {};
  const listeners = {};
  const document = {
    activeElement: null,
    getElementById: (id) => (els[id] ??= { id, innerHTML: '', textContent: '', hidden: true, contains: () => false }),
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  const ctx = vm.createContext({
    document, console, setTimeout, clearTimeout, setInterval: () => 0,
    fetch: (path, init) => worker.fetch(new Request(`https://relay.test${path}`, init), env),
  });
  vm.runInContext(script, ctx);
  for (let i = 0; i < 100 && !/wcard|Nobody/.test(els.watchers?.innerHTML || ''); i++) await new Promise((res) => setTimeout(res, 5));
  return { html, els, listeners };
}
const selectFor = (html, device) => {
  const m = html.match(new RegExp(`<select data-act="assign" data-device="${device}"[^>]*>([\\s\\S]*?)</select>`));
  return m && m[1];
};
const selectedValue = (opts) => [...opts.matchAll(/<option value="([^"]*)"( selected)?>/g)].filter((o) => o[2]).map((o) => o[1]);

assert.equal((await act({ action: 'assign', device: 'dev-1', server: 'pc' })).status, 200);
assert.equal((await act({ action: 'avoid', device: 'dev-2', server: 'home' })).status, 200);
await beat('dev-1', { name: 'Ann', server: 'Friend PC' });
await beat('dev-2', { name: 'Bob', server: 'Home Mac' });
await beat('dev-3', { name: 'Cy' });
const HOSTILE = 'x"><img src=x onerror=alert(1)>';
await beat(HOSTILE, { name: '<b>Eve</b>', title: '<script>alert(2)</script>', server: '"><svg onload=alert(3)>' });

let d = await renderDashboard();
assert.match(d.html, /Routing changes apply on each device's next play \(route cache ≤ 60 s\)\./);
let w = d.els.watchers.innerHTML;
// dev-1 pinned to Friend PC; dev-2 / dev-3 Automatic.
assert.deepEqual(selectedValue(selectFor(w, 'dev-1')), ['pc']);
assert.deepEqual(selectedValue(selectFor(w, 'dev-2')), ['']);
assert.deepEqual(selectedValue(selectFor(w, 'dev-3')), ['']);
assert.match(selectFor(w, 'dev-1'), /<option value="">Automatic<\/option><option value="pc" selected>Friend PC<\/option><option value="home">Home Mac<\/option><option value="oracle">Oracle<\/option>/);
assert.match(w, /via Friend PC/);
assert.match(w, /via Home Mac/);
// "Not my Mac" resolves to the Home Mac server id; checked only where avoided.
assert.match(w, /<input type="checkbox" data-act="avoid" data-device="dev-2" data-server="home" checked>Not my Mac/);
assert.match(w, /<input type="checkbox" data-act="avoid" data-device="dev-1" data-server="home">Not my Mac/);
assert.match(w, /data-act="clear-device" data-device="dev-1"/);
assert.ok(!/data-act="clear-device" data-device="dev-3"/.test(w), 'no Reset without a policy');
// Hostile values are escaped; a device id the relay would reject gets no control.
assert.ok(!/<img|<svg|<script|<b>/i.test(w), 'no injected markup');
assert.match(w, /title="device x&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;"/);
assert.match(w, /&lt;b&gt;Eve&lt;\/b&gt;/);
assert.match(w, /via &quot;&gt;&lt;svg onload=alert\(3\)&gt;/);
assert.equal((w.match(/<select /g) || []).length, 3, 'hostile id: no Server control');
// The server grid keeps its Disable/Prefer buttons.
assert.match(d.els.grid.innerHTML, /data-act="disable" data-id="home"/);
assert.match(d.els.grid.innerHTML, /data-act="prefer" data-id="home"/);

// Delegated change handler → /admin/action.
const fakeEl = (attrs) => ({ ...attrs, blurred: false, blur() { this.blurred = true; } });
const sel = fakeEl({ type: 'select-one', tagName: 'SELECT', value: 'oracle', dataset: { act: 'assign', device: 'dev-3' } });
d.listeners.change({ target: { closest: () => sel } });
for (let i = 0; i < 100 && policy().devices?.['dev-3']?.server !== 'oracle'; i++) await new Promise((res) => setTimeout(res, 5));
assert.equal(policy().devices['dev-3'].server, 'oracle');
assert.ok(sel.blurred, 'select blurred so the next refresh re-renders it');
const box = fakeEl({ type: 'checkbox', checked: true, dataset: { act: 'avoid', device: 'dev-3', server: 'home' } });
d.listeners.change({ target: { closest: () => box } });
for (let i = 0; i < 100 && !policy().devices['dev-3'].avoid.includes('home'); i++) await new Promise((res) => setTimeout(res, 5));
assert.deepEqual(policy().devices['dev-3'].avoid, ['home']);
box.checked = false;
d.listeners.change({ target: { closest: () => box } });
for (let i = 0; i < 100 && policy().devices['dev-3'].avoid.length; i++) await new Promise((res) => setTimeout(res, 5));
assert.deepEqual(policy().devices['dev-3'].avoid, []);
const autoSel = fakeEl({ type: 'select-one', tagName: 'SELECT', value: '', dataset: { act: 'assign', device: 'dev-3' } });
d.listeners.change({ target: { closest: () => autoSel } });
for (let i = 0; i < 100 && policy().devices['dev-3']; i++) await new Promise((res) => setTimeout(res, 5));
assert.equal(policy().devices['dev-3'], undefined, 'Automatic sends server:null and clears the entry');
// Reset button (click handler) → clear-device; server buttons still send { id }.
const reset = { dataset: { act: 'clear-device', device: 'dev-1' } };
d.listeners.click({ target: { closest: () => reset } });
for (let i = 0; i < 100 && policy().devices['dev-1']; i++) await new Promise((res) => setTimeout(res, 5));
assert.equal(policy().devices['dev-1'], undefined);
d.listeners.click({ target: { closest: () => ({ dataset: { act: 'disable', id: 'pc' } }) } });
for (let i = 0; i < 100 && !policy().disabled.includes('pc'); i++) await new Promise((res) => setTimeout(res, 5));
assert.deepEqual(policy().disabled, ['pc']);
await act({ action: 'enable', id: 'pc' });

// A pin to an offline server stays visible as the selected option.
assert.equal((await act({ action: 'assign', device: 'dev-2', server: 'pc' })).status, 200);
kv.m.delete('srv:pc');
d = await renderDashboard();
assert.deepEqual(selectedValue(selectFor(d.els.watchers.innerHTML, 'dev-2')), ['pc']);
assert.match(d.els.watchers.innerHTML, /<option value="pc" selected>pc \(offline\)<\/option>/);
// No "Home Mac" in the fleet → no "Not my Mac" checkbox.
kv.m.delete('srv:home');
d = await renderDashboard();
assert.ok(!/Not my Mac/.test(d.els.watchers.innerHTML));
assert.ok(selectFor(d.els.watchers.innerHTML, 'dev-1'), 'the Server select stays');

// Gate page without the admin key.
assert.match(await (await req('/', { token: 'user' })).text(), /Admin access required/);

console.log('routing OK');
