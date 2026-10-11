/* "Ask" — the apps' assistant, on the web. A port of the iOS/tvOS
   AssistantSession / AssistantTools / AssistantLogic (VideoDeck/Assistant/).

   The relay's POST /assist (reached through the Worker's /api/ask, which adds
   the token) holds the model key, the system prompt and the tool list, and
   returns the model's next assistant message. This file holds the
   conversation, runs the tool calls against TMDB (the Worker's /api/tmdb/*
   proxy) and loops until the model calls `recommend`. Picks are only ever
   titles a tool returned, so a made-up title can't reach the screen.

     request   { messages: [user | assistant (verbatim, incl. tool_calls /
                 reasoning_content) | { role:'tool', tool_call_id, content }],
                 history: bool }   — never a system message
     response  { message, finish_reason, prompt_version }

   The conversation lives in memory only (one per page load). Pure apart from
   the default relay/TMDB/library hooks, so test/ask.mjs drives it with fakes. */

import { api, apiFetch } from './api.js';
import { CHANNELS } from './catalog.js';
import { getState, getPrefs } from './state.js';

const MAX_ROUNDS = 7;     // model calls per question; a normal answer takes 2–3
const MAX_LOOKUPS = 12;   // tool calls run per model step; any beyond are answered "skipped"

export const ASK_SUGGESTIONS = [
  'Something funny under 90 minutes',
  'A mind-bending sci-fi movie',
  'A new series to binge this weekend',
  "Anime for someone who's never watched anime",
  'A cozy movie for a rainy night',
  "What's worth watching on Netflix right now?",
];
export const ASK_FOLLOWUPS = [
  'Something shorter', 'Newer, please', 'More like the first one',
  'Lighter and funnier', 'Something completely different',
];

// ── Logic (AssistantLogic.swift) ──────────────────────────────────────────────

export function toInt(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^\s*-?\d+\s*$/.test(v)) return parseInt(v, 10);
  return null;
}

/** Tool arguments as an object; tolerates a code fence around the JSON, or garbage. */
export function parseArgs(raw) {
  let text = String(raw == null ? '' : raw).trim();
  if (text.startsWith('```')) {
    const nl = text.indexOf('\n');
    text = (nl < 0 ? '' : text.slice(nl + 1)).trim();
    if (text.endsWith('```')) text = text.slice(0, -3);
  }
  try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}

const AWARDS = /\b(an? )?(multi[- ])?(emmy|oscar|academy award|golden globe|bafta|peabody|award)s?[- ](winning|winner|nominated|nominee|calibre|caliber|worthy|darling)\b[ ,]*/gi;
/** A pick's reason without award talk: nothing the tools return can back it. */
export function cleanReason(reason) {
  const cleaned = String(reason).replace(AWARDS, '').trim();
  return cleaned ? cleaned[0].toUpperCase() + cleaned.slice(1) : reason;
}

/** The `recommend` call's arguments -> { message, picks:[{ tmdbID, isMovie, reason }] }. */
export function parseAnswer(raw) {
  const args = parseArgs(raw);
  const message = typeof args.message === 'string' ? args.message.trim() : '';
  const picks = (Array.isArray(args.picks) ? args.picks : []).map(p => {
    const id = p && typeof p === 'object' ? toInt(p.tmdb_id) : null;
    if (id == null) return null;
    return { tmdbID: id, isMovie: p.kind === 'movie', reason: cleanReason(typeof p.reason === 'string' ? p.reason.trim() : '') };
  }).filter(Boolean);
  return { message, picks };
}

const LEAD = '(?:under|less than|no (?:more|longer) than|shorter than|at most|within|all under)';
const LENGTH_WORDS = [['an hour and a half', 90], ['one and a half hours', 90], ['90 minutes', 90],
  ['two and a half hours', 150], ['two hours', 120], ['2 hours', 120], ['three hours', 180], ['3 hours', 180],
  ['an hour', 60], ['one hour', 60]].sort((a, b) => b[0].length - a[0].length);
/** The longest runtime an answer's message promises for its films ("all under
    two hours" -> 120), or null. Checked against TMDB before it's shown. */
