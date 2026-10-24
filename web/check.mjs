/* Guards for what the Worker actually serves, then the unit checks.
   `npm test` runs build.mjs first, then this; `npm run check` runs this alone.

   History: the app used to be ONE giant template literal, and a stray backtick
   anywhere in it took the whole site down — twice. build.mjs now emits PAGE as
   JSON string literals, so that exact trap is gone, but its cousins are not:
     - a STALE artifact: deploy ships the committed src/generated/, not src/app/
     - an inline script that doesn't parse, or that ENDS EARLY because the
       bundle contains "</script" — the HTML parser cuts it there
     - CSP wiring: every <script> must carry the nonce placeholder the Worker fills
     - an inline on*="" handler: the CSP blocks it, so it would silently do nothing
   Each exits non-zero with a FAIL line. */

import { readFileSync } from 'node:fs';
import { build, NONCE_PLACEHOLDER } from './build.mjs';
import * as gen from './src/generated/page.js';
import { STATIC } from './src/generated/static.js';
import worker from './src/worker.js';
import { runUnitChecks } from './test/unit.mjs';
import { runSwChecks } from './test/sw.mjs';
import { runPwaChecks } from './test/pwa.mjs';
import { runPlayerChecks } from './test/player.mjs';
import { runReadingChecks } from './test/reading.mjs';
import { runSyncChecks } from './test/sync.mjs';
import { runAskChecks } from './test/ask.mjs';
import { runProfilesChecks } from './test/profiles.mjs';
import { runParityChecks } from './test/parity.mjs';   // Wave 8 W1
import { runPartyChecks } from './test/party.mjs';

let bad = 0;
const fail = (m) => { console.error('FAIL:', m); bad = 1; };
const ok = (cond, m) => { if (!cond) fail(m); };

// ── 1. The committed artifact is what src/app/ builds to ─────────────────────────
const fresh = await build({ write: false });
for (const [f, text] of Object.entries(fresh.files)) {
  if (readFileSync(new URL('./src/generated/' + f, import.meta.url), 'utf8') !== text) {
    fail(`src/generated/${f} is stale — run \`npm run build\` (deploy ships the generated file, not src/app/)`);
  }
}

// ── 2. PAGE renders, and its inline scripts are whole and parse ──────────────────
const PAGE = gen.PAGE;
ok(typeof PAGE === 'string' && PAGE.length > 100000, 'PAGE did not render to a (full-size) string');
ok(gen.NONCE_PLACEHOLDER === NONCE_PLACEHOLDER, 'generated NONCE_PLACEHOLDER does not match build.mjs');

// Extract scripts the way a browser's HTML parser would: up to the first </script.
const scripts = [...String(PAGE).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script/gi)].map(m => ({ attrs: m[1], body: m[2] }));
ok(scripts.length === 2, `expected 2 inline scripts (hls.js, app), found ${scripts.length}`);
for (const [i, s] of scripts.entries()) {
  if (/\ssrc\s*=/i.test(s.attrs)) fail(`script #${i + 1} loads an external src — everything must be inlined`);
  if (!s.attrs.includes(`nonce="${NONCE_PLACEHOLDER}"`)) fail(`script #${i + 1} has no CSP nonce placeholder — the CSP would block it`);
  try { new Function(s.body); } catch (e) { fail(`inline script #${i + 1} does not parse: ${e.message}`); }
}
if (scripts.length === 2) {
  ok(scripts[0].body === fresh.hls, 'inline hls.js script is not the vendored hls.min.js byte-for-byte (cut short?)');
  ok(scripts[1].body === '\n' + fresh.js, 'inline app script is not the whole bundle (something ended it early)');
}
ok(PAGE.split(NONCE_PLACEHOLDER).length === 3, 'the CSP nonce placeholder must appear exactly twice (once per script)');
ok((PAGE.match(/<style>/g) || []).length === 1 && PAGE.includes(fresh.css), 'expected the bundled stylesheet inlined exactly once');

