// SlimeRelay — registry + admin control plane for the SlimeWatch server fleet.
// State lives in KV (binding: SERVERS): server heartbeats (srv:<id>, TTL'd) and a
// routing policy (key "policy": { disabled:[ids], preferred:id|null,
// devices:{ <deviceId>: { server:id|null, avoid:[ids], seenAt:ms } } }).
// Per-device presence freshness for that map lives in seen:<deviceId> (TTL'd).
//
// Roles (secrets, set via `wrangler secret put`):
//   ADMIN_TOKEN  full control — dashboard, /servers (names+addresses+load),
//                /admin/* controls, /presence read.
//   USER_TOKEN   limited client — /route, /presence write. Ships INSIDE the app,
//                so treat it as public: it must never grant registration.
//   FLEET_TOKEN  server-only — the credential a server uses to /register. Keep it
//                OUT of the app. Once set, the app's USER_TOKEN can no longer
//                register/overwrite a server (closes fleet-poisoning). Until set,
//                /register keeps accepting USER_TOKEN so a deploy can't drop the fleet.
// Optional var: ADDR_PRIVATE_ONLY="1" — reject any registered address that isn't a
//   private/Tailscale host (recommended once the fleet is on Tailscale/Tunnel).
// A request is admin if it presents ADMIN_TOKEN; user if it presents USER_TOKEN.
//
// Routes:
//   POST /register        heartbeat (admin) -> { ok }
//   GET  /route[?device=] ranked enabled addresses (user|admin) -> { servers:[url] }
//                         With a device that has a policy: its pinned server
//                         first (when up), its avoided servers removed. Header
//                         x-slime-route-note: avoid-exhausted when avoiding would
//                         leave nothing (the full list is returned instead).
//   GET  /servers         full fleet + status (admin) -> { servers:[...], devices:{...} }
//   GET  /pick            single best enabled server (admin) -> { server }
//   POST /admin/action    { action:'disable'|'enable'|'prefer'|'unprefer', id } (admin)
//                         { action:'assign', device, server:id|null } pin (null = Automatic)
//                         { action:'avoid'|'unavoid', device, server } per-device avoid
//                         { action:'clear-device', device } drop the device's policy
//   POST /presence        viewer heartbeat (user) { id, name, title, sub, kind,
//                         platform, paused, server } — server = fleet name played through
//   GET  /presence        who's watching (admin) -> { active, sessions:[{..., server, routing}] }
//   GET  /                dashboard (admin) — status + controls
//   POST /assist          the apps' "Ask" assistant (user|admin) — see assist.js

import { handleAssist } from './assist.js';

const HEARTBEAT_TTL = 90;
const FRESH_MS = 60_000;
// Presence: a viewer's app heartbeats what they're watching. Kept short-lived so
// "active" reflects who's genuinely watching right now (a closed app expires).
const PRESENCE_TTL = 120;
// Per-device routing (policy.devices). Ids are the apps' presence device ids.
const DEVICE_RE = /^[A-Za-z0-9._-]{1,80}$/;
// A device's policy is pruned after 30 days with no presence (and no owner
// change). Presence freshness lives in its own TTL'd key, seen:<id>, NOT in the
// policy: KV is eventually consistent (~60 s across locations), so a presence
// beat that rewrote "policy" could write back a stale copy and silently undo an
// owner action made moments earlier. The owner's writes fold seen:* into
// devices[id].seenAt and prune there.
const DEVICE_PRUNE_MS = 30 * 86_400_000;
const SEEN_TTL = 30 * 86_400;              // seconds; the key outliving this = seen recently
const SEEN_REFRESH_MS = 6 * 3_600_000;     // at most one seen:<id> write per device per 6 h

