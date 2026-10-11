// Settings sheet: Connect Debrid (BYO Real-Debrid key, stored in this browser —
// mirrors the iOS/tvOS flow), captions + anime audio prefs (synced), the home
// server's reachability, sync status, "Install app" when the browser offers
// it, and the build. The pref sections repaint in place, so a half-typed RD
// token survives a tap elsewhere in the sheet.

import { esc, $ } from '../util.js';
import { rdCheck, apiFetch } from '../api.js';
import { getRdKey, setRdKey, clearRdKey, getPrefs, setPrefs } from '../state.js';
import { syncStatus, onSyncStatus, syncNow } from '../sync.js';
import { onAction } from './actions.js';
import { installRowHTML } from './install.js';
import { closeDetail } from '../views/detail.js';

export const CAPTION_LANGS = [
  ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'],
  ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'], ['ar', 'Arabic'], ['hi', 'Hindi'], ['ru', 'Russian'],
  ['nl', 'Dutch'], ['sv', 'Swedish'], ['pl', 'Polish'], ['tr', 'Turkish'], ['id', 'Indonesian'], ['th', 'Thai'],
  ['vi', 'Vietnamese'], ['he', 'Hebrew'],
];
const langName = (code) => (CAPTION_LANGS.find(l => l[0] === code) || [code, String(code).toUpperCase()])[1];
const SIZES = [['S', 'Small'], ['M', 'Medium'], ['L', 'Large']];
const AUDIO = [['dub', 'Dub'], ['sub', 'Sub']];

let health = null, healthAt = 0, offSync = null;

export function openSettings() { const m = $('setmodal'), sh = $('setsheet');
  closeDetail(); m.classList.add('open'); const key = getRdKey();
  sh.innerHTML = `<div class="set">
    <div class="set-top"><h1>Settings</h1><button class="set-btn" data-act="settings-close">Done</button></div>

    <section class="set-sec">
      <h2>Debrid <span style="color:var(--accent)">HD</span></h2>
      <p class="set-note">Play clean, ad-free HD straight from your own Real-Debrid account — tried before the embed sources, just like the iOS &amp; TV apps. Your key is stored <b>only in this browser</b> and sent per request; it's never a shared server secret. <a href="https://real-debrid.com/apitoken" target="_blank" rel="noopener" style="color:var(--accent)">Get your API token ↗</a></p>
      <div class="set-line">
        <input id="rdfield" class="set-input" type="password" placeholder="Paste your Real-Debrid API token" value="${esc(key)}" autocomplete="off" autocapitalize="off" spellcheck="false">
        <button class="set-btn primary" data-act="debrid-connect">Connect</button>
      </div>
      <div id="rdstatus" class="set-status">${key ? '✓ A key is saved on this device.' : ''}</div>
      ${key ? '<button class="set-btn danger" data-act="debrid-remove">Remove key</button>' : ''}
    </section>

    <section class="set-sec"><h2>Captions</h2><div id="set-captions"></div></section>
    <section class="set-sec"><h2>Anime audio</h2><div id="set-audio"></div></section>
    <section class="set-sec"><h2>Home server</h2><div id="set-server"></div></section>
    <section class="set-sec"><h2>Sync</h2><div id="set-sync"></div></section>
    ${installRowHTML()}
    <section class="set-sec"><h2>About</h2><div id="set-about"></div></section>
  </div>`;
  $('rdfield').addEventListener('keydown', (event) => { if (event.key === 'Enter') connectDebrid(); });
  paintPrefs(); paintSync(); paintHealth();
  if (offSync) offSync();
  offSync = onSyncStatus(() => paintSync());
  if (!health || Date.now() - healthAt > 60000) checkServer();
}
export function closeSettings() { $('setmodal').classList.remove('open'); if (offSync) { offSync(); offSync = null; } }
export const isSettingsOpen = () => $('setmodal').classList.contains('open');

const seg = (pref, options, current) => `<div class="set-seg" role="radiogroup">${options.map(([v, label]) =>
  `<button role="radio" aria-checked="${v === current}" class="${v === current ? 'on' : ''}" data-act="set-pref" data-pref="${pref}" data-val="${v}">${esc(label)}</button>`).join('')}</div>`;

/** The caption languages in effect, best first: the player's current pick
    (subLang) leads, then the rest of the Settings list. */
export function captionLangs(p) {
  const list = Array.isArray(p.subLangs) && p.subLangs.length ? p.subLangs : ['en'];
  return p.subLang ? [p.subLang, ...list.filter(c => c !== p.subLang)] : [...list];
}

