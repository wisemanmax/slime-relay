// Watch Party — one Durable Object per room (PartyRoom, named by its 6-char
// code) that orders everyone's play/pause/seek and fans each change out to the
// members' WebSockets. The room's rules are the pure reducer in
// party-reducer.js; this file is only I/O: sockets, storage, alarms, HTTP.
//
// Why a Durable Object: a party needs ONE place that serializes commands (KV
// is eventually consistent, ~60 s across locations). Why the Hibernation API:
// a room is idle most of the time (people are watching), and a hibernating DO
// keeps its sockets open without being billed for wall time. The catch: its
// memory is dropped between events, so everything lives in this.state
// (reloaded from storage by the constructor) and in each socket's attachment —
// never a setTimeout. The alarm drives straggler timeouts, the sweep (host
// migration, dropping gone members) and expiry (24 h, or 2 h idle with nobody
// connected). Storage: SQLite-backed class (wrangler.toml), the only kind the
// Free plan allows.
//
// Socket protocol (GET /party/:code/ws): the first frame must be
//   hello {v:1, device, name, emoji, accentHex, engine, memberId?, secret?}
// (memberId + secret resume a row — the host's come from POST /party) and is
// answered with welcome {you:{id, role, secret}, room}. Then: ping {c} → pong
// {c, s:serverMs} · sync → state · and the room messages in party-reducer.js.
// Close codes: 4000 ended/expired · 4001 full · 4002 bad hello · 4003 kicked.
//
// Also here: handleParty, the Worker-side /party and /p routes, dispatched
// from worker.js with its helpers injected (like assist.js).

import {
  CODE_RE, MEMBER_ID_RE, fresh, genCode, peekView, reduce, safeEqual, stragglerDeadline,
} from './party-reducer.js';

const DAY_MS = 86_400_000;
const IDLE_MS = 2 * 3_600_000;       // no sockets + no activity this long → room deleted
const FIRST_ALARM_MS = 10 * 60_000;
const SWEEP_MS = 60_000;
const CLOSE_ALARM_MS = 35_000;       // after a disconnect: HOST_GRACE_MS (30 s) + slack
const HELLO_MS = 30_000;             // a socket that never says hello is closed by the alarm
const SAVE_EVERY_MS = 30_000;        // telemetry-only changes are persisted at most this often
const MAX_SOCKETS = 24;              // 8 members × a few reconnecting sockets
const MAX_FRAME = 4096;
// Push-to-talk voice clips travel as BINARY frames and are fanned out to the
// other members, never stored: [0x56 'V'][version 1][u16 BE header length]
// [header JSON {t:'voice', secs, mime}][audio bytes]. The room stamps the
// header with from/name/at. A 15 s AAC clip at 24 kbps is ~45 KB.
const VOICE_MAGIC = 0x56, VOICE_VERSION = 1, VOICE_MAX_BYTES = 300_000, VOICE_MAX_SECS = 16;
const CLIENT_TYPES = new Set(['play', 'pause', 'seek', 'rate', 'setItem', 'queue', 'report', 'ready',
  'chat', 'react', 'typing', 'settings', 'transferHost', 'kick', 'end', 'leave']);
// Per-socket budgets: [messages, window ms]. Best effort (kept in the attachment).
const BUDGETS = { cmd: [30, 10_000], social: [10, 10_000], report: [1, 2_000], other: [30, 10_000], voice: [6, 20_000] };
const BUDGET_OF = { play: 'cmd', pause: 'cmd', seek: 'cmd', rate: 'cmd', setItem: 'cmd', queue: 'cmd',
  chat: 'social', react: 'social', report: 'report', voice: 'voice' };