export function claimedMaxMinutes(message) {
  const text = String(message).toLowerCase();
  let m = text.match(new RegExp(LEAD + '\\s+(\\d{2,3})\\s*(?:minutes|mins?)\\b'));
  if (m) return +m[1];
  m = text.match(/(\d{2,3})\s*(?:minutes|mins?)\s+or\s+(?:less|under|shorter)/);
  if (m) return +m[1];
  for (const [phrase, minutes] of LENGTH_WORDS) {
    const esc = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(LEAD + '\\s+' + esc).test(text) || text.includes(phrase + ' or less') || text.includes(phrase + ' or under')) return minutes;
  }
  return null;
}

export const askKey = (id, isMovie) => (isMovie ? 'movie' : 'tv') + ':' + id;
const itemKey = (item) => askKey(item.id, item.media_type === 'movie');

/** Picks matched to titles the tools returned. A pick filed under the wrong
    kind still matches when only the other kind has that id. */
export function resolvePicks(picks, seen) {
  const found = [], missing = [], used = new Set();
  for (const p of picks) {
    const exact = askKey(p.tmdbID, p.isMovie), other = askKey(p.tmdbID, !p.isMovie);
    const hit = seen.has(exact) ? exact : (seen.has(other) ? other : null);
    if (!hit) { missing.push(p.tmdbID); continue; }
    if (!used.has(hit)) { used.add(hit); found.push([seen.get(hit), p.reason]); }
  }
  return { found, missing };
}

const enc = new TextEncoder();
const size = (messages) => enc.encode(JSON.stringify(messages)).length;
/** Keep a conversation under the relay's caps: shorten earlier questions' tool
    results first, then drop the oldest questions whole (a question is its user
    message and everything up to the next one, so no tool call loses its result). */
export function trimmed(input, { maxCount = 60, maxBytes = 56000, softBytes = 40000 } = {}) {
  let messages = input.map(m => ({ ...m }));
  let current = -1;
  messages.forEach((m, i) => { if (m.role === 'user') current = i; });
  for (let i = 0; i < Math.max(current, 0) && size(messages) > softBytes; i++) {
    if (messages[i].role === 'tool') messages[i].content = '{"note":"older results trimmed"}';
  }
  while (messages.length > maxCount || size(messages) > maxBytes) {
    const users = messages.map((m, i) => (m.role === 'user' ? i : -1)).filter(i => i >= 0);
    if (users.length < 2) break;
    messages = messages.slice(users[1]);
  }
  return messages;
}

/** The conversation without its last question — what's left after one fails. */
export function withoutLastQuestion(messages) {
  let start = -1;
  messages.forEach((m, i) => { if (m.role === 'user') start = i; });
  return start < 0 ? messages : messages.slice(0, start);
}

// ── Genres + services ─────────────────────────────────────────────────────────
// The genre names the relay's tool schema offers, to TMDB ids — which differ
// between films and series (TV has "Action & Adventure", no Horror).
const MOVIE_GENRES = { Action: 28, Adventure: 12, Animation: 16, Comedy: 35, Crime: 80, Documentary: 99, Drama: 18,
  Family: 10751, Kids: 10751, Fantasy: 14, History: 36, Horror: 27, Music: 10402, Mystery: 9648, Romance: 10749,
  'Science Fiction': 878, Thriller: 53, War: 10752, Western: 37 };
const TV_GENRES = { Action: 10759, Adventure: 10759, Animation: 16, Comedy: 35, Crime: 80, Documentary: 99, Drama: 18,
  Family: 10751, Kids: 10762, Fantasy: 10765, 'Science Fiction': 10765, Mystery: 9648, Thriller: 9648, Reality: 10764,
  War: 10768, Western: 37 };
const GENRE_NAMES = { 28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime', 99: 'Documentary',
  18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music', 9648: 'Mystery',
  10749: 'Romance', 878: 'Science Fiction', 10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western',
  10759: 'Action & Adventure', 10762: 'Kids', 10763: 'News', 10764: 'Reality', 10765: 'Sci-Fi & Fantasy',
  10766: 'Soap', 10767: 'Talk', 10768: 'War & Politics' };

