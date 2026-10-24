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

   - Wave 8 (W1): Kids profiles and the household Parent PIN (profilelock.js
     holds the rules, worker/profiles.js enforces them). A tile shows Kids / 🔒;
     ⋯ opens Edit (Kids + its level, Lock with Parent PIN, Delete) and the
     grid's "Parent PIN" sets, changes or removes it. Picking a locked profile,
     or leaving a Kids one, asks for the PIN first; so does any change once a
     PIN exists (one entry unlocks the rest of that visit). The browser derives
     the proof (PBKDF2) and sends only that; the Worker checks it on /select, so
     a direct API call can't skip the prompt. A Kids profile's catalog limits
     are kids.js; the body's `kids` class takes Live and Read off the chrome.

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
import {
  isKidsProfile, needsPIN, isValidPin, pinProof, newSalt, countdown, KIDS_LEVELS, KIDS_DEFAULT, MATURITY_TITLE, MATURITY_DETAIL, PIN_ITERATIONS,
} from './profilelock.js';

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

/** The local record of who's watching: {id, name, color} plus the Kids flag
    and level when set (kids.js reads them for the catalog cap). */
export function localProfile(q) {
  const out = { id: q.id, name: q.name, color: profileColor(q) };
  if (isKidsProfile(q)) { out.kids = true; out.maturity = KIDS_LEVELS.includes(q.maturity) ? q.maturity : KIDS_DEFAULT; }
  return out;
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
    const headers = { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) };
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
    const out = { profiles: Array.isArray(r.json.profiles) ? r.json.profiles : [], current: r.json.current || null };
    if (r.json.pin) out.pin = r.json.pin;   // W8: only once a Parent PIN is set
    return out;
  }

  /** A refusal, with the PIN details the prompt shows (W8). */
  const failed = (r) => ({ error: r.error, retryAfter: r.json.retryAfter || 0, failures: r.json.failures || 0 });
  const withProof = (proof) => (proof ? { 'x-sw-pin': proof } : {});

  /** -> { profile, profiles } | { error, profile? } (proof: the Parent PIN's, once one is set) */
  async function create(name, proof) {
    const r = await call(PROFILES_PATH, { method: 'POST', body: JSON.stringify({ name }), headers: withProof(proof) });
    return r.ok ? { profile: r.json.profile, profiles: r.json.profiles || [] } : { ...failed(r), profile: r.json.profile || null };
  }

  /** Kids / level / lock on one profile. patch: {kids?, maturity?, locked?} -> { profile, profiles } | { error } */
  async function update(p, patch, proof) {
    const r = await call(PROFILES_PATH + '/' + encodeURIComponent(p.id), { method: 'PATCH', body: JSON.stringify(patch), headers: withProof(proof) });
    if (!r.ok) return failed(r);
    const cur = current();
    if (cur && cur.id === p.id) store.setState({ profile: localProfile(r.json.profile) }, { source: 'sync' });
    return { profile: r.json.profile, profiles: r.json.profiles || [] };
  }

  /** The Parent PIN: check a proof · set or change (pin = the new digits) · remove. */
  async function checkPin(proof) {
    const r = await call(PROFILES_PATH + '/pin/check', { method: 'POST', body: '{}', headers: withProof(proof) });
    return r.ok ? { ok: true } : failed(r);
  }
  async function setPin(pin, proof, salt = newSalt()) {
    const newProof = await pinProof(pin, salt, PIN_ITERATIONS);
    const r = await call(PROFILES_PATH + '/pin', { method: 'POST', body: JSON.stringify({ salt, newProof, iterations: PIN_ITERATIONS }), headers: withProof(proof) });
    return r.ok ? { ok: true, pin: r.json.pin, proof: newProof } : failed(r);
  }
  async function removePin(proof) {
    const r = await call(PROFILES_PATH + '/pin', { method: 'DELETE', headers: withProof(proof) });
    return r.ok ? { ok: true, profiles: r.json.profiles || [] } : failed(r);
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
      opts.pinProof     the Parent PIN's proof, when the switch needs it (W8)
      -> { ok, profile, switched, ready } | { needsImport } | { unsent } | { error[, retryAfter, failures] } */
  async function select(p, { importLocal = null, force = false, pinProof: proof = '' } = {}) {
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
    const r = await call(PROFILES_PATH + '/select', { method: 'POST', body: JSON.stringify(proof ? { id: p.id, pinProof: proof } : { id: p.id }) });
    if (!r.ok) {
      if (prev && live) sync.start(prev.id);   // nothing changed: carry on as before
      return failed(r);
    }
    // 3. Someone else's data never shows under this name: start from empty
    //    (unless it's the same profile again, or a first pick that keeps it).
    if (!same && !(firstPick && importLocal)) resetStore();
    const profile = localProfile(r.json.profile || p);
    store.setState({ profile }, { source: 'sync' });
    // 4. Pull the new profile's state (and, after an import, upload what it lacks).
    const ready = Promise.resolve(sync.start(profile.id));
    return { ok: true, profile, switched: !same, ready };
  }

  /** Delete `p` and its history (`confirm` must be its name). Deleting the
      current profile empties this browser and leaves no profile picked.
      -> { ok, profiles, wasCurrent } | { error } */
  async function remove(p, confirm, proof) {
    const r = await call(PROFILES_PATH + '/' + encodeURIComponent(p.id) + '?confirm=' + encodeURIComponent(confirm), { method: 'DELETE', headers: withProof(proof) });
    if (!r.ok) return failed(r);
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

  /** W8: bring the remembered profile's Kids flags up to date from a fresh list
      (another device may have changed them; a hand-edited local copy is
      corrected). -> true when the local record changed. */
  function refreshLocal(profiles) {
    const cur = current(); if (!cur) return false;
    const q = (profiles || []).find(x => x.id === cur.id);
    if (!q) return false;
    const next = localProfile(q);
    if (JSON.stringify(next) === JSON.stringify(cur)) return false;
    store.setState({ profile: next }, { source: 'sync' });
    return true;
  }

  return { current, list, create, select, remove, boot, resetStore, update, checkPin, setPin, removePin, refreshLocal };
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
    const flipped = paintAvatars();
    const id = s.profile ? s.profile.id : null;
    if (source === 'storage' && id !== active) location.reload();
    // W8: this profile became (or stopped being) Kids: the rows, the chrome and
    // the routes change with the cap. The picker re-renders when it closes.
    else if (flipped) { if (ui.open) ui.dirty = true; else rerender(); }
  });
  initPickerGestures();
  paintAvatars();
  if (ctl.boot() === 'pick') { openProfiles({ boot: true }); return; }
  // W8: the remembered record's Kids flags may be stale (changed on another
  // device) or hand-edited: the server's list is the truth.
  ctl.list().then(r => { if (!r.error && !r.unconfigured) { ui.pin = r.pin || null; ctl.refreshLocal(r.profiles); } }).catch(() => {});
}

