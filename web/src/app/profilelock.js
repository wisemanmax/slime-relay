/* Wave 8 (W1, roadmap 8.3): profile locks on the web — the apps' Kids
   profiles and Parent PIN (MaturityPolicy.swift, ParentPIN.swift,
   TMDBService+Kids.swift in the app repo), as pure rules. node-tested in
   test/parity.mjs; profiles.js / worker/profiles.js wire the PIN, kids.js
   runs the catalog gate over the app's TMDB proxy.

   Kids: a profile flagged `kids` gets a maturity cap (Little Kids / Older Kids
   / Teens; Older Kids by default). Every TMDB list the app shows is thinned to
   titles whose US certification is at or under the cap; an unrated title is
   hidden and refused (fail closed); the title sheet and the player refuse
   anything else. Like the apps, the catalog filter runs in the client — the
   site password stays the real gate.

   PIN: one household Parent PIN, 4–6 digits. The digits never leave the
   browser: it derives PBKDF2-SHA256(pin, salt, 100,000) — the iteration
   ceiling Cloudflare Workers accept, kept so the Worker could re-derive — and
   sends that proof. The Worker stores only SHA-256(proof) (so KV holds nothing
   a request could replay), compares in constant time on /select and on every
   profile change, and counts failures with the apps' lockout. */

// ── Maturity (MaturityPolicy.swift) ───────────────────────────────────────────

/** The order IS the rank: a cap allows every tier at or below it. */
export const MATURITY = ['littleKids', 'olderKids', 'teens', 'adults'];
export const KIDS_LEVELS = ['littleKids', 'olderKids', 'teens'];
export const KIDS_DEFAULT = 'olderKids';
export const MATURITY_TITLE = { littleKids: 'Little Kids', olderKids: 'Older Kids', teens: 'Teens', adults: 'Adults' };
export const MATURITY_DETAIL = {
  littleKids: 'TV-Y and G', olderKids: 'Up to TV-Y7, TV-G and PG',
  teens: 'Up to TV-PG, TV-14 and PG-13', adults: 'Everything, including TV-MA and R',
};
export const NOT_AVAILABLE = 'Not available on this profile';
const rank = (level) => MATURITY.indexOf(level);

/** The tier a US certification belongs to; null = unrated or not a US rating
    this table knows ("NR", "Unrated", "", "18+"). */
export function levelForCertification(raw) {
  if (typeof raw !== 'string') return null;
  const c = raw.toUpperCase().replace(/ /g, '').replace(/_/g, '-');
  switch (c) {
    case 'TV-Y': case 'TVY': case 'G':
      return 'littleKids';
    case 'TV-Y7': case 'TVY7': case 'TV-Y7-FV': case 'TVY7FV': case 'TV-Y7FV': case 'TV-G': case 'TVG': case 'PG':
      return 'olderKids';
    case 'TV-PG': case 'TVPG': case 'TV-14': case 'TV14': case 'PG-13': case 'PG13':
      return 'teens';
    case 'TV-MA': case 'TVMA': case 'R': case 'NC-17': case 'NC17': case 'X':
      return 'adults';
    default:
      return null;
  }
}

/** 'allowed' | 'blocked' | 'unknown' (no usable rating: hidden and refused below Adults). */
export function verdict(level, cap) {
  if (cap === 'adults') return 'allowed';
  if (!level || rank(level) < 0) return 'unknown';
  return rank(level) <= rank(cap) ? 'allowed' : 'blocked';
}
export const verdictForCert = (cert, cap) => verdict(levelForCertification(cert), cap);

/** The highest US movie certification TMDB's discover may return for the cap. */
export const movieCeiling = (cap) => ({ littleKids: 'G', olderKids: 'PG', teens: 'PG-13' })[cap] || null;

/** A known US rating first (films list several US releases, some "NR"), else
    the first non-empty US value, else null. entries: [{country, certification}] */
export function usCertification(entries) {
  const us = (entries || []).filter(e => e && e.country === 'US')
    .map(e => String(e.certification || '').trim()).filter(Boolean);
  return us.find(c => levelForCertification(c) != null) || us[0] || null;
}

/** The US certification in a TMDB answer: a film's release_dates or a show's
    content_ratings, standalone or appended to a detail call. */
