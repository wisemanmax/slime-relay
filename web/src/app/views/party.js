/* Wave 7 (P5, roadmap 7.3/7.4) — '#party/<CODE>': the Watch Party join page for
   a signed-in visitor (the room's title, host, members with their avatars,
   control mode, Join), then the party panel (chat, reactions, who's here)
   beside the player. watch.byheir.com/p/<CODE> lands here when signed in
   (worker.js); the relay's public page links here for everyone else.

   The browser is always an ordinary member (party/client.js): it follows the
   room's item and clock through party/bind.js, sends its own play / pause /
   seek when the room allows it, chats and reacts, and shows avatars — the
   room's photos (`avatar` frames, and the peek's ?avatars=1 on this page), or
   the settled placeholder: the member's colour with its emoji, or its initial.
   Voice clips show as a chat line and are never played.

   When the room picks a new title: an open player switches to it; a closed
   one gets a "Watch" toast instead of opening by itself (a browser won't
   start sound without a tap, so the tap is the start). The Join and Watch
   taps also unlock the <video> for later remote starts (primeAutoplay).

   The renderers (joinPageHTML, membersHTML, chatHTML, statusText) are pure;
   test/party.mjs checks their escaping. */

import { $, esc, IMG } from '../util.js';
import { apiFetch } from '../api.js';
import { onAction } from '../ui/actions.js';
import { toast } from '../ui/toast.js';
import { go } from '../router.js';
import { createStore, memoryStorage } from '../state.js';
import { currentProfile, profileColor } from '../profiles.js';
import { fsActive } from '../player/player.js';
import { isPlayerOpen } from '../player/session.js';
import { createPartyClient } from '../party/client.js';
import { bindParty, unbindParty } from '../party/bind.js';
import {
  normalCode, controlMode, controlLine, placeholder, avatarSrc, itemLabel, memberOf, REACTIONS, MAX_CHAT,
} from '../party/rules.js';

// ── Pure renderers ──────────────────────────────────────────────────────────────

/** A member's face: the room's photo, else the colour with its emoji or initial. */
export function avatarHTML(m, src, cls = 'pp-av') {
  const p = placeholder(m);
  const inner = src ? `<img src="${esc(src)}" alt="">` : `<span class="${p.emoji ? 'em' : 'in'}">${esc(p.label)}</span>`;
  return `<span class="${cls}" style="background:${p.color}" aria-hidden="true">${inner}</span>`;
}

/** The join page body for `code` from its peek (null while loading). */
export function joinPageHTML(code, peek, o = {}) {
  const head = `<div class="party-eyebrow">WATCH PARTY</div><div class="party-code" aria-label="Party code">${esc(code)}</div>`;
  const banner = o.note ? `<p class="party-note warn">${esc(o.note)}</p>` : '';
  if (o.error) return `<div class="party-card">${head}${banner}<p class="party-dim">${esc(o.error)}</p></div>`;
  if (!peek) return `<div class="party-card">${head}${banner}<p class="party-dim">Looking up the party…</p></div>`;
  const it = peek.item;
  const poster = it && IMG(it.posterPath, 'w185');
  const now = it
    ? `<div class="party-now">${poster ? `<img src="${esc(poster)}" alt="">` : ''}<div><div class="party-now-l">Now showing</div><div class="party-now-t">${esc(itemLabel(it))}</div></div></div>`
    : '<p class="party-dim">Nothing picked yet — you\'ll follow what the party plays.</p>';
  const count = Number.isFinite(peek.memberCount) ? peek.memberCount : (peek.members || []).length;
  const host = peek.hostName ? `<b>${esc(peek.hostName)}</b> is hosting · ` : '';
  const faces = (peek.members || []).slice(0, 8).map((m) =>
    `<div class="party-face">${avatarHTML(m, avatarSrc(m.avatar))}<span>${esc(m.name || 'Guest')}</span></div>`).join('');
  const mode = controlMode(peek.control ? { control: peek.control } : { everyoneControls: peek.everyoneControls });
  return `<div class="party-card">${head}${banner}${now}
    <p class="party-line">${host}${count} here</p>
    ${faces ? `<div class="party-faces">${faces}</div>` : ''}
    <p class="party-ctl">${mode === 'host' ? '🔒' : '👥'} ${esc(controlLine(mode))}</p>
    <button class="party-btn" data-act="party-join" data-code="${esc(code)}">${o.rejoin ? 'Rejoin the party' : 'Join the party'}</button>
    <p class="party-note">You'll watch here in the browser, in sync with everyone. Voice clips play in the app.</p></div>`;
}