function genreId(name, movie) {
  const table = movie ? MOVIE_GENRES : TV_GENRES;
  if (Object.hasOwn(table, name)) return table[name];
  const k = Object.keys(table).find(x => x.toLowerCase() === String(name).toLowerCase());
  return k ? table[k] : null;
}

/** A streaming service by (loosely matched) name -> TMDB watch-provider id. */
export function providerID(name) {
  const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const key = norm(name);
  const hit = CHANNELS.find(c => norm(c[1]) === key);
  if (hit) return hit[0];
  const aliases = { hbo: 1899, hbomax: 1899, amazon: 9, amazonprime: 9, prime: 9, primevideo: 9, appletv: 350,
    apple: 350, paramount: 2303, disney: 337, disneyplus: 337, amc: 526 };
  return aliases[key] || null;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** JSON with sorted keys (the apps encode tool results with .sortedKeys). */
function encode(v) {
  const sort = (x) => Array.isArray(x) ? x.map(sort)
    : (x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, sort(x[k])])) : x);
  return JSON.stringify(sort(v));
}

// ── Tools (AssistantTools.swift) ──────────────────────────────────────────────

/** What the viewer sees while a tool runs. */
export function toolStatus(name, rawArgs) {
  const args = parseArgs(rawArgs);
  const text = (k) => (typeof args[k] === 'string' && args[k] ? args[k].slice(0, 40) : null);
  switch (name) {
    case 'search_titles': return text('query') ? `Looking up “${text('query')}”…` : 'Searching…';
    case 'similar_titles': return 'Finding similar titles…';
    case 'person_titles': return text('name') ? `Checking ${text('name')}'s work…` : 'Checking filmographies…';
    case 'title_details': return 'Checking the details…';
    case 'discover': return text('service') ? `Browsing ${text('service')}…` : 'Browsing the catalog…';
    case 'trending': return "Checking what's trending…";
    case 'my_titles': return 'Looking at your list…';
    default: return 'Thinking…';
  }
}

/** Runs the relay's tools against TMDB. tmdb(path) -> parsed JSON or null
    (path relative to api.themoviedb.org/3, query included). library() -> the
    viewer's titles [{ item, status }], or null when they didn't share them. */
