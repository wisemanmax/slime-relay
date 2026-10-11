// Debrid tier (Torrentio + the user's own Real-Debrid account) — tried first,
// mirroring the apps' ladder. Pure helpers + the resolve; the player decides
// what to do with the result.

import { api, rdKeyFromSite, debridFallback } from '../api.js';
import { esc } from '../util.js';
import { getRdKey, setRdKey } from '../state.js';

/* Browser can decode these CONTAINERS directly. Mirrors WEB_PLAYABLE in the
   worker — keep the two in step. */
export const WEB_PLAYABLE = /\.(mp4|webm|mov|m4v)$/i;

/* Containers no browser plays, which the extractor's /vt converter can remux
   into fMP4 HLS for hls.js / Safari — H.264 video only (it copies, never
   re-encodes; anything else answers 502). They used to be dropped outright. */
export const REMUXABLE = /\.(mkv|avi)$/i;

/* Container was never the whole story. An mp4 carrying Dolby Digital (AC-3),
   DD+/E-AC-3, DTS, TrueHD or Atmos plays PICTURE with no sound in a browser —
   which is what "debrid has no audio" turned out to be. Apple's players decode
   these happily, so the iOS and TV apps are unaffected; only the web is.
   Release names carry the tag, so screen on it. */
export const WEB_DEAD_AUDIO = /\b(ddp?[0-9]|dd\+|e-?ac-?3|ac-?3|dts(-hd|-?ma)?|truehd|atmos|flac)\b/i;

/* Through the converter the audio rule changes: /vt transcodes DTS / TrueHD /
   PCM / Opus to AAC, but COPIES AC-3 and E-AC-3 (Apple HLS allows them) —
   and Chrome / Firefox can't decode those. So for a remux only the Dolby
   Digital family is dead, and only where the browser lacks AC-3. Atmos rides
   on either TrueHD (transcoded: fine) or DD+ (copied: dead); untagged Atmos is
   read as DD+, the common web release. */
export const VT_DEAD_AUDIO = /\b(ddp?[0-9]|dd\+|e-?ac-?3|ac-?3)\b/i;
const ATMOS_ON_DDP = (t) => /\batmos\b/i.test(t) && !/\btrue-?hd\b/i.test(t);

/* HEVC / 10-bit video: /vt copies H.264 only (HEVC, Hi10P -> 502), and of the
   browsers only Safari (plus Chrome on HEVC-capable hardware) decodes HEVC. */
export const HEVC = /\b(x265|h\.?265|hevc|10-?bit|hi10p?)\b/i;
export const H264 = /\b(x264|h\.?264|avc)\b/i;

export function qualityOf(t) {
  t = String(t).toLowerCase();
  if (/2160|\b4k\b|uhd/.test(t)) return 2160;
  if (/1440/.test(t)) return 1440;
  if (/1080/.test(t)) return 1080;
  if (/720/.test(t)) return 720;
  if (/480/.test(t)) return 480;
  return 0;
}
export function shortName(fn) { return String(fn).replace(/\.[^.]+$/, '').replace(/[._]+/g, ' ').trim().slice(0, 46); }

/** Torrentio's response -> the player's source list: browser-playable files
    best first, then (opts.convert) files the Mac can remux, H.264-tagged first.
      opts.convert   offer mkv/avi through /vt (the extractor is reachable)
      opts.canHevc   false = this browser can't decode HEVC: drop HEVC mp4s too
      opts.canAc3    this browser decodes AC-3 / E-AC-3 (Safari): keep DD remuxes
    The result carries .silentDropped (browser-playable files skipped for their
    audio) so an empty list can say why. Max 10, at most 4 of them remuxes. */
export function pickDebridStreams(data, opts = {}) {
  const direct = [], remux = []; let dropped = 0;
  for (const x of (data && data.streams) || []) {
    const fn = (x.behaviorHints && x.behaviorHints.filename) || x.title || x.name || '';
    const txt = (x.name || '') + ' ' + (x.title || '');
    if (!x.url || !/^https?:/i.test(x.url)) continue;   // not a cached direct link
    if (/download/i.test(txt)) continue;              // Torrentio marks uncached RD "download"
    const q = qualityOf(txt);
    const label = (q ? q + 'p' : 'SD') + ' · ' + shortName(fn);
    if (WEB_PLAYABLE.test(fn)) {
      if (WEB_DEAD_AUDIO.test(txt)) { dropped++; continue; }   // plays silent in a browser
      if (opts.canHevc === false && HEVC.test(txt)) continue;  // no picture here
      direct.push({ url: x.url, quality: q, label });
    } else if (opts.convert && REMUXABLE.test(fn)) {
      if (HEVC.test(txt)) continue;                           // /vt would 502
      if (!opts.canAc3 && (VT_DEAD_AUDIO.test(txt) || ATMOS_ON_DDP(txt))) continue;
      remux.push({ url: x.url, quality: q, label, vt: true, h264: H264.test(txt) });
    }
  }
  direct.sort((a, b) => b.quality - a.quality);
  // Tagged H.264 first (the converter's one video codec), then by quality.
  remux.sort((a, b) => (b.h264 - a.h264) || (b.quality - a.quality));
  const out = direct.slice(0, 10);
  out.push(...remux.slice(0, Math.min(4, 10 - out.length)));
  // Set on the array that is RETURNED: it used to be set on the full list and
  // then lost to slice(), so 'silent-audio' could never be reported.
  out.silentDropped = dropped;
  return out;
}