export function certFromTMDB(json, isMovie) {
  if (!json || typeof json !== 'object') return null;
  const key = isMovie ? 'release_dates' : 'content_ratings';
  const src = json[key] && typeof json[key] === 'object' && !Array.isArray(json[key]) ? json[key] : json;
  const results = Array.isArray(src.results) ? src.results : [];
  const entries = isMovie
    ? results.flatMap(c => (c && Array.isArray(c.release_dates) ? c.release_dates : [])
      .map(r => ({ country: c.iso_3166_1 || '', certification: (r && r.certification) || '' })))
    : results.map(r => ({ country: (r && r.iso_3166_1) || '', certification: (r && r.rating) || '' }));
  return usCertification(entries);
}

/** Whether a profile record is a Kids profile. */
export function isKidsProfile(profile) {
  return !!profile && typeof profile === 'object' && profile.kids === true;
}
/** The profile's cap: its Kids level (Older Kids when unset or unknown), else Adults. */
export function capOf(profile) {
  if (!isKidsProfile(profile)) return 'adults';
  return KIDS_LEVELS.includes(profile.maturity) ? profile.maturity : KIDS_DEFAULT;
}

/** "Rated TV-MA", or why there is no rating — the blocked sheet's one line. */
export function blockedReason(cert) {
  const c = String(cert || '').trim();
  return c && levelForCertification(c) ? 'Rated ' + c : 'This title has no rating';
}

// ── Which TMDB answers the gate thins ─────────────────────────────────────────

/* The list endpoints the app shows rows / grids / results from. Anything else
   (a detail, a season, release_dates, videos) passes the gate untouched — a
   detail is refused by the title sheet instead. */
const LIST_PATH = /^(trending\/(all|movie|tv)\/|discover\/(movie|tv)(\?|$)|search\/(multi|movie|tv)(\?|$)|(movie|tv)\/(popular|top_rated|now_playing|upcoming|on_the_air|airing_today)(\?|$)|(movie|tv)\/\d+\/(similar|recommendations)(\?|$))/;
export const isListPath = (path) => LIST_PATH.test(String(path || ''));

/** 'movie' | 'tv' for a list row (its media_type, else the path's), null for
    anything that isn't a title (a person in search/multi). */
export function rowKind(path, item) {
  if (!item || typeof item !== 'object' || !(Number(item.id) > 0)) return null;
  if (item.media_type === 'movie' || item.media_type === 'tv') return item.media_type;
  if (item.media_type) return null;
  const p = String(path || '');
  if (/^((discover|search|trending)\/movie\b|movie\/)/.test(p)) return 'movie';
  if (/^((discover|search|trending)\/tv\b|tv\/)/.test(p)) return 'tv';
  return null;
}

/** A discover/movie query whose own US certification ceiling keeps every
    result within the cap: TMDB did the filtering, nothing to look up per title
    (TMDBService.tmdbFiltersCertification). discover/tv has no such parameter. */
export function trustsCeiling(path, cap) {
  if (cap === 'adults') return false;
  const [p, q = ''] = String(path || '').split('?');
  if (p !== 'discover/movie') return false;
  const sp = new URLSearchParams(q);
  const lte = levelForCertification(sp.get('certification.lte'));
  return sp.get('certification_country') === 'US' && !!lte && rank(lte) <= rank(cap);
}

/** The ceiling as discover/movie params ({} on Adults) — merged into the
    browse views' movie queries on a Kids profile so they need no lookups. */
export function kidsMovieParams(cap) {
  const c = movieCeiling(cap);
  return c ? { include_adult: 'false', certification_country: 'US', 'certification.lte': c } : {};
}
const qs = (o) => new URLSearchParams(o).toString();

/* Home for a Kids profile replaces the adult line-up outright (TMDBService+Kids):
   thinning "Hidden Gems" to what a seven-year-old may watch leaves a page of stubs.
   Films carry the ceiling (free); shows are checked per title. */