/** A member's state chip (the apps' stateLabel, minus what the web can't know). */
function stateChip(m, room) {
  if (m.role === 'companion') return 'Chat only';
  if (!m.connected) return 'Away';
  if (m.buffering) return 'Buffering';
  if (m.engine === 'embed') return 'Not synced';
  if (room && room.playback && room.playback.reason === 'waiting' && (room.playback.waitingFor || []).includes(m.id)) return 'Catching up';
  return m.synced ? 'In sync' : '';
}

/** Who's here, host first, then in join order. */
export function membersHTML(st) {
  const room = st.room;
  if (!room) return '';
  const list = [...room.members].sort((a, b) => (b.id === room.hostId) - (a.id === room.hostId));
  return list.map((m) => {
    const a = st.avatars[m.id];
    const chip = stateChip(m, room);
    return `<div class="pp-m${m.connected === false ? ' away' : ''}">${avatarHTML(m, a && a.src)}
      <span class="pp-n">${esc(m.name || 'Guest')}${m.id === st.myId ? ' <i>(you)</i>' : ''}</span>
      ${m.id === room.hostId ? '<span class="pp-chip host">Host</span>' : ''}${chip ? `<span class="pp-chip">${esc(chip)}</span>` : ''}</div>`;
  }).join('');
}

/** The chat log: messages, system lines ("Ann joined"), voice-clip lines. */
export function chatHTML(lines, myId) {
  if (!lines.length) return '<div class="pp-l system">Say hi — everyone in the party sees it.</div>';
  return lines.map((l) => {
    if (l.kind === 'system') return `<div class="pp-l system">${esc(l.text)}</div>`;
    const mine = l.from && l.from === myId ? ' mine' : '';
    const icon = l.kind === 'voice' ? '🎙 ' : '';
    return `<div class="pp-l ${l.kind}${mine}"><b>${esc(l.name)}</b> ${icon}${esc(l.text)}</div>`;
  }).join('');
}

/** The badge / status line: the connection first, then how this player is doing. */
export function statusText(st, binderPhase) {
  if (st.phase === 'connecting' || st.phase === 'idle') return 'Joining…';
  if (st.phase === 'reconnecting') return 'Reconnecting…';
  if (st.phase === 'failed') return 'Disconnected';
  if (st.phase !== 'joined' || !st.room) return '';
  const pb = st.room.playback;
  if (pb && pb.reason === 'waiting' && (pb.waitingFor || []).length) {
    const m = memberOf(st.room, pb.waitingFor[0]);
    return 'Waiting for ' + (m ? m.name : 'someone');
  }
  switch (binderPhase) {
    case 'inSync': return 'In sync';
    case 'catchingUp': return 'Catching up';
    case 'aligning': return 'Syncing…';
    case 'embed': return 'Not synced';
    case 'atEnd': return 'At the end';
    default: return st.room.item ? 'Not watching' : 'Waiting for a pick';
  }
}

function panelHTML(scope) {
  return `<div class="pp-members" id="pp-${scope}-members"></div>
    <div class="pp-chat" id="pp-${scope}-chat" role="log" aria-live="polite"></div>
    <div class="pp-typing" id="pp-${scope}-typing"></div>
    <div class="pp-reacts">${REACTIONS.map((e) => `<button class="pp-r" data-act="party-react" data-emoji="${e}" title="React ${e}">${e}</button>`).join('')}</div>
    <div class="pp-compose"><input class="pp-in" id="pp-${scope}-in" maxlength="${MAX_CHAT}" placeholder="Say something…" autocomplete="off" aria-label="Chat message">
      <button class="pp-send" data-act="party-send" data-for="pp-${scope}-in">Send</button></div>`;
}

// ── The controller (one party per tab) ──────────────────────────────────────────

