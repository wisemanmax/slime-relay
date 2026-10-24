/* Wave 7 (P5, roadmap 7.4) — the web's room socket: connect through this
   Worker's /api/party/<code>/ws (the Worker adds the relay token, so it never
   reaches the page), hello, ping/pong clock offset, reconnect with backoff,
   and the room mirror. The same protocol the apps speak (PartySession.swift,
   contracts.md §1 + §6): the browser is an ordinary member — platform "web",
   no emoji (its avatar is the colour + initial), never asks to be a companion,
   never sends settings / transferHost / kick / end / role / avatar, never a
   binary frame. Incoming voice clips become a chat line; nothing is played.

   DOM-free: the socket constructor, storage, timers and clock are arguments,
   so test/party.mjs drives it against a fake WebSocket.

     createPartyClient({ code, url, WebSocket, local, seats, identity, engine, app,
                         now, timers, random, onChange, onEvent }) -> client
       local   a store ({getState,setState}) with key `device` (localStorage)
       seats   a store with key `seat` (sessionStorage): {code, memberId, secret}
       onEvent(type, detail): 'welcome' {reconnected} · 'state' {pb, prev, mine} ·
               'item' {item, by, mine} · 'react' {emoji, name, from} ·
               'snapback' {toast} · 'notice' {text} · 'closed' {reason, text} · 'phase' {phase}

   Phases: idle -> connecting -> joined <-> reconnecting -> failed | left. */

import {
  canControl, memberOf, expectedTime, createClock, acceptsSeq, controlChangedToast, closedText,
  chatText, avatarSrc, acceptsAvatar, voiceHeader, voiceText, backoffMs, newDeviceId, DEVICE_RE,
  itemLabel, sameEpisode, clockLabel, REFUSED_TOAST, PING_MS, WELCOME_MS, GIVE_UP_MS,
} from './rules.js';

const CMDS = new Set(['play', 'pause', 'seek', 'rate', 'setItem', 'queue']);
const MAX_LINES = 200;

