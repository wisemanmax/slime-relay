// Per-device tokens on the relay (Wave 8, F1a; roadmap F1, PLAN-TO-9 Phase 8,
// THREAT-MODEL "Open: per-device extractor tokens").
//
// A device enrols ONCE: the owner issues a one-time invite code (dashboard, or
// an admin phone with the admin token), the device presents it with the
// household token and gets its own token, which the apps keep in the Keychain.
// The relay accepts that token wherever it accepts USER_TOKEN; the dashboard
// lists devices with last-seen and Revoke; revoked tokens are refused within a
// minute — here and, through the /register reply, on every extractor.
// Contract: Wave 8 contracts.md §1. The registry is the DeviceRegistry Durable
// Object (strongly consistent; KV is not, ~60 s), bound as DEVICES.
//
// Exports used by worker.js (scaffold lines — keep the names and shapes):
//   userAuth(env, provided, pathname) -> Promise<boolean>   is this the user role?
//   deviceFleetBlock(env, registerBody) -> Promise<{} | { tokens }>   merged into /register's reply
//   handleDevices(request, env, ctx) -> Promise<Response>   /devices/*, /admin/devices*
//   devicesPanelHTML() / devicesPanelScript() -> string     the dashboard's Devices section
//   class DeviceRegistry                                    the Durable Object
//
// Routes (ctx = { isUser, isAdmin, provided, clientIP, json, rateLimited } from worker.js):
//   POST /admin/devices/invite  admin  {label?} -> 201 {code, display, link, expiresAt, qr?}
//                               (qr: the link's QR as rows of "0"/"1", for the dashboard; apps ignore it)
//   POST /devices/enroll        household token or admin  {code, deviceId, name, platform, app}
//                               -> 200 {deviceId, token, name, issuedAt} (the ONLY time the token
//                               is shown) · 403 {error:'bad-code'} for a bad, used or expired code
//                               · 429 past 10/min per IP · 400 bad deviceId / json
//   GET  /devices/me            the device token -> {deviceId, name, platform, enrolledAt}
//                               · 401 revoked/unknown · 503 registry unreachable (≠ revoked)
//   GET  /admin/devices         admin -> {devices:[…], invites:[{hint, label, expiresAt}]}
//   POST /admin/devices/revoke  admin {id} -> {ok:true} (idempotent; the row stays, greyed)
//   POST /admin/devices/forget  admin {id} of a revoked device -> {ok:true} · 409 while live
//
// Secrets: tokens are `swd1_` + 43 base64url (32 random bytes). The Worker
// makes them and returns them once; the registry only ever sees sha256 hex
// (of tokens AND of invite codes), extractors only ever receive those hashes,
// and nothing here logs either.

import { devQR } from './qr.js';   // the enrolment QR encoder

const DEVICE_RE = /^[A-Za-z0-9._-]{1,80}$/;   // worker.js's: the apps' presence ids (RelayConfig.deviceID)
const TOKEN_PREFIX = 'swd1_';
const TOKEN_RE = /^swd1_[A-Za-z0-9_-]{43}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
// The party-code alphabet (party-reducer.js: no 0/O, no 1/I). 32 symbols, so a
// random byte & 31 picks one with no modulo bias; 8 of them ≈ 40 bits.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;
const PLATFORMS = ['ios', 'tvos', 'macos', 'web', 'roku', 'other'];
const INVITE_TTL_MS = 15 * 60_000;
const MAX_OPEN_INVITES = 5;
const MAX_DEVICES = 500;            // live devices; also the /register list's cap
const MAX_SEEN = 200;               // deviceSeen entries read per heartbeat
const SEEN_WRITE_MS = 5 * 60_000;   // lastSeen: ≤ 1 storage write per device per 5 min (Free-plan row writes)
const AUTH_CACHE_MS = 30_000;       // the revocation budget for positive answers (contracts §1.2)
const BLOCK_CACHE_MS = 10_000;      // the tokens block per isolate: a heartbeat sees a revoke ≤ 10 s + one beat late
const CACHE_MAX = 2000;
const NAME_MAX = 40, APP_MAX = 40, LABEL_MAX = 40;
const BAD_CODE = { error: 'bad-code' };

// ── Pure helpers (exported for the tests) ──