/** Re-render the current route (main.js renders on hashchange). */
const rerender = () => window.dispatchEvent(new Event('hashchange'));

// ── Header avatar (desktop) + the phone header's profile icon ────────────────
let kidsChrome = null;   // W8: whether the page wears the Kids chrome (null: not painted yet)
/** Paint the avatars (and the body's `kids` class). -> true when Kids flipped. */
export function paintAvatars() {
  const p = currentProfile();
  const kids = isKidsProfile(p);
  const flipped = kidsChrome !== null && kidsChrome !== kids;
  kidsChrome = kids;
  try { document.body.classList.toggle('kids', kids); } catch {}   // layout.css: no Live / Read entries
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
  return flipped;
}

// ── The picker overlay ───────────────────────────────────────────────────────
/* One state object, one paint(). Modes:
     loading · grid (tiles + Add name) · error · unconfigured ·
     import (first pick: bring local history?) · delete (type the name) ·
     unsent (old profile's changes didn't upload: switch anyway?) · busy ·
     W8: pin (enter the Parent PIN — to open or leave a profile, or before a
     change) · edit (one profile: Kids, its level, the lock, Delete) ·
     pinset (set, change or remove the Parent PIN) */
const ui = { open: false, closable: false, mode: 'loading', profiles: [], adding: false, draft: '', confirm: '',
  target: null, note: '', error: '', busyText: '', boot: false,
  pin: null, pinFor: '', after: null, proof: '', pickProof: '', lockedUntil: 0, flags: null, dirty: false };