export class PartyRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.state = null;
    this.savedAt = 0;
    this.ready = ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get('state')) ?? null;
    });
  }

  // ── HTTP (from the Worker) ──

  async fetch(req) {
    await this.ready;
    const now = Date.now();
    const path = new URL(req.url).pathname;
    if ((req.headers.get('upgrade') || '').toLowerCase() === 'websocket') return this.upgrade(now);
    if (path === '/init' && req.method === 'POST') return this.init(req, now);
    if (path === '/peek') return this.live(now) ? reply(peekView(this.state)) : reply({ error: 'not found' }, 404);
    if (path === '/info') {
      if (!this.live(now)) return reply({ error: 'not found' }, 404);
      const s = this.state;
      return reply({ ...peekView(s), seq: s.seq, lastActivity: s.lastActivity, sockets: this.sockets().length });
    }
    if (path === '/end' && req.method === 'POST') return this.endByHost(req, now);
    return reply({ error: 'not found' }, 404);
  }

  async init(req, now) {
    if (this.live(now)) return reply({ error: 'exists' }, 409);
    let body;
    try { body = await req.json(); } catch { return reply({ error: 'bad json' }, 400); }
    if (typeof body?.code !== 'string' || !CODE_RE.test(body.code)) return reply({ error: 'bad code' }, 400);
    const src = body.host && typeof body.host === 'object' ? body.host : {};
    const id = typeof src.id === 'string' && MEMBER_ID_RE.test(src.id) ? src.id : newMemberId();
    const secret = randomHex(16);
    // Sockets left from a dead room under this code must not hear the new one.
    for (const ws of this.sockets()) close(ws, 4000, 'expired');
    this.state = fresh({ code: body.code, now, host: { ...src, id, secret } });
    await this.save(true);
    await this.ctx.storage.setAlarm(now + FIRST_ALARM_MS);
    return reply({ code: body.code, hostSecret: secret, memberId: id, expiresAt: now + DAY_MS });
  }

  async endByHost(req, now) {
    if (!this.live(now)) return reply({ error: 'not found' }, 404);
    let body = null;
    try { body = await req.json(); } catch {}
    const s = this.state;
    const host = Object.hasOwn(s.members, s.hostId ?? '') ? s.members[s.hostId] : null;
    if (!host || !safeEqual(body?.secret, host.secret)) return reply({ error: 'forbidden' }, 403);
    await this.apply({ t: 'end' }, host.id, null, now);
    return reply({ ok: true });
  }

  upgrade(now) {
    if (!this.live(now)) return reply({ error: 'not found' }, 404);
    if (this.sockets().length >= MAX_SOCKETS) return reply({ error: 'full' }, 429);
    const [client, server] = Object.values(new WebSocketPair());
    this.accept(server, now);
    return new Response(null, { status: 101, webSocket: client });
  }

  accept(ws, now = Date.now()) {
    this.ctx.acceptWebSocket(ws);
    ws.serializeAttachment({ memberId: null, hello: false, budget: {}, sid: randomHex(6), at: now });
  }

  // ── WebSocket events (Hibernation API) ──

  async webSocketMessage(ws, raw) {
    await this.ready;
    const now = Date.now();
    if (!this.live(now)) {
      send(ws, { t: 'closed', reason: 'ended' });
      return close(ws, 4000, 'ended');
    }
    if (typeof raw !== 'string') return this.voice(ws, raw, now);
    let msg = null;
    if (raw.length <= MAX_FRAME) { try { msg = JSON.parse(raw); } catch {} }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return send(ws, { t: 'error', code: 'bad_msg' });
    const att = attachment(ws);
    if (!att.hello) {
      return msg.t === 'hello' ? this.hello(ws, att, msg, now) : send(ws, { t: 'error', code: 'hello_required' });
    }
    if (msg.t === 'ping') {
      const c = typeof msg.c === 'number' || (typeof msg.c === 'string' && msg.c.length <= 64) ? msg.c : null;
      return send(ws, { t: 'pong', c, s: Date.now() });
    }
    if (msg.t === 'sync') return send(ws, { t: 'state', seq: this.state.seq, playback: this.state.playback });
    if (!CLIENT_TYPES.has(msg.t)) return send(ws, { t: 'error', code: 'bad_msg', re: msg.t });
    if (!this.spend(ws, att, msg, now)) return;
    await this.apply(msg, att.memberId, ws, now);
  }

  // A binary voice clip from a joined member: validate, stamp, fan out to the
  // others. Nothing is stored; a member who missed it missed it.
  async voice(ws, raw, now) {
    const att = attachment(ws);
    if (!att.hello) return send(ws, { t: 'error', code: 'hello_required' });
    const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw.buffer ?? raw);
    const parsed = parseVoice(bytes);
    if (!parsed) return send(ws, { t: 'error', code: 'bad_msg', re: 'voice' });
    if (!this.spend(ws, att, { t: 'voice' }, now)) return;
    const m = this.state.members[att.memberId];
    const header = { t: 'voice', secs: parsed.header.secs, mime: parsed.header.mime,
                     from: att.memberId, name: m?.name ?? '?', at: now };
    const out = buildVoice(header, parsed.audio);
    const originSid = att.sid;
    for (const other of this.sockets()) {
      const oa = attachment(other);
      if (!oa.hello || oa.sid === originSid) continue;
      try { other.send(out); } catch {}
    }
    this.state.lastActivity = now;
  }

  async hello(ws, att, msg, now) {
    const resume = typeof msg.memberId === 'string' && MEMBER_ID_RE.test(msg.memberId) &&
      typeof msg.secret === 'string' && msg.secret.length > 0;
    const id = resume ? msg.memberId : newMemberId();
    const member = { id, device: msg.device, name: msg.name, emoji: msg.emoji, accentHex: msg.accentHex,
                     engine: msg.engine, ...(resume ? { secret: msg.secret } : {}) };
    const { state, effects } = reduce(this.state, { t: 'member:hello', member, newSecret: randomHex(16) }, { now, from: id });
    if (effects.some((e) => e.msg?.t === 'welcome')) {
      att.memberId = id;
      att.hello = true;
      ws.serializeAttachment(att);
      this.state = state;
      await this.save(true);
    }
    // Everything addressed to `id` goes to THIS socket only: a hello with a
    // stolen id and a wrong secret must not error/close the real member.
    await this.dispatch(effects, ws, id);
  }

  async webSocketClose(ws, code) {
    await this.ready;
    close(ws, code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000, 'bye');   // finish the close handshake
    await this.gone(ws);
  }

  async webSocketError(ws) {
    await this.ready;
    await this.gone(ws);
  }

  // A socket ended. The member only counts as disconnected once its LAST
  // socket is gone (a reconnect often opens the new socket before the old one dies).
  async gone(ws) {
    const att = attachment(ws);
    if (!att.hello || !att.memberId || !this.state) return;
    const still = this.sockets().some((o) => {
      const a = attachment(o);
      return a.sid !== att.sid && a.hello && a.memberId === att.memberId;
    });
    if (still) return;
    const now = Date.now();
    await this.apply({ t: 'member:disconnected', id: att.memberId }, att.memberId, ws, now);
    await this.wakeBy(now + CLOSE_ALARM_MS);
  }

  async alarm() {
    await this.ready;
    const s0 = this.state;
    if (!s0) return;
    const now = Date.now();
    for (const ws of this.sockets()) {
      const a = attachment(ws);
      if (!a.hello && now - (a.at || 0) > HELLO_MS) close(ws, 4002, 'no hello');
    }
    const due = stragglerDeadline(s0);
    if (due !== null && now >= due) await this.apply({ t: 'alarm:straggler' }, null, null, now);
    if (this.state) await this.apply({ t: 'sweep' }, null, null, now);
    const s = this.state;
    if (!s) return;
    const idle = this.sockets().length === 0 && now - s.lastActivity > IDLE_MS;
    if (s.ended || idle || now - s.createdAt > DAY_MS) {
      for (const ws of this.sockets()) {
        send(ws, { t: 'closed', reason: s.ended ? 'ended' : 'expired' });
        close(ws, 4000, s.ended ? 'ended' : 'expired');
      }
      return this.destroy();
    }
    const next = stragglerDeadline(s);
    await this.ctx.storage.setAlarm(next !== null && next > now ? Math.min(now + SWEEP_MS, next) : now + SWEEP_MS);
  }

  // ── Internals ──

  sockets() { return this.ctx.getWebSockets(); }

  live(now) {
    const s = this.state;
    if (!s || s.ended || now - s.createdAt > DAY_MS) return false;
    return !(now - s.lastActivity > IDLE_MS && this.sockets().length === 0);
  }

  // Run one message through the reducer, persist, then deliver its effects.
  async apply(msg, from, origin, now) {
    const prev = this.state;
    const { state, effects } = reduce(prev, msg, { now, from });
    this.state = state;
    await this.save(state.seq !== prev.seq || !!state.ended);
    await this.dispatch(effects, origin);
    if (state.ended) await this.destroy();
  }

  // Anything that bumps seq is written at once. Telemetry (reports, lastSeen)
  // is written at most every SAVE_EVERY_MS — losing a few seconds of it to a
  // hibernation reload costs nothing, and per-report writes would eat the
  // Free plan's daily row-write quota.
  async save(force) {
    const now = Date.now();
    if (!force && now - this.savedAt < SAVE_EVERY_MS) return;
    this.savedAt = now;
    await this.ctx.storage.put('state', this.state);
  }

  async destroy() {
    const code = this.state?.code;
    this.state = null;
    await this.ctx.storage.deleteAlarm();   // deleteAll() leaves alarms alone
    await this.ctx.storage.deleteAll();
    if (code && this.env?.SERVERS) { try { await this.env.SERVERS.delete(`party:${code}`); } catch {} }
  }

  async wakeBy(t) {
    const cur = await this.ctx.storage.getAlarm();
    if (cur == null || t < cur) await this.ctx.storage.setAlarm(t);
  }

  // Carry out reducer effects. `helloId`: effects addressed to that id go to
  // `origin` alone (see hello()).
  async dispatch(effects, origin, helloId = null) {
    const socks = this.sockets().map((ws) => ({ ws, att: attachment(ws) }));
    const originSid = origin ? attachment(origin).sid : undefined;
    const pick = (to) => {
      if (helloId !== null && to === helloId) return [origin];
      if (to === '*') return socks.map((x) => x.ws);
      const joined = socks.filter((x) => x.att.hello);
      if (to === 'all') return joined.map((x) => x.ws);
      if (to === 'others') return joined.filter((x) => x.att.sid !== originSid).map((x) => x.ws);
      return joined.filter((x) => x.att.memberId === to).map((x) => x.ws);
    };
    for (const e of effects) {
      if (e.alarm != null) await this.wakeBy(e.alarm);
      else if (e.close != null) for (const ws of pick(e.close)) close(ws, e.code ?? 1000, e.reason ?? '');
      else if (e.msg) {
        const data = JSON.stringify(e.msg);
        for (const ws of pick(e.to)) send(ws, data);
      }
    }
  }

  // Per-socket message budgets. Over budget: commands and chat get an error
  // (commands also the current state, to undo an optimistic UI); a surplus
  // report is dropped quietly UNLESS it flips playing/buffering — the
  // straggler wait depends on seeing that edge.
  spend(ws, att, msg, now) {
    const cls = BUDGET_OF[msg.t] || 'other';
    const [limit, win] = BUDGETS[cls];
    att.budget ||= {};
    const prev = att.budget[cls];
    const b = prev && now - prev.w < win ? prev : { w: now, n: 0 };
    if (b.n >= limit) {
      if (cls === 'report') return flagsChanged(this.state.members[att.memberId], msg);
      send(ws, { t: 'error', code: 'rate_limited', re: msg.t });
      if (cls === 'cmd') send(ws, { t: 'state', seq: this.state.seq, playback: this.state.playback });
      return false;
    }
    b.n += 1;
    att.budget[cls] = b;
    ws.serializeAttachment(att);
    return true;
  }
}