// Current embed-provider domains the apps should use. Streaming sites rotate
// domains constantly; the apps fetch this on launch and override their baked
// defaults, so a rotation is a one-line edit here (or in the KV key "providers")
// instead of a new app build. Edit + redeploy, or set the KV to override live.
// Audited 2026-07-25: dropped embedsu (embed.su NXDOMAIN), autoembed
// (autoembed.cc NXDOMAIN), pstream (iframe.pstream.org lapsed → ParkLogic
// parking redirector) and vidsrcto (Cloudflare challenge never clears, not on
// the official mirror list). Old shipped builds still carry those baked hosts,
// so they're ALSO killed via the extractor's manifest.json providers.disabled —
// removing them here only stops handing the hosts out, it can't remove a rung.
// Mirrors are chosen to serve directly: vidsrc-embed.ru and vsrc.su both 302 to
// vsembed.ru, which would collapse two ladder rungs onto one origin.
// 2026-09-26: VidSrc's official list (vidsrc.domains) is now vidsrc.sh (primary),
// vidsrc2.ru and vidsrc.ir; vidsrcme.ru is "use new" and vidsrcme.su just 301s
// to vidsrc.sh (so it duplicated the first rung's origin).
const DEFAULT_PROVIDERS = {
  hosts: {
    vidlink: 'vidlink.pro',
    vidfast: 'vidfast.vc',
    vidsrccc: 'vidsrc.cc',
    vidsrcme: 'vidsrc.sh',
    vidsrcme2: 'vidsrc2.ru',
    vidsrcme3: 'vidsrc.ir',
  },
  animeHosts: {
    // tryembed is the working PRIMARY (verified 2026-07-25 in a real browser:
    // AniList 21 → ONE PIECE ep1 sub 24:37, AniList 16498 → ATTACK ON TITAN ep1
    // dub with a loaded 1556s stream).
    // 2026-10-05 (docs/ANIME-SOURCING-REVIEW-2026-10-05.md §4, the extractor's
    // headless Chromium, AoT ep1 + One Piece ep1120, sub and dub): vidnest.fun
    // streamed in 0.8–1.9 s with the same encodes as tryembed (a second front
    // on one catalog); anixo.buzz streamed once (own-domain mp4) and failed
    // once — probationary, last. vidsrc.cc (522) and vidsrc.icu (NXDOMAIN) are
    // dead and REMOVED: the apps clear an anime id this map stops naming, so
    // every device drops those rungs. Re-adding one here brings it back.
    tryembed: 'tryembed.us.cc',
    vidnest: 'vidnest.fun',
    anixo: 'anixo.buzz',
  },
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const provided =
      (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') ||
      url.searchParams.get('key') || '';
    const isAdmin = !!env.ADMIN_TOKEN && provided === env.ADMIN_TOKEN;
    const isUser = isAdmin || (!!env.USER_TOKEN && provided === env.USER_TOKEN);
    // Server-only credential for /register — NEVER the app-extractable USER_TOKEN.
    // If FLEET_TOKEN isn't set yet, /register falls back to admin-only (still safe).
    const isFleet = isAdmin || (!!env.FLEET_TOKEN && provided === env.FLEET_TOKEN);
    const clientIP = request.headers.get('cf-connecting-ip') || 'unknown';

    // ── Provider domains (PUBLIC — just domain names, no auth). Apps fetch this
    // on launch so a rotated streaming domain is fixed here, not in a new build.
    // Merges the KV "providers" override (if set) over the baked defaults. ──
    // ── Provider-domain rotation (server credential). The home extractor's
    // domain watcher writes here after it has PROVEN a host plays (see
    // SlimeWatchExtractor/lib/domainwatch.js). Only known provider ids, only
    // well-formed hostnames; every write is appended to a history. ──
    if (url.pathname === '/providers' && request.method === 'POST') {
      if (!env.FLEET_TOKEN || !isFleet) return json({ error: 'unauthorized' }, 401);
      if (await rateLimited(env, `prov:${clientIP}`, 20)) return json({ error: 'rate limited' }, 429);
      let body; try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
      // An EMPTY host for a known id means "clear": stored as "" so GET hands
      // out "" and the apps remove their override (a baked host falls back to
      // its default, a relay-only one disappears). HOST_RE rejected "", which
      // left no way to clear a host once set.
      const clean = (src, allowed) => {
        const out = {};
        for (const [id, h] of Object.entries(src || {})) {
          const host = String(h || '').trim().toLowerCase();
          if (!(id in allowed) || (host !== '' && !HOST_RE.test(host))) return null;
          out[id] = host;
        }
        return out;
      };
      const hosts = clean(body?.hosts, DEFAULT_PROVIDERS.hosts);
      const animeHosts = clean(body?.animeHosts, DEFAULT_PROVIDERS.animeHosts);
      if (!hosts || !animeHosts) return json({ error: 'unknown provider id or bad host' }, 400);
      if (!Object.keys(hosts).length && !Object.keys(animeHosts).length) return json({ error: 'nothing to set' }, 400);
      let override = {};
      try { override = JSON.parse(await env.SERVERS.get('providers') || '{}') || {}; } catch {}
      const next = {
        hosts: { ...(override.hosts || {}), ...hosts },
        animeHosts: { ...(override.animeHosts || {}), ...animeHosts },
      };
      await env.SERVERS.put('providers', JSON.stringify(next));
      let history = [];
      try { history = JSON.parse(await env.SERVERS.get('providers:history') || '[]'); } catch {}
      history.push({ at: new Date().toISOString(), hosts, animeHosts, reason: String(body?.reason || '').slice(0, 300) });
      await env.SERVERS.put('providers:history', JSON.stringify(history.slice(-50)));
      return json({ ok: true, hosts: { ...DEFAULT_PROVIDERS.hosts, ...next.hosts },
                    animeHosts: { ...DEFAULT_PROVIDERS.animeHosts, ...next.animeHosts } });
    }

    if (url.pathname === '/providers') {
      let override = null;
      try { const raw = await env.SERVERS.get('providers'); override = raw ? JSON.parse(raw) : null; } catch {}
      // Anime ids only while they are defaults: a KV override written before an
      // id was retired (vidsrccc / vidsrcicu, 2026-10-05) must not keep handing
      // the dead host out.
      const animeOverride = Object.fromEntries(Object.entries(override?.animeHosts || {})
        .filter(([id]) => id in DEFAULT_PROVIDERS.animeHosts));
      const cfg = {
        hosts: { ...DEFAULT_PROVIDERS.hosts, ...(override?.hosts || {}) },
        animeHosts: { ...DEFAULT_PROVIDERS.animeHosts, ...animeOverride },
      };
      return new Response(JSON.stringify(cfg), {
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*',
                   'cache-control': 'public, max-age=300' },
      });
    }

    // ── Server registration (fleet token — servers heartbeat with it) ──
    if (url.pathname === '/register' && request.method === 'POST') {
      // Server-only credential. STAGED so deploying the Worker alone never drops
      // the fleet: once FLEET_TOKEN is set (wrangler secret + each server's .env),
      // /register requires it (or admin) and the app's USER_TOKEN is REJECTED —
      // closing the fleet-poisoning / client-redirection hole. Until then it keeps
      // the old USER_TOKEN behavior so nothing breaks mid-rollout.
      const canRegister = env.FLEET_TOKEN ? isFleet : isUser;
      if (!canRegister) return json({ error: 'unauthorized' }, 401);
      if (await rateLimited(env, `reg:${clientIP}`, 60)) return json({ error: 'rate limited' }, 429);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      if (!body || !body.id) return json({ error: 'id required' }, 400);
      const cap = (v, n) => String(v ?? '').slice(0, n);
      const record = {
        id: cap(body.id, 128), name: cap(body.name || body.id, 80), os: cap(body.os || 'unknown', 80),
        address: safeAddress(body.address, env), load: Math.max(0, Number(body.load) || 0),
        capacity: Math.max(0, Number(body.capacity) || 0), version: Number(body.version) || 1, lastSeen: Date.now(),
      };
      if (!record.address) return json({ error: 'address rejected' }, 400);
      await env.SERVERS.put(`srv:${record.id}`, JSON.stringify(record), { expirationTtl: HEARTBEAT_TTL });
      return json({ ok: true });
    }

    // ── Presence: a viewer's app reports what it's playing (any valid client
    // token). Short TTL so "active now" is genuinely live. Owner-only to READ. ──
    if (url.pathname === '/presence' && request.method === 'POST') {
      if (!isUser) return json({ error: 'unauthorized' }, 401);
      if (await rateLimited(env, `pres:${clientIP}`, 120)) return json({ error: 'rate limited' }, 429);
      let body; try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      if (!body || !body.id) return json({ error: 'id required' }, 400);
      const cap = (v, n) => String(v ?? '').slice(0, n);
      const rec = {
        id: cap(body.id, 128),
        name: cap(body.name || 'Someone', 60),
        title: cap(body.title || '', 120),
        sub: cap(body.sub || '', 24),          // "S2·E4" for series, "" for movies
        kind: cap(body.kind || '', 16),
        platform: cap(body.platform || '', 16),
        paused: !!body.paused,
        // The fleet server's name this device is playing through ("" = unknown
        // or a manual host). Display only: routing never trusts it.
        server: typeof body.server === 'string' ? body.server.slice(0, 80) : '',
        lastSeen: Date.now(),
      };
      await env.SERVERS.put(`pres:${rec.id}`, JSON.stringify(rec), { expirationTtl: PRESENCE_TTL });
      await touchSeen(env, rec.id, rec.lastSeen);
      return json({ ok: true });
    }
    // Explicit stop (app closed / playback ended) — clear immediately.
    if (url.pathname === '/presence' && request.method === 'DELETE') {
      if (!isUser) return json({ error: 'unauthorized' }, 401);
      const id = url.searchParams.get('id') || '';
      if (id) await env.SERVERS.delete(`pres:${id.slice(0, 128)}`);
      return json({ ok: true });
    }
    // Admin read: who's watching right now + a live count.
    if (url.pathname === '/presence' && request.method === 'GET') {
      if (!isAdmin) return json({ error: 'unauthorized' }, 401);
      const sessions = await presence(env);
      const policy = await getPolicy(env);
      const rules = sessions.map((s) => deviceRule(policy, s.id));
      // Names for just the servers those rules mention (point reads, not
      // another srv: listing on every dashboard refresh).
      const names = new Map();
      for (const sid of new Set(rules.flatMap((r) => (r ? [r.server, ...r.avoid] : [])).filter(Boolean))) {
        try { const v = await env.SERVERS.get(`srv:${sid}`); if (v) names.set(sid, JSON.parse(v).name); } catch {}
      }
      sessions.forEach((s, i) => {
        s.server = typeof s.server === 'string' ? s.server : '';   // rows from before this field
        s.routing = routingSummary(rules[i], (sid) => names.get(sid) || sid);
      });
      return json({ active: sessions.length, sessions });
    }

    // ── The "Ask" assistant: a DeepSeek proxy with the prompt and tools fixed here. ──
    if (url.pathname === '/assist' && request.method === 'POST') {
      return handleAssist(request, env, { isUser, clientIP, json, rateLimited });
    }

    // ── User routing: bare, ranked, enabled-only addresses. No metadata. ──
    if (url.pathname === '/route') {
      if (!isUser) return json({ error: 'unauthorized' }, 401);
      if (await rateLimited(env, `route:${clientIP}`, 120)) return json({ error: 'rate limited' }, 429);
      const { servers, policy } = await fleet(env);
      const usable = servers.filter((s) => s.enabled && s.address);
      usable.sort(rank);
      // Optional ?device=: the owner's per-device pin/avoid. A malformed id or a
      // device with no policy gets exactly the shared list, as before.
      const { list, note } = routeFor(usable, deviceRule(policy, url.searchParams.get('device')));
      return json({ servers: list.map((s) => s.address) }, 200,
        note ? { 'x-slime-route-note': note } : undefined);
    }

    // ── Admin: full fleet with names/addresses/load/status ──
    if (url.pathname === '/servers') {
      if (!isAdmin) return json({ error: 'unauthorized' }, 401);
      const { servers, policy } = await fleet(env);
      return json({ servers: servers.sort(rank), devices: policy.devices });
    }

    if (url.pathname === '/pick') {
      if (!isAdmin) return json({ error: 'unauthorized' }, 401);
      const { servers } = await fleet(env);
      const usable = servers.filter((s) => s.enabled && s.address).sort(rank);
      return json({ server: usable[0] || null });
    }

    // ── Admin controls: disable / enable / prefer / unprefer (fleet-wide) and
    // assign / avoid / unavoid / clear-device (one device's routing) ──
    if (url.pathname === '/admin/action' && request.method === 'POST') {
      if (!isAdmin) return json({ error: 'unauthorized' }, 401);
      let body; try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const policy = await getPolicy(env);
      const id = String(body?.id || '');
      switch (body?.action) {
        case 'disable': if (id && !policy.disabled.includes(id)) policy.disabled.push(id); break;
        case 'enable':  policy.disabled = policy.disabled.filter((x) => x !== id); break;
        case 'prefer':  policy.preferred = id || null; break;
        case 'unprefer': policy.preferred = null; break;
        case 'assign': case 'avoid': case 'unavoid': case 'clear-device': {
          const err = await applyDeviceAction(env, policy, body);
          if (err) return json({ error: err }, 400);
          break;
        }
        default: return json({ error: 'unknown action' }, 400);
      }
      await foldSeen(env, policy);
      await env.SERVERS.put('policy', JSON.stringify(policy));
      return json({ ok: true, policy });
    }

    // ── Dashboard (admin) ──
    if (url.pathname === '/') {
      if (!isAdmin) return htmlResponse(gatePage());
      return htmlResponse(dashboardPage(provided));
    }

    return json({ error: 'not found' }, 404);
  },
};