export function createTools({ tmdb, library = null }) {
  const qs = (path, params) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) if (v != null) q.set(k, String(v));
    const s = q.toString();
    return s ? path + '?' + s : path;
  };
  const note = (text) => ({ json: encode({ note: text }), titles: [] });
  const FAILED = note("The lookup failed (TMDB unreachable). Tell the viewer you couldn't search right now.");

  function found(r, kind) {
    if (!r || typeof r !== 'object') return null;
    if (r.media_type && r.media_type !== 'movie' && r.media_type !== 'tv') return null;   // people
    if (!r.poster_path) return null;                                                       // nothing to show
    const isMovie = r.media_type ? r.media_type === 'movie' : kind === 'movie';
    const d = r.release_date || r.first_air_date || '';
    const item = { id: r.id, media_type: isMovie ? 'movie' : 'tv', title: r.title || r.name || 'Untitled',
      poster_path: r.poster_path, backdrop_path: r.backdrop_path || null, genre_ids: r.genre_ids || [] };
    if (d.length >= 4) item.year = d.slice(0, 4);
    return { item, rating: r.vote_average, overview: r.overview || '', runtime: null };
  }
  async function rowsFrom(path, params, kind) {
    const page = await tmdb(qs(path, params));
    if (!page || !Array.isArray(page.results)) return null;   // unreachable: the model is told, not "no matches"
    return page.results.map(r => found(r, kind)).filter(Boolean);
  }
  const encodeRows = (list) => list.map(f => {
    const o = { tmdb_id: f.item.id, kind: f.item.media_type, title: f.item.title };
    if (f.item.year) o.year = f.item.year;
    if (f.rating > 0) o.rating = Math.round(f.rating * 10) / 10;
    if (f.runtime) o.runtime_minutes = f.runtime;
    const genres = (f.item.genre_ids || []).map(id => GENRE_NAMES[id]).filter(Boolean);
    if (genres.length) o.genres = genres;
    if (f.overview) o.overview = f.overview.slice(0, 110);   // short: the whole conversation must fit the relay's cap
    return o;
  });
  const result = (list, notes = []) => {
    const body = { results: encodeRows(list) };
    if (!list.length) body.note = 'No matches.';
    if (notes.length) body.notes = notes;
    return { json: encode(body), titles: list.map(f => f.item) };
  };

  async function runtimes(ids) {
    const out = {};
    await Promise.all([...new Set(ids)].map(async (id) => {
      const d = await tmdb('movie/' + id);
      if (d && Number.isFinite(d.runtime)) out[id] = d.runtime;
    }));
    return out;
  }
  async function withinRuntime(list, limit) {
    const mins = await runtimes(list.map(f => f.item.id));
    return list.filter(f => mins[f.item.id] > 0 && mins[f.item.id] <= limit).map(f => ({ ...f, runtime: mins[f.item.id] }));
  }
  async function keywordID(text) {
    const q = String(text).trim();
    if (!q) return null;
    const list = await tmdb(qs('search/keyword', { query: q }));
    const res = (list && Array.isArray(list.results)) ? list.results : [];
    const hit = res.find(k => String(k.name).toLowerCase() === q.toLowerCase()) || res[0];
    return hit ? hit.id : null;
  }

  const tools = {
    async search_titles(args) {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return note('Give search_titles a query.');
      const kind = args.kind || 'any';
      const path = kind === 'movie' ? 'search/movie' : kind === 'tv' ? 'search/tv' : 'search/multi';
      const rows = await rowsFrom(path, { query, include_adult: 'false' }, kind === 'movie' || kind === 'tv' ? kind : null);
      return rows ? result(rows.slice(0, 10)) : FAILED;
    },
    async similar_titles(args) {
      const id = toInt(args.tmdb_id);
      if (id == null) return note('similar_titles needs a tmdb_id.');
      const movie = args.kind === 'movie';
      let rows = await rowsFrom(`${movie ? 'movie' : 'tv'}/${id}/recommendations`, {}, movie ? 'movie' : 'tv');
      if (!rows) return FAILED;
      rows = rows.slice(0, 15);
      const limit = toInt(args.max_runtime_minutes);
      if (movie && limit > 0) {
        rows = await withinRuntime(rows, limit);
        if (!rows.length) return result([], ['None of the similar films are that short.']);
      }
      return result(rows);
    },
    async person_titles(args) {
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      if (!name) return note('person_titles needs a name.');
      const people = await tmdb(qs('search/person', { query: name }));
      if (!people || !Array.isArray(people.results)) return FAILED;
      const who = people.results[0];
      if (!who) return note(`No person called ${name} on TMDB.`);
      const credits = await tmdb(`person/${who.id}/combined_credits`);
      if (!credits) return FAILED;
      const role = args.role || 'any', kind = args.kind || 'any';
      let rows = [];
      if (role !== 'directing') rows = rows.concat(credits.cast || []);
      if (role !== 'acting') rows = rows.concat((credits.crew || []).filter(r => r.job === 'Director' || r.job === 'Creator'));
      // Best known first; talk and news shows (guest spots) are dropped.
      const ranked = rows.filter(r => kind === 'any' || r.media_type === kind)
        .filter(r => (r.genre_ids || []).every(g => g !== 10763 && g !== 10767))
        .sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0));
      const ids = new Set(), list = [];
      for (const r of ranked) {
        const f = found(r, null);
        if (!f || ids.has(itemKey(f.item))) continue;
        ids.add(itemKey(f.item)); list.push(f);
        if (list.length >= 20) break;
      }
      const body = { person: who.name, results: encodeRows(list) };
      if (who.known_for_department) body.known_for = who.known_for_department;
      if (!list.length) body.note = 'No matching credits.';
      return { json: encode(body), titles: list.map(f => f.item) };
    },
    async discover(args) {
      const movie = args.kind !== 'tv';
      const q = { include_adult: 'false' }, notes = [];
      const genreIDs = (key) => (Array.isArray(args[key]) ? args[key] : []).map(name => {
        const id = genreId(String(name), movie);
        if (id == null) notes.push(`${name} isn't a ${movie ? 'movie' : 'TV'} genre on TMDB, so it was ignored.`);
        return id;
      }).filter(x => x != null);
      const withG = genreIDs('genres'), without = genreIDs('exclude_genres');
      if (withG.length) q.with_genres = withG.join(',');
      if (without.length) q.without_genres = without.join(',');
      const keywords = (Array.isArray(args.keywords) ? args.keywords : []).slice(0, 4);
      if (keywords.length) {
        const kids = [];
        for (const k of keywords) { const id = await keywordID(k); if (id != null) kids.push(id); else notes.push(`No TMDB keyword for “${k}”.`); }
        if (kids.length) q.with_keywords = kids.join('|');
      }
      const dateKey = movie ? 'primary_release_date' : 'first_air_date';
      const yf = toInt(args.year_from), yt = toInt(args.year_to);
      if (yf != null) q[dateKey + '.gte'] = `${yf}-01-01`;
      if (yt != null) q[dateKey + '.lte'] = `${yt}-12-31`;
      const minRating = typeof args.min_rating === 'number' ? args.min_rating : toInt(args.min_rating);
      if (minRating != null) q['vote_average.gte'] = String(minRating);
      const maxRun = toInt(args.max_runtime_minutes);
      if (maxRun > 0) q['with_runtime.lte'] = String(maxRun);
      if (typeof args.max_age_rating === 'string' && args.max_age_rating) {
        if (movie) { q.certification_country = 'US'; q['certification.lte'] = args.max_age_rating; }
        else notes.push('Age ratings only filter movies; for series use the Kids or Family genre.');
      }
      if (typeof args.original_language === 'string' && args.original_language.length === 2) q.with_original_language = args.original_language.toLowerCase();
      if (typeof args.service === 'string' && args.service) {
        const pid = providerID(args.service);
        if (pid) { q.with_watch_providers = String(pid); q.watch_region = 'US'; q.with_watch_monetization_types = 'flatrate'; }
        else notes.push(`Unknown service ${args.service}, so every service was searched.`);
      }
      if (args.sort === 'top_rated') { q.sort_by = 'vote_average.desc'; q['vote_count.gte'] = '300'; }
      else if (args.sort === 'newest') {
        q.sort_by = dateKey + '.desc';
        q[dateKey + '.lte'] = q[dateKey + '.lte'] || today();
        q['vote_count.gte'] = '10';
      } else {
        q.sort_by = 'popularity.desc';
        // A rating filter without a vote floor is topped by titles nobody saw.
        q['vote_count.gte'] = q['vote_average.gte'] == null ? '20' : '100';
      }
      let rows = await rowsFrom(movie ? 'discover/movie' : 'discover/tv', q, movie ? 'movie' : 'tv');
      if (!rows) return FAILED;
      // TMDB's runtime filter is loose, so each film's real runtime is checked (and shown).
      if (movie && maxRun > 0) rows = await withinRuntime(rows.slice(0, 20), maxRun);
      if (!rows.length) notes.push('Nothing matched every filter; try fewer or looser ones.');
      return result(rows.slice(0, 20), notes);
    },
    async title_details(args) {
      const id = toInt(args.tmdb_id);
      if (id == null) return note('title_details needs a tmdb_id.');
      const movie = args.kind === 'movie';
      const d = await tmdb(qs(`${movie ? 'movie' : 'tv'}/${id}`, { append_to_response: movie ? 'release_dates' : 'content_ratings' }));
      if (!d || d.id == null) return FAILED;
      const o = { tmdb_id: d.id, kind: movie ? 'movie' : 'tv', title: d.title || d.name || '' };
      const date = d.release_date || d.first_air_date || '';
      if (date.length >= 4) o.year = date.slice(0, 4);
      if (movie) {
        if (d.runtime > 0) o.runtime_minutes = d.runtime;
        const us = ((d.release_dates && d.release_dates.results) || []).find(c => c.iso_3166_1 === 'US');
        const cert = us && (us.release_dates || []).map(x => x.certification).find(Boolean);
        if (cert) o.us_rating = cert;
      } else {
        const ep = (d.episode_run_time || [])[0];
        if (ep > 0) o.episode_minutes = ep;
        if (d.number_of_seasons != null) o.seasons = d.number_of_seasons;
        if (d.number_of_episodes != null) o.episodes = d.number_of_episodes;
        if (d.status) o.status = d.status;
        if (d.last_air_date) o.last_aired = d.last_air_date;
        const us = ((d.content_ratings && d.content_ratings.results) || []).find(c => c.iso_3166_1 === 'US');
        if (us && us.rating) o.us_rating = us.rating;
      }
      if (Array.isArray(d.genres) && d.genres.length) o.genres = d.genres.map(g => g.name);
      if (d.original_language) o.original_language = d.original_language;
      if (d.overview) o.overview = d.overview.slice(0, 240);
      // Pickable too, like anything else a tool returned.
      const titles = [];
      if (d.poster_path) {
        const item = { id: d.id, media_type: movie ? 'movie' : 'tv', title: d.title || d.name || 'Untitled', poster_path: d.poster_path,
          backdrop_path: d.backdrop_path || null, genre_ids: (d.genres || []).map(g => g.id) };
        if (o.year) item.year = o.year;
        titles.push(item);
      }
      return { json: encode(o), titles };
    },
    async trending(args) {
      const kind = args.kind || 'any';
      const path = kind === 'movie' ? 'trending/movie/week' : kind === 'tv' ? 'trending/tv/week' : 'trending/all/week';
      const rows = await rowsFrom(path, {}, kind === 'movie' || kind === 'tv' ? kind : null);
      return rows ? result(rows.slice(0, 20)) : FAILED;
    },
    async my_titles() {
      if (!library) return note("The viewer hasn't shared their history.");
      const own = (await library() || []).filter(t => t && t.item && t.item.id != null).slice(0, 40);
      if (!own.length) return note("The viewer's list and history are empty.");
      const rows = own.map(t => {
        const o = { tmdb_id: t.item.id, title: t.item.title, kind: t.item.media_type === 'movie' ? 'movie' : 'tv', status: t.status };
        if (t.item.year) o.year = t.item.year;
        return o;
      });
      return { json: encode({ titles: rows }), titles: own.map(t => t.item) };
    },
  };

  return {
    async run(name, rawArgs) {
      const fn = Object.hasOwn(tools, name) ? tools[name] : null;
      if (!fn) return note(`There's no tool called ${name}.`);
      try { return await fn(parseArgs(rawArgs)); } catch { return FAILED; }
    },
    runtimes,
  };
}