function paintPrefs() {
  const p = getPrefs();
  const box = $('set-captions');
  if (box) {
    const langs = captionLangs(p);
    const left = CAPTION_LANGS.filter(l => !langs.includes(l[0]));
    box.innerHTML = `<p class="set-note">Captions stay off unless you turn them on automatically here, or pick a language in the player (which then becomes your first choice). Subtitled anime always shows them.</p>
      <div class="set-label">Turn on automatically</div>${seg('subAuto', [['off', 'Off'], ['on', 'On']], p.subLang ? 'on' : 'off')}
      <div class="set-label">Languages, best first</div>
      <div class="set-chips">${langs.map((c, i) => `<span class="set-chip">${i + 1}. ${esc(langName(c))}${
        i > 0 ? `<button title="Move up" aria-label="Move ${esc(langName(c))} up" data-act="caption-lang-up" data-lang="${esc(c)}">↑</button>` : ''}${
        langs.length > 1 ? `<button title="Remove" aria-label="Remove ${esc(langName(c))}" data-act="caption-lang-remove" data-lang="${esc(c)}">✕</button>` : ''}</span>`).join('')}
        ${left.length ? `<select id="caplang" class="set-select" aria-label="Add a language"><option value="">+ Add language</option>${left.map(([c, n]) => `<option value="${c}">${esc(n)}</option>`).join('')}</select>` : ''}
      </div>
      <div class="set-label">Size</div>${seg('subSize', SIZES, p.subSize)}`;
    const sel = $('caplang');
    if (sel) sel.addEventListener('change', () => { if (sel.value) addCaptionLang(sel.value); paintPrefs(); });
  }
  const audio = $('set-audio');
  if (audio) audio.innerHTML = `<p class="set-note">What anime plays with first: the English dub (it falls back to subtitles when a title has no dub), or Japanese audio with subtitles. The player's Sub/Dub switch changes the same setting.</p>${seg('animeAudio', AUDIO, p.animeAudio === 'sub' ? 'sub' : 'dub')}`;
}

/** [tone, words] for a sync status ({state, at, detail}). */
export function syncText(st, now = Date.now()) {
  const ago = (t) => { const s = Math.round((now - t) / 1000); return s < 10 ? 'just now' : s < 60 ? s + ' s ago' : s < 3600 ? Math.round(s / 60) + ' min ago' : Math.round(s / 3600) + ' h ago'; };
  switch (st.state) {
    case 'synced': return ['ok', 'Synced' + (st.at ? ' ' + ago(st.at) : '') + ' — My List, Continue Watching, reading and these settings follow you to every browser you sign in on.'];
    case 'pending': case 'syncing': case 'connecting': return ['busy', 'Syncing…'];
    case 'offline': return ['warn', "Offline — changes are kept here and sync when you're back online."];
    case 'local': return ['dim', "Sync isn't set up on this site — your lists stay in this browser."];
    case 'signed-out': return ['warn', 'Signed out — sign in again to sync.'];
    case 'error': return ['warn', st.detail === 'too-large' ? 'Sync paused: your saved data is over the 256 KB limit.' : 'Sync hit a problem' + (st.detail ? ' (' + st.detail + ')' : '') + ' — retrying.'];
    default: return ['dim', 'Sync is off in this tab.'];
  }
}

function paintSync() {
  const box = $('set-sync'); if (!box) return;
  const st = syncStatus(), [tone, text] = syncText(st);
  const can = st.state !== 'local' && st.state !== 'off' && st.state !== 'signed-out';
  box.innerHTML = `<div class="set-state ${tone}"><i></i><span>${esc(text)}</span></div>
    ${can ? '<button class="set-btn" data-act="sync-now">Sync now</button>' : ''}`;
}