/** What this browser can decode, for pickDebridStreams. Runtime only. */
export function browserCaps() {
  const MS = globalThis.MediaSource;
  const ms = (t) => { try { return !!(MS && MS.isTypeSupported(t)); } catch (_) { return false; } };
  let v = null; try { v = document.createElement('video'); } catch (_) {}
  const can = (t) => { try { return !!(v && v.canPlayType(t)); } catch (_) { return false; } };
  return {
    canHevc: ms('video/mp4; codecs="hvc1.1.6.L93.B0"') || can('video/mp4; codecs="hvc1.1.6.L93.B0"'),
    canAc3: ms('audio/mp4; codecs="ac-3"') || can('audio/mp4; codecs="ac-3"'),
  };
}

/* Seed the debrid key from the site's own secret, so a new browser, a cleared
   cache or a second device doesn't mean pasting a token again. A key the user
   entered themselves always wins — this only fills a blank. */
export async function seedRdKey() {
  if (getRdKey()) return;
  try { const j = await rdKeyFromSite();
    if (j && j.key) setRdKey(j.key); } catch (_) {}
}

/** -> { streams:[{url,quality,label,vt?}], reason } ; reason explains an empty list (see debridWhy).
    opts: pickDebridStreams options (convert / canHevc / canAc3). */
export async function resolveDebrid(it, kind, s, e, opts = {}) {
  let key = getRdKey();
  if (!key) { await seedRdKey(); key = getRdKey(); }
  if (!key) return { streams: [], reason: 'no-key' };   // still nothing → skip the round-trip

  /* Ask Torrentio from the BROWSER first.
     The Worker route kept failing with a torrentio-* status while the same
     request from a normal connection answered in under half a second — Torrentio
     sits behind Cloudflare and does not welcome Worker egress. Torrentio sends
     access-control-allow-origin: *, so the page can just ask it directly, from
     the user's own connection, which is also what the iOS and TV apps do.
     No new exposure: the key already travels to Torrentio inside this URL, and
     the stream links it returns are RD CDN redirects either way. */
  try {
    const ext = await api((kind === 'tv' ? 'tv/' : 'movie/') + it.id + '/external_ids');
    const imdb = ext && ext.imdb_id;
    if (imdb && imdb.indexOf('tt') === 0) {
      const id = kind === 'tv' ? imdb + ':' + s + ':' + e : imdb;
      const cfg = 'sort=qualitysize%7Cqualityfilter=cam,scr,unknown%7Crealdebrid=' + encodeURIComponent(key);
      const url = 'https://torrentio.strem.fun/' + cfg + '/stream/' + (kind === 'tv' ? 'series' : 'movie') + '/' + id + '.json';
      const r = await fetch(url, { signal: AbortSignal.timeout(9000) });
      if (r.ok) {
        const streams = pickDebridStreams(await r.json(), opts);
        if (streams.length) return { streams, reason: '' };
        return { streams: [], reason: streams.silentDropped ? 'silent-audio' : 'none-playable' };
      }
    }
  } catch (e) { /* fall through to the Worker route below */ }

  // Fallback: the original server-side path, still bounded so a hung request
  // can't stall playback. (Browser-playable containers only.)
  try { const r = await debridFallback(it, kind, s, e, key, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return { streams: [], reason: 'error' }; const j = await r.json(); return { streams: j.streams || [], reason: j.reason || '' }; }
  catch { return { streams: [], reason: 'timeout' }; }
}

// Never leave debrid invisible — say why it fell back (and how to fix it).
// The links carry data-act="settings" (registered in ui/settings.js).
export function debridWhy(reason) {
  if (reason === 'no-key') return '⚡ Debrid is off — <b data-act="settings" style="cursor:pointer;text-decoration:underline">add your Real-Debrid key</b> to unlock clean HD. Using an embed source for now.';
  if (reason === 'bad-key') return 'Your saved Real-Debrid key looks malformed — <b data-act="settings" style="cursor:pointer;text-decoration:underline">re-enter it</b>. Using an embed source.';
  if (reason === 'no-imdb') return 'Debrid couldn\'t match this title — using an embed source.';
  if (reason === 'none-playable') return 'Debrid has this title, but only in containers a browser can\'t play (mkv / 4K remux) — using an embed source.';
  if (reason === 'silent-audio') return 'Debrid has this title, but only with surround audio (Dolby / DTS) that browsers can\'t decode — it would play silent, so using an embed source.';
  if (reason && reason.indexOf('torrentio') === 0) return 'Debrid source unreachable (' + esc(reason) + ') — using an embed source.';
  return 'No browser-playable debrid file for this title (4K remux / mkv can\'t play in a browser) — using an embed source. A browser ad blocker makes it ad-free.';
}