export function kidsShelves(cap) {
  if (!movieCeiling(cap)) return [];
  const m = (extra) => 'discover/movie?' + qs({ ...kidsMovieParams(cap), ...extra });
  const t = (extra) => 'discover/tv?' + qs({ include_adult: 'false', ...extra });
  return [
    { label: 'Top Picks for Kids', kind: 'movie', path: m({ sort_by: 'popularity.desc', 'vote_count.gte': '300' }) },
    { label: "Kids' Shows", kind: 'tv', path: t({ with_genres: '10762', sort_by: 'popularity.desc', 'vote_count.gte': '10' }) },
    { label: 'Family Movies', kind: 'movie', path: m({ with_genres: '10751', sort_by: 'vote_average.desc', 'vote_count.gte': '300' }) },
    { label: 'Animated Movies', kind: 'movie', path: m({ with_genres: '16', sort_by: 'popularity.desc', 'vote_count.gte': '200' }) },
    { label: 'Cartoons', kind: 'tv', path: t({ with_genres: '16', sort_by: 'popularity.desc', 'vote_count.gte': '50' }) },
    { label: 'Family Shows', kind: 'tv', path: t({ with_genres: '10751', sort_by: 'popularity.desc', 'vote_count.gte': '20' }) },
    { label: 'Disney+ for Kids', kind: 'movie', path: m({ with_watch_providers: '337', watch_region: 'US', with_watch_monetization_types: 'flatrate', sort_by: 'popularity.desc', 'vote_count.gte': '20' }) },
  ];
}
/** The Movies pill on a Kids profile: films only, every row ceiling-filtered. */
export function kidsMovieRows(cap) {
  if (!movieCeiling(cap)) return [];
  const m = (extra) => 'discover/movie?' + qs({ ...kidsMovieParams(cap), ...extra });
  return [
    { label: 'Popular', path: m({ sort_by: 'popularity.desc', 'vote_count.gte': '100' }) },
    { label: 'Top Rated', path: m({ sort_by: 'vote_average.desc', 'vote_count.gte': '300' }) },
    { label: 'Family', path: m({ with_genres: '10751', sort_by: 'popularity.desc', 'vote_count.gte': '50' }) },
    { label: 'Animation', path: m({ with_genres: '16', sort_by: 'popularity.desc', 'vote_count.gte': '50' }) },
  ];
}

/** Rows in order, a title shown once (in the first row that has it). rows: [{label, items}] */
export function dedupeRows(rows) {
  const seen = new Set();
  return (rows || []).map(r => ({ ...r, items: (r.items || []).filter(x => {
    const k = (x.media_type || '') + ':' + x.id;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  }) }));
}

/** Routes a Kids profile never lands on: Live sports, Reading (the web has
    manga and comics only, which the apps hide from Kids) and Watch Party. */
export const KIDS_HIDDEN_ROUTES = ['live', 'read', 'party'];
export const hiddenForKids = (base, kids) => !!kids && KIDS_HIDDEN_ROUTES.includes(base);

// ── Certification store (CertificationStore.swift) ────────────────────────────

export const certKey = (id, isMovie) => (isMovie ? 'movie-' : 'tv-') + id;
const DAY = 86400000;
/** A known rating stands 90 days; "no US rating" is asked again after 7 (it
    often appears once a title reaches US release). */
export const certFresh = (cert, fetchedAt, now) => now - fetchedAt < (levelForCertification(cert) ? 90 : 7) * DAY;

/** Certifications by title for a capped profile. DOM-free: tmdb(path) -> JSON
    | null (the Worker's TMDB proxy, unfiltered), load()/save(map) persist
    {key: {c, t}}. At most `maxInFlight` lookups at once, one per title even
    when several rows ask together. A failed lookup is not kept and reads as
    unknown — fail closed, asked again next time. */
export function createCertStore({ tmdb, load = () => null, save = () => {}, now = () => Date.now(), maxInFlight = 6, max = 1500 } = {}) {
  let map = null;
  const inflight = new Map();
  const waiting = [];
  let active = 0;
  const data = () => map || (map = { ...((load && load()) || {}) });
  const fresh = (key) => { const e = data()[key]; return e && Number.isFinite(e.t) && certFresh(e.c, e.t, now()) ? e : null; };
  function put(key, cert) {
    const m = data();
    m[key] = { c: cert || null, t: now() };
    const keys = Object.keys(m);
    if (keys.length > max) keys.sort((a, b) => m[a].t - m[b].t).slice(0, keys.length - max).forEach(k => delete m[k]);
    save(m);
  }
  async function slot(fn) {
    if (active >= maxInFlight) await new Promise(r => waiting.push(r));
    active++;
    try { return await fn(); } finally { active--; const next = waiting.shift(); if (next) next(); }
  }
  /** -> {ok, cert}; ok false = the lookup failed (not cached). */
  function lookup(id, isMovie) {
    if (!(Number(id) > 0)) return Promise.resolve({ ok: false, cert: null });
    const key = certKey(id, isMovie);
    const hit = fresh(key);
    if (hit) return Promise.resolve({ ok: true, cert: hit.c });
    if (inflight.has(key)) return inflight.get(key);
    const p = slot(async () => {
      const j = await tmdb(isMovie ? `movie/${id}/release_dates` : `tv/${id}/content_ratings`);
      if (!j || typeof j !== 'object') return { ok: false, cert: null };
      const cert = certFromTMDB(j, isMovie);
      put(key, cert);
      return { ok: true, cert };
    }).catch(() => ({ ok: false, cert: null })).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }
  return {
    lookup,
    /** -> {verdict, cert} for the cap. */
    async check(id, isMovie, cap) {
      if (cap === 'adults') return { verdict: 'allowed', cert: null };
      const r = await lookup(id, isMovie);
      return { verdict: r.ok ? verdictForCert(r.cert, cap) : 'unknown', cert: r.cert };
    },
    /** From the cache only: the verdict, or null when the title was never looked up. */
    now(id, isMovie, cap) {
      if (cap === 'adults') return 'allowed';
      const hit = Number(id) > 0 ? fresh(certKey(id, isMovie)) : null;
      return hit ? verdictForCert(hit.c, cap) : null;
    },
    /** Keep the items the cap allows, in order. isMovie(item) -> bool. */
    async filter(items, cap, isMovie) {
      const list = Array.isArray(items) ? items : [];
      if (cap === 'adults') return list;
      const v = await Promise.all(list.map(x => lookup(x && x.id, isMovie(x)).then(r => r.ok && verdictForCert(r.cert, cap) === 'allowed')));
      return list.filter((_, i) => v[i]);
    },
    /** A certification learned elsewhere (the title sheet's appended answer). */
    seed(id, isMovie, cert) { if (Number(id) > 0) put(certKey(id, isMovie), cert); },
    size: () => Object.keys(data()).length,
  };
}