function paintHealth() {
  const box = $('set-server'), about = $('set-about'), h = health;
  if (box) {
    if (!h) box.innerHTML = '<div class="set-state busy"><i></i><span>Checking…</span></div>';
    else {
      const x = h.extractor || {};
      const [tone, text] = !x.base && !x.error ? ['dim', 'No extractor configured (EXTRACTOR_BASE).']
        : x.ok ? ['ok', `Reachable · ${x.ms} ms`]
        : x.error === 'draining' ? ['warn', 'Restarting — try again shortly.']
        : ['warn', 'Not reachable' + (x.error ? ' (' + x.error + ')' : x.status ? ' (HTTP ' + x.status + ')' : '') + '.'];
      box.innerHTML = `<p class="set-note">The SlimeWatch extractor${x.base ? ` at <b>${esc(x.base)}</b>` : ''} powers Live TV, Sports and the ad-free tier.</p>
        <div class="set-state ${tone}"><i></i><span>${esc(text)}</span></div>
        <button class="set-btn" data-act="server-check">Check again</button>`;
    }
  }
  if (about) about.innerHTML = `<p class="set-note">SlimeWatch for the web${h && h.build ? ` · build <code>${esc(h.build)}</code>` : ''}${h && h.ask != null ? ` · Ask ${h.ask ? 'on' : 'not set up'}` : ''}.</p>
    <button class="set-btn" data-act="logout">Sign out</button>`;
}

async function checkServer() {
  health = null; paintHealth();
  try { const r = await apiFetch('/api/state/health', { cache: 'no-store' }); health = r.ok ? await r.json() : { extractor: { ok: false, error: 'HTTP ' + r.status } }; }
  catch { health = { extractor: { ok: false, error: 'offline' } }; }
  healthAt = Date.now();
  if (isSettingsOpen()) paintHealth();
}

async function connectDebrid() { const f = $('rdfield'), st = $('rdstatus');
  const key = (f.value || '').trim(); if (!key) { st.style.color = '#f4665f'; st.textContent = 'Paste your token first.'; return; }
  st.style.color = 'var(--dim)'; st.textContent = 'Checking…';
  try { const j = await rdCheck(key);
    if (j.valid) { setRdKey(key); st.style.color = 'var(--accent)';
      st.innerHTML = '✓ Connected' + (j.name ? ' as <b>' + esc(j.name) + '</b>' : '') + '. Debrid HD is on — reopen the player to use it.'; }
    else { st.style.color = '#f4665f'; st.textContent = j.reason === 'invalid' ? 'Real-Debrid rejected that token — check it and try again.' : 'Couldn\'t reach Real-Debrid — try again in a moment.'; }
  } catch { st.style.color = '#f4665f'; st.textContent = 'Network error — try again.'; }
}
function removeDebrid() { clearRdKey(); openSettings(); }

// ── Pref writes (exported for the checks; `store` is for tests) ──────────────
/** Save a caption-language order; an automatic language follows the new first choice. */
function saveLangs(langs, store) {
  const patch = { subLangs: langs };
  if (getPrefs(store).subLang) patch.subLang = langs[0];
  setPrefs(patch, store);
}
export function applyPref(pref, val, store) {
  if (pref === 'subSize' && SIZES.some(s => s[0] === val)) setPrefs({ subSize: val }, store);
  else if (pref === 'animeAudio' && AUDIO.some(a => a[0] === val)) setPrefs({ animeAudio: val }, store);
  else if (pref === 'subAuto' && (val === 'on' || val === 'off')) {
    setPrefs({ subLang: val === 'on' ? captionLangs(getPrefs(store))[0] : null }, store);
  }
}
export function addCaptionLang(code, store) {
  const langs = captionLangs(getPrefs(store));
  if (CAPTION_LANGS.some(l => l[0] === code) && !langs.includes(code)) saveLangs([...langs, code], store);
}
export function moveCaptionLang(code, how, store) {
  const langs = captionLangs(getPrefs(store));
  const i = langs.indexOf(code); if (i < 0) return;
  if (how === 'remove') { if (langs.length < 2) return; langs.splice(i, 1); }
  else if (how === 'up') { if (i === 0) return; [langs[i - 1], langs[i]] = [langs[i], langs[i - 1]]; }
  saveLangs(langs, store);
}

onAction('settings', () => openSettings());
onAction('settings-close', () => closeSettings());
onAction('debrid-connect', () => connectDebrid());
onAction('debrid-remove', () => removeDebrid());
onAction('set-pref', (el) => { applyPref(el.dataset.pref, el.dataset.val); paintPrefs(); });
onAction('caption-lang-up', (el) => { moveCaptionLang(el.dataset.lang, 'up'); paintPrefs(); });
onAction('caption-lang-remove', (el) => { moveCaptionLang(el.dataset.lang, 'remove'); paintPrefs(); });
onAction('server-check', () => checkServer());
onAction('sync-now', () => { paintSync(); syncNow().finally(() => { if (isSettingsOpen()) paintSync(); }); });