async function getPolicy(env) {
  const raw = await env.SERVERS.get('policy');
  const p = raw ? JSON.parse(raw) : {};
  return { disabled: Array.isArray(p.disabled) ? p.disabled : [], preferred: p.preferred || null,
           devices: cleanDevices(p.devices) };
}

// policy.devices, normalized. A null-prototype map, so a device id such as
// "__proto__" or "constructor" (both match DEVICE_RE) is only ever an own key.
// An entry with neither a pin nor an avoid is dropped: that is Automatic.
function cleanDevices(src) {
  const out = Object.create(null);
  if (!src || typeof src !== 'object') return out;
  for (const [id, v] of Object.entries(src)) {
    if (!DEVICE_RE.test(id) || !v || typeof v !== 'object') continue;
    const server = typeof v.server === 'string' && v.server ? v.server.slice(0, 128) : null;
    const avoid = Array.isArray(v.avoid)
      ? [...new Set(v.avoid.filter((x) => typeof x === 'string' && x).map((x) => x.slice(0, 128)))].slice(0, 32)
      : [];
    if (!server && !avoid.length) continue;
    out[id] = { server, avoid, seenAt: Number(v.seenAt) || 0 };
  }
  return out;
}

// The policy rule for a device id from a request/presence row, or null.
function deviceRule(policy, id) {
  return typeof id === 'string' && DEVICE_RE.test(id) && Object.hasOwn(policy.devices, id)
    ? policy.devices[id] : null;
}