// Voice frame codec (see VOICE_MAGIC). Returns null for anything malformed.
export function parseVoice(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4 || bytes.length > VOICE_MAX_BYTES) return null;
  if (bytes[0] !== VOICE_MAGIC || bytes[1] !== VOICE_VERSION) return null;
  const hlen = (bytes[2] << 8) | bytes[3];
  if (hlen < 2 || 4 + hlen > bytes.length) return null;
  let header;
  try { header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + hlen))); } catch { return null; }
  if (!header || header.t !== 'voice') return null;
  const secs = Number(header.secs);
  if (!(secs > 0 && secs <= VOICE_MAX_SECS)) return null;
  const mime = typeof header.mime === 'string' && header.mime.length <= 32 ? header.mime : 'audio/aac';
  const audio = bytes.subarray(4 + hlen);
  if (audio.length === 0) return null;
  const stamped = {};
  if (typeof header.from === 'string' && header.from.length <= 40) stamped.from = header.from;
  if (typeof header.name === 'string' && header.name.length <= 24) stamped.name = header.name;
  if (typeof header.at === 'number') stamped.at = header.at;
  return { header: { secs: Math.round(secs * 10) / 10, mime, ...stamped }, audio };
}
export function buildVoice(header, audio) {
  const h = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + h.length + audio.length);
  out[0] = VOICE_MAGIC; out[1] = VOICE_VERSION; out[2] = (h.length >> 8) & 0xff; out[3] = h.length & 0xff;
  out.set(h, 4); out.set(audio, 4 + h.length);
  return out;
}

