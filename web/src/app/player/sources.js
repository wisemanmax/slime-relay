// Embed providers, the ad-free extractor tier, and the source <select>.

import { resolveEmbed } from '../api.js';
import { esc } from '../util.js';

/* Embed providers, synced with the apps' verified set (StreamProvider.swift).
   Tested from here: embed.su and player.autoembed.cc no longer resolve at all,
   iframe.pstream.org is a PARKED domain serving ads, and vidfast.pro is a 301 to
   vidfast.vc — all four were still being offered here long after the apps
   dropped them, which is why "some sources don't work". The three VidSrc mirrors
   the apps use were never offered on the web at all; they answer 200.

   vidsrc.cc removed 2026-08-27: it answers 403 with a 5.5 KB block page for
   every title (measured here, and the apps dropped it the day before for the
   same reason). Offering a source that can only fail is worse than offering one
   fewer — it costs the viewer a rung and reads as "the site is broken".

   Each entry: [select value, label, (tmdbId, kind, season, episode, startAt) => embed URL].
   startAt (s) is a shared moment's start; only VidLink takes one (`startAt=`, as
   the apps pass it in StreamProvider.swift) — the rest start at the top. The
   ad-free tier's resolve never passes it, so its URLs (and cache keys) stay put. */
export const PROVIDERS = [
  ['vidlink','VidLink',(t,k,s,e,at)=> (k==='movie'?`https://vidlink.pro/movie/${t}?autoplay=true&title=false&primaryColor=43e048`:`https://vidlink.pro/tv/${t}/${s}/${e}?autoplay=true&title=false&primaryColor=43e048`) + (at > 0 ? `&startAt=${Math.floor(at)}` : '')],
  ['vidfast','VidFast',(t,k,s,e)=> k==='movie'?`https://vidfast.vc/movie/${t}?autoPlay=true`:`https://vidfast.vc/tv/${t}/${s}/${e}?autoPlay=true`],
  // The VidSrc mirror family shares one embed API: /embed/{movie,tv}?tmdb=&season=&episode=
  ['vidsrcme','VidSrc',(t,k,s,e)=> k==='movie'?`https://vidsrcme.ru/embed/movie?tmdb=${t}&autoplay=1`:`https://vidsrcme.ru/embed/tv?tmdb=${t}&season=${s}&episode=${e}&autoplay=1`],
  ['vidsrcme2','VidSrc 2',(t,k,s,e)=> k==='movie'?`https://vidsrc2.ru/embed/movie?tmdb=${t}&autoplay=1`:`https://vidsrc2.ru/embed/tv?tmdb=${t}&season=${s}&episode=${e}&autoplay=1`],
  ['vidsrcme3','VidSrc 3',(t,k,s,e)=> k==='movie'?`https://vidsrcme.su/embed/movie?tmdb=${t}&autoplay=1`:`https://vidsrcme.su/embed/tv?tmdb=${t}&season=${s}&episode=${e}&autoplay=1`],
];

/** The <option>s for the source picker: extractor streams (dx:i — anime rungs
    and ad-free), then debrid (rd:i — direct files, then Mac remuxes), then embeds. */
export function sourceOptionsHTML(direct, debrid) {
  const dx = direct.map((st, i) => `<option value="dx:${i}">${st.anime ? 'Anime ' + (st.anime.audio === 'dub' ? 'DUB' : 'SUB') : 'Ad-free'} · ${esc(st.label)}</option>`).join('');
  const rd = debrid.map((st, i) => `<option value="rd:${i}">Debrid${st.vt ? ' · Convert on Mac' : ''} · ${esc(st.label)}</option>`).join('');
  const em = PROVIDERS.map(([id, name]) => `<option value="${id}">${name} (embed)</option>`).join('');
  return dx + rd + em;
}

/** An extractor /resolve answer -> the player's stream record, or null. */
export function streamFromResolve(j, label) {
  const play = j && (j.play || j.url || j.stream);
  if (!play || !/^https?:/i.test(play)) return null;
  const type = j.type === 'mp4' ? 'mp4' : 'hls';
  const subs = Array.isArray(j.subs) ? j.subs.filter(x => x && typeof x.url === 'string') : [];
  return { url: play, label, type, subs };
}

/* Ad-free tier.
   The providers cannot be sandboxed (they detect it and refuse), so their popups
   and overlays are untouchable from this page. The way out is to not load their
   page at all: the extractor opens it server-side and hands back the underlying
   stream, which plays in the same <video> element the debrid tier uses. Same
   trick the iOS and TV apps use, now available here.
   Bounded and best-effort — extraction takes seconds and can fail, so the embed
   iframe stays as the fallback it always was.

   Returns the first stream found ({url, label, type, subs}) or null. The
   caller checks its title generation before using it: a resolve that
   finishes after the viewer moved on must not touch the new title. */
export async function resolveDirect(ctx) {
  if (!ctx) return null;
  const { it, kind, s, e } = ctx;
  // Two attempts, not the whole list: extraction took ~4s in testing, but a
  // failing provider costs the full timeout, and nobody waits a minute to start
  // a film. Two covers the common case without a worst case that feels broken.
  for (const [, name, build] of PROVIDERS.slice(0, 2)) {
    try {
      const j = await resolveEmbed(build(it.id, kind, s, e), { signal: AbortSignal.timeout(15000) });
      const st = streamFromResolve(j, name);
      if (st) return st;
    } catch (_) { /* try the next provider */ }
  }
  return null;
}