// One device's ranked list. `usable` is the shared list (enabled, addressed,
// ranked). Pin first when it's in that list (a down or disabled pin falls
// through, never stranding the device), then the rest minus `avoid`. If
// avoiding empties the list, availability beats policy: the full list + a note.
function routeFor(usable, rule) {
  if (!rule) return { list: usable, note: '' };
  const pin = rule.server ? usable.find((s) => s.id === rule.server) || null : null;
  const list = [...(pin ? [pin] : []), ...usable.filter((s) => s !== pin && !rule.avoid.includes(s.id))];
  if (!list.length && usable.length) return { list: usable, note: 'avoid-exhausted' };
  return { list, note: '' };
}

// 'auto' | 'pinned:<name>' | 'avoid:<name>,<name>' — a pin is reported over an
// avoid (devices[id] has both). nameOf(id) names a server (its id when offline).
function routingSummary(rule, nameOf) {
  if (!rule) return 'auto';
  if (rule.server) return `pinned:${nameOf(rule.server)}`;
  if (rule.avoid.length) return `avoid:${rule.avoid.map(nameOf).join(',')}`;
  return 'auto';
}

// assign / avoid / unavoid / clear-device on policy.devices (in place). Returns
// an error string, or '' on success. Servers must be live fleet ids (srv:<id>);
// unavoid also accepts an id already in the device's avoid list, so a retired
// server can still be cleaned out.
async function applyDeviceAction(env, policy, body) {
  const device = body?.device;
  if (typeof device !== 'string' || !DEVICE_RE.test(device)) return 'bad device id';
  const devices = policy.devices;
  if (body.action === 'clear-device') { delete devices[device]; return ''; }
  const cur = Object.hasOwn(devices, device)
    ? devices[device] : { server: null, avoid: [], seenAt: 0 };
  const server = body.server;
  const known = async (sid) => typeof sid === 'string' && sid.length > 0 && sid.length <= 128 &&
    !!(await env.SERVERS.get(`srv:${sid}`));
  if (body.action === 'assign') {
    const sid = server === null || server === undefined || server === '' ? null : server;
    if (sid !== null && !(await known(sid))) return 'unknown server';
    cur.server = sid;
    if (sid) cur.avoid = cur.avoid.filter((x) => x !== sid);
  } else if (body.action === 'avoid') {
    if (!(await known(server))) return 'unknown server';
    if (!cur.avoid.includes(server)) cur.avoid.push(server);
    if (cur.server === server) cur.server = null;
  } else {   // unavoid
    if (typeof server !== 'string' || !(cur.avoid.includes(server) || await known(server))) return 'unknown server';
    cur.avoid = cur.avoid.filter((x) => x !== server);
  }
  cur.seenAt = Date.now();   // an owner change counts as a touch for pruning
  if (cur.server || cur.avoid.length) devices[device] = cur;
  else delete devices[device];   // nothing left = Automatic
  return '';
}