function flagsChanged(m, msg) {
  if (!m) return false;
  return (typeof msg.buffering === 'boolean' && msg.buffering !== m.buffering) ||
         (typeof msg.playing === 'boolean' && msg.playing !== m.playing);
}

function attachment(ws) {
  try { return ws.deserializeAttachment() || {}; } catch { return {}; }
}
function send(ws, data) {
  try { ws.send(typeof data === 'string' ? data : JSON.stringify(data)); } catch {}
}
function close(ws, code, reason) {
  try { ws.close(code, reason); } catch {}
}
function reply(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}
function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}
const newMemberId = () => `m_${randomHex(6)}`;
const cryptoRandom = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;

// ── Worker-side routes ──
//   POST   /party          create (user) { device, name, emoji, accentHex }
//                          -> { code, hostSecret, memberId, expiresAt, joinUrl }
//   GET    /party/:code    peek (user)
//   GET    /party/:code/ws the room's WebSocket (user) — forwarded untouched
//   DELETE /party/:code    end (user + host secret: body { secret } or ?secret=)
//   GET    /party/rooms    every registered room + its /info (admin)
//   GET    /p/:code        public join page (no auth)
// The KV registry party:<code> (24 h TTL) exists only so /party/rooms can list
// rooms: Durable Objects can't be enumerated.

