/* Profiles — "Who's watching?". Each person picks their name and gets their
   own My List, Continue Watching, reading progress and viewer prefs; the site
   password stays the only gate (names, no passwords — like the apps).

   How it fits together:
   - The Worker (src/worker/profiles.js) keeps the names and sets an HttpOnly
     sw_profile cookie on /api/profiles/select; /api/state keys each profile's
     state by that cookie and answers 428 without one.
   - This browser remembers who it is in the store's local `profile` key
     (localStorage sw_profile: { id, name, color }) and syncs ONLY that
     profile: sync.js's engine sends the id in x-sw-profile on every request,
     and the Worker refuses it if the cookie says otherwise.
   - Switching: flush the old profile's queue → stop its engine → POST select
     → empty every synced key (no tombstones) → start an engine for the new
     profile, whose first pull fills the store → re-render.
   - The first pick in a browser that has history from before profiles (and
     has never picked a name) asks "Bring this browser's history into <name>?":
     Yes keeps it and lets the normal first-pull upload merge it into that
     profile; No clears it. Local-only keys (rdkey, installHint) stay put.
   - Another tab switching this browser's profile reloads this tab (the store
     is shared through localStorage, so its data already changed under it).

   createProfiles() is DOM-free and takes its store, network and sync engine
   as arguments, so test/profiles.mjs drives it in node; the picker overlay,
   header avatar and boot wiring below are thin views over it. */

import { appStore, SYNCED_KEYS } from './state.js';
import { initSync, flushSync, stopSync, syncStatus } from './sync.js';
import { loginBounce } from './api.js';
import { esc, $ } from './util.js';
import { onAction } from './ui/actions.js';
import { closePlayer } from './player/player.js';
import { isPlayerOpen } from './player/session.js';
import { askSession } from './ask.js';

export const PROFILES_PATH = '/api/profiles';
export const MAX_NAME = 24;
export const MAX_PROFILES = 12;
const GREY = '#8E8E93';

// ── Pure helpers ──────────────────────────────────────────────────────────────

/** The profile's colour as a safe #rrggbb (it goes into a style attribute). */
export const profileColor = (p) => (p && /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : GREY);

/** The avatar letter: the name's first character, upper-cased. */
export function profileInitial(name) {
  const s = String(name || '').trim();
  if (!s) return '?';
  let first = [...s][0];
  try { if (typeof Intl !== 'undefined' && Intl.Segmenter) first = new Intl.Segmenter().segment(s)[Symbol.iterator]().next().value.segment; } catch {}
  return first.toUpperCase();
}

/** Black on bright colours, white on dark (the iOS picker's rule). */
export function labelColor(hex) {
  const v = parseInt(String(hex).replace('#', ''), 16) || 0;
  const r = ((v >> 16) & 255) / 255, g = ((v >> 8) & 255) / 255, b = (v & 255) / 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 0.55 ? '#000' : '#fff';
}

