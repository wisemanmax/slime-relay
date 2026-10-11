// Profiles — "Who's watching?" names, so each person's history is their own.
// Names only, no passwords: the site password stays the gate (everything here
// sits behind it). Each profile's sync state is its own KV key, `state:<id>`
// (src/worker/sync.js); the browser says which profile it is with the
// sw_profile cookie, set by /select.
//
//   GET    /api/profiles                 -> 200 { profiles: [{ id, name, color, createdAt, lastUsedAt }], current }
//                                           current = the cookie's profile id when it names one, else null
//   POST   /api/profiles   { name }      -> 201 { profile, profiles }
//                                        -> 400 bad-name (1–24 characters once trimmed) · 409 name-taken { profile }
//                                           (same name, any case) · 409 too-many { max: 12 }
//   POST   /api/profiles/select { id }   -> 200 { profile } + Set-Cookie sw_profile=<id> (HttpOnly; Secure;
//                                           SameSite=Lax; Path=/; one year) · 404 no-such-profile
//   DELETE /api/profiles/<id>?confirm=<name>   removes the profile AND its state
//                                        -> 200 { profiles } (clears the cookie if it named this profile)
//                                        -> 400 confirm-mismatch (the name, any case) · 404 no-such-profile
//   Without the STATE KV binding every route answers 503 { error:'profiles-not-configured' }
//   (the browser then stays local, as sync does).
//
// Migration: profiles shipped on top of ONE shared state (`owner-state:v1`)
// that everybody's browsers had merged into. The first time the profile list
// is read and has never been written, a non-empty legacy state becomes a
// profile named "Shared" (grey, id `shared`) and moves to `state:shared`, so
// nothing is lost and the owner can delete it later. Idempotent: a repeated
// migration (a stale KV read elsewhere) never overwrites `state:shared`.
//
// KV is eventually consistent across locations (~60 s): two browsers in
// different places creating names in the same minute can lose one of them;
// a name just made elsewhere can take a minute to appear.
import { emptyData, mergeData } from '../app/sync.js';