export const isDeviceToken = (t) => typeof t === 'string' && TOKEN_RE.test(t);
export const displayCode = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;
export const enrolLink = (c) => `slimewatch://enrol?code=${c}`;
const codeHint = (c) => `${c.slice(0, 2)}…`;   // enough to tell open codes apart; never the code

export function newDeviceToken() {
  const a = new Uint8Array(32);
  crypto.getRandomValues(a);
  let s = '';
  for (const b of a) s += String.fromCharCode(b);
  return TOKEN_PREFIX + btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function newInviteCode() {
  const a = new Uint8Array(CODE_LEN);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => CODE_ALPHABET[b & 31]).join('');
}

// ` k7q4-mz2p ` → `K7Q4MZ2P`; null when it isn't a well-formed code (the apps'
// DeviceEnrolmentRules.normalizeCode is the same rule).
export function normalizeCode(raw) {
  if (typeof raw !== 'string' || raw.length > 32) return null;
  const s = raw.toUpperCase().replace(/[\s-]/g, '');
  return s.length === CODE_LEN && [...s].every((c) => CODE_ALPHABET.includes(c)) ? s : null;
}

export async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

const clip = (v, n) => (typeof v === 'string' ? v : '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, n);

// ── Per-isolate memory ──
// A Worker isolate lives seconds to hours and serves many requests. Positive
// answers only (contracts §1.2: ≤ 30 s, never negatives, so a device that just
// enrolled is never refused), keyed by the token's sha256 — no token is kept.
// Every enrol / revoke / forget handled HERE drops it all; other isolates catch
// up within AUTH_CACHE_MS / BLOCK_CACHE_MS.
const authCache = new Map();   // sha256 → { dev, until }
const seenSent = new Map();    // deviceId → the newest extractor lastSeen this isolate forwarded
let blockCache = null;         // { tokens, until }
let blockPending = null;       // one registry read shared by concurrent heartbeats (an extractor beats each path at once)
let cacheGen = 0;              // bumped by forgetCaches(): a read that started before a change isn't cached
function forgetCaches() { authCache.clear(); blockCache = null; blockPending = null; cacheGen++; }
export const _test = { reset() { forgetCaches(); seenSent.clear(); } };

const registry = (env) => env.DEVICES.get(env.DEVICES.idFromName('registry'));
async function callRegistry(env, path, body) {
  const init = body === undefined ? undefined
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const r = await registry(env).fetch(`https://devices${path}`, init);
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
}

// The device behind a token, or null (revoked / unknown). Throws when the
// registry can't answer — userAuth then refuses, /devices/me answers 503.
async function lookupDevice(env, token, seen) {
  const h = await sha256Hex(token);
  const now = Date.now();
  const hit = authCache.get(h);
  if (hit && hit.until > now) return hit.dev;
  if (hit) authCache.delete(h);
  const { status, data } = await callRegistry(env, '/auth', { sha256: h, seen: !!seen });
  if (status !== 200 || !data) throw new Error(`registry ${status}`);
  if (!data.ok) return null;
  const dev = { id: data.id, name: data.name, platform: data.platform, createdAt: data.createdAt };
  if (authCache.size >= CACHE_MAX) authCache.clear();
  authCache.set(h, { dev, until: now + AUTH_CACHE_MS });
  return dev;
}

// Paths whose handlers never read isUser, so a device token there costs no
// registry call. /register: a device token must never grant registration
// (worker.js still lets the user role register while FLEET_TOKEN is unset —
// a household-token leftover); /devices/enroll checks the household token itself.
function wantsUser(path) {
  return !(path === '/register' || path === '/providers' || path === '/' || path === '/servers' || path === '/pick' ||
           path === '/devices/enroll' || path.startsWith('/admin/') || path.startsWith('/p/'));
}

// worker.js: `const isUser = isAdmin || await userAuth(env, provided, url.pathname)`.
export async function userAuth(env, provided, pathname) {
  if (typeof provided !== 'string' || !provided) return false;
  if (env.USER_TOKEN && provided === env.USER_TOKEN) {
    // After the rotation (runbook §9) the shared token, compiled into every
    // app, only enrols: DEVICE_TOKENS_REQUIRED="1". Unset = today's behaviour.
    return env.DEVICE_TOKENS_REQUIRED !== '1' || pathname === '/devices/enroll';
  }
  // Only swd1_ tokens ever reach the registry.
  if (!isDeviceToken(provided) || !env.DEVICES || !wantsUser(String(pathname || ''))) return false;
  try { return !!(await lookupDevice(env, provided, true)); } catch { return false; }
}

// The register body's optional deviceSeen ({id: epoch ms}, F1c): the entries
// worth a registry write — well-formed ids, not in the future, and at least
// SEEN_WRITE_MS newer than what this isolate last forwarded. null = nothing new.
function seenToSend(map, now) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
  const out = Object.create(null);   // a device id may be "__proto__" (DEVICE_RE allows it)
  let n = 0;
  for (const [id, v] of Object.entries(map).slice(0, MAX_SEEN)) {
    const at = Math.min(Number(v), now);
    if (!DEVICE_RE.test(id) || !Number.isFinite(at) || at <= 0) continue;
    if (at - (seenSent.get(id) ?? 0) < SEEN_WRITE_MS) continue;
    out[id] = at;
    n++;
  }
  return n ? out : null;
}