/** Names match ignoring case and spacing (the Worker's rule for dedupe + delete). */
export const sameName = (a, b) => {
  const f = (s) => String(s || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
  return f(a) === f(b);
};

/** The avatar square for a profile. */
export function avatarHTML(p, cls = 'pick-av') {
  const c = profileColor(p);
  return `<span class="${cls}" style="background:${c};color:${labelColor(c)}" aria-hidden="true">${esc(profileInitial(p && p.name))}</span>`;
}

/** This browser holds history from before profiles and has never picked a name. */
export function hasLocalHistory(state) {
  return !state.profile && (state.list.length > 0 || state.continue.length > 0 || Object.keys(state.reading || {}).length > 0);
}

// ── The controller ────────────────────────────────────────────────────────────

/** sync: { start(id) -> Promise (first pull done), flush() -> Promise<bool>,
    stop(), status() -> { state } } — the app's sync engine, or a test double. */
export function createProfiles({ store, fetch: doFetch, sync }) {
  const current = () => store.getState().profile || null;

  async function call(path, init = {}) {
    const headers = { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) };
    let res;
    try { res = await doFetch(path, { credentials: 'same-origin', cache: 'no-store', ...init, headers }); }
    catch { return { status: 0, ok: false, json: {}, error: 'offline' }; }
    if (loginBounce(res) || res.status === 401) return { status: 401, ok: false, json: {}, error: 'signed-out' };
    let json = null;
    try { json = await res.json(); } catch {}
    json = json && typeof json === 'object' ? json : {};
    return { status: res.status, ok: res.ok, json, error: res.ok ? null : (json.error || 'HTTP ' + res.status) };
  }

  /** -> { profiles, current } | { unconfigured: true } | { error } */
  async function list() {
    const r = await call(PROFILES_PATH);
    if (r.status === 503) return { unconfigured: true, profiles: [] };
    if (!r.ok) return { error: r.error, profiles: [] };
    return { profiles: Array.isArray(r.json.profiles) ? r.json.profiles : [], current: r.json.current || null };
  }

  /** -> { profile, profiles } | { error, profile? } */
  async function create(name) {
    const r = await call(PROFILES_PATH, { method: 'POST', body: JSON.stringify({ name }) });
    return r.ok ? { profile: r.json.profile, profiles: r.json.profiles || [] } : { error: r.error, profile: r.json.profile || null };
  }

  /** Empty every synced key and the old profile's queue — as the sync layer, so
      nothing is tombstoned (the old profile's entries are not being deleted). */
  function resetStore() {
    store.setState(Object.fromEntries([...SYNCED_KEYS, 'sync'].map(k => [k, null])), { source: 'sync' });
  }

  /** Make `p` this browser's profile.
      opts.importLocal  the answer to "bring this browser's history?" (asked only on a
                        first pick with pre-profile history: { needsImport } until given)
      opts.force        switch even though the old profile's changes didn't upload
      -> { ok, profile, switched, ready } | { needsImport } | { unsent } | { error } */
  async function select(p, { importLocal = null, force = false } = {}) {
    const prev = current();
    const same = !!prev && prev.id === p.id;
    const firstPick = hasLocalHistory(store.getState());
    if (firstPick && importLocal == null) return { needsImport: true };
    const st = (sync.status() || {}).state;
    const live = !!prev && st !== 'no-profile' && st !== 'profile-changed' && st !== 'off';
    // 1. The old profile's unsent changes go to the old profile, under the old cookie.
    if (prev && !same && live && !force && !(await sync.flush())) return { unsent: true };
    // 2. Stop it before the cookie changes: a late PUT must never land under the new one.
    sync.stop();
    const r = await call(PROFILES_PATH + '/select', { method: 'POST', body: JSON.stringify({ id: p.id }) });
    if (!r.ok) {
      if (prev && live) sync.start(prev.id);   // nothing changed: carry on as before
      return { error: r.error };
    }
    // 3. Someone else's data never shows under this name: start from empty
    //    (unless it's the same profile again, or a first pick that keeps it).
    if (!same && !(firstPick && importLocal)) resetStore();
    const q = r.json.profile || p;
    const profile = { id: q.id, name: q.name, color: profileColor(q) };
    store.setState({ profile }, { source: 'sync' });
    // 4. Pull the new profile's state (and, after an import, upload what it lacks).
    const ready = Promise.resolve(sync.start(profile.id));
    return { ok: true, profile, switched: !same, ready };
  }

  /** Delete `p` and its history (`confirm` must be its name). Deleting the
      current profile empties this browser and leaves no profile picked.
      -> { ok, profiles, wasCurrent } | { error } */
  async function remove(p, confirm) {
    const r = await call(PROFILES_PATH + '/' + encodeURIComponent(p.id) + '?confirm=' + encodeURIComponent(confirm), { method: 'DELETE' });
    if (!r.ok) return { error: r.error };
    const cur = current(), wasCurrent = !!cur && cur.id === p.id;
    if (wasCurrent) { sync.stop(); resetStore(); store.setState({ profile: null }, { source: 'sync' }); }
    return { ok: true, profiles: r.json.profiles || [], wasCurrent };
  }

  /** Boot: sync the remembered profile, or say the picker is needed. -> 'started' | 'pick' */
  function boot() {
    const p = current();
    if (!p) return 'pick';
    sync.start(p.id);
    return 'started';
  }

  return { current, list, create, select, remove, boot, resetStore };
}