// ── 3. No inline event handlers (CSP blocks them; use data-act + onAction) ───────
const markup = PAGE.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style>[\s\S]*?<\/style>/gi, '');
const HANDLER = /\son[a-z]+\s*=\s*\\?["']/i;
ok(!HANDLER.test(markup), 'the HTML shell contains an inline on*= handler');
ok(!HANDLER.test(fresh.js), 'the app bundle renders markup with an inline on*= handler: ' + (fresh.js.match(HANDLER) || [''])[0]);
// Every data-act the app can render has a registered handler.
const used = new Set([...(markup + fresh.js).matchAll(/data-act=\\?"([a-z][a-z0-9-]*)/g)].map(m => m[1]));
const registered = new Set([...fresh.js.matchAll(/onAction\(\s*["']([a-z][a-z0-9-]*)["']/g)].map(m => m[1]));
for (const a of used) if (!registered.has(a)) fail(`data-act="${a}" is rendered but no onAction("${a}") handler is registered`);

// ── 4. Structural smoke tests (phone layout + player chrome) ─────────────────────
for (const marker of ['id="tabbar"', 'id="pick"', 'id="hdr-avatar"', 'id="hdr-me"', 'id="pills"', 'stagewrap', 'id="pvideo"', 'id="pframe"', 'id="psel"', 'id="ppip"', 'id="toasts"', 'rel="manifest"', 'apple-touch-icon', 'apple-mobile-web-app-capable', 'viewport-fit=cover']) {
  ok(PAGE.includes(marker), `missing expected markup: ${marker}`);
}
ok(/max-width:\s*700px/.test(PAGE), 'missing the phone layout media query (max-width: 700px)');

// ── 5. PWA static files ──────────────────────────────────────────────────────────
const sw = STATIC['/sw.js'];
ok(sw && sw.cache === 'no-cache', '/sw.js missing or cacheable');
if (sw) {
  ok(!/__BUILD_ID__|__STATIC_ASSETS__/.test(sw.text), 'sw.js still has build placeholders');
  ok(sw.text.includes(JSON.stringify(gen.BUILD_ID)), 'sw.js is not stamped with this BUILD_ID (updates would not be detected)');
  try { new Function(sw.text); } catch (e) { fail('sw.js does not parse: ' + e.message); }
}
let manifest = null;
try { manifest = JSON.parse(STATIC['/manifest.webmanifest'].text); } catch (e) { fail('manifest does not parse: ' + e.message); }
if (manifest) {
  ok(manifest.display === 'standalone' && manifest.start_url === '/', 'manifest must be standalone with start_url "/"');
  for (const ic of manifest.icons || []) ok(Object.hasOwn(STATIC, ic.src), `manifest icon ${ic.src} is not served`);
  ok((manifest.icons || []).some(i => i.purpose === 'maskable'), 'manifest has no maskable icon');
}
for (const m of markup.matchAll(/<link[^>]+href="(\/[^"]+)"/g)) ok(Object.hasOwn(STATIC, m[1]), `page links ${m[1]}, which is not served`);

// ── 6. Worker routes, run in-process (node has fetch's Request/Response + WebCrypto) ──
const env = { SITE_PASSWORD: 'check-pw', SESSION_SECRET: 'check-secret', TMDB_TOKEN: '', EXTRACTOR_BASE: 'https://example.invalid' };
const call = (path, init) => worker.fetch(new Request('https://watch.example' + path, init), env);
{
  let r = await call('/manifest.webmanifest');
  ok(r.status === 200 && r.headers.get('content-type').startsWith('application/manifest+json'), 'manifest is not served ungated');
  r = await call('/sw.js');
  ok(r.status === 200 && r.headers.get('service-worker-allowed') === '/' && r.headers.get('cache-control') === 'no-cache', '/sw.js headers wrong (needs Service-Worker-Allowed: / and no-cache)');
  ok(sw && (await r.text()) === sw.text, '/sw.js body differs from STATIC');
  r = await call('/icons/icon-192.png');
  const png = new Uint8Array(await r.arrayBuffer());
  ok(r.status === 200 && r.headers.get('content-type') === 'image/png' && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47, 'icon not served as a PNG');
  ok(Buffer.from(png).equals(readFileSync(new URL('./src/app/icons/icon-192.png', import.meta.url))), 'served icon bytes differ from src/app/icons');
  r = await call('/sw.js', { method: 'POST' });
  ok(r.status === 302, 'a non-GET to a static path must fall through to the gate');

  r = await call('/', { redirect: 'manual' });
  ok(r.status === 302 && r.headers.get('location') === '/login', 'the app is not gated (expected 302 -> /login)');
  r = await call('/login');
  const login = await r.text();
  ok(r.status === 200 && login.includes('rel="manifest"') && login.includes('apple-touch-icon'), 'login page missing its PWA tags');
  r = await call('/login', { method: 'POST', body: new URLSearchParams({ password: 'nope' }) });
  ok(r.status === 401, 'wrong password was not refused');
  r = await call('/login', { method: 'POST', body: new URLSearchParams({ password: 'check-pw' }) });
  const setCookie = r.headers.get('set-cookie') || '';
  ok(r.status === 302 && r.headers.get('location') === '/', 'login did not redirect to /');
  ok(/^sw_auth=[a-f0-9]{64};/.test(setCookie) && !/domain=/i.test(setCookie), 'login cookie missing, or not host-only (must work on any host)');
  // A link opened while signed out lands where it pointed — a plain hash route only (src/worker/next.js).
  ok(login.includes('name="next"') && login.includes('location.hash'), 'login page does not carry the hash in a next field');
  for (const [next, want] of [['#title/tv/1399/2/3', '/#title/tv/1399/2/3'], ['#list', '/#list'], ['//evil.example', '/'], ['https://evil.example/#list', '/'], ['#<script>', '/'],
    ['#title/tv/1399/2/3/t/90', '/#title/tv/1399/2/3/t/90'], ['#title/movie/550/t/0', '/#title/movie/550/t/0']]) {   // shared moments survive sign-in
    r = await call('/login', { method: 'POST', body: new URLSearchParams({ password: 'check-pw', next }) });
    ok(r.status === 302 && r.headers.get('location') === want, `login with next=${JSON.stringify(next)} redirected to ${r.headers.get('location')}, expected ${want}`);
  }
  r = await call('/login', { method: 'POST', body: new URLSearchParams({ password: 'nope', next: '#list' }) });
  ok(r.status === 401 && (await r.text()).includes('name="next" id="next" value="#list"'), 'a wrong password loses the next hash');
  r = await call('/login', { method: 'POST', body: new URLSearchParams({ password: 'nope', next: '#title/movie/550/t/3600' }) });
  ok(r.status === 401 && (await r.text()).includes('name="next" id="next" value="#title/movie/550/t/3600"'), 'a wrong password loses a moment hash');
  r = await call('/login', { method: 'POST', body: new URLSearchParams({ password: 'nope', next: '"><script>x()</script>' }) });
  ok(r.status === 401 && !(await r.text()).includes('x()'), 'a disallowed next is echoed into the login page');

  const cookie = setCookie.split(';')[0];
  const nonces = [];
  for (let i = 0; i < 2; i++) {
    r = await call('/', { headers: { cookie } });
    const csp = r.headers.get('content-security-policy') || '';
    const nonce = (csp.match(/'nonce-([^']+)'/) || [])[1];
    const body = await r.text();
    ok(r.status === 200 && nonce, 'app page has no CSP nonce');
    ok(/object-src 'none'/.test(csp) && /base-uri 'none'/.test(csp) && /worker-src 'self' blob:/.test(csp), 'CSP is missing object-src/base-uri/worker-src');
    ok(nonce && body.split(`nonce="${nonce}"`).length === 3 && !body.includes(NONCE_PLACEHOLDER), 'served page scripts do not carry the response nonce');
    nonces.push(nonce);
  }
  ok(nonces[0] !== nonces[1], 'CSP nonce is not fresh per request');
  r = await call('/api/rdkey', { headers: { cookie } });
  ok(r.status === 200 && (await r.json()).key === '', '/api/rdkey broken behind the gate');
}

// ── 7. Unit checks: store/router/debrid, service worker, page-side update flow ──
for (const [name, run] of [['unit', () => runUnitChecks()], ['sw', () => runSwChecks(sw ? sw.text : '')], ['pwa', () => runPwaChecks()], ['player', () => runPlayerChecks()], ['reading', () => runReadingChecks()], ['sync', () => runSyncChecks()], ['ask', () => runAskChecks()], ['profiles', () => runProfilesChecks()], ['parity', () => runParityChecks()], ['party', () => runPartyChecks()]]) {
  try { const n = await run(); console.log(`${name} — ${n} checks passed`); }
  catch (e) { fail(`${name} check: ` + (e && e.message)); if (e && e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n')); }
}

if (!bad) console.log(`ok — build ${gen.BUILD_ID}, ${PAGE.length} chars, ${scripts.length} inline scripts parsed, ${registered.size} actions, worker routes verified`);
process.exit(bad);
