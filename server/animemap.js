'use strict';
// TMDB → AniList/MAL mapping + anime episode resolution, from Fribb's anime-lists
// (a merge of manami-project/anime-offline-database + Anime-Lists). Anime stream
// sources are keyed on AniList/MAL, not TMDB, so this is the bridge that lets the
// app offer real anime sources (and dub/sub). Data is cached on disk (7 MB) and
// refreshed periodically; if the network is down we fall back to the stale cache.
const fs = require('fs');
const path = require('path');
const https = require('https');

const SRC = 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json';
const FILE = path.join(__dirname, 'anime-list-full.json');
const MAX_AGE_MS = 14 * 24 * 3600 * 1000;

let tvIndex = new Map();     // tmdb tv id -> [entries]
let movieIndex = new Map();  // tmdb movie id -> [entries]
let ready = false;

function build(list) {
  const tv = new Map(), mv = new Map();
  for (const e of list) {
    const t = e.themoviedb_id;
    if (!t || typeof t !== 'object') continue;
    if (t.tv != null) { const k = Number(t.tv); (tv.get(k) || tv.set(k, []).get(k)).push(e); }
    if (Array.isArray(t.movie)) for (const id of t.movie) { const k = Number(id); (mv.get(k) || mv.set(k, []).get(k)).push(e); }
  }
  tvIndex = tv; movieIndex = mv; ready = true;
}

function download() {
  return new Promise((resolve, reject) => {
    https.get(SRC, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function init() {
  try {
    const st = fs.statSync(FILE);
    if (Date.now() - st.mtimeMs < MAX_AGE_MS) {
      build(JSON.parse(fs.readFileSync(FILE, 'utf8')));
      console.log(`[animemap] ${tvIndex.size} tv + ${movieIndex.size} movie mappings (cached)`);
      return;
    }
  } catch (e) {}
  try {
    const buf = await download();
    const list = JSON.parse(buf.toString('utf8'));
    fs.writeFileSync(FILE, buf);
    build(list);
    console.log(`[animemap] ${tvIndex.size} tv + ${movieIndex.size} movie mappings (downloaded)`);
  } catch (e) {
    try {
      build(JSON.parse(fs.readFileSync(FILE, 'utf8')));
      console.warn('[animemap] download failed, using stale cache:', e.message);
    } catch (e2) {
      console.warn('[animemap] no mapping data available (anime sources disabled):', e.message);
    }
  }
}

/// Resolve a TMDB id (+ season/episode for TV) to anime-source ids and the
/// per-cour episode number the AniList-keyed sources expect. Returns null when
/// the title isn't anime (or isn't in the mapping).
function animeIds(tmdbId, kind, season, episode) {
  if (!ready) return null;
  const id = Number(tmdbId);
  if (kind === 'movie') {
    const list = movieIndex.get(id);
    if (!list || !list.length) return null;
    const e = list[0];
    return { anilistId: e.anilist_id || null, malId: e.mal_id || null, anidbId: e.anidb_id || null, episode: 1 };
  }
  const list = tvIndex.get(id);
  if (!list || !list.length) return null;
  const s = Number(season) || 1, ep = Number(episode) || 1;
  let cands = list.filter((e) => (e.type || 'TV').toUpperCase() !== 'MOVIE');
  if (!cands.length) cands = list;
  // Match the TMDB season, then (for shows TMDB lumps into one season but AniList
  // splits into cours) pick the entry whose episode offset is the largest below
  // this episode, and shift the episode into that cour's own 1-based numbering.
  let seasonCands = cands.filter((e) => (e.season && e.season.tmdb != null ? Number(e.season.tmdb) : 1) === s);
  if (!seasonCands.length) seasonCands = cands.filter((e) => Number(e.season && e.season.tmdb) === 1);
  if (!seasonCands.length) seasonCands = cands;
  const ranked = seasonCands
    .map((e) => ({ e, off: (e.episode_offset && Number(e.episode_offset.tmdb)) || 0 }))
    .filter((x) => ep > x.off)
    .sort((a, b) => b.off - a.off);
  const pick = ranked[0] || { e: seasonCands[0], off: 0 };
  return {
    anilistId: pick.e.anilist_id || null,
    malId: pick.e.mal_id || null,
    anidbId: pick.e.anidb_id || null,
    episode: Math.max(1, ep - pick.off),
  };
}

module.exports = { init, animeIds, isReady: () => ready };
