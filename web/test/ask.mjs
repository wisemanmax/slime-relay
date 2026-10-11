// "Ask", in node: the pure logic ported from AssistantLogic.swift, the tool
// loop (src/app/ask.js) against a scripted fake relay + fake TMDB, the
// Worker's /api/ask proxy, and the Search/Settings UI wiring (prefs round-trip
// through the real click dispatcher). Run by check.mjs; returns the number of
// assertions, throws on the first failure.

import assert from 'node:assert/strict';
import {
  parseArgs, parseAnswer, cleanReason, claimedMaxMinutes, resolvePicks, trimmed, withoutLastQuestion,
  providerID, toolStatus, createTools, createAsk, askKey, webLibrary,
} from '../src/app/ask.js';
import { askRoutes } from '../src/worker/ask.js';
import { memoryStorage } from '../src/app/state.js';

// ── A tiny fake TMDB ────────────────────────────────────────────────────────────
const MOVIES = {
  438631: { id: 438631, title: 'Dune', poster_path: '/dune.jpg', release_date: '2021-09-15', vote_average: 7.8, genre_ids: [878, 12], overview: 'Paul Atreides…', runtime: 155 },
  693134: { id: 693134, title: 'Dune: Part Two', poster_path: '/dune2.jpg', release_date: '2024-02-27', vote_average: 8.2, genre_ids: [878], overview: 'Paul unites…', runtime: 167 },
  1: { id: 1, title: 'Short One', poster_path: '/s1.jpg', release_date: '2019-01-01', vote_average: 7, genre_ids: [35], overview: 'Short.', runtime: 85 },
  2: { id: 2, title: 'Short Two', poster_path: '/s2.jpg', release_date: '2020-01-01', vote_average: 7, genre_ids: [35], overview: 'Short.', runtime: 88 },
  3: { id: 3, title: 'Short Three', poster_path: '/s3.jpg', release_date: '2021-01-01', vote_average: 7, genre_ids: [35], overview: 'Short.', runtime: 90 },
  4: { id: 4, title: 'Long Four', poster_path: '/s4.jpg', release_date: '2022-01-01', vote_average: 7, genre_ids: [35], overview: 'Long.', runtime: 140 },
};
function fakeTmdb() {
  const calls = [];
  const fn = async (path) => {
    calls.push(path);
    const [p, q = ''] = path.split('?');
    const qs = new URLSearchParams(q);
    if (p === 'search/multi' || p === 'search/movie') {
      const hits = Object.values(MOVIES).filter(m => m.title.toLowerCase().includes((qs.get('query') || '').toLowerCase()));
      return { results: [...hits.map(m => ({ ...m, media_type: p === 'search/multi' ? 'movie' : undefined })), { id: 77, media_type: 'person', name: 'Somebody' }] };
    }
    if (p === 'trending/all/week') return { results: [{ id: 1399, media_type: 'tv', name: 'Game of Thrones', poster_path: '/got.jpg', first_air_date: '2011-04-17', vote_average: 8.4, genre_ids: [10765] }] };
    if (/^movie\/\d+\/recommendations$/.test(p)) return { results: [MOVIES[1], MOVIES[2], MOVIES[3], MOVIES[4]] };
    if (/^movie\/\d+$/.test(p)) return MOVIES[p.split('/')[1]] || null;
    if (p === 'discover/movie') return { results: [MOVIES[1], MOVIES[4]] };
    if (p === 'search/keyword') return { results: [{ id: 4379, name: 'time travel' }, { id: 1, name: 'time' }] };
    if (p === 'search/person') return { results: [{ id: 525, name: 'Christopher Nolan', known_for_department: 'Directing' }] };
    if (p === 'person/525/combined_credits') return { cast: [], crew: [
      { id: 27205, media_type: 'movie', title: 'Inception', poster_path: '/i.jpg', job: 'Director', vote_count: 30000, release_date: '2010-07-15' },
      { id: 27205, media_type: 'movie', title: 'Inception', poster_path: '/i.jpg', job: 'Writer', vote_count: 30000 },
      { id: 999, media_type: 'tv', name: 'A Talk Show', poster_path: '/t.jpg', job: 'Director', genre_ids: [10767], vote_count: 99999 },
    ] };
    if (p === 'tv/1399') return { id: 1399, name: 'Game of Thrones', poster_path: '/got.jpg', first_air_date: '2011-04-17', number_of_seasons: 8, number_of_episodes: 73, status: 'Ended', episode_run_time: [60], genres: [{ id: 10765, name: 'Sci-Fi & Fantasy' }], content_ratings: { results: [{ iso_3166_1: 'US', rating: 'TV-MA' }] } };
    return null;
  };
  fn.calls = calls;
  return fn;
}