function shapeBlock(d) {
  if (!d || d.v !== 1 || !Number.isInteger(d.version) || d.version < 0 || !Array.isArray(d.devices)) return null;
  return { v: 1, version: d.version, devices: d.devices.slice(0, MAX_DEVICES).map(({ id, sha256 }) => ({ id, sha256 })) };
}

async function readBlock(env, seen, now, gen) {
  try {
    const { status, data } = await callRegistry(env, '/beat', { seen: seen || {} });
    const tokens = status === 200 ? shapeBlock(data) : null;
    if (tokens && gen === cacheGen) blockCache = { tokens, until: now + BLOCK_CACHE_MS };
    return tokens;
  } catch { return null; }
}

// worker.js /register: `json({ ok: true, ...(await deviceFleetBlock(env, body)), …})`.
// {tokens: {v:1, version, devices:[{id, sha256}]}} — live devices only; {} when
// the registry can't answer (the extractor keeps the list it has).
export async function deviceFleetBlock(env, registerBody) {
  if (!env.DEVICES) return {};
  const now = Date.now();
  const seen = seenToSend(registerBody?.deviceSeen, now);
  let tokens;
  if (seen) {
    tokens = await readBlock(env, seen, now, cacheGen);
    if (tokens) {
      if (seenSent.size > CACHE_MAX) seenSent.clear();
      for (const id of Object.keys(seen)) seenSent.set(id, seen[id]);
    }
  } else if (blockCache && blockCache.until > now) {
    tokens = blockCache.tokens;
  } else {
    if (!blockPending) {
      const p = readBlock(env, null, now, cacheGen);
      blockPending = p;
      p.then(() => { if (blockPending === p) blockPending = null; });
    }
    tokens = await blockPending;
  }
  return tokens ? { tokens } : {};
}

// ── Routes ──

export async function handleDevices(request, env, ctx) {
  const { json } = ctx;
  const path = new URL(request.url).pathname;
  try {
    if (path === '/devices/enroll') return await enroll(request, env, ctx);
    if (path === '/devices/me') return await me(request, env, ctx);
    if (path === '/admin/devices' || path.startsWith('/admin/devices/')) return await admin(request, env, ctx, path);
    return json({ error: 'not found' }, 404);
  } catch {
    // The registry threw (unreachable, over the plan's quota): never a 401, so
    // an app can tell "try later" from "revoked".
    return json({ error: 'registry unavailable' }, 503);
  }
}