// ── The app: controller over the real store, network and sync engine ─────────

let ctl = null;
let active = null;   // the profile id this tab's engine syncs (null: none yet)
const appSync = {
  start: (id) => { active = id; return initSync({ profile: id, onProfile: refused }).ready(); },
  flush: () => flushSync(),
  stop: () => stopSync(),
  status: () => syncStatus(),
};

/** { id, name, color } of who's watching in this browser, or null. */
export const currentProfile = () => (appStore().getState().profile || null);

/* The Worker refused this tab's profile mid-session. 'mismatch': another tab
   switched the browser (its storage event normally reloads us first). 'none':
   the profile was deleted elsewhere or the cookie is gone — ask who's watching. */
function refused(kind) {
  if (kind === 'mismatch') { location.reload(); return; }
  openProfiles({ lost: true });
}

/** Boot (main.js, after the first route): start syncing the remembered profile,
    or show "Who's watching?". */
export function initProfiles() {
  const store = appStore();
  ctl = createProfiles({ store, fetch: (u, i) => fetch(u, i), sync: appSync });
  store.subscribe((s, { keys, source }) => {
    if (!keys.includes('profile')) return;
    paintAvatars();
    const id = s.profile ? s.profile.id : null;
    if (source === 'storage' && id !== active) location.reload();
  });
  initPickerGestures();
  paintAvatars();
  if (ctl.boot() === 'pick') openProfiles({ boot: true });
}

/** Re-render the current route (main.js renders on hashchange). */
const rerender = () => window.dispatchEvent(new Event('hashchange'));

// ── Header avatar (desktop) + the phone header's profile icon ────────────────
export function paintAvatars() {
  const p = currentProfile();
  const label = p ? p.name + " — switch profile" : "Who's watching?";
  const c = profileColor(p), fg = labelColor(c);
  const d = $('hdr-avatar');
  if (d) {
    d.hidden = !p;
    d.textContent = p ? profileInitial(p.name) : '';
    d.style.background = p ? c : ''; d.style.color = p ? fg : '';
    d.title = label; d.setAttribute('aria-label', label);
  }
  const m = $('hdr-me');
  if (m) {
    m.textContent = p ? profileInitial(p.name) : '🍿';
    m.style.background = p ? c : ''; m.style.color = p ? fg : '';
    m.classList.toggle('has-profile', !!p);
    m.title = label; m.setAttribute('aria-label', label);
  }
}

// ── The picker overlay ───────────────────────────────────────────────────────
/* One state object, one paint(). Modes:
     loading · grid (tiles + Add name) · error · unconfigured ·
     import (first pick: bring local history?) · delete (type the name) ·
     unsent (old profile's changes didn't upload: switch anyway?) · busy */
const ui = { open: false, closable: false, mode: 'loading', profiles: [], adding: false, draft: '', confirm: '',
  target: null, note: '', error: '', busyText: '', boot: false };
let suppressClickUntil = 0;

export const isProfilesOpen = () => ui.open;

const ERRORS = {
  'name-taken': "That name's already here — tap it instead.",
  'too-many': `That's ${MAX_PROFILES} names — delete one first.`,
  'bad-name': `Names are 1–${MAX_NAME} characters.`,
  'offline': "Can't reach SlimeWatch — check your connection.",
  'no-such-profile': 'That name was just removed.',
  'confirm-mismatch': 'Type the name exactly to confirm.',
};
const errorText = (code) => ERRORS[code] || 'Something went wrong (' + code + ').';