export const PROFILES_PATH = '/api/profiles';
export const PROFILES_KEY = 'profiles';
export const LEGACY_STATE_KEY = 'owner-state:v1';
export const PROFILE_COOKIE = 'sw_profile';
export const MAX_PROFILES = 12;
export const MAX_NAME = 24;
export const SHARED_ID = 'shared';
/** The iOS profile accents (ProfilePickerView.accents); new names take the first one not in use. */
export const PROFILE_COLORS = ['#35C759', '#E50914', '#0A46E6', '#9C27B0', '#FF9800', '#00BCD4', '#E91E63', '#FFC107', '#4CAF50', '#607D8B'];
export const SHARED_COLOR = '#8E8E93';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const stateKey = (id) => 'state:' + id;

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}
const cookieHeader = (id) => `${PROFILE_COOKIE}=${id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=31536000`;
export const CLEAR_PROFILE_COOKIE = `${PROFILE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;

/** The profile id the browser's cookie names (shape-checked only), or null. */
export function profileCookie(request) {
  const m = (request.headers.get('cookie') || '').match(/(?:^|;\s*)sw_profile=([^;]*)/);
  const id = m ? m[1].trim() : '';
  return ID_RE.test(id) ? id : null;
}

/** A display name: NFC, invisible/control characters dropped, runs of
    whitespace collapsed, trimmed; 1–24 characters. null when unusable. */
export function cleanName(v) {
  if (typeof v !== 'string') return null;
  const s = v.normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/\s+/g, ' ').trim();
  const n = [...s].length;
  return n >= 1 && n <= MAX_NAME ? s : null;
}
const fold = (s) => String(s).normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
/** Names match ignoring case and spacing (dedupe, and the delete confirmation). */
export const sameName = (a, b) => fold(a) === fold(b);

/** `max-k3j9a`: a slug of the name + a short random suffix. */
function newId(name, taken) {
  const base = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 16).replace(/-+$/, '') || 'p';
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (;;) {
    const id = base + '-' + [...crypto.getRandomValues(new Uint8Array(5))].map(b => abc[b % 36]).join('');
    if (!taken.has(id)) return id;
  }
}

const isProfile = (p) => !!p && typeof p === 'object' && ID_RE.test(p.id) && typeof p.name === 'string';

/** The stored list, or null when it has never been written. */
export async function readProfiles(env) {
  let v = null;
  try { v = await env.STATE.get(PROFILES_KEY, 'json'); } catch {}
  return v && Array.isArray(v.profiles) ? v.profiles.filter(isProfile) : null;
}
const saveProfiles = (env, profiles) => env.STATE.put(PROFILES_KEY, JSON.stringify({ profiles }));

/** The legacy shared state's raw JSON when it holds anything worth keeping. */
async function legacyBlob(env) {
  let raw = null;
  try { raw = await env.STATE.get(LEGACY_STATE_KEY); } catch {}
  if (!raw) return null;
  let v; try { v = JSON.parse(raw); } catch { return null; }
  if (!v || typeof v !== 'object' || !v.data) return null;
  const d = mergeData(emptyData(), v.data, { now: Date.now() });
  const has = d.list.length || d.continue.length || Object.keys(d.reading).length || Object.keys(d.prefs).length;
  return has ? raw : null;
}

/** The profile list, running the one-time legacy migration if it was never written. */
export async function loadProfiles(env) {
  const list = await readProfiles(env);
  if (list) return list;
  const legacy = await legacyBlob(env);
  if (!legacy) return [];
  const now = Date.now();
  const target = stateKey(SHARED_ID);
  let existing = null;
  try { existing = await env.STATE.get(target); } catch {}
  if (existing == null) await env.STATE.put(target, legacy);
  const profiles = [{ id: SHARED_ID, name: 'Shared', color: SHARED_COLOR, createdAt: now, lastUsedAt: 0 }];
  await saveProfiles(env, profiles);
  await env.STATE.delete(LEGACY_STATE_KEY);
  return profiles;
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > 4096) return null;
  try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : null; } catch { return null; }
}

export async function profilesRoutes(request, env, url) {
  const path = url.pathname;
  if (path !== PROFILES_PATH && !path.startsWith(PROFILES_PATH + '/')) return null;
  if (!env.STATE) return json({ error: 'profiles-not-configured' }, 503);
  const method = request.method;

  if (path === PROFILES_PATH) {
    if (method === 'GET') {
      const profiles = await loadProfiles(env);
      const c = profileCookie(request);
      return json({ profiles, current: c && profiles.some(p => p.id === c) ? c : null });
    }
    if (method !== 'POST') return json({ error: 'method-not-allowed' }, 405);
    const body = await readBody(request);
    const name = cleanName(body && body.name);
    if (!name) return json({ error: 'bad-name', max: MAX_NAME }, 400);
    const profiles = await loadProfiles(env);
    const dupe = profiles.find(p => sameName(p.name, name));
    if (dupe) return json({ error: 'name-taken', profile: dupe }, 409);
    if (profiles.length >= MAX_PROFILES) return json({ error: 'too-many', max: MAX_PROFILES }, 409);
    const used = new Set(profiles.map(p => String(p.color).toUpperCase()));
    const color = PROFILE_COLORS.find(c => !used.has(c)) || PROFILE_COLORS[profiles.length % PROFILE_COLORS.length];
    const profile = { id: newId(name, new Set(profiles.map(p => p.id))), name, color, createdAt: Date.now(), lastUsedAt: 0 };
    const next = [...profiles, profile];
    await saveProfiles(env, next);
    return json({ profile, profiles: next }, 201);
  }

  if (path === PROFILES_PATH + '/select') {
    if (method !== 'POST') return json({ error: 'method-not-allowed' }, 405);
    const body = await readBody(request);
    const id = body && typeof body.id === 'string' ? body.id : '';
    const profiles = await loadProfiles(env);
    const i = ID_RE.test(id) ? profiles.findIndex(p => p.id === id) : -1;
    if (i < 0) return json({ error: 'no-such-profile' }, 404);
    const profile = { ...profiles[i], lastUsedAt: Date.now() };
    await saveProfiles(env, profiles.map((p, j) => (j === i ? profile : p)));
    return json({ profile }, 200, { 'set-cookie': cookieHeader(id) });
  }

  let id = '';
  try { id = decodeURIComponent(path.slice(PROFILES_PATH.length + 1)); } catch {}
  if (method !== 'DELETE') return json({ error: 'method-not-allowed' }, 405);
  const profiles = await loadProfiles(env);
  const profile = ID_RE.test(id) ? profiles.find(p => p.id === id) : null;
  if (!profile) return json({ error: 'no-such-profile' }, 404);
  if (!sameName(url.searchParams.get('confirm') || '', profile.name)) return json({ error: 'confirm-mismatch' }, 400);
  const next = profiles.filter(p => p.id !== id);
  await saveProfiles(env, next);
  await env.STATE.delete(stateKey(id));
  const headers = profileCookie(request) === id ? { 'set-cookie': CLEAR_PROFILE_COOKIE } : {};
  return json({ profiles: next }, 200, headers);
}