// Presence beat → seen:<id>, only for devices that have a policy, at most once
// per SEEN_REFRESH_MS. Never fails the beat.
async function touchSeen(env, id, now) {
  try {
    if (!deviceRule(await getPolicy(env), id)) return;
    const key = `seen:${id}`;
    const last = Number(await env.SERVERS.get(key)) || 0;
    if (now - last < SEEN_REFRESH_MS) return;
    await env.SERVERS.put(key, String(now), { expirationTtl: SEEN_TTL, metadata: { at: now } });
  } catch {}
}

// Owner write path: fold seen:* into devices[id].seenAt, then prune devices with
// no presence (and no owner change) for DEVICE_PRUNE_MS. A live seen:<id> key
// means "seen within SEEN_TTL", so it always keeps its entry. If the listing
// fails, nothing is pruned.
async function foldSeen(env, policy, now = Date.now()) {
  const seen = new Map();
  try {
    const list = await env.SERVERS.list({ prefix: 'seen:' });
    for (const k of list.keys) seen.set(k.name.slice(5), Number(k.metadata?.at) || 0);
  } catch { return; }
  for (const [id, d] of Object.entries(policy.devices)) {
    if (seen.has(id)) { d.seenAt = Math.max(d.seenAt, seen.get(id)); continue; }
    if (now - d.seenAt > DEVICE_PRUNE_MS) delete policy.devices[id];
  }
}

async function fleet(env) {
  const policy = await getPolicy(env);
  const list = await env.SERVERS.list({ prefix: 'srv:' });
  const servers = [];
  for (const k of list.keys) {
    const v = await env.SERVERS.get(k.name);
    if (!v) continue;
    const s = JSON.parse(v);
    s.enabled = !policy.disabled.includes(s.id);
    s.preferred = policy.preferred === s.id;
    servers.push(s);
  }
  return { servers, policy };
}

// Active viewers, most-recent first (TTL'd keys auto-expire, so this is "now").
async function presence(env) {
  const list = await env.SERVERS.list({ prefix: 'pres:' });
  const sessions = [];
  for (const k of list.keys) {
    const v = await env.SERVERS.get(k.name);
    if (!v) continue;
    try { sessions.push(JSON.parse(v)); } catch {}
  }
  sessions.sort((a, b) => b.lastSeen - a.lastSeen);
  return sessions;
}