/** The overlay's markup for a state (exported for test/profiles.mjs). */
export function pickerHTML(s, cur) {
  const t = s.target;
  const back = (label = 'Cancel') => `<button class="pick-btn" data-act="profile-back">${label}</button>`;
  const err = s.error ? `<p class="pick-note pick-err" role="alert">${esc(s.error)}</p>` : '';
  let body = '';
  if (s.mode === 'loading') body = '<p class="pick-note">Loading…</p>';
  else if (s.mode === 'busy') body = `<div class="pick-panel">${t ? avatarHTML(t) : ''}<p class="pick-note">${esc(s.busyText || 'One moment…')}</p></div>`;
  else if (s.mode === 'unconfigured') {
    body = `<p class="pick-note">Names need sync, which isn't set up on this site (the STATE KV binding) — everything stays in this browser.</p>
      <button class="pick-btn" data-act="profile-close">Close</button>`;
  } else if (s.mode === 'error') {
    body = `${err}<div class="pick-row"><button class="pick-btn primary" data-act="profile-retry">Try again</button>${s.closable ? '<button class="pick-btn" data-act="profile-close">Not now</button>' : ''}</div>`;
  } else if (s.mode === 'import' && t) {
    body = `<div class="pick-panel">${avatarHTML(t)}
      <h2>Bring this browser's history into ${esc(t.name)}?</h2>
      <p class="pick-note">This browser has My List, Continue Watching or reading progress from before names were added. <b>Yes</b> adds it to ${esc(t.name)}'s; <b>No</b> starts ${esc(t.name)} from what's saved under that name and clears it from this browser.</p>
      ${err}<div class="pick-row"><button class="pick-btn primary" data-act="profile-import" data-val="yes">Yes, bring it</button>
      <button class="pick-btn" data-act="profile-import" data-val="no">No</button>${back('Back')}</div></div>`;
  } else if (s.mode === 'unsent' && t) {
    body = `<div class="pick-panel">${avatarHTML(t)}
      <h2>Switch to ${esc(t.name)}?</h2>
      <p class="pick-note">${esc(cur ? cur.name : 'This profile')}'s latest changes haven't reached the server yet (offline?). Switching now drops them from this browser.</p>
      ${err}<div class="pick-row"><button class="pick-btn danger" data-act="profile-force">Switch anyway</button>${back()}</div></div>`;
  } else if (s.mode === 'delete' && t) {
    const okNow = sameName(s.confirm, t.name);
    body = `<div class="pick-panel">${avatarHTML(t)}
      <h2>Delete ${esc(t.name)}?</h2>
      <p class="pick-note">${esc(t.name)}'s My List, Continue Watching, reading progress and settings are deleted for every device. This can't be undone.</p>
      <label class="pick-label" for="pick-confirm">Type <b>${esc(t.name)}</b> to confirm</label>
      <input id="pick-confirm" class="pick-input" value="${esc(s.confirm)}" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="${MAX_NAME + 8}">
      ${err}<div class="pick-row"><button class="pick-btn danger" data-act="profile-delete"${okNow ? '' : ' disabled'}>Delete</button>${back()}</div></div>`;
  } else {
    const tiles = s.profiles.map(p => `<div class="pick-tile${cur && cur.id === p.id ? ' cur' : ''}">
        <button class="pick-face" data-act="profile-pick" data-id="${esc(p.id)}">${avatarHTML(p)}<span class="pick-name">${esc(p.name)}</span></button>
        <button class="pick-more" data-act="profile-menu" data-id="${esc(p.id)}" title="Delete…" aria-label="Delete ${esc(p.name)}…">⋯</button>
      </div>`).join('');
    const add = s.adding
      ? `<div class="pick-tile pick-add"><span class="pick-av add" aria-hidden="true">+</span>
          <input id="pick-name" class="pick-input" value="${esc(s.draft)}" maxlength="${MAX_NAME}" placeholder="Your name" aria-label="Your name" autocomplete="off" autocapitalize="words" spellcheck="false" enterkeyhint="done">
          <button class="pick-btn primary small" data-act="profile-create">Add</button></div>`
      : s.profiles.length < MAX_PROFILES
        ? `<div class="pick-tile"><button class="pick-face" data-act="profile-add"><span class="pick-av add" aria-hidden="true">+</span><span class="pick-name">Add name</span></button></div>`
        : '';
    body = `${s.note ? `<p class="pick-note">${esc(s.note)}</p>` : ''}${err}
      <div class="pick-grid">${tiles}${add}</div>
      ${s.profiles.length ? '<p class="pick-hint">Hold a name (or ⋯) to delete it.</p>' : ''}
      ${s.closable ? '<button class="pick-btn" data-act="profile-close">Done</button>' : ''}`;
  }
  return `<div class="pick-in"><div class="brand">SLIME<span>WATCH</span></div><h1>Who's watching?</h1>${body}</div>`;
}

