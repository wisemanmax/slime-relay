'use strict';
// Preflight / self-check. Run:  node doctor.js
// Verifies Node, Chromium, .env, token, relay auth, and address reachability —
// then prints a ✅/✖ checklist with the exact fix for anything wrong.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { loadEnv, ipv4Candidates } = require('./env');

loadEnv();
const OK = '✅', BAD = '✖ ', WARN = '⚠️ ';
let fails = 0;
const pass = (m) => console.log(`${OK}  ${m}`);
const warn = (m) => console.log(`${WARN} ${m}`);
const fail = (m) => { fails++; console.log(`${BAD} ${m}`); };

function get(url, headers) {
  return new Promise((resolve) => {
    try {
      const lib = url.startsWith('https') ? require('https') : http;
      const req = lib.get(url, { headers: headers || {}, timeout: 6000 }, (res) => {
        let body = ''; res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '', error: 'timeout' }); });
      req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
    } catch (e) { resolve({ status: 0, body: '', error: e.message }); }
  });
}

async function main() {
  console.log('\n── SlimeWatch server doctor ─────────────────────────\n');

  // 1) Node
  const major = Number(process.versions.node.split('.')[0]);
  major >= 18 ? pass(`Node ${process.versions.node}`) : fail(`Node ${process.versions.node} is too old — install Node 18+ from https://nodejs.org`);

  // 2) Chromium for Playwright
  try {
    const p = require('playwright').chromium.executablePath();
    fs.existsSync(p) ? pass('Chromium for Playwright is installed')
                     : fail('Chromium missing — run:  npx playwright install chromium');
  } catch {
    fail('Playwright not installed — run:  npm install   (inside server/)');
  }

  // 3) .env + token
  if (!fs.existsSync(path.join(__dirname, '.env'))) {
    fail('No .env yet — run:  node setup.js');
  } else {
    const t = (process.env.SLIME_TOKEN || '').trim();
    (!t || t === 'change-me') ? fail('SLIME_TOKEN not set in .env — run:  node setup.js')
                              : pass(`SLIME_TOKEN is set (${t.slice(0, 6)}…, ${t.length} chars)`);
  }
  const token = (process.env.SLIME_TOKEN || '').trim();
  const port = process.env.PORT || '8787';

  // 4) Advertised address
  const candidates = ipv4Candidates(port);
  const chosen = (process.env.PUBLIC_ADDRESS || '').trim() || (candidates[0] && candidates[0].url) || '';
  if (!chosen) {
    warn('No network address detected — set PUBLIC_ADDRESS in .env (mesh IP if across networks).');
  } else {
    const isVirtual = candidates.find((c) => c.url === chosen && c.virtual);
    if (process.env.PUBLIC_ADDRESS) pass(`PUBLIC_ADDRESS is pinned to ${chosen}`);
    else if (candidates.length > 1) warn(`Auto address = ${chosen} (of ${candidates.length}). If the app can't reach it, pin PUBLIC_ADDRESS in .env.`);
    else pass(`Address = ${chosen}`);
    if (isVirtual) warn(`${chosen} is on a virtual adapter — the Apple TV usually can't reach that. Prefer a LAN/mesh IP.`);
  }

  // 5) Is the local server up? (optional)
  const local = await get(`http://127.0.0.1:${port}/health`);
  if (local.status === 200) pass(`Local server is running on port ${port} (/health = ${local.body.trim()})`);
  else warn(`Local server not responding on port ${port} — that's fine if you haven't started it yet (./start.sh).`);

  // 6) Relay reachability + auth
  const relay = (process.env.RELAY_URL || '').replace(/\/+$/, '');
  if (!relay) {
    warn('RELAY_URL not set — running standalone (no fleet). Set it in .env to join the relay.');
  } else {
    const r = await get(`${relay}/route`, { authorization: `Bearer ${token}` });
    if (r.status === 200) pass(`Relay reachable and token accepted (${relay})`);
    else if (r.status === 401) fail(`Relay rejected the token (401) — this server's SLIME_TOKEN must equal the relay's USER_TOKEN.`);
    else if (r.status === 0) fail(`Could not reach the relay (${r.error}) — check RELAY_URL and your connection.`);
    else fail(`Relay returned ${r.status} for ${relay}/route — is the URL right and the relay deployed?`);
  }

  console.log('\n─────────────────────────────────────────────────────');
  if (fails === 0) console.log('All required checks passed. Start with  ./start.sh  (Windows: start.bat).\n');
  else console.log(`${fails} problem(s) above. Fix them, then re-run  node doctor.js\n`);
  process.exit(fails ? 1 : 0);
}

main();