async function enroll(request, env, { isAdmin, provided, clientIP, json, rateLimited }) {
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  // The household token or admin, never a device token — and regardless of
  // DEVICE_TOKENS_REQUIRED: enrolling is what the shared token stays for.
  const household = !!env.USER_TOKEN && provided === env.USER_TOKEN;
  if (!isAdmin && !household) return json({ error: 'unauthorized' }, 401);
  if (!env.DEVICES) return json({ error: 'devices not configured' }, 503);
  if (await rateLimited(env, `enroll:${clientIP}`, 10)) return json({ error: 'rate limited' }, 429);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  if (!body || typeof body !== 'object') return json({ error: 'bad json' }, 400);
  const deviceId = typeof body.deviceId === 'string' ? body.deviceId : '';
  if (!DEVICE_RE.test(deviceId)) return json({ error: 'bad deviceId' }, 400);
  const code = normalizeCode(body.code);
  if (!code) return json(BAD_CODE, 403);
  const token = newDeviceToken();
  const { status, data } = await callRegistry(env, '/enroll', {
    codeHash: await sha256Hex(code), id: deviceId, sha256: await sha256Hex(token),
    name: clip(body.name, NAME_MAX) || deviceId.slice(0, NAME_MAX),
    platform: PLATFORMS.includes(body.platform) ? body.platform : 'other',
    app: clip(body.app, APP_MAX),
  });
  if (status === 403) return json(BAD_CODE, 403);   // one answer for bad, used and expired
  if (status >= 500) throw new Error(`registry ${status}`);
  if (status !== 200 || !data) return json({ error: data?.error || 'enrol failed' }, status === 200 ? 500 : status);
  forgetCaches();   // a re-enrolment dropped the device's old hash: no cached yes may outlive it
  // No-store: the token is shown this once. Compact (one line), so local test tooling can mask it by pattern.
  return new Response(JSON.stringify({ deviceId, token, name: data.name, issuedAt: data.issuedAt }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

async function me(request, env, { provided, clientIP, json, rateLimited }) {
  if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
  if (!isDeviceToken(provided)) return json({ error: 'unauthorized' }, 401);
  if (!env.DEVICES) return json({ error: 'devices not configured' }, 503);
  if (await rateLimited(env, `devme:${clientIP}`, 60)) return json({ error: 'rate limited' }, 429);
  const dev = await lookupDevice(env, provided, true);   // usually the entry userAuth just cached
  if (!dev) return json({ error: 'unauthorized' }, 401);
  return json({ deviceId: dev.id, name: dev.name, platform: dev.platform, enrolledAt: dev.createdAt });
}

async function admin(request, env, { isAdmin, json }, path) {
  if (!isAdmin) return json({ error: 'unauthorized' }, 401);
  if (!env.DEVICES) return json({ error: 'devices not configured' }, 503);
  const method = request.method;
  if (path === '/admin/devices') {
    if (method !== 'GET') return json({ error: 'method not allowed' }, 405);
    const { status, data } = await callRegistry(env, '/list');
    if (status !== 200 || !data) throw new Error(`registry ${status}`);
    return json({ devices: data.devices, invites: data.invites });
  }
  const action = path.slice('/admin/devices/'.length);
  if (!['invite', 'revoke', 'forget'].includes(action)) return json({ error: 'not found' }, 404);
  if (method !== 'POST') return json({ error: 'method not allowed' }, 405);
  let body = {};
  try { const t = await request.text(); body = t ? JSON.parse(t) : {}; } catch { return json({ error: 'bad json' }, 400); }
  if (!body || typeof body !== 'object') return json({ error: 'bad json' }, 400);

  if (action === 'invite') {
    const label = clip(body.label, LABEL_MAX);
    for (let attempt = 0; attempt < 3; attempt++) {   // 409 = that code is already open (2^-40): draw again
      const code = newInviteCode();
      const { status, data } = await callRegistry(env, '/invite', { codeHash: await sha256Hex(code), hint: codeHint(code), label });
      if (status === 409) continue;
      if (status >= 500) throw new Error(`registry ${status}`);
      if (status !== 201) return json({ error: data?.error || 'invite failed' }, status);
      // The QR is drawn HERE, not in the page: wrangler's bundler rewrites function
      // bodies (keepNames → __name(…) calls), so shipping devQR's source to the
      // browser breaks once deployed. The page only paints these rows.
      const qr = devQR(enrolLink(code));
      return json({ code, display: displayCode(code), link: enrolLink(code), expiresAt: data.expiresAt,
                    ...(qr ? { qr: qr.map((row) => row.map((dark) => (dark ? '1' : '0')).join('')) } : {}) }, 201,
        { 'cache-control': 'no-store' });
    }
    return json({ error: 'no free code, try again' }, 503);
  }

  const id = typeof body.id === 'string' ? body.id : '';
  if (!DEVICE_RE.test(id)) return json({ error: 'bad id' }, 400);
  const { status, data } = await callRegistry(env, `/${action}`, { id });
  if (status >= 500) throw new Error(`registry ${status}`);
  if (status !== 200) return json({ error: data?.error || `${action} failed` }, status);
  forgetCaches();   // refused at once in this isolate; elsewhere within AUTH_CACHE_MS
  return json({ ok: true });
}

// ── The dashboard's Devices section ──
// Spliced into worker.js's page: the HTML after the server grid, the script
// inside the page's one <script> (it shares KEY, esc, ago, flash). Identifiers
// are prefixed `dev`. Buttons carry data-dev (never data-act: the page's
// document-level listener posts every data-act click to /admin/action), and
// the panel wires its own element's onclick — no second document listener.
// Every value from the registry is escaped: names and app strings come from
// whoever held an invite code.

const PLATFORM_NAMES = { ios: 'iPhone / iPad', tvos: 'Apple TV', macos: 'Mac', web: 'Web', roku: 'Roku', other: 'Other' };

export function devicesPanelHTML() {
  return `
    <h2 class="sec">Devices</h2>
    <p class="note">Each enrolled device has its own token. Revoke refuses it within a minute, here and on every server. To enrol: Add a device, then type the code on the device (Settings → Advanced on iPhone, Connection on Apple TV and Mac) or scan the QR with the iPhone camera.</p>
    <div id="devPanel">
      <div class="devbar"><input id="devLabel" maxlength="40" placeholder="Label (optional), e.g. Living room TV" aria-label="Label for the new device"><button class="devpri" data-dev="invite">Add a device</button></div>
      <div id="devInvite" class="devinv" role="status" hidden></div>
      <div id="devOpen" class="devopen"></div>
      <div id="devList" class="grid"><div class="empty small">Loading…</div></div>
    </div>
    <style>
      #devPanel .devbar{max-width:980px;margin:0 auto 12px;display:flex;gap:8px;flex-wrap:wrap}
      #devPanel input{flex:1;min-width:180px;max-width:360px;background:#0d120f;border:1px solid var(--line);color:var(--txt);border-radius:9px;padding:8px 10px;font-size:13px}
      #devPanel input:focus{outline:none;border-color:var(--accent)}
      #devPanel button{background:#0d120f;border:1px solid var(--line);color:var(--txt);border-radius:9px;padding:8px 12px;font-size:13px;cursor:pointer}
      #devPanel button:hover{border-color:var(--accent)}
      #devPanel .devpri{background:var(--accent);color:#04170e;border-color:var(--accent);font-weight:700}
      .devinv{max-width:980px;margin:0 auto 14px;background:var(--panel);border:1px solid var(--accent);border-radius:14px;padding:18px;display:flex;gap:20px;flex-wrap:wrap;align-items:center;justify-content:space-between}
      .devinv[hidden]{display:none}
      .devcode{font:800 clamp(34px,9vw,56px)/1 ui-monospace,Menlo,monospace;letter-spacing:.14em;color:var(--accent)}
      .devhint{color:var(--dim);font-size:13px;margin:10px 0 6px;max-width:460px}
      .devlink{font:12px ui-monospace,Menlo,monospace;color:var(--dim);word-break:break-all;margin-bottom:10px}
      .devqr{width:176px;height:176px;border-radius:10px;flex:none}
      .devopen{max-width:980px;margin:0 auto 10px;color:var(--dim);font-size:12px}
      .devc.off{opacity:.55}
      .devmeta{margin:6px 0 2px;font:11px ui-monospace,Menlo,monospace;color:var(--dim);word-break:break-all}
    </style>`;
}

export function devicesPanelScript() {
  return `
    // ── Devices (Wave 8 F1a — relay/src/devices.js) ──
    const DEV_PLATFORMS=${JSON.stringify(PLATFORM_NAMES)};
    const DEV_FRESH=${15 * 60_000};
    function devWhen(ms){if(!ms)return 'never';const h=(Date.now()-ms)/3600000;return h>=48?Math.round(h/24)+'d ago':ago(ms);}
    function devIn(ms){return Math.max(0,Math.round((ms-Date.now())/60000))+' min';}
    function devSvg(rows){
      if(!Array.isArray(rows)||!rows.length)return '';
      const n=rows.length,q=4;let d='';
      for(let y=0;y<n;y++){const r=String(rows[y]);for(let x=0;x<n;x++)if(r[x]==='1')d+='M'+(x+q)+' '+(y+q)+'h1v1h-1z';}
      return '<svg class="devqr" viewBox="0 0 '+(n+2*q)+' '+(n+2*q)+'" role="img" aria-label="QR code of the enrolment link" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="'+d+'" fill="#000"/></svg>';
    }
    async function devCall(method,path,body){
      try{const r=await fetch(path+'?key='+encodeURIComponent(KEY),{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
        let j=null;try{j=await r.json();}catch(e){}
        if(!r.ok){flash((j&&j.error)||('HTTP '+r.status));return null;}
        return j;
      }catch(e){flash('network error');return null;}
    }
    function devCard(d){
      const off=!!d.revokedAt,id=esc(d.id),nm=esc(d.name||d.id);
      const fresh=!off&&d.lastSeenAt&&(Date.now()-d.lastSeenAt)<DEV_FRESH;
      const seen=d.lastSeenAt?'seen '+devWhen(d.lastSeenAt)+(d.lastSeenFrom?' · '+esc(d.lastSeenFrom):''):'never seen';
      const btn=off?'<button data-dev="forget" data-dev-id="'+id+'">Forget</button>'
        :'<button data-dev="revoke" data-dev-id="'+id+'" data-dev-name="'+nm+'">Revoke</button>';
      return '<div class="wcard devc'+(off?' off':'')+'" title="device '+id+'"><div class="row1">'
        +(off?'<span class="badge">revoked</span>':'<span class="dot '+(fresh?'up':'off')+'"></span>')
        +'<span class="name">'+nm+'</span><span class="os">'+esc(DEV_PLATFORMS[d.platform]||d.platform||'')+'</span></div>'
        +'<div class="devmeta">'+(d.app?esc(d.app)+' · ':'')+id+(d.label?' · '+esc(d.label):'')+'</div>'
        +'<div class="row2"><span>'+(off?'revoked '+devWhen(d.revokedAt):'enrolled '+devWhen(d.createdAt))+'</span><span class="seen">'+seen+'</span></div>'
        +'<div class="ctl">'+btn+'</div></div>';
    }
    function devShowInvite(inv){
      const box=document.getElementById('devInvite');if(!box)return;
      const until=new Date(inv.expiresAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
      box.innerHTML='<div><div class="devcode" aria-label="Enrolment code">'+esc(inv.display)+'</div>'
        +'<div class="devhint">Type this on the device, or scan the QR with the iPhone camera. One use, until '+esc(until)+'.</div>'
        +'<div class="devlink">'+esc(inv.link)+'</div><button data-dev="hide">Done</button></div>'+devSvg(inv.qr);
      box.hidden=false;
    }
    async function devRefresh(){
      const list=document.getElementById('devList'),open=document.getElementById('devOpen');
      let j=null,err='';
      try{const r=await fetch('/admin/devices?key='+encodeURIComponent(KEY));try{j=await r.json();}catch(e){}
        if(!r.ok){err=(j&&j.error)||('HTTP '+r.status);j=null;}
      }catch(e){err='network error';}
      if(!j){if(list)list.innerHTML='<div class="empty small">Device list unavailable ('+esc(err)+').</div>';return;}
      const ds=Array.isArray(j.devices)?j.devices:[],inv=Array.isArray(j.invites)?j.invites:[];
      if(list)list.innerHTML=ds.length?ds.map(devCard).join(''):'<div class="empty small">No enrolled devices yet. Add a device to issue a one-time code.</div>';
      if(open)open.innerHTML=inv.length?'Open codes: '+inv.map(i=>esc(i.hint)+(i.label?' ('+esc(i.label)+')':'')+', '+devIn(i.expiresAt)+' left').join(' · '):'';
    }
    const devRoot=document.getElementById('devPanel');
    if(devRoot)devRoot.onclick=async function(e){
      const b=e.target&&e.target.closest&&e.target.closest('[data-dev]');if(!b)return;
      const a=b.dataset.dev,id=b.dataset.devId||'';
      if(a==='invite'){
        const l=document.getElementById('devLabel');
        const inv=await devCall('POST','/admin/devices/invite',{label:String((l&&l.value)||'').slice(0,40)});
        if(inv){devShowInvite(inv);if(l)l.value='';}
      }else if(a==='hide'){
        const box=document.getElementById('devInvite');if(box){box.hidden=true;box.innerHTML='';}return;
      }else if(a==='revoke'){
        if(typeof confirm==='function'&&!confirm('Revoke '+(b.dataset.devName||id)+'? Its token stops working within a minute.'))return;
        await devCall('POST','/admin/devices/revoke',{id});
      }else if(a==='forget'){
        await devCall('POST','/admin/devices/forget',{id});
      }
      devRefresh();
    };
    devRefresh();setInterval(devRefresh,15000);`;
}

// ── The Durable Object ──
// ONE instance (idFromName("registry")), SQLite-backed (wrangler.toml migration
// v2-devices), through the storage KV API like PartyRoom. Storage: `dev:<id>`
// per device {id, name, platform, app, label, sha256, createdAt, lastSeenAt,
// lastSeenFrom, revokedAt}, `inv:<sha256(code)>` per open invite {hint, label,
// createdAt, expiresAt}, `meta` {version}. Everything is mirrored in memory at
// load (≤ 500 devices), so a lookup is a Map read; writes are per record, and
// lastSeen is throttled. `version` +1 on every enrol / revoke / forget orders
// the extractors' copies (they take only a newer one).
export class DeviceRegistry {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.devices = new Map();   // id → record
    this.byHash = new Map();    // sha256 → id, live devices only
    this.invites = new Map();   // sha256(code) → invite
    this.version = 0;
    this.ready = ctx.blockConcurrencyWhile(() => this.load());
  }

  async load() {
    this.version = Number((await this.ctx.storage.get('meta'))?.version) || 0;
    for (const rec of (await this.ctx.storage.list({ prefix: 'dev:' })).values()) {
      if (!rec || typeof rec.id !== 'string' || !DEVICE_RE.test(rec.id)) continue;
      this.devices.set(rec.id, rec);
      if (!rec.revokedAt && HEX64_RE.test(rec.sha256 || '')) this.byHash.set(rec.sha256, rec.id);
    }
    for (const [k, inv] of await this.ctx.storage.list({ prefix: 'inv:' })) this.invites.set(k.slice(4), inv);
  }

  async fetch(req) {
    await this.ready;
    const now = Date.now();
    let body = {};
    if (req.method === 'POST') {
      try { body = (await req.json()) ?? {}; } catch { return reply({ error: 'bad json' }, 400); }
      if (typeof body !== 'object') return reply({ error: 'bad json' }, 400);
    }
    switch (new URL(req.url).pathname) {
      case '/auth': return this.auth(body, now);
      case '/beat': return this.beat(body, now);
      case '/list': return reply(this.list(now));
      case '/invite': return this.invite(body, now);
      case '/enroll': return this.enroll(body, now);
      case '/revoke': return this.revoke(body, now);
      case '/forget': return this.forget(body);
      default: return reply({ error: 'not found' }, 404);
    }
  }

  live(h) {
    const id = typeof h === 'string' ? this.byHash.get(h) : undefined;
    const rec = id === undefined ? null : this.devices.get(id);
    return rec && !rec.revokedAt ? rec : null;
  }

  liveCount() { let n = 0; for (const r of this.devices.values()) if (!r.revokedAt) n++; return n; }

  // lastSeen, at most one write per device per SEEN_WRITE_MS (and only forward in time).
  async touch(pairs, from) {
    const writes = {};
    for (const [rec, at] of pairs) {
      if (at - (rec.lastSeenAt || 0) < SEEN_WRITE_MS) continue;
      rec.lastSeenAt = at;
      rec.lastSeenFrom = from;
      writes[`dev:${rec.id}`] = rec;
    }
    if (Object.keys(writes).length) await this.ctx.storage.put(writes);
  }

  async auth({ sha256, seen }, now) {
    const rec = this.live(sha256);
    if (!rec) return reply({ ok: false });
    if (seen) await this.touch([[rec, now]], 'relay');
    return reply({ ok: true, id: rec.id, name: rec.name, platform: rec.platform, createdAt: rec.createdAt });
  }

  async beat({ seen }, now) {
    if (seen && typeof seen === 'object' && !Array.isArray(seen)) {
      const pairs = [];
      for (const [id, v] of Object.entries(seen).slice(0, MAX_SEEN)) {
        const rec = this.devices.get(id);
        const at = Math.min(Number(v), now);
        if (rec && !rec.revokedAt && Number.isFinite(at) && at > 0) pairs.push([rec, at]);
      }
      await this.touch(pairs, 'extractor');
    }
    const devices = [];
    for (const r of this.devices.values()) if (!r.revokedAt && r.sha256) devices.push({ id: r.id, sha256: r.sha256 });
    return reply({ v: 1, version: this.version, devices: devices.slice(0, MAX_DEVICES) });
  }

  list(now) {
    const seenOrMade = (r) => Math.max(r.lastSeenAt || 0, r.createdAt || 0);
    const devices = [...this.devices.values()]
      .sort((a, b) => (!!a.revokedAt - !!b.revokedAt) || seenOrMade(b) - seenOrMade(a))
      .map((r) => ({ id: r.id, name: r.name, platform: r.platform, app: r.app, label: r.label || '',
                     createdAt: r.createdAt, lastSeenAt: r.lastSeenAt || null, lastSeenFrom: r.lastSeenFrom || null,
                     revokedAt: r.revokedAt || null }));
    const invites = [...this.invites.values()].filter((i) => i.expiresAt > now)
      .sort((a, b) => a.expiresAt - b.expiresAt)
      .map(({ hint, label, expiresAt }) => ({ hint, label, expiresAt }));
    return { devices, invites };
  }

  async pruneInvites(now) {
    const dead = [...this.invites].filter(([, i]) => !(i.expiresAt > now)).map(([h]) => h);
    for (const h of dead) this.invites.delete(h);
    if (dead.length) await this.ctx.storage.delete(dead.map((h) => `inv:${h}`));
  }

  async invite({ codeHash, hint, label }, now) {
    if (!HEX64_RE.test(codeHash || '')) return reply({ error: 'bad request' }, 400);
    await this.pruneInvites(now);
    if (this.invites.has(codeHash)) return reply({ error: 'exists' }, 409);
    if (this.invites.size >= MAX_OPEN_INVITES) return reply({ error: 'too-many-invites' }, 429);
    const inv = { hint: String(hint || '').slice(0, 8), label: String(label || '').slice(0, LABEL_MAX),
                  createdAt: now, expiresAt: now + INVITE_TTL_MS };
    this.invites.set(codeHash, inv);
    await this.ctx.storage.put(`inv:${codeHash}`, inv);
    return reply({ expiresAt: inv.expiresAt }, 201);
  }

  async enroll({ codeHash, id, sha256, name, platform, app }, now) {
    if (!HEX64_RE.test(codeHash || '') || !HEX64_RE.test(sha256 || '') || typeof id !== 'string' || !DEVICE_RE.test(id)) {
      return reply({ error: 'bad request' }, 400);
    }
    const inv = this.invites.get(codeHash);
    if (!inv || !(inv.expiresAt > now)) return reply(BAD_CODE, 403);
    const prev = this.devices.get(id);
    if ((!prev || prev.revokedAt) && this.liveCount() >= MAX_DEVICES) return reply({ error: 'too many devices' }, 409);
    const clash = this.byHash.get(sha256);
    if (clash !== undefined && clash !== id) return reply({ error: 'token clash' }, 409);
    // Same id again (a reinstall, a revoked device the owner let back): its
    // old hash goes, so the old token is refused from here on.
    if (prev?.sha256) this.byHash.delete(prev.sha256);
    const rec = { id, name: String(name || id).slice(0, NAME_MAX), platform: PLATFORMS.includes(platform) ? platform : 'other',
                  app: String(app || '').slice(0, APP_MAX), label: inv.label || '', sha256,
                  createdAt: now, lastSeenAt: now, lastSeenFrom: 'relay', revokedAt: null };
    this.devices.set(id, rec);
    this.byHash.set(sha256, id);
    this.invites.delete(codeHash);
    this.version += 1;
    await this.ctx.storage.delete(`inv:${codeHash}`);
    await this.ctx.storage.put({ [`dev:${id}`]: rec, meta: { version: this.version } });
    return reply({ name: rec.name, issuedAt: now });
  }

  async revoke({ id }, now) {
    const rec = typeof id === 'string' ? this.devices.get(id) : undefined;
    if (!rec) return reply({ error: 'unknown device' }, 404);
    if (rec.revokedAt) return reply({ ok: true });
    if (rec.sha256) this.byHash.delete(rec.sha256);
    rec.revokedAt = now;
    rec.sha256 = null;   // a revoked hash has no further use
    this.version += 1;
    await this.ctx.storage.put({ [`dev:${rec.id}`]: rec, meta: { version: this.version } });
    return reply({ ok: true });
  }

  async forget({ id }) {
    const rec = typeof id === 'string' ? this.devices.get(id) : undefined;
    if (!rec) return reply({ error: 'unknown device' }, 404);
    if (!rec.revokedAt) return reply({ error: 'revoke first' }, 409);
    this.devices.delete(rec.id);
    this.version += 1;
    await this.ctx.storage.delete(`dev:${rec.id}`);
    await this.ctx.storage.put('meta', { version: this.version });
    return reply({ ok: true });
  }
}

function reply(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}