function paint() {
  const el = $('pick'); if (!el) return;
  el.innerHTML = pickerHTML(ui, currentProfile());
  const name = $('pick-name');
  if (name) {
    name.addEventListener('input', () => { ui.draft = name.value; });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); createFromInput(); } });
  }
  const conf = $('pick-confirm');
  if (conf && ui.target) {
    conf.addEventListener('input', () => {
      ui.confirm = conf.value;
      const b = el.querySelector('[data-act="profile-delete"]');
      if (b) b.disabled = !sameName(conf.value, ui.target.name);
    });
    conf.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); deleteTarget(); } });
  }
  const focus = name || conf;
  if (focus) { try { focus.focus(); const n = focus.value.length; focus.setSelectionRange(n, n); } catch {} }
}

function show(on) {
  const el = $('pick'); if (!el) return;
  el.classList.toggle('open', on);
  el.setAttribute('aria-hidden', on ? 'false' : 'true');
}

/** Open "Who's watching?". opts.boot: no profile yet; opts.lost: the server
    refused ours (deleted elsewhere / cookie gone) — neither can be dismissed. */
export async function openProfiles(opts = {}) {
  if (!ctl) return;
  const cur = currentProfile();
  if (opts.lost && isPlayerOpen()) closePlayer();
  Object.assign(ui, { open: true, closable: !!cur && !opts.lost && !opts.boot, mode: 'loading', adding: false, draft: '',
    confirm: '', target: null, note: '', error: '', boot: !!opts.boot, lost: !!opts.lost });
  show(true); paint();
  await refresh();
}

async function refresh() {
  ui.mode = 'loading'; ui.error = ''; paint();
  const r = await ctl.list();
  if (!ui.open) return;
  if (r.unconfigured) {
    // A site without the KV binding has no profiles (and no sync): stay local, as before.
    if (ui.boot) { closeProfiles(true); initSync({}); return; }
    ui.closable = true; ui.mode = 'unconfigured'; paint(); return;
  }
  if (r.error === 'signed-out') { location.href = '/login'; return; }
  if (r.error) {
    ui.mode = 'error'; ui.error = errorText(r.error);
    if (ui.boot) ui.closable = true;   // offline at first visit: let the app open; it asks again next time
    paint(); return;
  }
  ui.profiles = r.profiles; ui.mode = 'grid';
  const cur = currentProfile();
  if (ui.lost && cur) ui.note = r.profiles.some(p => p.id === cur.id) ? `Pick ${cur.name} again to keep syncing.` : `${cur.name} was removed. Who's watching?`;
  if (!r.profiles.length) { ui.adding = true; ui.note = ui.note || 'Add your name — your lists and history stay yours.'; }
  paint();
}

/** Close the picker (only when it may be closed, unless forced). */
export function closeProfiles(force = false) {
  if (!ui.open || (!ui.closable && !force)) return false;
  ui.open = false; show(false);
  const el = $('pick'); if (el) el.innerHTML = '';
  return true;
}

/** Esc: leave the add field / a panel / the picker. -> true when it handled the key. */
export function escProfiles() {
  if (!ui.open) return false;
  if (ui.mode === 'grid' && ui.adding && ui.profiles.length) { ui.adding = false; ui.error = ''; paint(); return true; }
  if (ui.mode === 'import' || ui.mode === 'delete' || ui.mode === 'unsent') { ui.mode = 'grid'; ui.error = ''; paint(); return true; }
  closeProfiles();
  return true;   // a picker that can't close still swallows Esc
}