let suppressClickUntil = 0;
let lockTimer = null;

export const isProfilesOpen = () => ui.open;

const ERRORS = {
  'name-taken': "That name's already here — tap it instead.",
  'too-many': `That's ${MAX_PROFILES} names — delete one first.`,
  'bad-name': `Names are 1–${MAX_NAME} characters.`,
  'offline': "Can't reach SlimeWatch — check your connection.",
  'no-such-profile': 'That name was just removed.',
  'confirm-mismatch': 'Type the name exactly to confirm.',
  'pin-wrong': "That's not the Parent PIN.",
  'pin-locked': 'Too many wrong tries.',
  'pin-required': 'This needs the Parent PIN.',
  'pin-mismatch': "The two PINs don't match.",
  'bad-pin': 'The PIN is 4–6 digits.',
  'no-pin': 'Set a Parent PIN first.',
  'bad-flags': "That change didn't save.",
  'no-crypto': "This browser can't check a PIN on this page (it needs the https site).",
};
const errorText = (code) => ERRORS[code] || 'Something went wrong (' + code + ').';

const pinField = (id, label, extra = '') =>
  `<input id="${id}" class="pick-input pick-pin" type="password" inputmode="numeric" autocomplete="off" maxlength="6" aria-label="${label}" placeholder="${label}"${extra}>`;