// ── Relay client ──────────────────────────────────────────────────────────────

const askError = (message) => Object.assign(new Error(message), { userMessage: message });

/** POST /api/ask -> the model's next assistant message. Throws with a viewer-facing userMessage. */
export async function relayNext(messages, history, signal) {
  let r, body = null;
  try {
    r = await apiFetch('/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages, history: !!history }), signal });
  } catch (e) {
    throw askError(e && e.name === 'AbortError' ? 'Stopped.' : "Couldn't reach the assistant. Check your connection and try again.");
  }
  try { body = await r.json(); } catch {}
  switch (r.status) {
    case 200:
      if (body && body.message && typeof body.message === 'object') return body.message;
      throw askError('The assistant sent back nothing.');
    case 404: case 503: throw askError("The assistant isn't set up yet.");
    case 429: throw askError(body && body.error === 'daily limit'
      ? "The assistant's daily limit is used up. Try again tomorrow."
      : 'Too many questions at once. Try again in a minute.');
    case 413: throw askError('This conversation got too long — start a new chat.');
    case 504: throw askError('The assistant took too long to answer. Try again.');
    default: throw askError(`The assistant had a problem (${r.status}). Try again.`);
  }
}

/** The viewer's own titles for my_titles: My List first, then what they've been watching. */
export function webLibrary(state = getState()) {
  const list = state.list.slice(0, 15).map(x => ({
    item: { id: x.id, media_type: x.kind === 'movie' ? 'movie' : 'tv', title: x.title, poster_path: x.poster || null }, status: 'My List' }));
  const watched = [...state.continue].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 25).map(x => ({
    item: { id: x.id, media_type: x.kind === 'movie' ? 'movie' : 'tv', title: x.title, poster_path: x.poster || null },
    status: x.dur > 0 && x.pos / x.dur >= 0.9 ? 'Watched' : 'Watching' }));
  return [...list, ...watched];
}

