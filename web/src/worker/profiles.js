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
// Wave 8 (W1) — Kids profiles and the household Parent PIN (the apps' rules,
// src/app/profilelock.js). A record may carry `kids: true` (+ `maturity`:
// littleKids | olderKids | teens) and `locked: true`; old records without them
// read as an ordinary, unlocked profile. The PIN is ONE KV value (`household-pin`:
// {v, salt, verifier, iterations, updatedAt}) where verifier = SHA-256 of the
// proof — PBKDF2(pin, salt, 100,000), derived in the browser, so neither the
// digits nor anything a request could replay is ever stored. The proof comes as
// `pinProof` in a JSON body or an `x-sw-pin` header, and is asked:
//   - by /select when the target is locked, or the cookie's profile is Kids and
//     the target is another profile (the kid-proof exit) — so a direct API call
//     can't skip it;
//   - by every change (create, PATCH, delete, the PIN itself) once a PIN exists.
// Wrong proofs count in `pin-fails` ({n, until}): none for three, then 30 s
// doubling to 15 min (429 pin-locked { retryAfter }); a right one resets it.
// The answer never carries the verifier. The site password stays the real gate:
// clearing cookies also signs the browser out.
//   GET    /api/profiles                 -> also `pin: { set:true, salt, iterations[, retryAfter] }` once one is set
//   PATCH  /api/profiles/<id> { kids?, maturity?, locked? }  -> { profile, profiles } · 409 no-pin (locking needs a PIN)
//   POST   /api/profiles/pin { salt, newProof, iterations }  -> { pin }   set, or change (with the current proof)
//   DELETE /api/profiles/pin             -> { profiles } (removes the PIN and every lock)
//   POST   /api/profiles/pin/check       -> { ok:true } (the picker's "Enter the Parent PIN" before managing)
//   PIN errors: 403 pin-required · 403 pin-wrong { failures, retryAfter } · 429 pin-locked { retryAfter } · 409 no-pin
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
import {
  KIDS_LEVELS, PIN_ITERATIONS, SALT_RE, PROOF_RE, pinVerifier, sameSecret, afterFailure, lockedFor, needsPIN,
} from '../app/profilelock.js';

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
export const PIN_KEY = 'household-pin';
export const PIN_FAILS_KEY = 'pin-fails';

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

// ── Kids flags + the Parent PIN (Wave 8) ─────────────────────────────────────

/** The stored PIN record, or null (none set, or unreadable — never a half-trusted one). */
export async function readPin(env) {
  let v = null;
  try { v = await env.STATE.get(PIN_KEY, 'json'); } catch {}
  return v && SALT_RE.test(v.salt) && /^[0-9a-f]{64}$/.test(v.verifier) && v.iterations === PIN_ITERATIONS ? v : null;
}
async function readFails(env) {
  let v = null;
  try { v = await env.STATE.get(PIN_FAILS_KEY, 'json'); } catch {}
  return v && Number.isFinite(v.n) ? v : null;
}
/** What the page may know about the PIN: that it exists, and how to derive a proof. */
const publicPin = (pin, fails, now) => {
  const out = { set: true, salt: pin.salt, iterations: pin.iterations };
  const wait = lockedFor(fails, now);
  return wait ? { ...out, retryAfter: wait } : out;
};
/** The proof a request carries (x-sw-pin header, else body.pinProof), lower-cased. */
function proofOf(request, body) {
  const v = request.headers.get('x-sw-pin') ?? (body && body.pinProof);
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}
/** Check a proof against the PIN, counting failures. -> null when it passes, else the refusal. */
async function refusePin(env, pin, proof) {
  const now = Date.now();
  const fails = await readFails(env);
  const wait = lockedFor(fails, now);
  if (wait) return json({ error: 'pin-locked', retryAfter: wait }, 429);
  if (!proof) return json({ error: 'pin-required' }, 403);
  if (PROOF_RE.test(proof) && sameSecret(await pinVerifier(proof), pin.verifier)) {
    if (fails) await env.STATE.delete(PIN_FAILS_KEY);
    return null;
  }
  const next = afterFailure(fails, now);
  await env.STATE.put(PIN_FAILS_KEY, JSON.stringify(next));
  return json({ error: 'pin-wrong', failures: next.n, retryAfter: lockedFor(next, now) }, 403);
}
/** Changes ask the PIN once one exists. -> null to go ahead, else the refusal. */
async function manageGate(env, request, body) {
  const pin = await readPin(env);
  return pin ? refusePin(env, pin, proofOf(request, body)) : null;
}
/** Apply {kids?, maturity?, locked?} to a record. -> the record, or an error code. */
function withFlags(p, body, hasPIN) {
  const out = { ...p };
  if (body.kids !== undefined) {
    if (typeof body.kids !== 'boolean') return 'bad-flags';
    if (body.kids) out.kids = true; else delete out.kids;
  }
  if (body.maturity !== undefined) {
    if (!KIDS_LEVELS.includes(body.maturity)) return 'bad-flags';
    out.maturity = body.maturity;
  }
  if (body.locked !== undefined) {
    if (typeof body.locked !== 'boolean') return 'bad-flags';
    if (body.locked && !hasPIN) return 'no-pin';
    if (body.locked) out.locked = true; else delete out.locked;
  }
  return out;
}