/** The overlay's markup for a state (exported for test/profiles.mjs, test/parity.mjs). */
export function pickerHTML(s, cur) {
  const t = s.target;
  const hasPin = !!(s.pin && s.pin.set);
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
  } else if (s.mode === 'pin') {
    const wait = Math.max(0, Math.ceil(((s.lockedUntil || 0) - (s.now || Date.now())) / 1000));
    const why = s.pinFor !== 'select' ? 'Changing profiles needs the Parent PIN.'
      : t && t.locked ? `${esc(t.name)} is locked.`
      : `Leaving ${esc(cur ? cur.name : 'a Kids profile')} needs the Parent PIN.`;
    body = `<div class="pick-panel">${t ? avatarHTML(t) : ''}
      <h2>Enter the Parent PIN</h2><p class="pick-note">${why}</p>
      ${pinField('pick-pin', 'Parent PIN', wait ? ' disabled' : '')}
      ${wait ? `<p class="pick-note pick-err" role="alert">Too many wrong tries — try again in ${countdown(wait)}.</p>` : err}
      <div class="pick-row"><button class="pick-btn primary" data-act="profile-pin-ok"${wait ? ' disabled' : ''}>OK</button>${back()}</div></div>`;
  } else if (s.mode === 'edit' && t && s.flags) {
    const f = s.flags;
    const levels = KIDS_LEVELS.map(l => `<button role="radio" aria-checked="${f.maturity === l}" class="pick-btn small${f.maturity === l ? ' on' : ''}" data-act="profile-flag" data-flag="maturity" data-val="${l}">${MATURITY_TITLE[l]}</button>`).join('');
    body = `<div class="pick-panel">${avatarHTML(t)}<h2>${esc(t.name)}</h2>
      <label class="pick-check"><input type="checkbox" data-act="profile-flag" data-flag="kids"${f.kids ? ' checked' : ''}> Kids profile
        <span>Only titles rated for kids show and play; no Live, Read or Ask.</span></label>
      ${f.kids ? `<div class="pick-row pick-levels" role="radiogroup" aria-label="Maturity">${levels}</div>
        <p class="pick-note">${esc(MATURITY_DETAIL[f.maturity] || '')}.${hasPin ? '' : ' Set a Parent PIN so leaving this profile asks for it.'}</p>` : ''}
      <label class="pick-check"><input type="checkbox" data-act="profile-flag" data-flag="locked"${f.locked ? ' checked' : ''}${hasPin ? '' : ' disabled'}> Lock with Parent PIN
        <span>${hasPin ? 'Opening this profile asks for the PIN.' : 'Set a Parent PIN first.'}</span></label>
      ${err}<div class="pick-row"><button class="pick-btn primary" data-act="profile-save">Save</button>
        <button class="pick-btn danger" data-act="profile-ask-delete">Delete…</button>${back()}</div></div>`;
  } else if (s.mode === 'pinset') {
    body = `<div class="pick-panel"><h2>${hasPin ? 'Parent PIN' : 'Set a Parent PIN'}</h2>
      <p class="pick-note">${hasPin ? 'Change it, or remove it (which also unlocks every profile).'
        : '4–6 digits. Leaving a Kids profile, opening a locked one and changing profiles will ask for it, on every browser.'}</p>
      ${pinField('pick-pin-a', hasPin ? 'New PIN' : 'PIN')}${pinField('pick-pin-b', 'Again')}
      ${err}<div class="pick-row"><button class="pick-btn primary" data-act="profile-pin-save">${hasPin ? 'Change' : 'Set PIN'}</button>
        ${hasPin ? '<button class="pick-btn danger" data-act="profile-pin-remove">Remove PIN</button>' : ''}${back()}</div></div>`;
  } else {
    const tiles = s.profiles.map(p => `<div class="pick-tile${cur && cur.id === p.id ? ' cur' : ''}">
        <button class="pick-face" data-act="profile-pick" data-id="${esc(p.id)}">${avatarHTML(p)}<span class="pick-name">${esc(p.name)}</span>${
          p.kids === true ? '<span class="pick-tag">Kids</span>' : ''}${p.locked === true ? '<span class="pick-tag" aria-label="Locked">🔒</span>' : ''}</button>
        <button class="pick-more" data-act="profile-menu" data-id="${esc(p.id)}" title="Edit…" aria-label="Edit ${esc(p.name)}…">⋯</button>
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
      ${s.profiles.length ? `<p class="pick-hint">Hold a name (or ⋯) to edit or delete it.</p>
        <button class="pick-btn small" data-act="profile-pin">${hasPin ? '🔒 Parent PIN' : 'Set a Parent PIN'}</button>` : ''}
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
  const pin = $('pick-pin'), pinA = $('pick-pin-a'), pinB = $('pick-pin-b');
  if (pin) pin.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitPin(); } });
  if (pinA && pinB) pinA.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); pinB.focus(); } });
  if (pinB) pinB.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); savePin(); } });
  const focus = name || conf || (pin && !pin.disabled ? pin : null) || pinA;
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
    confirm: '', target: null, note: '', error: '', boot: !!opts.boot, lost: !!opts.lost,
    pinFor: '', after: null, proof: '', pickProof: '', lockedUntil: 0, flags: null });
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
  ui.profiles = r.profiles; ui.pin = r.pin || null; ui.mode = 'grid';
  ctl.refreshLocal(r.profiles);
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
  // The PIN's proof lives for one visit to the picker ("one entry unlocks the visit").
  ui.proof = ''; ui.pickProof = ''; ui.after = null; clearInterval(lockTimer); lockTimer = null;
  if (ui.dirty) { ui.dirty = false; rerender(); }
  return true;
}

/** Esc: leave the add field / a panel / the picker. -> true when it handled the key. */
export function escProfiles() {
  if (!ui.open) return false;
  if (ui.mode === 'grid' && ui.adding && ui.profiles.length) { ui.adding = false; ui.error = ''; paint(); return true; }
  if (['import', 'delete', 'unsent', 'pin', 'edit', 'pinset'].includes(ui.mode)) { ui.mode = 'grid'; ui.error = ''; paint(); return true; }
  closeProfiles();
  return true;   // a picker that can't close still swallows Esc
}

// ── The Parent PIN prompt (W8) ───────────────────────────────────────────────
const hasPIN = () => !!(ui.pin && ui.pin.set);
/** Who's watching, as the server's list knows them (its Kids flag). */
const curRecord = () => { const c = currentProfile(); return c ? (ui.profiles.find(x => x.id === c.id) || c) : null; };

/** Show "Enter the Parent PIN". pinFor 'select' picks `target` next; 'manage' runs after(). */
function askPin(pinFor, target, after) {
  Object.assign(ui, { pinFor, target: target || null, after: after || null, error: '', mode: 'pin' });
  if (ui.pin && ui.pin.retryAfter > 0) { ui.lockedUntil = Date.now() + ui.pin.retryAfter * 1000; ui.pin = { ...ui.pin, retryAfter: 0 }; }
  paint(); armLockTimer();
}
/** A change: go ahead with this visit's proof, or ask for the PIN first (none set: just go). */
function managed(then) { if (!hasPIN() || ui.proof) then(); else askPin('manage', ui.target, then); }

function pinRefused(r) {
  ui.mode = 'pin'; ui.error = errorText(r.error);
  if (r.retryAfter > 0) ui.lockedUntil = Date.now() + r.retryAfter * 1000;
  paint(); armLockTimer();
}
/** Repaint the countdown once a second while the prompt waits out a lockout. */
function armLockTimer() {
  clearInterval(lockTimer); lockTimer = null;
  if (!(ui.lockedUntil > Date.now())) return;
  lockTimer = setInterval(() => {
    if (!ui.open || ui.mode !== 'pin') { clearInterval(lockTimer); lockTimer = null; return; }
    if (Date.now() >= ui.lockedUntil) { clearInterval(lockTimer); lockTimer = null; ui.error = ''; }
    paint();
  }, 1000);
}

async function submitPin() {
  if (ui.mode !== 'pin' || Date.now() < ui.lockedUntil) return;
  const f = $('pick-pin'); const pin = String((f && f.value) || '');
  if (!isValidPin(pin)) { ui.error = errorText('bad-pin'); paint(); return; }
  if (!hasPIN()) { ui.mode = 'grid'; await refresh(); return; }   // the PIN went away meanwhile
  const keep = { target: ui.target, pinFor: ui.pinFor, after: ui.after };
  ui.mode = 'busy'; ui.busyText = 'Checking…'; paint();
  let proof;
  try { proof = await pinProof(pin, ui.pin.salt, ui.pin.iterations || PIN_ITERATIONS); }
  catch { Object.assign(ui, keep, { mode: 'pin', error: errorText('no-crypto') }); paint(); return; }
  if (keep.pinFor === 'select') { ui.pickProof = proof; ui.mode = 'grid'; await pick(keep.target.id, { pinProof: proof }); return; }
  const r = await ctl.checkPin(proof);
  if (r.error) { Object.assign(ui, keep); pinRefused(r); return; }
  ui.proof = proof; ui.mode = 'grid'; ui.error = '';
  if (keep.after) keep.after(); else paint();
}

async function pick(id, opts = {}) {
  const p = ui.profiles.find(x => x.id === id);
  if (!p || ui.mode === 'busy') return;
  const cur = currentProfile();
  // Your own tile while all is well: nothing to switch.
  if (cur && cur.id === id && ui.closable && !opts.importLocal && syncStatus().state !== 'no-profile') { closeProfiles(); return; }
  // W8: a locked profile, or leaving a Kids one, asks for the PIN first (the
  // Worker asks again). Any proof from this visit is the same PIN's.
  const proof = opts.pinProof || ui.pickProof || ui.proof;
  if (!proof && needsPIN({ current: curRecord(), target: p, hasPIN: hasPIN() })) { askPin('select', p, null); return; }
  ui.target = p; ui.error = ''; ui.mode = 'busy';
  ui.busyText = cur && cur.id !== id ? `Switching to ${p.name}…` : `Opening ${p.name}…`; paint();
  const r = await ctl.select(p, { ...opts, pinProof: proof });
  if (r.needsImport) { ui.mode = 'import'; paint(); return; }
  if (r.unsent) { ui.mode = 'unsent'; paint(); return; }
  if (r.error) {
    if (/^pin-/.test(r.error)) {
      ui.pickProof = '';
      if (!hasPIN()) { const l = await ctl.list(); ui.pin = l.pin || null; if (l.profiles && l.profiles.length) ui.profiles = l.profiles; }
      ui.pinFor = 'select'; ui.target = p; ui.after = null; pinRefused(r); return;
    }
    ui.mode = 'grid'; ui.error = errorText(r.error); paint();
    if (r.error === 'no-such-profile') refresh();
    return;
  }
  ui.pickProof = '';
  if (r.switched) { try { askSession().reset(); } catch {} }   // Ask's chat was the previous person's
  paintAvatars();
  // Give the first pull a moment so the page re-renders with their lists, not empty.
  await Promise.race([r.ready, new Promise(res => setTimeout(res, 4000))]);
  ui.dirty = false;
  closeProfiles(true);
  rerender();
}

async function createFromInput() {
  if (ui.mode !== 'grid') return;
  const f = $('pick-name'); const name = String((f && f.value) || ui.draft || '').trim();
  if (!name) { ui.error = 'Type a name first.'; paint(); return; }
  ui.draft = name;
  if (hasPIN() && !ui.proof) { ui.target = null; managed(() => { ui.adding = true; createFromInput(); }); return; }
  ui.error = ''; ui.mode = 'busy'; ui.target = { name, color: GREY }; ui.busyText = `Adding ${name}…`; paint();
  const r = await ctl.create(name, ui.proof);
  if (r.error) { if (/^pin-/.test(r.error)) ui.proof = ''; ui.mode = 'grid'; ui.adding = true; ui.error = errorText(r.error); paint(); return; }
  ui.profiles = r.profiles; ui.adding = false; ui.draft = ''; ui.mode = 'grid';
  await pick(r.profile.id);
}

/** ⋯ / long-press: the profile's Edit panel (after the PIN, once one is set). */
function openEdit(id) {
  const p = ui.profiles.find(x => x.id === id);
  if (!p || ui.mode !== 'grid') return;
  ui.target = p;
  managed(() => {
    Object.assign(ui, { target: p, error: '', mode: 'edit',
      flags: { kids: p.kids === true, maturity: KIDS_LEVELS.includes(p.maturity) ? p.maturity : KIDS_DEFAULT, locked: p.locked === true } });
    paint();
  });
}

async function saveEdit() {
  const t = ui.target, f = ui.flags;
  if (!t || !f || ui.mode !== 'edit') return;
  const patch = f.kids ? { kids: true, maturity: f.maturity, locked: f.locked } : { kids: false, locked: f.locked };
  ui.mode = 'busy'; ui.busyText = `Saving ${t.name}…`; paint();
  const cur = currentProfile();
  const r = await ctl.update(t, patch, ui.proof);
  if (r.error) { if (/^pin-/.test(r.error)) ui.proof = ''; ui.mode = 'edit'; ui.error = errorText(r.error); paint(); return; }
  ui.profiles = r.profiles; ui.mode = 'grid'; ui.target = null; ui.flags = null;
  if (cur && cur.id === t.id) ui.dirty = true;   // this browser's own cap may have changed: re-render on close
  paint();
}

function openDelete(id) {
  const p = ui.profiles.find(x => x.id === id);
  if (!p || (ui.mode !== 'grid' && ui.mode !== 'edit')) return;
  ui.target = p; ui.confirm = ''; ui.error = ''; ui.mode = 'delete'; paint();
}

async function deleteTarget() {
  const p = ui.target; if (!p || ui.mode !== 'delete') return;
  const typed = ui.confirm;
  if (!sameName(typed, p.name)) { ui.error = errorText('confirm-mismatch'); paint(); return; }
  if (hasPIN() && !ui.proof) { managed(() => { ui.target = p; ui.confirm = typed; ui.mode = 'delete'; deleteTarget(); }); return; }
  ui.mode = 'busy'; ui.busyText = `Deleting ${p.name}…`; paint();
  const r = await ctl.remove(p, typed, ui.proof);
  if (r.error) { if (/^pin-/.test(r.error)) ui.proof = ''; ui.mode = 'delete'; ui.error = errorText(r.error); paint(); return; }
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

/** The grid's "Parent PIN": set one, or (after the current one) change or remove it. */
function openPinSet() {
  if (ui.mode !== 'grid') return;
  ui.target = null;
  managed(() => { ui.error = ''; ui.mode = 'pinset'; paint(); });
}
async function savePin() {
  if (ui.mode !== 'pinset') return;
  const a = String(($('pick-pin-a') || {}).value || ''), b = String(($('pick-pin-b') || {}).value || '');
  if (!isValidPin(a)) { ui.error = errorText('bad-pin'); paint(); return; }
  if (a !== b) { ui.error = errorText('pin-mismatch'); paint(); return; }
  ui.mode = 'busy'; ui.busyText = 'Saving the PIN…'; paint();
  let r;
  try { r = await ctl.setPin(a, ui.proof); } catch { r = { error: 'no-crypto' }; }
  if (r.error) { if (/^pin-/.test(r.error)) ui.proof = ''; ui.mode = 'pinset'; ui.error = errorText(r.error); paint(); return; }
  Object.assign(ui, { pin: r.pin, proof: r.proof, mode: 'grid', error: '', note: 'Parent PIN set.' });
  paint();
}
async function removePinNow() {
  if (ui.mode !== 'pinset') return;
  ui.mode = 'busy'; ui.busyText = 'Removing the PIN…'; paint();
  const r = await ctl.removePin(ui.proof);
  if (r.error) { if (/^pin-/.test(r.error)) ui.proof = ''; ui.mode = 'pinset'; ui.error = errorText(r.error); paint(); return; }
  Object.assign(ui, { pin: null, proof: '', profiles: r.profiles, mode: 'grid', error: '', note: 'Parent PIN removed — every profile is unlocked.' });
  paint();
}

/* Long-press a tile (or right-click it) = its Edit panel, like the ⋯ button. */
function initPickerGestures() {
  const el = $('pick'); if (!el) return;
  let timer = null;
  const tileOf = (e) => (e.target && e.target.closest ? e.target.closest('[data-act="profile-pick"]') : null);
  el.addEventListener('pointerdown', (e) => {
    const t = tileOf(e); if (!t || ui.mode !== 'grid') return;
    clearTimeout(timer);
    timer = setTimeout(() => { suppressClickUntil = Date.now() + 800; openEdit(t.dataset.id); }, 600);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) el.addEventListener(ev, () => clearTimeout(timer));
  el.addEventListener('contextmenu', (e) => { const t = tileOf(e); if (!t) return; e.preventDefault(); clearTimeout(timer); openEdit(t.dataset.id); });
}

onAction('profiles', () => openProfiles());
onAction('profile-pick', (el) => { if (Date.now() < suppressClickUntil) return; pick(el.dataset.id); });
onAction('profile-menu', (el) => openEdit(el.dataset.id));
onAction('profile-add', () => { ui.adding = true; ui.error = ''; paint(); });
onAction('profile-create', () => createFromInput());
onAction('profile-close', () => closeProfiles());
onAction('profile-back', () => { ui.mode = 'grid'; ui.error = ''; paint(); });
onAction('profile-retry', () => refresh());
onAction('profile-import', (el) => { if (ui.target) pick(ui.target.id, { importLocal: el.dataset.val === 'yes' }); });
onAction('profile-force', () => { if (ui.target) pick(ui.target.id, { force: true }); });
onAction('profile-delete', () => deleteTarget());
onAction('profile-pin', () => openPinSet());
onAction('profile-pin-ok', () => submitPin());
onAction('profile-pin-save', () => savePin());
onAction('profile-pin-remove', () => removePinNow());
onAction('profile-save', () => saveEdit());
onAction('profile-ask-delete', () => { if (ui.target) openDelete(ui.target.id); });
onAction('profile-flag', (el) => {
  if (ui.mode !== 'edit' || !ui.flags) return;
  const k = el.dataset.flag;
  ui.flags = k === 'maturity' ? { ...ui.flags, maturity: KIDS_LEVELS.includes(el.dataset.val) ? el.dataset.val : KIDS_DEFAULT } : { ...ui.flags, [k]: !!el.checked };
  ui.error = ''; paint();
});