// ── Session (AssistantSession.swift) ──────────────────────────────────────────

/** A conversation. relay(messages, history, signal) -> assistant message (throws
    { userMessage }); tmdb(path) -> JSON | null; library() -> [{item,status}] |
    null when the viewer didn't share it (read at each question). onChange(view)
    fires on every visible change. */
export function createAsk({ relay = relayNext, tmdb = api, library = () => (getPrefs().askHistory ? webLibrary() : null), onChange = () => {} } = {}) {
  let turns = [], status = null, messages = [], seen = new Map(), trace = [];
  let gen = 0, ctrl = null, cancelled = false, turnSeq = 0;
  const emit = () => { try { onChange(view()); } catch (e) { console.error('ask onChange failed', e); } };
  const view = () => ({ turns, status, working: status != null });
  const toolMsg = (id, content) => ({ role: 'tool', tool_call_id: id, content });
  const live = (my) => my === gen;
  const stopped = (my) => !live(my) || cancelled;
  const setStatus = (my, s) => { if (live(my)) { status = s; emit(); } };

  function finish(my, reply, picks = [], failed = false) {
    if (!live(my) || !turns.length) return;
    const last = { ...turns[turns.length - 1], reply, picks, failed };
    turns = [...turns.slice(0, -1), last];
    // A failed question leaves no half-finished exchange behind (a tool call
    // without its reply would get every later request rejected).
    if (failed) messages = withoutLastQuestion(messages);
  }

  async function run(my, lib) {
    const tools = createTools({ tmdb, library: lib });
    let corrected = false, nudged = false, lengthChecked = false;
    const shownBefore = new Set(turns.slice(0, -1).flatMap(t => t.picks.map(p => itemKey(p.item))));
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (stopped(my)) return finish(my, 'Stopped.', [], true);
      let reply;
      try { reply = await relay(messages, !!lib, ctrl && ctrl.signal); }
      catch (e) {
        if (stopped(my)) return finish(my, 'Stopped.', [], true);
        return finish(my, (e && e.userMessage) || "Couldn't reach the assistant. Check your connection and try again.", [], true);
      }
      if (stopped(my)) return finish(my, 'Stopped.', [], true);
      if (!reply || typeof reply !== 'object') return finish(my, 'The assistant sent back nothing.', [], true);
      messages.push(reply);
      const calls = Array.isArray(reply.tool_calls) ? reply.tool_calls : [];
      if (!calls.length) {
        // A plain answer (it skipped the tool). Shown as it is.
        const text = String(reply.content || '').trim();
        trace.push('plain reply');
        return finish(my, text || "I couldn't come up with anything for that — try saying it another way.");
      }
      let final = null, lookups = 0;
      for (const call of calls) {
        const id = String((call && call.id) || '');
        const fn = (call && call.function) || {};
        const name = String(fn.name || '');
        const args = typeof fn.arguments === 'string' ? fn.arguments : '{}';
        // Every tool call needs a tool reply, or the next request is rejected.
        if (name === 'recommend') {
          const answer = parseAnswer(args);
          const { found, missing } = resolvePicks(answer.picks, seen);
          trace.push(`recommend ${answer.picks.length} picks, ${missing.length} unknown`);
          // It named titles it never looked up and too little is left to show:
          // say so once and let it look them up, rather than a thin answer.
          if (found.length < 3 && missing.length && !corrected) {
            corrected = true;
            messages.push(toolMsg(id, JSON.stringify({ error: `None of those tmdb_ids came from your tool results (${missing.slice(0, 12).join(', ')}). Look the titles up with search_titles, then call recommend again with ids from the results.` })));
            continue;
          }
          let picks = found.map(([item, reason]) => ({ item, reason }));
          // A promised length ("all under two hours") is checked against TMDB:
          // over-length films go back once to fix, then they're dropped.
          const limit = claimedMaxMinutes(answer.message);
          if (limit != null) {
            setStatus(my, 'Checking lengths…');
            const minutes = await tools.runtimes(picks.filter(p => p.item.media_type === 'movie').map(p => p.item.id));
            const over = picks.filter(p => p.item.media_type === 'movie' && (minutes[p.item.id] || 0) > limit + 1);
            if (over.length) {
              trace.push(`length claim ${limit} min: ${over.length} over`);
              if (!lengthChecked) {
                lengthChecked = true;
                const list = over.map(p => `${p.item.title} (${minutes[p.item.id] || 0} min)`).join(', ');
                messages.push(toolMsg(id, JSON.stringify({ error: `Your message promises under ${limit} minutes, but these run longer: ${list}. Replace or drop them (discover and similar_titles take max_runtime_minutes), then call recommend again.` })));
                continue;
              }
              const overIds = new Set(over.map(p => itemKey(p.item)));
              picks = picks.filter(p => !overIds.has(itemKey(p.item)));
            }
          }
          // A follow-up shouldn't hand back what's already on screen — unless that leaves too little.
          const fresh = picks.filter(p => !shownBefore.has(itemKey(p.item)));
          if (fresh.length >= 4) picks = fresh;
          // A one- or two-title answer usually means promised alternatives never got looked up.
          if (picks.length >= 1 && picks.length <= 2 && !nudged) {
            nudged = true;
            trace.push(`nudged: ${picks.length} picks`);
            messages.push(toolMsg(id, JSON.stringify({ note: `Only ${picks.length} pick(s). If your message offers alternatives or similar titles, look them up with similar_titles and call recommend again with them. If a short answer is right, call recommend again with the same picks.` })));
            continue;
          }
          final = { message: answer.message, picks };
          messages.push(toolMsg(id, '{"shown":true}'));
          continue;
        }
        // Every call needs an answer, but a burst of lookups is capped.
        lookups++;
        if (lookups > MAX_LOOKUPS) {
          messages.push(toolMsg(id, JSON.stringify({ note: 'Skipped: too many lookups in one step. Use the results you have.' })));
          continue;
        }
        trace.push(`${name} ${args.slice(0, 160)}`);
        setStatus(my, toolStatus(name, args));
        const res = await tools.run(name, args);
        for (const item of res.titles) seen.set(itemKey(item), item);
        messages.push(toolMsg(id, res.json));
      }
      if (final) {
        const msg = !final.message && final.picks.length ? 'Here are some picks.' : final.message;
        return finish(my, msg || "I couldn't find anything for that.", final.picks);
      }
      setStatus(my, 'Picking…');
      messages = trimmed(messages);
    }
    finish(my, 'That took too many steps — try asking a little differently.', [], true);
  }

  function ask(text) {
    // Long pastes are cut rather than refused.
    const question = String(text || '').trim().slice(0, 1000);
    if (!question || status != null) return null;
    turns = [...turns, { id: ++turnSeq, question, reply: '', picks: [], failed: false }];
    messages.push({ role: 'user', content: question });
    messages = trimmed(messages);
    trace = [];
    cancelled = false;
    const my = ++gen;
    ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    status = 'Thinking…'; emit();
    let lib = null;
    try { lib = library ? library() : null; } catch {}
    const libFn = lib ? async () => lib : null;
    return run(my, libFn).catch(e => {
      console.error('ask failed', e);
      finish(my, 'Something went wrong — try again.', [], true);
    }).finally(() => { if (live(my)) { status = null; ctrl = null; emit(); } });
  }

  return {
    ask,
    /** Ask the last question again (after it failed). */
    retry() {
      const last = turns[turns.length - 1];
      if (status != null || !last || !last.failed) return null;
      turns = turns.slice(0, -1);
      return ask(last.question);
    },
    /** Start over: nothing carried across. */
    reset() {
      gen++; if (ctrl) ctrl.abort(); ctrl = null;
      turns = []; messages = []; seen = new Map(); trace = []; status = null; cancelled = false;
      emit();
    },
    cancel() { if (status == null) return; cancelled = true; if (ctrl) ctrl.abort(); },
    get turns() { return turns; },
    get status() { return status; },
    get working() { return status != null; },
    get trace() { return trace; },
    get messages() { return messages; },
    set onChange(fn) { onChange = fn || (() => {}); },
  };
}

let session = null;
/** The page's one conversation (memory only — gone on reload). */
export function askSession() { return session || (session = createAsk()); }