const REG_TTL = 86_400;
const stubFor = (env, code) => env.PARTY.get(env.PARTY.idFromName(code));

export async function handleParty(request, env, { isUser, isAdmin, clientIP, json, rateLimited, htmlResponse }) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  const page = path.match(/^\/p\/([^/]+)\/?$/);
  if (page) {
    if (method !== 'GET') return json({ error: 'method not allowed' }, 405);
    if (await rateLimited(env, `party-page:${clientIP}`, 60)) return json({ error: 'rate limited' }, 429);
    const code = page[1].toUpperCase();
    if (!CODE_RE.test(code)) return htmlResponse(joinPage(null, null, false), 404);
    let peek = null, gone = false;
    if (env.PARTY) {
      try {
        const r = await stubFor(env, code).fetch('https://party/peek');
        if (r.ok) peek = await r.json(); else gone = r.status === 404;
      } catch {}
    }
    return htmlResponse(joinPage(code, peek, gone));
  }

  if (!env.PARTY) return json({ error: 'party not configured' }, 503);

  if (path === '/party/rooms') {
    if (!isAdmin) return json({ error: 'unauthorized' }, 401);
    const list = await env.SERVERS.list({ prefix: 'party:' });
    const rooms = [];
    for (const k of list.keys) {
      const code = k.name.slice('party:'.length);
      if (!CODE_RE.test(code)) continue;
      let reg = null, info = null;
      try { reg = JSON.parse((await env.SERVERS.get(k.name)) || 'null'); } catch {}
      try { const r = await stubFor(env, code).fetch('https://party/info'); if (r.ok) info = await r.json(); } catch {}
      rooms.push({ code, createdAt: reg?.createdAt ?? null, host: reg?.host ?? null, live: !!info, info });
    }
    return json({ rooms });
  }

  if (path === '/party') {
    if (method !== 'POST') return json({ error: 'method not allowed' }, 405);
    if (!isUser) return json({ error: 'unauthorized' }, 401);
    if (await rateLimited(env, `party-create:${clientIP}`, 10)) return json({ error: 'rate limited' }, 429);
    let body = {};
    try { const t = await request.text(); body = t ? JSON.parse(t) : {}; } catch { return json({ error: 'bad json' }, 400); }
    if (!body || typeof body !== 'object') return json({ error: 'bad json' }, 400);
    // Raw fields: the reducer sanitizes them (it is the one authority on member rows).
    const host = { id: newMemberId(), device: body.device, name: body.name, emoji: body.emoji, accentHex: body.accentHex };
    for (let attempt = 0; attempt < 4; attempt++) {   // a fresh code, then up to 3 retries on a collision
      const code = genCode(cryptoRandom);
      const r = await stubFor(env, code).fetch('https://party/init', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, host }),
      });
      if (r.status === 409) continue;
      const out = await r.json().catch(() => ({ error: 'create failed' }));
      if (!r.ok) return json(out, r.status);
      try {
        await env.SERVERS.put(`party:${code}`,
          JSON.stringify({ createdAt: Date.now(), host: String(body.name ?? '').slice(0, 24) }), { expirationTtl: REG_TTL });
      } catch {}
      return json({ ...out, joinUrl: `${url.origin}/p/${code}` });
    }
    return json({ error: 'no free code, try again' }, 503);
  }

  const room = path.match(/^\/party\/([^/]+)(\/ws)?$/);
  if (!room) return json({ error: 'not found' }, 404);
  if (!isUser) return json({ error: 'unauthorized' }, 401);
  const code = room[1].toUpperCase();

  if (room[2]) {   // /party/:code/ws
    if (method !== 'GET') return json({ error: 'method not allowed' }, 405);
    if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') return json({ error: 'expected websocket' }, 426);
    if (await rateLimited(env, `party-ws:${clientIP}`, 30)) return json({ error: 'rate limited' }, 429);
    if (!CODE_RE.test(code)) return json({ error: 'bad code' }, 400);
    return stubFor(env, code).fetch(request);   // the DO answers the upgrade
  }

  if (method !== 'GET' && method !== 'DELETE') return json({ error: 'method not allowed' }, 405);
  if (await rateLimited(env, `party-peek:${clientIP}`, 60)) return json({ error: 'rate limited' }, 429);
  if (!CODE_RE.test(code)) return json({ error: 'bad code' }, 400);
  if (method === 'GET') return stubFor(env, code).fetch('https://party/peek');

  let secret = url.searchParams.get('secret') || '';
  if (!secret) { try { secret = String((await request.json())?.secret ?? ''); } catch {} }
  const r = await stubFor(env, code).fetch('https://party/end', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret }),
  });
  if (r.ok) { try { await env.SERVERS.delete(`party:${code}`); } catch {} }
  return r;
}

