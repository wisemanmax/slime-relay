/* Wave 8 (W1, roadmap 8.3): skip markers for everything that isn't anime —
   intro / recap / credits / preview windows from TheIntroDB (theintrodb.org),
   a community database keyed by TMDB id, so it covers live-action series AND
   films where AniSkip only knows anime. A port of the apps' TheIntroDB.swift
   and the per-kind merge in SkipMarkers.swift; skip.js shows the windows the
   way it already shows AniSkip's (a button + the `s` key). Pure: node-tested in
   test/parity.mjs, and the Worker's /api/player/markers fallback cleans
   upstream answers with sanitizeIntroDB below.

   API v3, read side, no key (the apps checked it 2026-10-01):
     GET https://api.theintrodb.org/v3/media?tmdb_id=1396&season=1&episode=1
     -> {"tmdb_id":1396,"type":"tv","season":1,"episode":1,
         "intro":[{"start_ms":228664,"end_ms":246143}],
         "credits":[{"start_ms":3431000,"end_ms":null}]}
     GET https://api.theintrodb.org/v3/media?tmdb_id=1726        (a film: no season)
   Each kind is an array (a film can have credits, a scene, more credits); an
   absent kind = nothing known. start_ms null = the top of the file, end_ms null
   = its end. An unknown title: 404 {"error":"media not found"}. Rate limit:
   30 requests per 10 s per address.

   Chapter-named windows (the apps' third source) don't exist here: a browser's
   <video> exposes no chapter list. */

export const INTRODB_BASE = 'https://api.theintrodb.org/v3/media';

const KINDS = [['intro', 'Skip intro'], ['recap', 'Skip recap'], ['credits', 'Skip credits'], ['preview', 'Skip preview']];
/** Kinds that sit at the end of an episode: plausible only in its last 40 %,
    and the only ones that may run to the end of the file. */
export const END_KINDS = new Set(['outro', 'credits', 'preview']);
const MAX_PER_KIND = 10;

/** The lookup URL for {it, kind, s, e} (a film asks without season/episode), or null. */
export function introDBUrl(ctx) {
  const id = ctx && ctx.it && Number(ctx.it.id);
  if (!(id > 0) || !Number.isInteger(id)) return null;
  if (ctx.kind === 'movie') return INTRODB_BASE + '?tmdb_id=' + id;
  if (ctx.kind !== 'tv' || !(ctx.s >= 0) || !(ctx.e >= 1)) return null;
  return `${INTRODB_BASE}?tmdb_id=${id}&season=${ctx.s}&episode=${ctx.e}`;
}
/** One answer per title / episode (the apps' cache key). */
export const introDBKey = (ctx) => (ctx && ctx.kind === 'movie' ? 'm' + ctx.it.id : `t${ctx && ctx.it && ctx.it.id}:${ctx && ctx.s}:${ctx && ctx.e}`);

const seconds = (v) => (typeof v === 'number' && Number.isFinite(v) ? v / 1000 : null);

/** A TheIntroDB /media answer -> [{start, end, kind, label, endsPlayback?}],
    sorted. `want` {tmdb, isMovie}: a body describing another title or media
    type than asked for is ignored rather than trusted. A row with no end runs
    to the end of the file (end Infinity, endsPlayback) — allowed only for an
    end-of-episode kind: an "intro to the end of the file" is a bad submission,
    not a window. Anything malformed is dropped, never thrown. */
export function parseIntroDB(json, want) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return [];
  if (want) {
    if (json.tmdb_id != null && Number(json.tmdb_id) !== Number(want.tmdb)) return [];
    if (typeof json.type === 'string' && json.type !== (want.isMovie ? 'movie' : 'tv')) return [];
  }
  const out = [];
  for (const [field, label] of KINDS) {
    const rows = Array.isArray(json[field]) ? json[field].slice(0, MAX_PER_KIND) : [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const start = row.start_ms == null ? 0 : seconds(row.start_ms);
      if (start == null || start < 0) continue;
      const end = seconds(row.end_ms);
      if (end == null) {
        if (row.end_ms == null && END_KINDS.has(field)) out.push({ start, end: Infinity, kind: field, label, endsPlayback: true });
        continue;
      }
      if (end > start) out.push({ start, end, kind: field, label });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** AniSkip's outro and TheIntroDB's credits are the same stretch. */
export const kindGroup = (kind) => (kind === 'credits' ? 'outro' : kind);

/** AniSkip's windows, then TheIntroDB's for every KIND AniSkip didn't answer
    (all of them, for anything that isn't anime) — per kind, not per window:
    the same opening timed twice would be two buttons for one stretch. Sorted. */
export function mergeMarkers(anime, community) {
  const a = Array.isArray(anime) ? anime : [];
  const answered = new Set(a.map(s => kindGroup(s.kind)));
  const c = (Array.isArray(community) ? community : []).filter(s => !answered.has(kindGroup(s.kind)));
  return [...a, ...c].sort((x, y) => x.start - y.start);
}

/** Upstream's answer reduced to the fields parseIntroDB reads (the Worker's
    fallback passes only this on): numbers or null, at most 10 rows a kind. */
export function sanitizeIntroDB(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return {};
  const out = {};
  if (Number.isInteger(json.tmdb_id) && json.tmdb_id > 0) out.tmdb_id = json.tmdb_id;
  if (json.type === 'movie' || json.type === 'tv') out.type = json.type;
  for (const k of ['season', 'episode']) if (Number.isInteger(json[k]) && json[k] >= 0) out[k] = json[k];
  // null stays null (the top / the end of the file); any other non-number drops
  // the row, so junk can never turn into an open-ended window on the way through.
  const ms = (v) => (v == null ? null : typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e9 ? Math.round(v) : undefined);
  for (const [field] of KINDS) {
    if (!Array.isArray(json[field])) continue;
    out[field] = json[field].slice(0, MAX_PER_KIND).filter(r => r && typeof r === 'object')
      .map(r => ({ start_ms: ms(r.start_ms), end_ms: ms(r.end_ms) }))
      .filter(r => r.start_ms !== undefined && r.end_ms !== undefined);
  }
  return out;
}