// Preferred first, then least-loaded.
function rank(a, b) {
  if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
  return loadRatio(a) - loadRatio(b);
}
function loadRatio(s) { return s.capacity > 0 ? s.load / s.capacity : (s.load > 0 ? 1 : 0); }

// Coarse per-minute abuse throttle backed by KV. Approximate (KV isn't atomic) —
// enough to stop write-floods, not precise quota enforcement. Fails open so the
// limiter can never break routing.
async function rateLimited(env, bucket, limit, windowSec = 60) {
  try {
    const key = `rl:${bucket}:${Math.floor(Date.now() / (windowSec * 1000))}`;
    const n = Number(await env.SERVERS.get(key)) || 0;
    if (n >= limit) return true;
    await env.SERVERS.put(key, String(n + 1), { expirationTtl: windowSec + 10 });
    return false;
  } catch { return false; }
}

// Validate a server-advertised address: always http(s) + length-capped. With
// ADDR_PRIVATE_ONLY=1 (recommended once the fleet is on Tailscale/Tunnel), also
// reject raw PUBLIC IPs so a poisoned/misconfigured record can't point clients at
// an arbitrary internet host.
function safeAddress(v, env) {
  const s = String(v || '');
  if (!/^https?:\/\//i.test(s) || s.length > 200) return '';
  if (env && env.ADDR_PRIVATE_ONLY === '1') {
    let host;
    try { host = new URL(s).hostname.toLowerCase(); } catch { return ''; }
    if (!isPrivateHost(host)) return '';
  }
  return s.slice(0, 200);
}
function isPrivateHost(h) {
  if (h.endsWith('.ts.net') || h.endsWith('.local')) return true;   // Tailscale / mDNS
  const p = h.split('.');
  if (p.length === 4 && p.every((x) => /^\d+$/.test(x) && +x >= 0 && +x <= 255)) {
    const n = p.map(Number);
    if (n[0] === 10 || n[0] === 127) return true;
    if (n[0] === 192 && n[1] === 168) return true;
    if (n[0] === 172 && n[1] >= 16 && n[1] <= 31) return true;
    if (n[0] === 100 && n[1] >= 64 && n[1] <= 127) return true;      // Tailscale CGNAT
    if (n[0] === 169 && n[1] === 254) return true;                   // link-local
    return false;                                                    // other dotted-quad = public IP
  }
  return !h.includes('.');   // bare hostname (LAN) ok; public FQDNs rejected in private mode
}

function json(obj, status = 200, headers = undefined) {
  return new Response(JSON.stringify(obj, null, 2), {
    // No CORS `*`: authed routes are hit by the native apps (no origin) and the
    // same-origin dashboard. Only public `/providers` sets an allow-origin header.
    status, headers: { 'content-type': 'application/json', ...headers },
  });
}
function htmlResponse(body, status = 200) {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function gatePage() {
  return page(`<div class="empty"><div class="logo">SLIME<span>RELAY</span></div>
    <p>Admin access required. Append <code>?key=YOUR_ADMIN_TOKEN</code>.</p></div>`);
}

function dashboardPage(key) {
  // Every value from KV is escaped (presence rows are posted with the public
  // app token). Controls carry data-act/data-device/data-server and are wired by
  // the two delegated listeners at the bottom — no inline handlers.
  const script = `
    const KEY=${JSON.stringify(key)};
    const FRESH=${FRESH_MS};
    const DEV_RE=${DEVICE_RE.toString()};
    let FLEET=[], DEVICES={};
    function own(o,k){return !!o&&Object.prototype.hasOwnProperty.call(o,k);}
    function ago(ms){const s=Math.max(0,Math.round((Date.now()-ms)/1000));if(s<60)return s+'s ago';const m=Math.round(s/60);return m<60?m+'m ago':Math.round(m/60)+'h ago';}
    function esc(x){return String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
    function flash(m){const f=document.getElementById('flash');if(!f)return;f.textContent='Change failed: '+m;f.hidden=false;clearTimeout(flash.t);flash.t=setTimeout(()=>{f.hidden=true;},5000);}
    async function action(body){
      try{const r=await fetch('/admin/action?key='+encodeURIComponent(KEY),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
        if(!r.ok){let m='HTTP '+r.status;try{m=(await r.json()).error||m;}catch(e){}flash(m);}
      }catch(e){flash('network error');}
      refresh();
    }
    function card(s){
      const ratio=s.capacity>0?Math.min(1,s.load/s.capacity):0, pct=Math.round(ratio*100), fresh=(Date.now()-s.lastSeen)<FRESH;
      const cls=!s.enabled?'off':(fresh?'up':'down');
      return \`<div class="card \${s.enabled?'':'dim'}">
        <div class="row1"><span class="dot \${cls}"></span><span class="name">\${esc(s.name)}</span>
          \${s.preferred?'<span class="star">★ preferred</span>':''}
          \${!s.enabled?'<span class="badge">disabled</span>':''}<span class="os">\${esc(s.os)}</span></div>
        <div class="addr">\${s.address?esc(s.address):'<span class=noaddr>no address</span>'}</div>
        <div class="bar"><div class="fill" style="width:\${pct}%"></div></div>
        <div class="row2"><span>\${s.load} / \${s.capacity||'∞'} streams</span><span class="seen">\${ago(s.lastSeen)}</span></div>
        <div class="ctl">
          \${s.enabled?\`<button data-act="disable" data-id="\${esc(s.id)}">Disable</button>\`:\`<button class="pri" data-act="enable" data-id="\${esc(s.id)}">Enable</button>\`}
          \${s.preferred?\`<button data-act="unprefer" data-id="\${esc(s.id)}">Unprefer</button>\`:\`<button data-act="prefer" data-id="\${esc(s.id)}">Prefer</button>\`}
        </div>
      </div>\`;
    }
    // The viewer's Server control: Automatic or one fleet server (the device's
    // pin), plus "Not my Mac" (avoid the server named "Home Mac", by id). Shown
    // only for device ids the relay accepts.
    function routeCtl(w){
      const id=String(w.id??'');
      if(!DEV_RE.test(id))return '';
      const rule=own(DEVICES,id)?DEVICES[id]:null;
      const pin=(rule&&rule.server)||'';
      const avoid=rule&&Array.isArray(rule.avoid)?rule.avoid:[];
      const d=esc(id);
      let opts='<option value=""'+(pin?'':' selected')+'>Automatic</option>', listed=false;
      for(const s of FLEET.slice().sort((a,b)=>String(a.name).localeCompare(String(b.name)))){
        const sel=s.id===pin; if(sel)listed=true;
        opts+='<option value="'+esc(s.id)+'"'+(sel?' selected':'')+'>'+esc(s.name)+(s.enabled?'':' (disabled)')+'</option>';
      }
      if(pin&&!listed)opts+='<option value="'+esc(pin)+'" selected>'+esc(pin)+' (offline)</option>';
      const mac=FLEET.find(s=>/home mac/i.test(String(s.name??'')));
      const box=mac?'<label class="nm"><input type="checkbox" data-act="avoid" data-device="'+d+'" data-server="'+esc(mac.id)+'"'+(avoid.includes(mac.id)?' checked':'')+'>Not my Mac</label>':'';
      const reset=rule?'<button data-act="clear-device" data-device="'+d+'">Reset</button>':'';
      return '<div class="rt"><span class="rl">Server</span><select data-act="assign" data-device="'+d+'" aria-label="Server for '+esc(w.name)+'">'+opts+'</select>'+box+reset+'</div>';
    }
    function watcher(w){
      const where = w.sub ? esc(w.title)+' · '+esc(w.sub) : esc(w.title||'—');
      const badge = w.paused ? '<span class="pz">paused</span>' : '<span class="dot up"></span>';
      const via = w.server ? '<span class="via">via '+esc(w.server)+'</span>' : '';
      return \`<div class="wcard" title="device \${esc(w.id)}"><div class="row1">\${badge}<span class="name">\${esc(w.name)}</span>
        <span class="os">\${esc(w.platform||'')}</span></div>
        <div class="watching">\${where}</div>
        <div class="row2"><span>\${esc(w.kind||'')}\${w.kind&&via?' · ':''}\${via}</span><span class="seen">\${ago(w.lastSeen)}</span></div>
        \${routeCtl(w)}</div>\`;
    }
    async function refresh(){
      const q='?key='+encodeURIComponent(KEY);
      try{const r=await fetch('/servers'+q);const {servers,devices}=await r.json();
        FLEET=Array.isArray(servers)?servers:[]; DEVICES=devices&&typeof devices==='object'?devices:{};
        document.getElementById('count').textContent=FLEET.length;
        const g=document.getElementById('grid');
        g.innerHTML=FLEET.length?FLEET.map(card).join(''):'<div class="empty small">No servers connected. Start one with RELAY_URL set.</div>';
      }catch(e){}
      try{const r=await fetch('/presence'+q);const {active,sessions}=await r.json();
        document.getElementById('acount').textContent=active;
        const w=document.getElementById('watchers'), a=document.activeElement;
        if(a&&a.tagName==='SELECT'&&w.contains(a))return;   // don't yank a dropdown the owner has open
        w.innerHTML=sessions.length?sessions.map(watcher).join(''):'<div class="empty small">Nobody watching right now.</div>';
      }catch(e){}
    }
    document.addEventListener('click',e=>{
      const b=e.target&&e.target.closest&&e.target.closest('button[data-act]');if(!b)return;
      const d=b.dataset;
      action(d.device?{action:d.act,device:d.device}:{action:d.act,id:d.id});
    });
    document.addEventListener('change',e=>{
      const el=e.target&&e.target.closest&&e.target.closest('[data-act][data-device]');if(!el)return;
      const d=el.dataset;
      if(el.type==='checkbox')action({action:el.checked?'avoid':'unavoid',device:d.device,server:d.server});
      else action({action:d.act,device:d.device,server:el.value||null});
      if(el.blur)el.blur();
    });
    refresh();setInterval(refresh,5000);`;
  return page(`<header><div class="logo">SLIME<span>RELAY</span></div>
    <div class="sub"><span id="acount">–</span> watching · <span id="count">–</span> server(s) · admin · refreshes every 5s</div></header>
    <div id="flash" class="flash" role="status" hidden></div>
    <h2 class="sec">Now Watching</h2>
    <div id="watchers" class="grid"><div class="empty small">Loading…</div></div>
    <h2 class="sec">Servers</h2>
    <p class="note">Routing changes apply on each device's next play (route cache ≤ 60 s).</p>
    <div id="grid" class="grid"><div class="empty small">Loading…</div></div><script>${script}</script>`);
}

function page(inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>SlimeRelay</title>
<style>
  :root{--bg:#0a0d0b;--panel:#121613;--line:#1f2723;--txt:#e8f0ea;--dim:#7d8a82;--accent:#37e29a;--red:#f4665f}
  *{box-sizing:border-box} body{margin:0;background:radial-gradient(1200px 600px at 50% -10%,#12211a,var(--bg));color:var(--txt);
    font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;min-height:100vh;padding:28px 20px 60px}
  header{max-width:980px;margin:0 auto 24px;display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap}
  .logo{font-weight:900;letter-spacing:2px;font-size:22px}.logo span{color:var(--accent)}.sub{color:var(--dim);font-size:13px}
  .sec{max-width:980px;margin:26px auto 12px;font-size:13px;letter-spacing:1.5px;text-transform:uppercase;color:var(--dim);font-weight:700}
  .grid{max-width:980px;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
  .wcard{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
  .wcard .watching{margin:8px 0 6px;font-weight:600;color:var(--accent);word-break:break-word}
  .pz{font-size:10px;color:var(--dim);border:1px solid var(--line);border-radius:8px;padding:1px 6px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px}
  .card.dim{opacity:.6}
  .row1{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.name{font-weight:700}
  .star{color:var(--accent);font-size:11px}.badge{color:var(--red);font-size:11px;border:1px solid var(--red);border-radius:8px;padding:1px 6px}
  .os{margin-left:auto;color:var(--dim);font-size:11px;font-family:ui-monospace,Menlo,monospace}
  .addr{margin:10px 0 12px;font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--accent);word-break:break-all}.noaddr{color:var(--dim)}
  .bar{height:6px;background:#0d120f;border-radius:99px;overflow:hidden}.fill{height:100%;background:linear-gradient(90deg,var(--accent),#8be9c0)}
  .row2{display:flex;justify-content:space-between;margin-top:8px;font-size:12px;color:var(--dim)}
  .dot{width:9px;height:9px;border-radius:99px;flex:none}.dot.up{background:var(--accent)}.dot.down{background:var(--red)}.dot.off{background:var(--dim)}
  .ctl{display:flex;gap:8px;margin-top:12px}
  .ctl button{flex:1;background:#0d120f;border:1px solid var(--line);color:var(--txt);border-radius:9px;padding:8px;font-size:13px;cursor:pointer}
  .ctl button:hover{border-color:var(--accent)}.ctl button.pri{background:var(--accent);color:#04170e;border-color:var(--accent);font-weight:700}
  .empty{max-width:980px;margin:60px auto;text-align:center;color:var(--dim)}.empty .logo{font-size:28px;margin-bottom:14px}
  .empty code{display:inline-block;margin-top:10px;background:var(--panel);border:1px solid var(--line);padding:8px 12px;border-radius:8px;color:var(--accent);font-family:ui-monospace,monospace}
  .empty.small{grid-column:1/-1;margin:40px auto}
  .note{max-width:980px;margin:-4px auto 12px;color:var(--dim);font-size:12px}
  .flash{max-width:980px;margin:0 auto 12px;color:var(--red);font-size:13px}
  .via{color:var(--txt)}
  .rt{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px solid var(--line);font-size:12px}
  .rt .rl{color:var(--dim);text-transform:uppercase;letter-spacing:1px;font-size:10px;font-weight:700}
  .rt select{flex:1;min-width:120px;background:#0d120f;border:1px solid var(--line);color:var(--txt);border-radius:9px;padding:6px 8px;font-size:13px}
  .rt select:focus{outline:none;border-color:var(--accent)}
  .nm{display:flex;align-items:center;gap:5px;color:var(--dim);cursor:pointer;white-space:nowrap}
  .nm input{accent-color:var(--accent);margin:0}
  .rt button{background:#0d120f;border:1px solid var(--line);color:var(--dim);border-radius:9px;padding:6px 10px;font-size:12px;cursor:pointer}
  .rt button:hover{border-color:var(--accent);color:var(--txt)}
</style></head><body>${inner}</body></html>`;
}