// ── Parent PIN (ParentPIN.swift) ──────────────────────────────────────────────

export const PIN_ITERATIONS = 100000;
export const SALT_RE = /^[0-9a-f]{32}$/;
export const PROOF_RE = /^[0-9a-f]{64}$/;
export const isValidPin = (pin) => typeof pin === 'string' && /^[0-9]{4,6}$/.test(pin);

export const toHex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
export function fromHex(hex) {
  const s = String(hex || '');
  const out = new Uint8Array(s.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16) || 0;
  return out;
}
/** 16 random bytes as hex. */
export const newSalt = (rand = (n) => crypto.getRandomValues(new Uint8Array(n))) => toHex(rand(16));

/** The proof a browser sends for a PIN: PBKDF2-SHA256(pin, salt, iterations), 64 hex. */
export async function pinProof(pin, saltHex, iterations = PIN_ITERATIONS, subtle = globalThis.crypto.subtle) {
  const key = await subtle.importKey('raw', new TextEncoder().encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  return toHex(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations }, key, 256));
}
/** What the Worker keeps for a proof: SHA-256 of its bytes. */
export async function pinVerifier(proofHex, subtle = globalThis.crypto.subtle) {
  return toHex(await subtle.digest('SHA-256', fromHex(proofHex)));
}
/** Equal strings, compared without an early exit. */
export function sameSecret(a, b) {
  const x = String(a || ''), y = String(b || '');
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

/** Seconds to wait after `failures` wrong entries in a row: none for the first
    three, then 30 s, doubling, capped at 15 minutes. A right entry resets it. */
export function lockoutSeconds(failures) {
  return failures >= 4 ? Math.min(900, 30 * 2 ** (failures - 4)) : 0;
}
/** "0:27" — the countdown as the prompt shows it. */
export function countdown(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
/** The stored failure record after one more wrong entry. rec: {n, until} | null */
export function afterFailure(rec, now) {
  const n = (rec && Number.isFinite(rec.n) ? rec.n : 0) + 1;
  return { n, until: now + lockoutSeconds(n) * 1000 };
}
/** Seconds still to wait before another try (0 = may try). */
export const lockedFor = (rec, now) => (rec && Number.isFinite(rec.until) && rec.until > now ? Math.ceil((rec.until - now) / 1000) : 0);

/** Switching from `current` to `target` asks the PIN when one exists and the
    target is locked (even the active profile: nothing waves a viewer back into
    a locked one), or the viewer is LEAVING a Kids profile — the kid-proof exit.
    current: {id, kids} | null, target: {id, locked} (ProfileLockRules.needsPIN). */
export function needsPIN({ current, target, hasPIN }) {
  if (!hasPIN || !target) return false;
  return target.locked === true || (!!current && current.kids === true && current.id !== target.id);
}
/** Adding, editing or deleting profiles, and changing the PIN: always once a
    PIN exists — the web has no "Require PIN to manage" switch to turn off, so
    it takes the apps' default (on) and their Kids rule (always) together. */
export const needsPINToManage = ({ hasPIN }) => !!hasPIN;
