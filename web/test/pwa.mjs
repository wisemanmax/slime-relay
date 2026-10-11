// The page half of the update flow (src/app/pwa.js + ui/toast.js), run in node
// against a minimal fake DOM and a scriptable navigator.serviceWorker:
//   - a worker already waiting at load (and a controller) -> "updated" toast
//   - updatefound -> installed (with a controller)        -> "updated" toast
//   - first install (no controller)                       -> no toast
//   - tapping the toast posts SKIP_WAITING; the next controllerchange reloads
//   - a controllerchange nobody asked for (first install's claim) never reloads

import assert from 'node:assert/strict';

class El {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.style = {}; this.attrs = {}; this.l = {}; this.className = ''; this.textContent = ''; this.innerHTML = ''; this.parent = null; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this); this.parent = null; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(t, f) { (this.l[t] ||= []).push(f); }
  closest(sel) { let n = this; const cls = sel.replace(/^\./, ''); while (n) { if (n.className.split(' ').includes(cls)) return n; n = n.parent; } return null; }
  click() { let n = this; const e = { type: 'click', target: this, stopped: false, stopPropagation() { this.stopped = true; } }; while (n && !e.stopped) { for (const f of n.l.click || []) f(e); n = n.parent; } }
  find(cls) { for (const c of this.children) { if (c.className.split(' ').includes(cls)) return c; const d = c.find(cls); if (d) return d; } return null; }
}

function setup({ waiting = false, controller = true } = {}) {
  const host = new El('div'); host.id = 'toasts';
  const winL = {}, docL = {};
  const swL = {};
  const posted = [];
  const mkWorker = (state) => { const w = { state, l: {}, addEventListener(t, f) { (this.l[t] ||= []).push(f); }, postMessage: (m) => posted.push(m) }; return w; };
  const reg = { waiting: waiting ? mkWorker('installed') : null, installing: null, l: {}, addEventListener(t, f) { (this.l[t] ||= []).push(f); }, update: async () => {} };
  const sw = { controller: controller ? {} : null, addEventListener: (t, f) => { (swL[t] ||= []).push(f); }, register: async () => reg };
  let reloads = 0;
  Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker: sw }, configurable: true, writable: true });
  globalThis.window = { addEventListener: (t, f) => { (winL[t] ||= []).push(f); } };
  globalThis.document = { getElementById: (id) => (id === 'toasts' ? host : null), createElement: (t) => new El(t), addEventListener: (t, f) => { (docL[t] ||= []).push(f); }, visibilityState: 'visible' };
  globalThis.location = { reload: () => { reloads++; } };
  return { host, winL, swL, reg, sw, posted, mkWorker, reloads: () => reloads };
}
const flush = () => new Promise(r => setTimeout(r, 0));

export async function runPwaChecks() {
  let n = 0;
  const ok = (v, m) => { assert.ok(v, m); n++; };
  const eq = (a, b, m) => { assert.deepEqual(a, b, m); n++; };
  // Fresh module instances per scenario (pwa.js keeps per-boot state in closures).
  let i = 0;
  const boot = async (env) => { const { initPwa } = await import('../src/app/pwa.js?case=' + (i++)); initPwa(); for (const f of env.winL.load || []) await f(); await flush(); };
  const toastText = (env) => env.host.children.map(t => t.find('tx').innerHTML || t.find('tx').textContent);

  // 1. waiting at load -> toast; tap -> SKIP_WAITING -> controllerchange reloads once
  {
    const env = setup({ waiting: true });
    await boot(env);
    eq(env.host.children.length, 1, 'a waiting update shows one toast');
    ok(/updated/i.test(toastText(env)[0]), 'toast says SlimeWatch updated');
    env.host.children[0].find('ta').click();
    eq(env.posted, [{ type: 'SKIP_WAITING' }], 'tapping posts SKIP_WAITING to the waiting worker');
    eq(env.host.children.length, 0, 'the toast closes on tap');
    for (const f of env.swL.controllerchange || []) f();
    eq(env.reloads(), 1, 'the takeover reloads the page');
    for (const f of env.swL.controllerchange || []) f();
    eq(env.reloads(), 1, '...exactly once');
  }
  // 2. updatefound -> installed with a controller -> toast
  {
    const env = setup();
    await boot(env);
    eq(env.host.children.length, 0, 'nothing waiting: no toast');
    const w = env.mkWorker('installing'); env.reg.installing = w;
    for (const f of env.reg.l.updatefound || []) f();
    w.state = 'installed'; for (const f of w.l.statechange || []) f();
    eq(env.host.children.length, 1, 'a freshly installed update shows the toast');
  }
  // 3. first install: no controller -> no toast, and its claim() never reloads
  {
    const env = setup({ controller: false });
    await boot(env);
    const w = env.mkWorker('installing'); env.reg.installing = w;
    for (const f of env.reg.l.updatefound || []) f();
    w.state = 'installed'; for (const f of w.l.statechange || []) f();
    eq(env.host.children.length, 0, 'first install shows no toast');
    for (const f of env.swL.controllerchange || []) f();
    eq(env.reloads(), 0, 'first install claim does not reload the page');
  }
  // 4. dismissing (x) neither updates nor reloads
  {
    const env = setup({ waiting: true });
    await boot(env);
    env.host.children[0].find('tx-close').click();
    eq([env.host.children.length, env.posted.length], [0, 0], 'dismiss closes without activating the update');
  }
  delete globalThis.window; delete globalThis.document; delete globalThis.location;
  return n;
}