// ── A scripted relay: each step is a function of the request -> assistant message ──
let callSeq = 0;
const toolCall = (name, args) => ({ id: 'call_' + (++callSeq), type: 'function', function: { name, arguments: JSON.stringify(args) } });
const assistant = (...calls) => ({ role: 'assistant', content: '', tool_calls: calls });
function fakeRelay(steps) {
  const requests = [];
  const fn = async (messages, history) => {
    requests.push({ messages: JSON.parse(JSON.stringify(messages)), history });
    const step = steps[requests.length - 1];
    if (!step) throw Object.assign(new Error('no more steps'), { userMessage: 'script ran out' });
    return typeof step === 'function' ? step(messages) : step;
  };
  fn.requests = requests;
  return fn;
}
/** Every assistant tool_call is answered by exactly one tool message, in order. */
function wellFormed(messages) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant' || !m.tool_calls) continue;
    const ids = m.tool_calls.map(c => c.id);
    const replies = messages.slice(i + 1, i + 1 + ids.length).map(r => r.role === 'tool' && r.tool_call_id);
    if (JSON.stringify(ids) !== JSON.stringify(replies)) return false;
  }
  return !messages.some(m => m.role === 'system');
}

export async function runAskChecks() {
  let n = 0;
  const eq = (a, b, m) => { assert.deepEqual(a, b, m); n++; };
  const ok = (v, m) => { assert.ok(v, m); n++; };

  // ── 1. Pure logic ───────────────────────────────────────────────────────────
  eq(parseArgs('```json\n{"a":1}\n```'), { a: 1 }, 'arguments in a code fence');
  eq(parseArgs('not json'), {}, 'garbage arguments -> {}');
  eq(parseAnswer('{"message":" Here. ","picks":[{"tmdb_id":"12","kind":"movie","reason":"Oscar-winning drama"},{"kind":"tv"}]}'),
     { message: 'Here.', picks: [{ tmdbID: 12, isMovie: true, reason: 'Drama' }] }, 'recommend parsed; string ids; award talk stripped; bad picks dropped');
  eq(cleanReason('An Emmy-nominated, witty comedy'), 'Witty comedy', 'cleanReason');
  eq([claimedMaxMinutes('All under 90 minutes.'), claimedMaxMinutes('these are 95 mins or less'), claimedMaxMinutes('Each is under two hours'),
      claimedMaxMinutes('under an hour and a half'), claimedMaxMinutes('Great sci-fi picks')], [90, 95, 120, 90, null], 'claimedMaxMinutes');
  const seen = new Map([[askKey(5, true), { id: 5, media_type: 'movie' }], [askKey(6, false), { id: 6, media_type: 'tv' }]]);
  const rp = resolvePicks([{ tmdbID: 5, isMovie: true, reason: 'a' }, { tmdbID: 6, isMovie: true, reason: 'b' }, { tmdbID: 5, isMovie: true, reason: 'dup' }, { tmdbID: 7, isMovie: false, reason: 'c' }], seen);
  eq([rp.found.map(f => f[0].id), rp.missing], [[5, 6], [7]], 'resolvePicks: wrong kind still matches, duplicates once, unknowns missing');
  const big = 'x'.repeat(5000);
  const convo = [];
  for (let q = 0; q < 12; q++) convo.push({ role: 'user', content: 'q' + q }, assistant(toolCall('search_titles', { query: 'a' })), { role: 'tool', tool_call_id: 'c', content: big });
  const t = trimmed(convo);
  ok(JSON.stringify(t).length <= 56000 && t[0].role === 'user', 'trimmed: under the cap, starts at a question');
  eq(t.at(-1).content, big, "trimmed: the current question's tool results are kept whole");
  ok(t.filter(m => m.role === 'tool').some(m => m.content === '{"note":"older results trimmed"}'), 'trimmed: older tool results shortened first');
  eq(withoutLastQuestion([{ role: 'user' }, { role: 'assistant' }, { role: 'user' }, { role: 'assistant' }]).length, 2, 'withoutLastQuestion');
  eq([providerID('Netflix'), providerID('HBO Max'), providerID('disney+'), providerID('Prime'), providerID('Nope TV')], [8, 1899, 337, 9, null], 'providerID');
  eq(toolStatus('discover', '{"service":"Netflix"}'), 'Browsing Netflix…', 'status line');

  // ── 2. Tools against TMDB ────────────────────────────────────────────────────
  {
    const tmdb = fakeTmdb();
    const tools = createTools({ tmdb });
    let r = await tools.run('search_titles', '{"query":"Dune"}');
    const body = JSON.parse(r.json);
    eq(body.results.map(x => x.title), ['Dune', 'Dune: Part Two'], 'search_titles: people dropped');
    eq(Object.keys(body.results[0]), ['genres', 'kind', 'overview', 'rating', 'title', 'tmdb_id', 'year'], 'result rows: the app\'s fields, sorted keys');
    eq(body.results[0].genres, ['Science Fiction', 'Adventure'], 'genre names');
    eq(r.titles[0], { id: 438631, media_type: 'movie', title: 'Dune', poster_path: '/dune.jpg', backdrop_path: null, genre_ids: [878, 12], year: '2021' }, 'titles are card-ready');
    r = await tools.run('discover', JSON.stringify({ kind: 'movie', genres: ['Comedy', 'Nonsense'], keywords: ['time travel'], service: 'Netflix', max_runtime_minutes: 95, sort: 'newest', year_from: 2015 }));
    const path = tmdb.calls.find(c => c.startsWith('discover/movie'));
    const q = new URLSearchParams(path.split('?')[1]);
    eq([q.get('with_genres'), q.get('with_keywords'), q.get('with_watch_providers'), q.get('watch_region'), q.get('with_runtime.lte'), q.get('sort_by'), q.get('primary_release_date.gte'), q.get('vote_count.gte')],
       ['35', '4379', '8', 'US', '95', 'primary_release_date.desc', '2015-01-01', '10'], 'discover: filters mapped like the app');
    const d = JSON.parse(r.json);
    eq(d.results.map(x => [x.title, x.runtime_minutes]), [['Short One', 85]], 'discover: real runtimes checked, over-length dropped, runtime shown');
    ok(d.notes.some(x => x.includes("Nonsense isn't a movie genre")), 'discover: unknown genre noted');
    r = await tools.run('person_titles', '{"name":"Christopher Nolan","role":"directing"}');
    eq([JSON.parse(r.json).person, JSON.parse(r.json).results.map(x => x.title)], ['Christopher Nolan', ['Inception']], 'person_titles: talk shows dropped, deduped');
    r = await tools.run('title_details', '{"tmdb_id":1399,"kind":"tv"}');
    const det = JSON.parse(r.json);
    eq([det.seasons, det.status, det.us_rating, det.episode_minutes, r.titles.length], [8, 'Ended', 'TV-MA', 60, 1], 'title_details');
    r = await tools.run('my_titles', '{}');
    ok(JSON.parse(r.json).note.includes("hasn't shared"), 'my_titles without sharing');
    r = await tools.run('nope', '{}');
    ok(JSON.parse(r.json).note.includes('no tool called nope'), 'unknown tool answered');
    const dead = createTools({ tmdb: async () => null });
    ok(JSON.parse((await dead.run('trending', '{}')).json).note.includes('TMDB unreachable'), 'an outage is reported, not read as "no matches"');
  }

  // ── 3. The loop ──────────────────────────────────────────────────────────────
  {
    const tmdb = fakeTmdb();
    const s1 = toolCall('search_titles', { query: 'Dune' }), s2 = toolCall('trending', {});
    const relay = fakeRelay([
      { ...assistant(s1, s2), reasoning_content: 'keep me verbatim' },
      (msgs) => {
        const rec = toolCall('recommend', { message: 'Big sci-fi.', picks: [
          { tmdb_id: 438631, kind: 'movie', reason: 'Desert epic' }, { tmdb_id: 693134, kind: 'movie', reason: 'The sequel' },
          { tmdb_id: 1399, kind: 'tv', reason: 'Epic fantasy' }, { tmdb_id: 4242, kind: 'movie', reason: 'Made up' }] });
        return assistant(rec);
      },
    ]);
    const changes = [];
    const s = createAsk({ relay, tmdb, library: () => null, onChange: (v) => changes.push(v.status) });
    await s.ask('  Something like Dune  ');
    const turn = s.turns[0];
    eq(turn.question, 'Something like Dune', 'question trimmed');
    eq(turn.picks.map(p => [p.item.title, p.reason]), [['Dune', 'Desert epic'], ['Dune: Part Two', 'The sequel'], ['Game of Thrones', 'Epic fantasy']], 'picks: only titles a tool returned, made-up one dropped');
    eq([turn.reply, turn.failed, s.working], ['Big sci-fi.', false, false], 'reply shown, idle');
    ok(changes.includes('Looking up “Dune”…') && changes.includes("Checking what's trending…") && changes.at(-1) === null, 'status streamed while tools run');
    eq(relay.requests[0].messages, [{ role: 'user', content: 'Something like Dune' }], 'first request: just the question (no system message)');
    const second = relay.requests[1].messages;
    eq(second[1].reasoning_content, 'keep me verbatim', 'assistant messages go back verbatim');
    eq(second.slice(2).map(m => [m.role, m.tool_call_id]), [['tool', s1.id], ['tool', s2.id]], 'every tool call answered, in order');
    eq(relay.requests[0].history, false, 'history off unless shared');
    eq(s.messages.at(-1), { role: 'tool', tool_call_id: s.messages.at(-2).tool_calls[0].id, content: '{"shown":true}' }, 'recommend answered {"shown":true}');
    ok(wellFormed(s.messages), 'conversation well-formed for the next turn');
  }

  // Correction (unknown ids), nudge (1–2 picks), length promise, follow-up dedupe.
  {
    const tmdb = fakeTmdb();
    const relay = fakeRelay([
      assistant(toolCall('recommend', { message: 'Try these.', picks: [{ tmdb_id: 111, kind: 'movie', reason: 'x' }] })),
      (msgs) => { const err = JSON.parse(msgs.at(-1).content).error; assert.match(err, /None of those tmdb_ids came from your tool results \(111\)/); return assistant(toolCall('search_titles', { query: 'Short' }), toolCall('search_titles', { query: 'Long' })); },
      assistant(toolCall('recommend', { message: 'One pick.', picks: [{ tmdb_id: 1, kind: 'movie', reason: 'Quick laugh' }] })),
      (msgs) => { assert.match(JSON.parse(msgs.at(-1).content).note, /^Only 1 pick\(s\)/); return assistant(toolCall('recommend', { message: 'All under 90 minutes.', picks: [1, 2, 3, 4].map(id => ({ tmdb_id: id, kind: 'movie', reason: 'r' + id })) })); },
      (msgs) => { assert.match(JSON.parse(msgs.at(-1).content).error, /promises under 90 minutes, but these run longer: Long Four \(140 min\)/); return assistant(toolCall('recommend', { message: 'All under 90 minutes.', picks: [1, 2, 3, 4].map(id => ({ tmdb_id: id, kind: 'movie', reason: 'r' + id })) })); },
    ]);
    const s = createAsk({ relay, tmdb, library: () => null });
    await s.ask('short comedies');
    eq(s.turns[0].picks.map(p => p.item.id), [1, 2, 3], 'corrected, nudged once, over-length film dropped after one fix-up');
    ok(wellFormed(s.messages), 'still well-formed after the corrections');
    eq(relay.requests.length, 5, 'five model calls');

    // A follow-up hides what's already on screen when enough is new.
    const pick = (ids) => ids.map(([id, kind]) => ({ tmdb_id: id, kind, reason: 'r' }));
    const relay2 = fakeRelay([
      assistant(toolCall('search_titles', { query: 'Dune' }), toolCall('search_titles', { query: 'Short' }), toolCall('search_titles', { query: 'Long' }), toolCall('trending', {})),
      assistant(toolCall('recommend', { message: 'First.', picks: pick([[438631, 'movie'], [693134, 'movie'], [1, 'movie']]) })),
      assistant(toolCall('recommend', { message: 'More.', picks: pick([[438631, 'movie'], [2, 'movie'], [3, 'movie'], [4, 'movie'], [1399, 'tv'], [693134, 'movie']]) })),
    ]);
    const s2 = createAsk({ relay: relay2, tmdb, library: () => null });
    await s2.ask('first');
    await s2.ask('more like that');
    eq(s2.turns.map(t => t.picks.map(p => p.item.id)), [[438631, 693134, 1], [2, 3, 4, 1399]], "a follow-up drops titles already shown when 4+ new ones remain");
    eq(relay2.requests[2].messages.filter(m => m.role === 'user').map(m => m.content), ['first', 'more like that'], 'follow-ups carry the conversation');
  }

  // Failure: the half-finished exchange is rolled back; retry asks again. Plain replies show as-is.
  {
    let fail = true;
    const relay = async (messages) => {
      if (fail) throw Object.assign(new Error('x'), { userMessage: "The assistant's daily limit is used up. Try again tomorrow." });
      return { role: 'assistant', content: 'Plain words.' };
    };
    const s = createAsk({ relay, tmdb: fakeTmdb(), library: () => null });
    await s.ask('anything');
    eq([s.turns[0].failed, s.turns[0].reply, s.messages.length], [true, "The assistant's daily limit is used up. Try again tomorrow.", 0], 'failed turn: message shown, conversation rolled back');
    fail = false;
    await s.retry();
    eq([s.turns.length, s.turns[0].failed, s.turns[0].reply], [1, false, 'Plain words.'], 'retry replaces the failed turn; a plain reply is shown as it is');
    s.reset();
    eq([s.turns.length, s.messages.length, s.working], [0, 0, false], 'reset clears the conversation');
  }

  // Lookup cap, history sharing, cancel.
  {
    const many = Array.from({ length: 13 }, () => toolCall('trending', {}));
    const relay = fakeRelay([assistant(...many), (msgs) => {
      assert.match(msgs.at(-1).content, /Skipped: too many lookups/);
      return assistant(toolCall('my_titles', {}));
    }, (msgs) => {
      const titles = JSON.parse(msgs.at(-1).content).titles;
      assert.deepEqual(titles.map(t => t.status), ['My List', 'Watched', 'Watching']);
      return assistant(toolCall('recommend', { message: 'From your list.', picks: [{ tmdb_id: 10, kind: 'movie', reason: 'Yours' }, { tmdb_id: 12, kind: 'tv', reason: 'b' }, { tmdb_id: 13, kind: 'movie', reason: 'c' }] }));
    }]);
    const state = {
      list: [{ id: 10, kind: 'movie', title: 'Mine', poster: '/m.jpg' }],
      continue: [{ id: 12, kind: 'tv', title: 'Done', pos: 95, dur: 100, ts: 5 }, { id: 13, kind: 'movie', title: 'Half', pos: 10, dur: 100, ts: 2 }],
    };
    const s = createAsk({ relay, tmdb: fakeTmdb(), library: () => webLibrary(state) });
    await s.ask('pick from my list');
    eq(relay.requests[0].history, true, 'history: true when the viewer shares their list');
    eq(s.turns[0].picks.map(p => p.item.title), ['Mine', 'Done', 'Half'], 'my_titles results are pickable');
    ok(wellFormed(s.messages), 'the 13th lookup was answered "skipped", not left dangling');

    let release;
    const slow = createAsk({ relay: () => new Promise(r => { release = r; }), tmdb: fakeTmdb(), library: () => null });
    const p = slow.ask('wait');
    eq(slow.ask('second at once'), null, 'one question at a time');
    slow.cancel(); release({ role: 'assistant', content: 'late' });
    await p;
    eq([slow.turns[0].reply, slow.turns[0].failed], ['Stopped.', true], 'cancel stops the question');
  }

  // ── 4. The Worker's /api/ask proxy ────────────────────────────────────────────
  {
    const post = (env, body, method = 'POST') => {
      const req = new Request('https://watch.example/api/ask', { method, body: method === 'POST' ? body : undefined, headers: { 'content-type': 'application/json' } });
      return askRoutes(req, env, new URL(req.url));
    };
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], history: false });
    let r = await post({}, body);
    eq([r.status, (await r.json()).error], [503, 'ask-not-configured'], 'no SLIME_TOKEN -> 503');
    let seenReq = null;
    const binding = (status, payload) => ({ fetch: async (req) => { seenReq = { url: req.url, auth: req.headers.get('authorization'), body: await req.text() }; return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } }); } });
    r = await post({ SLIME_TOKEN: 'app-token', RELAY: binding(200, { message: { role: 'assistant', content: 'x' }, finish_reason: 'stop', prompt_version: 8 }) }, body);
    eq([r.status, (await r.json()).prompt_version], [200, 8], 'relay answer passed through');
    eq([new URL(seenReq.url).pathname, seenReq.auth, seenReq.body], ['/assist', 'Bearer app-token', body], 'forwarded to /assist with the token added server-side, body untouched');
    r = await post({ SLIME_TOKEN: 't', RELAY: binding(429, { error: 'daily limit' }) }, body);
    eq([r.status, (await r.json()).error], [429, 'daily limit'], '429 passed through');
    r = await post({ SLIME_TOKEN: 't', RELAY: binding(401, { error: 'unauthorized' }) }, body);
    eq([r.status, (await r.json()).error], [502, 'ask-unauthorized'], "a refused token is a 502, never a 401 the page would read as its own session");
    r = await post({ SLIME_TOKEN: 't', RELAY: { fetch: async () => { throw new DOMException('timed out', 'TimeoutError'); } } }, body);
    eq([r.status, (await r.json()).error], [504, 'ask-timeout'], 'timeout -> 504');
    r = await post({ SLIME_TOKEN: 't' }, 'x'.repeat(64001));
    eq(r.status, 413, 'oversized body refused before the relay');
    r = await post({ SLIME_TOKEN: 't' }, '{"nope":1}');
    eq(r.status, 400, 'no messages -> 400');
    r = await post({ SLIME_TOKEN: 't' }, null, 'GET');
    eq(r.status, 405, 'GET -> 405');
    const realFetch = globalThis.fetch;
    try {
      let target = null;
      globalThis.fetch = async (u, init) => { target = [String(u), init.headers.authorization]; return new Response('{"message":{"role":"assistant","content":""}}'); };
      r = await post({ SLIME_TOKEN: 't', RELAY_BASE: 'https://relay.example/' }, body);
      eq([r.status, target], [200, ['https://relay.example/assist', 'Bearer t']], 'without the binding: fetch RELAY_BASE/assist');
    } finally { globalThis.fetch = realFetch; }
  }

  // ── 5. Settings + Search UI wiring, through the real click dispatcher ────────
  {
    const els = new Map();
    const el = (id) => {
      if (!els.has(id)) {
        const cls = new Set();
        els.set(id, { id, innerHTML: '', value: '', style: {}, dataset: {}, listeners: {},
          classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c), toggle() {} },
          addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }, focus() {}, querySelectorAll: () => [] });
      }
      return els.get(id);
    };
    const MAIN_ACTS = new Set(['logout', 'go']);
    const saved = { document: globalThis.document, location: globalThis.location, fetch: globalThis.fetch,
      localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage') };
    // The app's singleton store reads globalThis.localStorage on first use; give it one
    // (node 26 otherwise warns that it has no --localstorage-file).
    Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true, writable: true });
    let clickHandler = null, savedPrefs = null, restorePrefs = null;
    try {
      globalThis.document = { getElementById: el, querySelectorAll: () => [], querySelector: () => null };
      globalThis.location = { hash: '#search/ask', href: '' };
      globalThis.fetch = async (u) => new Response(JSON.stringify({ build: 'abc123def456', sync: true, ask: true, extractor: { base: 'https://x', ok: true, ms: 42 } }), { headers: { 'content-type': 'application/json' } });
      const { initActions, actionNames } = await import('../src/app/ui/actions.js');
      const settings = await import('../src/app/ui/settings.js');
      const search = await import('../src/app/views/search.js');
      const { getPrefs, getState, setPrefs, setState } = await import('../src/app/state.js');
      // The app singleton may already hold prefs from another suite in this process: start clean, restore after.
      savedPrefs = getState().prefs; restorePrefs = () => setState({ prefs: savedPrefs }, { source: 'sync' });
      setState({ prefs: null }, { source: 'sync' });
      initActions({ addEventListener: (t, f) => { clickHandler = f; } });
      const click = (dataset) => clickHandler({ target: { closest: () => ({ dataset, checked: dataset.checked }) } });

      click({ act: 'settings' });
      await new Promise(r => setTimeout(r, 0));
      const html = el('setsheet').innerHTML + el('set-captions').innerHTML + el('set-audio').innerHTML + el('set-server').innerHTML + el('set-sync').innerHTML + el('set-about').innerHTML;
      ok(el('setmodal').classList.contains('open'), 'Settings opens');
      for (const s of ['Debrid', 'Captions', 'Anime audio', 'Home server', 'Sync', 'About', 'rdfield']) ok(html.includes(s), 'Settings has ' + s);
      ok(el('set-server').innerHTML.includes('Reachable · 42 ms') && el('set-about').innerHTML.includes('abc123def456'), 'home server reachability + build shown');
      const acts = new Set([...html.matchAll(/data-act="([a-z-]+)"/g)].map(m => m[1]));
      // ('logout' and 'go' are registered by main.js, which this check doesn't load; check.mjs verifies the whole bundle.)
      for (const a of acts) if (!MAIN_ACTS.has(a)) ok(actionNames().includes(a), `Settings' data-act="${a}" has a handler`);

      ok(el('set-audio').innerHTML.includes('aria-checked="true" class="on" data-act="set-pref" data-pref="animeAudio" data-val="dub"'), 'anime audio shows the player\'s default (dub)');
      ok(el('set-captions').innerHTML.includes('data-pref="subAuto" data-val="off"') && el('set-captions').innerHTML.includes('aria-checked="true" class="on" data-act="set-pref" data-pref="subAuto" data-val="off"'), 'captions: automatic is off by default');
      click({ act: 'set-pref', pref: 'subSize', val: 'L' });
      click({ act: 'set-pref', pref: 'animeAudio', val: 'sub' });
      click({ act: 'set-pref', pref: 'subSize', val: 'XXL' });   // ignored
      settings.addCaptionLang('ja');
      click({ act: 'caption-lang-up', lang: 'ja' });
      eq([getPrefs().subSize, getPrefs().animeAudio, getPrefs().subLangs, getPrefs().subLang], ['L', 'sub', ['ja', 'en'], undefined], 'Settings writes prefs (round-trip through the click dispatcher)');
      ok(el('set-captions').innerHTML.includes('1. Japanese') && el('set-captions').innerHTML.includes('aria-checked="true" class="on" data-act="set-pref" data-pref="subSize" data-val="L"'), 'and repaints them');
      click({ act: 'set-pref', pref: 'subAuto', val: 'on' });
      eq(getPrefs().subLang, 'ja', 'turning captions on automatically uses the first language (the player\'s subLang)');
      click({ act: 'caption-lang-up', lang: 'en' });
      eq([getPrefs().subLangs, getPrefs().subLang], [['en', 'ja'], 'en'], 'reordering keeps subLang on the first choice');
      setPrefs({ subLang: 'fr' });   // the player picked French
      eq(settings.captionLangs(getPrefs()), ['fr', 'en', 'ja'], 'the player\'s pick leads the list Settings shows');
      click({ act: 'set-pref', pref: 'subAuto', val: 'off' });
      eq(getState().prefs.subLang, undefined, 'turning it off removes subLang (what the player reads as off)');
      click({ act: 'caption-lang-remove', lang: 'en' });
      click({ act: 'caption-lang-remove', lang: 'ja' });
      eq(getPrefs().subLangs, ['ja'], 'the last caption language cannot be removed');
      ok(getState().prefs.subSize === 'L' && !('rdkey' in getState().prefs), 'prefs live in the synced key, the RD key stays separate');
      eq(settings.syncText({ state: 'local' })[0], 'dim', 'unconfigured sync reads as local');
      click({ act: 'settings-close' });
      ok(!el('setmodal').classList.contains('open'), 'Done closes it');

      // Search screen in Ask mode renders suggestions whose actions exist, and the history toggle is a pref.
      el('main'); search.viewSearchScreen('ask');
      el('mres').dataset.mode = 'ask';   // (the fake DOM doesn't parse innerHTML)
      const askActs = new Set([...(el('main').innerHTML).matchAll(/data-act="([a-z-]+)"/g)].map(m => m[1]));
      for (const a of askActs) if (!MAIN_ACTS.has(a)) ok(actionNames().includes(a), `Search's data-act="${a}" has a handler`);
      ok(el('main').innerHTML.includes('Ask SlimeWatch anything'), 'Ask mode field');
      click({ act: 'ask-history', checked: true });
      eq(getPrefs().askHistory, true, 'the Ask history toggle is a synced pref');
    } finally {
      globalThis.document = saved.document; globalThis.location = saved.location; globalThis.fetch = saved.fetch;
      if (restorePrefs) restorePrefs();
      if (saved.localStorage) Object.defineProperty(globalThis, 'localStorage', saved.localStorage); else delete globalThis.localStorage;
    }
  }
  return n;
}