function esc(x) {
  return String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// The link a host shares. Opens the app on the code; everything shown from the
// room (host name, title) is escaped — both come from the public app token.
function joinPage(code, peek, gone) {
  const it = peek?.item;
  const what = it?.title
    ? esc(it.title) + (Number.isInteger(it.season) && Number.isInteger(it.episode) ? ` · S${it.season} E${it.episode}` : '')
    : '';
  let line = '';
  if (!code) line = 'That doesn’t look like a party code.';
  else if (peek?.hostName) line = `${esc(peek.hostName)} is hosting${what ? ` <b>${what}</b>` : ''}.`;
  else if (what) line = `Now showing <b>${what}</b>.`;
  else if (gone) line = 'This party may have ended. Ask the host for a fresh code.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<meta name="color-scheme" content="dark"><title>Watch Party · SlimeWatch</title>
<style>
  :root{--bg:#0a0d0b;--panel:#121613;--line:#1f2723;--txt:#e8f0ea;--dim:#7d8a82;--accent:#37e29a}
  *{box-sizing:border-box} body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:radial-gradient(900px 500px at 50% -10%,#12211a,var(--bg));background-color:var(--bg);color:var(--txt);
    font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:32px 16px}
  main{width:100%;max-width:420px;text-align:center}
  .brand{font-weight:900;letter-spacing:2px;font-size:13px;color:var(--dim)}.brand span{color:var(--accent)}
  h1{font-size:24px;line-height:1.25;margin:14px 0 8px}
  .line{color:var(--dim);margin:0 0 22px;word-break:break-word}.line b{color:var(--txt)}
  .code{font:800 clamp(40px,14vw,64px)/1 ui-monospace,Menlo,monospace;letter-spacing:.16em;padding:22px 8px 22px calc(8px + .16em);
    background:var(--panel);border:1px solid var(--line);border-radius:18px;margin:0 0 22px;color:var(--accent)}
  .btn{display:block;background:var(--accent);color:#04170e;font-weight:800;text-decoration:none;border-radius:14px;padding:16px;font-size:17px}
  .note{color:var(--dim);font-size:13px;margin-top:22px}
</style></head><body><main>
<div class="brand">SLIME<span>WATCH</span></div>
<h1>Join the Watch Party in SlimeWatch</h1>
${line ? `<p class="line">${line}</p>` : ''}
${code ? `<div class="code" aria-label="Party code">${code}</div>
<a class="btn" href="slimewatch://party?code=${code}">Open in SlimeWatch</a>` : ''}
<p class="note">Don't have SlimeWatch yet? Ask the host for a TestFlight invite.</p>
</main></body></html>`;
}