async function pick(id, opts = {}) {
  const p = ui.profiles.find(x => x.id === id);
  if (!p || ui.mode === 'busy') return;
  const cur = currentProfile();
  // Your own tile while all is well: nothing to switch.
  if (cur && cur.id === id && ui.closable && !opts.importLocal && syncStatus().state !== 'no-profile') { closeProfiles(); return; }
  ui.target = p; ui.error = ''; ui.mode = 'busy';
  ui.busyText = cur && cur.id !== id ? `Switching to ${p.name}…` : `Opening ${p.name}…`; paint();
  const r = await ctl.select(p, opts);
  if (r.needsImport) { ui.mode = 'import'; paint(); return; }
  if (r.unsent) { ui.mode = 'unsent'; paint(); return; }
  if (r.error) {
    ui.mode = 'grid'; ui.error = errorText(r.error); paint();
    if (r.error === 'no-such-profile') refresh();
    return;
  }
  if (r.switched) { try { askSession().reset(); } catch {} }   // Ask's chat was the previous person's
  paintAvatars();
  // Give the first pull a moment so the page re-renders with their lists, not empty.
  await Promise.race([r.ready, new Promise(res => setTimeout(res, 4000))]);
  closeProfiles(true);
  rerender();
}

async function createFromInput() {
  if (ui.mode !== 'grid') return;
  const f = $('pick-name'); const name = String((f && f.value) || ui.draft || '').trim();
  if (!name) { ui.error = 'Type a name first.'; paint(); return; }
  ui.draft = name; ui.error = ''; ui.mode = 'busy'; ui.target = { name, color: GREY }; ui.busyText = `Adding ${name}…`; paint();
  const r = await ctl.create(name);
  if (r.error) { ui.mode = 'grid'; ui.adding = true; ui.error = errorText(r.error); paint(); return; }
  ui.profiles = r.profiles; ui.adding = false; ui.draft = ''; ui.mode = 'grid';
  await pick(r.profile.id);
}

function openDelete(id) {
  const p = ui.profiles.find(x => x.id === id);
  if (!p || ui.mode !== 'grid') return;
  ui.target = p; ui.confirm = ''; ui.error = ''; ui.mode = 'delete'; paint();
}

async function deleteTarget() {
  const p = ui.target; if (!p || ui.mode !== 'delete') return;
  const typed = ui.confirm;
  if (!sameName(typed, p.name)) { ui.error = errorText('confirm-mismatch'); paint(); return; }
  ui.mode = 'busy'; ui.busyText = `Deleting ${p.name}…`; paint();
  const r = await ctl.remove(p, typed);
  if (r.error) { ui.mode = 'delete'; ui.error = errorText(r.error); paint(); return; }
  ui.profiles = r.profiles; ui.mode = 'grid'; ui.target = null; ui.error = '';
  if (r.wasCurrent) {
    // This browser was them: it is empty now, and someone has to pick.
    ui.closable = false; ui.note = `${p.name} is deleted. Who's watching?`;
    try { askSession().reset(); } catch {}
    paintAvatars(); rerender();
  }
  if (!ui.profiles.length) ui.adding = true;
  paint();
}

/* Long-press a tile (or right-click it) = the delete panel, like the ⋯ button. */
function initPickerGestures() {
  const el = $('pick'); if (!el) return;
  let timer = null;
  const tileOf = (e) => (e.target && e.target.closest ? e.target.closest('[data-act="profile-pick"]') : null);
  el.addEventListener('pointerdown', (e) => {
    const t = tileOf(e); if (!t || ui.mode !== 'grid') return;
    clearTimeout(timer);
    timer = setTimeout(() => { suppressClickUntil = Date.now() + 800; openDelete(t.dataset.id); }, 600);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) el.addEventListener(ev, () => clearTimeout(timer));
  el.addEventListener('contextmenu', (e) => { const t = tileOf(e); if (!t) return; e.preventDefault(); clearTimeout(timer); openDelete(t.dataset.id); });
}

onAction('profiles', () => openProfiles());
onAction('profile-pick', (el) => { if (Date.now() < suppressClickUntil) return; pick(el.dataset.id); });
onAction('profile-menu', (el) => openDelete(el.dataset.id));
onAction('profile-add', () => { ui.adding = true; ui.error = ''; paint(); });
onAction('profile-create', () => createFromInput());
onAction('profile-close', () => closeProfiles());
onAction('profile-back', () => { ui.mode = 'grid'; ui.error = ''; paint(); });
onAction('profile-retry', () => refresh());
onAction('profile-import', (el) => { if (ui.target) pick(ui.target.id, { importLocal: el.dataset.val === 'yes' }); });
onAction('profile-force', () => { if (ui.target) pick(ui.target.id, { force: true }); });
onAction('profile-delete', () => deleteTarget());