async function pinRoutes(request, env, path) {
  const method = request.method;
  const pin = await readPin(env);
  if (path === PROFILES_PATH + '/pin/check') {
    if (method !== 'POST') return json({ error: 'method-not-allowed' }, 405);
    if (!pin) return json({ error: 'no-pin' }, 409);
    return (await refusePin(env, pin, proofOf(request, await readBody(request)))) || json({ ok: true });
  }
  if (method === 'POST') {
    const body = await readBody(request);
    if (pin) { const no = await refusePin(env, pin, proofOf(request, body)); if (no) return no; }
    const salt = body && typeof body.salt === 'string' ? body.salt.toLowerCase() : '';
    const proof = body && typeof body.newProof === 'string' ? body.newProof.toLowerCase() : '';
    if (!SALT_RE.test(salt) || !PROOF_RE.test(proof) || !body || body.iterations !== PIN_ITERATIONS) return json({ error: 'bad-pin' }, 400);
    const rec = { v: 1, salt, verifier: await pinVerifier(proof), iterations: PIN_ITERATIONS, updatedAt: Date.now() };
    await env.STATE.put(PIN_KEY, JSON.stringify(rec));
    await env.STATE.delete(PIN_FAILS_KEY);
    return json({ pin: publicPin(rec, null, Date.now()) });
  }
  if (method === 'DELETE') {
    if (!pin) return json({ error: 'no-pin' }, 409);
    const no = await refusePin(env, pin, proofOf(request, null)); if (no) return no;
    await env.STATE.delete(PIN_KEY);
    await env.STATE.delete(PIN_FAILS_KEY);
    // Removing the PIN clears every lock (a lock nobody can open is no lock).
    const profiles = (await loadProfiles(env)).map(p => { const { locked, ...rest } = p; return rest; });
    await saveProfiles(env, profiles);
    return json({ profiles });
  }
  return json({ error: 'method-not-allowed' }, 405);
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
      const pin = await readPin(env);
      const out = { profiles, current: c && profiles.some(p => p.id === c) ? c : null };
      if (pin) out.pin = publicPin(pin, await readFails(env), Date.now());
      return json(out);
    }
    if (method !== 'POST') return json({ error: 'method-not-allowed' }, 405);
    const body = await readBody(request);
    const name = cleanName(body && body.name);
    if (!name) return json({ error: 'bad-name', max: MAX_NAME }, 400);
    const profiles = await loadProfiles(env);
    const dupe = profiles.find(p => sameName(p.name, name));
    if (dupe) return json({ error: 'name-taken', profile: dupe }, 409);
    if (profiles.length >= MAX_PROFILES) return json({ error: 'too-many', max: MAX_PROFILES }, 409);
    const refused = await manageGate(env, request, body); if (refused) return refused;
    const used = new Set(profiles.map(p => String(p.color).toUpperCase()));
    const color = PROFILE_COLORS.find(c => !used.has(c)) || PROFILE_COLORS[profiles.length % PROFILE_COLORS.length];
    let profile = { id: newId(name, new Set(profiles.map(p => p.id))), name, color, createdAt: Date.now(), lastUsedAt: 0 };
    if (body.kids !== undefined || body.maturity !== undefined) {   // a Kids profile from the start (never locked here)
      const flagged = withFlags(profile, { kids: body.kids, maturity: body.maturity }, false);
      if (typeof flagged === 'string') return json({ error: flagged }, 400);
      profile = flagged;
    }
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
    // W8: a locked profile, or leaving the cookie's Kids profile, needs the PIN —
    // here, so a direct API call can't skip the picker's prompt.
    const pin = await readPin(env);
    const cur = profiles.find(p => p.id === profileCookie(request)) || null;
    if (needsPIN({ current: cur && { id: cur.id, kids: cur.kids === true }, target: { id, locked: profiles[i].locked === true }, hasPIN: !!pin })) {
      const no = await refusePin(env, pin, proofOf(request, body)); if (no) return no;
    }
    const profile = { ...profiles[i], lastUsedAt: Date.now() };
    await saveProfiles(env, profiles.map((p, j) => (j === i ? profile : p)));
    return json({ profile }, 200, { 'set-cookie': cookieHeader(id) });
  }

  if (path === PROFILES_PATH + '/pin' || path === PROFILES_PATH + '/pin/check') return pinRoutes(request, env, path);

  let id = '';
  try { id = decodeURIComponent(path.slice(PROFILES_PATH.length + 1)); } catch {}
  if (method === 'PATCH') {
    const body = await readBody(request);
    if (!body) return json({ error: 'bad-flags' }, 400);
    const profiles = await loadProfiles(env);
    const i = ID_RE.test(id) ? profiles.findIndex(p => p.id === id) : -1;
    if (i < 0) return json({ error: 'no-such-profile' }, 404);
    const pin = await readPin(env);
    const profile = withFlags(profiles[i], body, !!pin);
    if (typeof profile === 'string') return json({ error: profile }, profile === 'no-pin' ? 409 : 400);
    if (pin) { const no = await refusePin(env, pin, proofOf(request, body)); if (no) return no; }
    const next = profiles.map((p, j) => (j === i ? profile : p));
    await saveProfiles(env, next);
    return json({ profile, profiles: next });
  }
  if (method !== 'DELETE') return json({ error: 'method-not-allowed' }, 405);
  const profiles = await loadProfiles(env);
  const profile = ID_RE.test(id) ? profiles.find(p => p.id === id) : null;
  if (!profile) return json({ error: 'no-such-profile' }, 404);
  if (!sameName(url.searchParams.get('confirm') || '', profile.name)) return json({ error: 'confirm-mismatch' }, 400);
  const refused = await manageGate(env, request, null); if (refused) return refused;
  const next = profiles.filter(p => p.id !== id);
  await saveProfiles(env, next);
  await env.STATE.delete(stateKey(id));
  const headers = profileCookie(request) === id ? { 'set-cookie': CLEAR_PROFILE_COOKIE } : {};
  return json({ profiles: next }, 200, headers);
}