export function createPartyClient(o) {
  const code = o.code;
  const WS = o.WebSocket || globalThis.WebSocket;
  const now = o.now || (() => Date.now());
  const T = o.timers || globalThis;
  const random = o.random || Math.random;
  const onChange = o.onChange || (() => {});
  const onEvent = o.onEvent || (() => {});
  const clock = createClock();

  const state = {
    code, phase: 'idle', myId: null, room: null, lastSeq: 0,
    chat: [], typing: [], avatars: {}, itemSetByMe: false, failure: '',
  };
  let sock = null, connId = 0, welcomed = false, resumed = false, retriedFresh = false, pendingFresh = false;
  let confirmed = null, confirmedItem = null;   // the relay's last word: a refusal snaps back to these
  let pingTimer = null, welcomeTimer = null, retryTimer = null, outstanding = 0;
  let firstDropAt = null, attempts = 0, lineId = 0, lastToastPb = null;
  const typingTimers = new Map();

  const changed = () => { try { onChange(state); } catch (e) { console.error('party view failed', e); } };
  const emit = (type, detail = {}) => { try { onEvent(type, detail); } catch (e) { console.error('party event failed', e); } };
  const setPhase = (p) => { if (state.phase !== p) { state.phase = p; emit('phase', { phase: p }); } };

  // ── Identity: the device id (kept) and this tab's seat (resumable) ──
  function deviceId() {
    let d = o.local && o.local.getState().device;
    if (typeof d !== 'string' || !DEVICE_RE.test(d)) { d = newDeviceId(random); if (o.local) o.local.setState({ device: d }); }
    return d;
  }
  function seat() {
    const s = o.seats && o.seats.getState().seat;
    return s && s.code === code && typeof s.memberId === 'string' && typeof s.secret === 'string' ? s : null;
  }
  const saveSeat = (memberId, secret) => { if (o.seats) o.seats.setState({ seat: { code, memberId, secret } }); };
  const dropSeat = () => { if (o.seats && seat()) o.seats.setState({ seat: null }); };

  // ── Socket ──
  function raw(msg) {
    if (!sock || sock.readyState !== 1) return false;
    try { sock.send(JSON.stringify(msg)); return true; } catch { return false; }
  }
  /** A room frame: only once welcomed (the relay wants hello first). */
  function send(msg) { return state.phase === 'joined' && welcomed ? raw(msg) : false; }

  function connect() {
    clearTimers();
    const mine = ++connId;
    welcomed = false; outstanding = 0;
    if (state.phase !== 'reconnecting') setPhase('connecting');
    let ws;
    try { ws = new WS(o.url); } catch { return drop(); }
    sock = ws;
    try { ws.binaryType = 'arraybuffer'; } catch {}
    ws.onopen = () => {
      if (mine !== connId) return;
      const id = o.identity ? o.identity() : {};
      const s = seat();
      resumed = !!s;
      const hello = { t: 'hello', v: 1, device: deviceId(), name: String(id.name || 'Guest').slice(0, 24), emoji: '',
                      accentHex: String(id.accentHex || '').replace(/^#/, ''), engine: o.engine ? o.engine() : 'none',
                      platform: 'web', app: o.app || 'web' };
      if (s) { hello.memberId = s.memberId; hello.secret = s.secret; }
      raw(hello);
      raw({ t: 'ping', c: now() });
    };
    ws.onmessage = (ev) => { if (mine === connId) receive(ev.data); };
    ws.onclose = (ev) => { if (mine === connId) closedSocket(ev && ev.code); };
    ws.onerror = () => {};   // onclose follows
    welcomeTimer = T.setTimeout(() => { if (mine === connId && !welcomed) { kill(); drop(); } }, WELCOME_MS);
  }

  function kill(codeNum = 1000, reason = '') {
    const s = sock; sock = null; connId++;
    if (s) { s.onopen = s.onmessage = s.onclose = s.onerror = null; try { s.close(codeNum, reason); } catch {} }
  }
  function clearTimers() {
    T.clearInterval(pingTimer); pingTimer = null;
    T.clearTimeout(welcomeTimer); welcomeTimer = null;
    T.clearTimeout(retryTimer); retryTimer = null;
  }

  // The relay's close codes: 4000 ended/expired · 4001 full · 4002 bad hello · 4003 kicked.
  function closedSocket(codeNum) {
    if (codeNum >= 4000 && codeNum <= 4003 && !(codeNum === 4002 && pendingFresh)) {
      return endLocally({ 4000: 'ended', 4001: 'full', 4002: 'bad_hello', 4003: 'kicked' }[codeNum]);
    }
    sock = null;
    drop();
  }

  /** The socket is gone (closed, never welcomed, silent): retry with backoff,
      for at most a minute from the first drop. */
  function drop() {
    if (!['connecting', 'joined', 'reconnecting'].includes(state.phase)) return;
    clearTimers();
    welcomed = false;
    if (firstDropAt == null) firstDropAt = now();
    if (now() - firstDropAt >= GIVE_UP_MS) {
      state.failure = 'Lost the party connection.';
      setPhase('failed'); changed();
      return;
    }
    setPhase('reconnecting'); changed();
    retryTimer = T.setTimeout(connect, backoffMs(attempts++, random()));
    // A room that ended while we were away answers the upgrade with 404, which
    // a WebSocket only ever reports as a failed connect: ask the peek, once.
    if (attempts === 2 && o.peek) {
      Promise.resolve().then(() => o.peek()).then((status) => {
        if (status === 404 && state.phase === 'reconnecting') endLocally('expired', 'The party has ended.');
      }, () => {});
    }
  }

  function reconnectNow() {
    kill();
    clearTimers();
    firstDropAt = now(); attempts = 0;
    setPhase('reconnecting');
    connect();
  }

  function startPings() {
    T.clearInterval(pingTimer);
    pingTimer = T.setInterval(() => {
      if (outstanding >= 2) { kill(); drop(); return; }   // two silent pings: the socket is gone
      outstanding++;
      raw({ t: 'ping', c: now() });
    }, PING_MS);
  }

  function endLocally(reason, text) {
    clearTimers();
    kill(1000, 'left');
    for (const t of typingTimers.values()) T.clearTimeout(t);
    typingTimers.clear(); state.typing = [];
    dropSeat();
    state.failure = text || closedText(reason === 'bad_hello' ? '' : reason);
    if (reason === 'bad_hello' && !text) state.failure = 'Couldn\'t join the party.';
    setPhase('left');
    emit('closed', { reason, text: state.failure });
    changed();
  }

  // ── Receive ──
  function receive(data) {
    if (typeof data !== 'string') return voice(data);
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    const before = state.lastSeq;
    if (!acceptsSeq(m.t, m.seq, before)) return;   // older than what we already applied
    const h = HANDLERS[m.t];
    if (h) { h(m); changed(); }
  }

  function voice(data) {
    const take = (buf) => {
      const h = voiceHeader(new Uint8Array(buf));
      if (!h) return;
      const mineClip = h.from && h.from === state.myId;
      line('voice', h.from, mineClip ? 'You' : (h.name || nameOf(h.from)), voiceText(h), h.at || now());
      changed();
    };
    if (data instanceof ArrayBuffer) take(data);
    else if (ArrayBuffer.isView(data)) take(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    else if (data && typeof data.arrayBuffer === 'function') data.arrayBuffer().then(take, () => {});
  }

  function line(kind, from, name, text, at) {
    state.chat.push({ id: ++lineId, kind, from: from || null, name: name || '', text, at: at || now() });
    if (state.chat.length > MAX_LINES) state.chat.splice(0, state.chat.length - MAX_LINES);
  }
  const system = (text) => line('system', null, '', text, now());
  function nameOf(id) {
    if (id && id === state.myId) return 'You';
    const m = memberOf(state.room, id);
    return m ? m.name : 'Someone';
  }

  const HANDLERS = {
    welcome(m) {
      const room = m.room || {};
      const reconnected = state.phase === 'reconnecting' && !!state.room;
      state.myId = m.you && m.you.id;
      if (m.you && typeof m.you.secret === 'string' && m.you.secret) saveSeat(state.myId, m.you.secret);
      state.lastSeq = Number.isFinite(m.seq) ? m.seq : 0;
      state.room = { code: room.code || code, hostId: room.hostId || null, settings: room.settings || {},
                     item: room.item || null, playback: room.playback || null,
                     queue: Array.isArray(room.queue) ? room.queue : [], members: Array.isArray(room.members) ? room.members : [] };
      confirmed = state.room.playback; confirmedItem = state.room.item;
      const pb = state.room.playback;
      state.itemSetByMe = !!pb && pb.by === state.myId && pb.reason === 'item';
      lastToastPb = pb;
      if (Number.isFinite(m.serverTime)) clock.add(now() - 50, m.serverTime, now());
      welcomed = true; retriedFresh = false; pendingFresh = false;
      T.clearTimeout(welcomeTimer); welcomeTimer = null;
      firstDropAt = null; attempts = 0; state.failure = '';
      setPhase('joined');
      startPings();
      if (reconnected) raw({ t: 'sync' });   // contracts §6: sync after a reconnect
      emit('welcome', { reconnected });
    },
    state(m) {
      const prev = state.room && state.room.playback;
      state.lastSeq = m.seq;
      if (!state.room || !m.playback) return;
      state.room.playback = confirmed = m.playback;
      const mine = m.playback.by != null && m.playback.by === state.myId;
      noteRemote(m.playback, prev, mine);
      emit('state', { pb: m.playback, prev, mine });
    },
    item(m) {
      state.lastSeq = m.seq;
      if (!state.room) return;
      state.room.item = confirmedItem = m.item || null;
      if (Array.isArray(m.queue)) state.room.queue = m.queue;
      const mine = m.by != null && m.by === state.myId;
      state.itemSetByMe = mine;
      if (!mine && m.item) system(`${nameOf(m.by)} picked ${itemLabel(m.item)}`);
      emit('item', { item: m.item || null, by: m.by || null, mine });
    },
    queue(m) { state.lastSeq = m.seq; if (state.room && Array.isArray(m.queue)) state.room.queue = m.queue; },
    roster(m) {
      if (Number.isFinite(m.seq)) state.lastSeq = Math.max(state.lastSeq, m.seq);
      if (!state.room || !Array.isArray(m.members)) return;
      const old = state.room.members, oldIds = new Set(old.map((x) => x.id)), newIds = new Set(m.members.map((x) => x.id));
      for (const x of m.members) if (!oldIds.has(x.id) && x.id !== state.myId) system(`${x.name} joined`);
      for (const x of old) if (!newIds.has(x.id) && x.id !== state.myId) { system(`${x.name} left`); delete state.avatars[x.id]; }
      state.room.members = m.members;
    },
    member(m) {
      const x = memberOf(state.room, m.id);
      if (!x) return;
      for (const k of ['engine', 'synced', 'pos', 'dur', 'playing', 'buffering', 'connected', 'reportedAt', 'name', 'avatarRev', 'platform', 'role']) {
        if (m[k] !== undefined) x[k] = m[k];
      }
    },
    host(m) {
      if (Number.isFinite(m.seq)) state.lastSeq = Math.max(state.lastSeq, m.seq);
      if (!state.room) return;
      state.room.hostId = m.hostId || null;
      // A companion keeps its role (contracts §1); every other non-host is a member.
      for (const x of state.room.members) x.role = x.id === m.hostId ? 'host' : x.role === 'companion' ? 'companion' : 'member';
      // No host (null): it left while only companions and browsers were here — the
      // relay never hands a browser the room. Shared rooms keep working; a
      // host-only room waits for an app member (or a companion's Watch along).
      if (m.reason === 'migrated') emit('notice', { text: m.hostId ? `${nameOf(m.hostId)} is the host now` : 'The host left — the party has no host right now' });
    },
    settings(m) {
      if (Number.isFinite(m.seq)) state.lastSeq = Math.max(state.lastSeq, m.seq);
      if (!state.room || !m.settings) return;
      const note = controlChangedToast(state.room.settings, m.settings);
      state.room.settings = m.settings;
      if (note) { system(note); emit('notice', { text: note }); }
    },
    chat(m) {
      const text = chatText(m.text);
      if (!text) return;
      line('message', m.from, m.from === state.myId ? 'You' : String(m.name || nameOf(m.from)), text, Number.isFinite(m.at) ? m.at : now());
    },
    react(m) { if (typeof m.emoji === 'string' && m.emoji) emit('react', { emoji: m.emoji, name: m.from === state.myId ? 'You' : m.name, from: m.from }); },
    typing(m) {
      if (!m.from || m.from === state.myId) return;
      const n = String(m.name || nameOf(m.from));
      T.clearTimeout(typingTimers.get(n));
      typingTimers.delete(n);
      state.typing = state.typing.filter((x) => x !== n);
      if (m.on) {
        state.typing.push(n);
        // A lost "off" must not leave someone typing forever.
        typingTimers.set(n, T.setTimeout(() => { typingTimers.delete(n); state.typing = state.typing.filter((x) => x !== n); changed(); }, 6000));
      }
    },
    avatar(m) {
      const src = avatarSrc(m.jpeg);
      if (!src || typeof m.id !== 'string') return;
      const cur = state.avatars[m.id];
      if (!acceptsAvatar(Number(m.rev) || 0, cur && cur.rev)) return;
      state.avatars[m.id] = { rev: Number(m.rev) || 0, src };
    },
    pong(m) { outstanding = 0; clock.add(Number(m.c), Number(m.s), now()); },
    error(m) {
      switch (m.code) {
        case 'forbidden':
        case 'rate_limited':
          if (m.code === 'rate_limited' && !CMDS.has(m.re)) return;
          // Our optimistic change was refused: back to the relay's last word.
          if (state.room) { state.room.playback = confirmed; state.room.item = confirmedItem; }
          emit('snapback', { toast: m.code === 'forbidden' ? REFUSED_TOAST : 'Too many changes at once — try again in a moment' });
          return;
        case 'full': return endLocally('full');
        case 'bad_hello':
          // A seat this tab kept from a room that no longer knows its secret: join fresh, once.
          if (resumed && !retriedFresh) { retriedFresh = true; pendingFresh = true; dropSeat(); kill(); reconnectNow(); return; }
          return endLocally('bad_hello');
        case 'closed': return endLocally('ended');
        case 'not_member': kill(); reconnectNow(); return;   // the sweep dropped our row: hello again (same id)
        case 'queue_full': emit('notice', { text: 'The party queue is full' }); return;
        default: return;
      }
    },
    closed(m) { endLocally(m.reason || ''); },
  };

  /** "Ann paused" / "Ann jumped to 41:10" for someone else's command. */
  function noteRemote(pb, prev, mine) {
    const before = lastToastPb || prev;
    lastToastPb = pb;
    if (mine || !before || pb.reason !== 'user' || !pb.by) return;
    const who = nameOf(pb.by);
    let text = '';
    if (pb.playing !== before.playing) text = pb.playing ? `${who} resumed` : `${who} paused`;
    else if (Math.abs(pb.mediaTime - expectedTime(before, pb.serverTimeAtUpdate)) > 3) text = `${who} jumped to ${clockLabel(pb.mediaTime)}`;
    else if (pb.rate !== before.rate) text = `${who} set speed ${pb.rate === 1 ? '1×' : pb.rate + '×'}`;
    if (text) emit('notice', { text });
  }

  const cmdId = () => Math.floor(random() * 2 ** 32).toString(36).padStart(7, '0').slice(0, 8);
  const client = {
    state,
    connect() { if (['idle', 'left', 'failed'].includes(state.phase)) { firstDropAt = null; attempts = 0; retriedFresh = false; state.failure = ''; setPhase('connecting'); connect(); changed(); } },
    /** The tab came back to the front: a socket the browser froze may be dead. */
    visible() {
      if (state.phase === 'joined') { raw({ t: 'ping', c: now() }); raw({ t: 'sync' }); }
      else if (state.phase === 'reconnecting' || state.phase === 'failed') reconnectNow();
    },
    rejoin() { if (state.phase === 'failed' || state.phase === 'reconnecting') reconnectNow(); },
    /** Page hide / unload: close without `leave`, so this tab's seat resumes —
        on a reload, or when the page comes back from the back-forward cache
        (visible() then reconnects from 'reconnecting'). */
    close() {
      clearTimers(); kill(1000, 'unload');
      if (['joined', 'connecting'].includes(state.phase)) { firstDropAt = null; setPhase('reconnecting'); }
    },
    leave() {
      send({ t: 'leave' });
      endLocally('left', 'You left the party.');
    },
    canControl: () => state.phase === 'joined' && canControl(state.room, state.myId),
    me: () => memberOf(state.room, state.myId),
    nameOf,
    serverNow: () => clock.serverNow(now()),
    expected: () => (state.room && state.room.playback ? expectedTime(state.room.playback, clock.serverNow(now())) : 0),
    clock,

    /** A viewer's play / pause / seek / rate. False = not allowed (nothing sent:
        the caller toasts and snaps back). The local mirror moves at once, so the
        binder doesn't undo the viewer's own tap before the relay's echo lands. */
    publish(kind, at, opts = {}) {
      if (!client.canControl() || !state.room) return false;
      const c = cmdId();
      const pb = { ...(state.room.playback || { playing: false, mediaTime: 0, rate: 1 }) };
      const t = Math.max(0, Number(at) || 0);
      let msg;
      if (kind === 'play') { pb.playing = true; pb.mediaTime = t; msg = { t: 'play', at: t, c }; }
      else if (kind === 'pause') { pb.playing = false; pb.mediaTime = t; msg = { t: 'pause', at: t, c }; }
      else if (kind === 'seek') { pb.playing = opts.playing == null ? pb.playing : !!opts.playing; pb.mediaTime = t; msg = { t: 'seek', to: t, playing: pb.playing, c }; }
      else if (kind === 'rate') { pb.mediaTime = client.expected(); pb.rate = Number(opts.rate) || 1; msg = { t: 'rate', rate: pb.rate, c }; }
      else return false;
      if (!send(msg)) return false;
      Object.assign(pb, { serverTimeAtUpdate: client.serverNow(), by: state.myId, cmd: c, reason: 'user' });
      state.room.playback = pb;
      lastToastPb = pb;
      changed();
      return true;
    },
    /** Put the room on `item` (anyone with control). Optimistic like the apps:
        the room sits paused at `startAt` with reason 'item' until our first
        frame starts it (the kick-off). True = sent or already there. */
    setItem(item, startAt) {
      if (!item || !client.canControl() || !state.room) return false;
      if (sameEpisode(item, state.room.item)) return true;
      const msg = { t: 'setItem', item, c: cmdId() };
      const at = Number.isFinite(startAt) && startAt > 0 ? startAt : 0;
      if (at) msg.startAt = at;
      if (!send(msg)) return false;
      state.room.item = item;
      state.room.playback = { playing: false, mediaTime: at, serverTimeAtUpdate: client.serverNow(), rate: 1,
                              seq: (state.room.playback && state.room.playback.seq) || 0, by: state.myId, cmd: msg.c, reason: 'item', waitingFor: [] };
      state.itemSetByMe = true;
      changed();
      return true;
    },
    playNext() {
      if (!client.canControl() || !state.room || !state.room.queue.length) return false;
      return send({ t: 'queue', op: 'playNext', c: cmdId() });
    },
    /** Our first frame for an item we set, while the room waits at its start. */
    shouldKickOff() {
      const pb = state.room && state.room.playback;
      return !!pb && state.itemSetByMe && !pb.playing && pb.reason === 'item';
    },
    chat(text) { const t = chatText(text); return t ? send({ t: 'chat', text: t }) : false; },
    react(emoji) { return typeof emoji === 'string' && emoji ? send({ t: 'react', emoji }) : false; },
    typing(on) { return send({ t: 'typing', on: !!on }); },
    report(r) { return send({ t: 'report', pos: r.pos, dur: r.dur, playing: !!r.playing, buffering: !!r.buffering, engine: r.engine, synced: !!r.synced }); },
  };
  return client;
}