const ctl = { client: null, binder: null, code: '', build: '', note: '', lastBubble: 0, raf: 0 };
let stores = null;
function partyStores() {
  if (stores) return stores;
  const get = (k) => { try { return globalThis[k] || null; } catch { return null; } };
  stores = {
    local: createStore(get('localStorage') || memoryStorage(), { device: { storage: 'sw_party_device', def: '', local: true } }),
    seats: createStore(get('sessionStorage') || memoryStorage(), { seat: { storage: 'sw_party_seat', def: null, local: true } }),
  };
  return stores;
}
const seatFor = (code) => { const s = partyStores().seats.getState().seat; return !!s && s.code === code; };
const activeFor = (code) => !!ctl.client && ctl.code === code && !['left'].includes(ctl.client.state.phase);
const onPartyRoute = () => normalCode(String(location.hash || '').replace(/^#party\//, '')) === ctl.code && /^#party\//.test(location.hash);

async function peek(code) {
  try {
    const r = await apiFetch('/api/party/' + code + '?avatars=1', { signal: AbortSignal.timeout(12000) });
    const b = r.headers.get('x-web-build'); if (b) ctl.build = b;
    let j = null; try { j = await r.json(); } catch (_) {}
    return { status: r.status, body: j };
  } catch (_) { return { status: 0, body: null }; }
}

export async function viewParty(arg) {
  const main = $('main');
  const code = normalCode(arg);
  main.innerHTML = '<section class="party-page" id="party-page"></section>';
  const page = $('party-page');
  if (!code) { page.innerHTML = `<div class="party-card"><div class="party-eyebrow">WATCH PARTY</div><p class="party-dim">That doesn't look like a party code. Codes are six letters and numbers, like <b>XK7Q2M</b>.</p></div>`; return; }
  if (activeFor(code)) { renderLobby(); return; }
  const note = ctl.code === code ? ctl.note : '';
  page.innerHTML = joinPageHTML(code, null, { note });
  const r = await peek(code);
  if (!$('party-page') || normalCode(String(location.hash).replace(/^#party\//, '')) !== code || activeFor(code)) return;   // moved on meanwhile
  let error = '';
  if (r.status === 404) error = 'This party has ended, or the code is wrong. Ask the host for a fresh one.';
  else if (r.status === 503) error = 'Watch Party isn\'t set up on this site yet.';
  else if (r.status !== 200 || !r.body) error = 'Couldn\'t reach the party right now — try again in a moment.';
  page.innerHTML = joinPageHTML(code, error ? null : r.body, { error, note, rejoin: seatFor(code) });
}

/** The Join / Watch taps are the gesture a browser wants before it starts sound
    later from a socket message: play() on the empty element inside the tap
    lifts that restriction (WebKit); it has no source, so nothing plays. */
function primeAutoplay() {
  const v = $('pvideo');
  if (!v || v.getAttribute('src')) return;
  try { const p = v.play(); if (p && p.catch) p.catch(() => {}); v.pause(); } catch (_) {}
}

function join(code) {
  if (ctl.client && ctl.code !== code) leave(true);
  if (activeFor(code)) { renderLobby(); return; }
  primeAutoplay();
  const wsBase = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  const st = partyStores();
  ctl.code = code; ctl.note = ''; ctl.lastBubble = 0;
  ctl.client = createPartyClient({
    code, url: wsBase + '/api/party/' + code + '/ws', local: st.local, seats: st.seats,
    identity: () => { const p = currentProfile(); return { name: (p && p.name) || 'Guest', accentHex: profileColor(p) }; },
    engine: () => (ctl.binder ? ctl.binder.wireEngine() : 'none'),
    app: 'web ' + (ctl.build || 'unknown'),
    peek: async () => (await peek(code)).status,
    onChange: schedule, onEvent,
  });
  ctl.binder = bindParty(ctl.client, { onPhase: schedule });
  mountPlayer();
  ctl.client.connect();
  if (onPartyRoute()) renderLobby();
}

function leave(quiet) {
  const c = ctl.client;
  if (!c) return;
  if (quiet) { ctl.client = null; c.leave(); teardown(); return; }
  c.leave();   // -> 'closed' -> teardown
}

function teardown() {
  unbindParty();
  ctl.binder = null;
  unmountPlayer();
  const pill = $('ppill'); if (pill) pill.remove();
}

function onEvent(type, d) {
  const c = ctl.client, b = ctl.binder;
  if (!c) return;
  if (type === 'welcome') {
    if (b) { if (!d.reconnected && c.state.room.item) b.route(); b.tick(); }
    if (!d.reconnected && !c.state.room.item) toast('You\'re in — waiting for someone to pick something', { id: 'party-notice' });
  } else if (type === 'state') { if (b) b.remoteStateChanged(); }
  else if (type === 'item') {
    if (d.mine || !d.item || !b) return;
    if (isPlayerOpen()) b.route();
    else toast(`${c.nameOf(d.by)} picked ${itemLabel(d.item)}`, { id: 'party-pick', action: 'Watch', onAction: watch });
  } else if (type === 'snapback') { if (b) b.snapBack(d.toast); }
  else if (type === 'notice') toast(d.text, { id: 'party-notice' });
  else if (type === 'react') floatReaction(d.emoji, d.name);
  else if (type === 'closed') {
    ctl.note = d.reason === 'left' ? '' : d.text;
    toast(d.text, { id: 'party-notice' });
    ctl.client = null;
    teardown();
    if (/^#party\//.test(location.hash)) viewParty(location.hash.slice('#party/'.length));
  }
}

function watch() {
  const c = ctl.client, b = ctl.binder;
  if (!c || !b) return;
  if (!c.state.room || !c.state.room.item) { toast('Nothing\'s playing in the party yet', { id: 'party-notice' }); return; }
  primeAutoplay();
  b.route();
}

// ── Rendering ───────────────────────────────────────────────────────────────────

function schedule() {
  if (ctl.raf) return;
  const run = () => { ctl.raf = 0; render(); };
  ctl.raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : setTimeout(run, 16);
}

function render() {
  const c = ctl.client;
  if (!c) return;
  const st = c.state, phase = ctl.binder ? ctl.binder.phase : 'unbound';
  const status = statusText(st, phase);
  for (const scope of ['lob', 'pl']) fillPanel(scope, st);
  const badge = $('pparty');
  if (badge) { badge.textContent = '🎉 ' + (status || 'Party'); badge.dataset.state = phase; }
  const ps = $('pp-pl-status'); if (ps) ps.textContent = status;
  const ls = $('plob-status');
  if (ls) ls.textContent = [status, st.room ? controlLine(controlMode(st.room.settings)) : ''].filter(Boolean).join(' · ');
  const lt = $('plob-title');
  if (lt) lt.textContent = st.room && st.room.item ? itemLabel(st.room.item) : 'Waiting for someone to pick something';
  const lr = $('plob-retry'); if (lr) lr.style.display = st.phase === 'failed' ? '' : 'none';
  const ln = $('plob-next'); if (ln) ln.style.display = st.room && st.room.queue.length && c.canControl() ? '' : 'none';
  bubbles(st);
  pill(st);
}

function fillPanel(scope, st) {
  const mem = $(`pp-${scope}-members`); if (!mem) return;
  mem.innerHTML = membersHTML(st);
  const log = $(`pp-${scope}-chat`);
  const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.innerHTML = chatHTML(st.chat, st.myId);
  if (atEnd) log.scrollTop = log.scrollHeight;
  const ty = $(`pp-${scope}-typing`);
  ty.textContent = st.typing.length ? st.typing.slice(0, 3).join(', ') + (st.typing.length > 1 ? ' are' : ' is') + ' typing…' : '';
  wireComposer($(`pp-${scope}-in`));
}

function renderLobby() {
  const page = $('party-page'); if (!page || !ctl.client) return;
  page.innerHTML = `<div class="party-lobby">
    <div class="party-lobby-head">
      <div class="party-lobby-t"><div class="party-eyebrow">WATCH PARTY · ${esc(ctl.code)}</div>
        <h1 class="party-title" id="plob-title"></h1><p class="party-dim" id="plob-status"></p></div>
      <div class="party-actions">
        <button class="party-btn" data-act="party-watch">▶ Watch</button>
        <button class="party-btn ghost" id="plob-next" data-act="party-next" style="display:none">Play next in queue</button>
        <button class="party-btn ghost" id="plob-retry" data-act="party-rejoin" style="display:none">Reconnect</button>
        <button class="party-btn ghost" data-act="party-leave">Leave</button>
      </div>
    </div>
    <div class="ppanel-body">${panelHTML('lob')}</div></div>`;
  render();
}

/** The sidebar beside the player, its badge in the bar and the reaction layer on the stage. */
function mountPlayer() {
  const player = $('player'); if (!player || $('ppanel')) return;
  player.classList.add('partyon');
  player.insertAdjacentHTML('beforeend', `<aside class="ppanel" id="ppanel" aria-label="Watch Party">
    <div class="pp-head"><b>Party</b><span id="pp-pl-status"></span><button class="pp-x" data-act="party-panel" title="Hide the party panel">✕</button></div>
    ${panelHTML('pl')}</aside>`);
  const close = player.querySelector('[data-act="player-close"]');
  if (close) close.insertAdjacentHTML('beforebegin', '<button class="x pparty" id="pparty" data-act="party-panel" title="Show or hide the party">🎉 Party</button>');
  const stage = player.querySelector('.stage');
  if (stage) stage.insertAdjacentHTML('beforeend', '<div class="preact" id="preact" aria-hidden="true"></div>');
}
function unmountPlayer() {
  const player = $('player'); if (!player) return;
  player.classList.remove('partyon', 'partyhide');
  for (const id of ['ppanel', 'pparty', 'preact']) { const el = $(id); if (el) el.remove(); }
}

function floatReaction(emoji, name) {
  const layer = $('preact'); if (!layer || !isPlayerOpen()) return;
  const el = document.createElement('div');
  el.className = 'pr-float';
  el.style.left = (12 + Math.random() * 70).toFixed(1) + '%';
  el.innerHTML = `<span class="e">${esc(emoji)}</span><span class="n">${esc(name || '')}</span>`;
  layer.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/** Chat over the video while the panel is hidden or the stage is fullscreen. */
function bubbles(st) {
  const fresh = st.chat.filter((l) => l.id > ctl.lastBubble && l.kind !== 'system' && l.from !== st.myId);
  if (st.chat.length) ctl.lastBubble = st.chat[st.chat.length - 1].id;
  const layer = $('preact');
  const player = $('player');
  if (!layer || !fresh.length || !isPlayerOpen() || !(player.classList.contains('partyhide') || fsActive())) return;
  for (const l of fresh.slice(-2)) {
    const el = document.createElement('div');
    el.className = 'pr-bubble';
    el.innerHTML = `<b>${esc(l.name)}</b> ${l.kind === 'voice' ? '🎙 ' : ''}${esc(l.text)}`;
    layer.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }
}

/** "🎉 Party · 3" in the corner while browsing elsewhere (hidden over the player by CSS). */
function pill(st) {
  let el = $('ppill');
  const show = st.phase !== 'left' && !onPartyRoute();
  if (!show) { if (el) el.remove(); return; }
  if (!el) {
    document.body.insertAdjacentHTML('beforeend', '<button class="ppill" id="ppill" data-act="party-open"></button>');
    el = $('ppill');
  }
  const n = st.room ? st.room.members.filter((m) => m.connected !== false).length : 0;
  el.textContent = `🎉 Party ${ctl.code}${n ? ' · ' + n : ''}` + (st.phase === 'reconnecting' ? ' · reconnecting' : st.phase === 'failed' ? ' · disconnected' : '');
}

// ── The composer ────────────────────────────────────────────────────────────────

let typingAt = 0, typingOff = null;
function wireComposer(input) {
  if (!input || input.dataset.wired) return;
  input.dataset.wired = '1';
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); send(input); } });
  input.addEventListener('input', () => {
    const c = ctl.client; if (!c) return;
    clearTimeout(typingOff);
    if (!input.value.trim()) { stopTyping(); return; }
    if (Date.now() - typingAt > 3000) { typingAt = Date.now(); c.typing(true); }
    typingOff = setTimeout(stopTyping, 4000);
  });
  input.addEventListener('blur', stopTyping);
}
function stopTyping() {
  clearTimeout(typingOff); typingOff = null;
  if (typingAt && ctl.client) ctl.client.typing(false);
  typingAt = 0;
}
function send(input) {
  if (!input || !ctl.client) return;
  if (ctl.client.state.phase !== 'joined') { toast('Not connected to the party right now', { id: 'party-notice' }); return; }
  if (ctl.client.chat(input.value)) input.value = '';
  stopTyping();
}

// ── Actions + page lifecycle ────────────────────────────────────────────────────

onAction('party-join', (el) => { const code = normalCode(el.dataset.code); if (code) join(code); });
onAction('party-leave', () => leave(false));
onAction('party-watch', () => watch());
onAction('party-rejoin', () => { if (ctl.client) ctl.client.rejoin(); });
onAction('party-next', () => { if (ctl.client && !ctl.client.playNext()) toast('Only the host can control playback', { id: 'party-refused' }); });
onAction('party-react', (el) => { if (ctl.client) ctl.client.react(el.dataset.emoji); });
onAction('party-send', (el) => send($(el.dataset.for)));
onAction('party-panel', () => { const p = $('player'); if (p) p.classList.toggle('partyhide'); });
onAction('party-open', () => { if (ctl.code) go('#party/' + ctl.code); });

if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && ctl.client) ctl.client.visible(); });
}
if (typeof window !== 'undefined' && window.addEventListener) {
  // Closing the tab keeps the seat (sessionStorage) so a reload resumes it; only Leave leaves.
  window.addEventListener('pagehide', () => { if (ctl.client) ctl.client.close(); });
  window.addEventListener('hashchange', () => { if (ctl.client) schedule(); });
}
