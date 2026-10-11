/* Anime Sub/Dub — the apps' anime tier on the web (AnimeSource.swift,
   AnimeRungRules.swift, AnimeNativeTier.swift in the app repo).

   Anime hosts are keyed on AniList ids, not TMDB, so the title is mapped first
   (/api/player/animeids -> the extractor's TMDB->AniList/MAL map), then each
   host is asked for the episode in the preferred audio, then in the other:
   tryembed -> vidnest -> anixo, dub first unless the viewer chose Sub. Each
   rung is resolved through the extractor (/api/resolve), so it plays as an
   ad-free stream in our own <video>, never as the host's page.

   A /dub request never fails for want of a dub — the hosts silently serve the
   sub. The extractor fingerprints the two encodes and says which one it got
   (`audio`, `dubVerified`, `dubReason`); `audio: "sub"` on a dub request means
   the host had no dub. deliveredAudio() is that rule.

   Pure helpers first (test/player.mjs drives them), then the lookup. */

import { api } from '../api.js';
import { fetchAnimeIds } from './playerapi.js';

/* The baked-on hosts, in ladder order. tryembed is the primary; vidnest is a
   second FRONT on tryembed's catalog (byte-identical encodes, measured
   2026-10-05), so its "no stream" for an audio is tryembed's answer too;
   anixo is its own catalog, probationary, last. */
export const ANIME_HOSTS = [
  { host: 'tryembed.us.cc', catalog: 'tryembed', primary: true, path: (a, e, au) => `/embed/anime/${a}/${e}/${au}` },
  { host: 'vidnest.fun', catalog: 'tryembed', primary: false, path: (a, e, au) => `/anime/${a}/${e}/${au}` },
  { host: 'anixo.buzz', catalog: 'anixo', primary: false, path: (a, e, au) => `/embed/ani/${a}/${e}/${au}` },
];

/** The viewer's audio preference: 'sub' only when chosen, else 'dub' (a dub
    request costs nothing when no dub exists — the host serves the sub). */
export const audioPref = (prefs) => (prefs && prefs.animeAudio === 'sub' ? 'sub' : 'dub');
export const otherAudio = (a) => (a === 'sub' ? 'dub' : 'sub');

/** Every anime rung for a mapped title, in preference order: each host for the
    preferred audio, then each host for the other one. [] when not anime. */
export function animeRungs(ids, preferred) {
  if (!ids || !ids.anime || !(ids.anilistId > 0)) return [];
  const pref = preferred === 'sub' ? 'sub' : 'dub';
  const ep = Math.max(1, Math.floor(ids.episode) || 1);
  const out = [];
  for (const audio of [pref, otherAudio(pref)]) {
    for (const h of ANIME_HOSTS) {
      out.push({ url: 'https://' + h.host + h.path(ids.anilistId, ep, audio), audio, host: h.host, catalog: h.catalog, primary: h.primary });
    }
  }
  return out;
}

/** What a rung's stream really carries, from the extractor's dub report.
      -> { audio: 'sub'|'dub', fellBack, verified }
    A sub request is a sub. A dub request answered `audio: "sub"` fell back
    (the host had no dub: badge SUB, captions on). Anything else on a dub
    request — "dub", or no field from an older server / an unfingerprintable
    mp4 — is taken at its word, unverified unless the server said so. */
export function deliveredAudio(requested, res) {
  const raw = String((res && res.audio) || '').toLowerCase();
  const audio = raw === 'sub' || raw === 'dub' ? raw : null;
  const verified = !!(audio && res.dubVerified === true);
  if (requested !== 'dub') return { audio: 'sub', fellBack: false, verified: true };
  if (audio === 'sub') return { audio: 'sub', fellBack: true, verified };
  return { audio: 'dub', fellBack: false, verified };
}

/* Budgets (AnimeNativeTier / AnimeHostHealth): the primary gets 15 s + 2 s of
   slack; a backup 10 s for a sub, 16 s for a dub (the extractor's first /dub
   on a host also waits up to 6 s for its sibling /sub fingerprint). Another
   rung starts only while it still fits in the 35 s start budget — sized so a
   hung primary still leaves one backup try. */
export const START_BUDGET_MS = 35000;
export const rungBudgetMs = (r) => (r.primary ? 17000 : r.audio === 'dub' ? 16000 : 10000);
export const mayTryRung = (elapsedMs, r) => elapsedMs + rungBudgetMs(r) <= START_BUDGET_MS;

/** Pass a rung over when a host on the same catalog already said "no stream"
    for this audio (the SITE's verdict, which every front on it repeats). */
export function skipRung(r, noStream) {
  return (noStream || []).some(x => x.audio === r.audio && x.catalog === r.catalog);
}

/** The extractor's "no stream for this title" (502) — a site verdict — vs a
    host failure (timeout / 504 unreachable / 429 busy), which isn't. */
export const isNoStream = (j) => !!(j && /^resolve-502$/.test(String(j.error || '')));

/** TMDB per-season episode -> the absolute number a single-entry AniList
    series uses, by adding every earlier season. Unchanged for season 1 or
    when any earlier season's count is missing (a wrong absolute is worse
    than an honest per-season number). */
export function absoluteEpisode(season, episode, counts) {
  if (!(season > 1) || !counts) return episode;
  let prior = 0;
  for (let n = 1; n < season; n++) {
    const c = counts[n];
    if (!(c > 0)) return episode;
    prior += c;
  }
  return episode + prior;
}

/** {seasonNumber: episodeCount} from a TMDB tv detail object, or null. */
export function seasonCounts(it) {
  const list = it && Array.isArray(it.seasons) ? it.seasons : null;
  if (!list || !list.length) return null;
  const out = {};
  for (const x of list) if (x && x.season_number >= 0 && x.episode_count > 0) out[x.season_number] = x.episode_count;
  return out;
}

/** The absolute episode worth sending (subtitle index fallback + the anime
    map's single-entry series), or null when it is the same number. */
export function absFor(ctx, counts) {
  if (!ctx || ctx.kind !== 'tv' || !(ctx.s > 1)) return null;
  const a = absoluteEpisode(ctx.s, ctx.e, counts);
  return a !== ctx.e ? a : null;
}

/** Worth asking the anime map at all? A TMDB item that names its genres and
    lacks Animation (16) is not anime; one that names none (a Continue Watching
    or My List record) is asked. */
export function maybeAnime(it) {
  if (!it) return false;
  const ids = Array.isArray(it.genre_ids) ? it.genre_ids
    : Array.isArray(it.genres) ? it.genres.map(g => g && g.id) : null;
  return ids == null || ids.includes(16);
}

/** The title's anime mapping -> {anime:true, anilistId, malId, episode, abs} |
    {anime:false}. Never throws. Fetches the season table only when it is
    needed (season > 1) and the item doesn't carry one. */
export async function lookupAnime(ctx) {
  if (!ctx || !maybeAnime(ctx.it)) return { anime: false };
  let counts = seasonCounts(ctx.it);
  if (!counts && ctx.kind === 'tv' && ctx.s > 1) counts = seasonCounts(await api('tv/' + ctx.it.id));
  const abs = absFor(ctx, counts);
  const j = await fetchAnimeIds(ctx, abs);
  if (!j || !j.anime || !(j.anilistId > 0)) return { anime: false };
  return { anime: true, anilistId: j.anilistId, malId: j.malId || 0, episode: j.episode || 1, abs };
}
