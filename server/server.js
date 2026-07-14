// SlimeWatch local extractor + proxy server (runs on your Mac).
// Extracts the real stream from a provider embed using headless Chromium,
// then PROXIES the bytes (the CDNs TLS-fingerprint-block non-browser clients,
// so AVPlayer can't fetch directly - we fetch via the browser's network stack
// and re-serve over your LAN).
const http = require('http');
const https = require('https');
const { chromium } = require('playwright');
const batcave = require('./batcave');

// -- Foolproof startup -- load .env no matter how we were launched (npm start,
// bare `node server.js`, or a double-click), then fail loud & clear on the
// mistakes that otherwise cause silent breakage.
require('./env').loadEnv();
(function preflight() {
  const t = (process.env.SLIME_TOKEN || '').trim();
  if (!t || t === 'change-me') {
    console.error(
      '\n[X]  SLIME_TOKEN is not set.\n' +
      '   The extractor refuses to start without it - otherwise it would be an open\n' +
      '   proxy on your network, and the relay rejects its heartbeats.\n\n' +
      '   Fix:  run  " node setup.js "  (guided), or set SLIME_TOKEN in server/.env\n' +
      '         to the SAME value as your relay USER_TOKEN and the SlimeWatch app token.\n'
    );
    process.exit(1);
  }
})();

const PORT = process.env.PORT || 8787;
// Shared secret - when set, every request (except /health) must carry ?key=...
// so other devices on the LAN can't use this as an open proxy.
const TOKEN = process.env.SLIME_TOKEN || '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
// Appended to URLs the server hands back so AVPlayer's follow-up requests
// (segments, ranges) stay authorized.
const KEY_Q = TOKEN ? `key=${TOKEN}` : '';
// Provider hosts the headless browser is allowed to navigate to on /resolve.
// Env-overridable because providers rotate domains; base domains match their
// subdomains too.
const EMBED_HOSTS = (process.env.SLIME_EMBED_HOSTS ||
  'vidlink.pro,vidfast.pro,vidsrc.cc,embed.su,autoembed.cc,pstream.org,vidsrc.to,vidsrcme.ru,vidsrc-embed.ru,vsrc.su,vidsrc.icu')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
function embedHostAllowed(embed) {
  let h; try { h = new URL(embed).hostname.toLowerCase(); } catch (e) { return false; }
  return EMBED_HOSTS.some(base => h === base || h.endsWith('.' + base));
}

// Ad / tracker / pop-under networks. During /resolve the headless browser ABORTS
// requests to these (faster + less CPU + no hostile ad code run), and the stream
// capture refuses to grab an .m3u8/.mp4 whose host is one of them (VAST/VPAID ad
// creatives are often HLS - without this guard an ad reel can be mistaken for the
// feature). Env-overridable via SLIME_AD_HOSTS (comma-separated, appended).
const AD_HOSTS = (
  'doubleclick.net,googlesyndication.com,googleadservices.com,googletagservices.com,' +
  'google-analytics.com,googletagmanager.com,adnxs.com,adsrvr.org,criteo.com,criteo.net,' +
  'pubmatic.com,rubiconproject.com,openx.net,casalemedia.com,smartadserver.com,33across.com,' +
  'yieldmo.com,sharethrough.com,amazon-adsystem.com,adform.net,adcash.com,bidvertiser.com,' +
  'zedo.com,adroll.com,taboola.com,outbrain.com,mgid.com,revcontent.com,teads.tv,' +
  'springserve.com,spotxchange.com,spotx.tv,tremorhub.com,undertone.com,moatads.com,' +
  'scorecardresearch.com,quantserve.com,adsafeprotected.com,doubleverify.com,chartbeat.com,' +
  'popads.net,popcash.net,propellerads.com,propellerclick.com,adsterra.com,exoclick.com,' +
  'juicyads.com,trafficjunky.com,hilltopads.net,clickadu.com,onclickperformance.com,' +
  'poweredby.jads.co,a-ads.com,adskeeper.com,mc.yandex.ru,onclickalgo.com,onclckstr.com,' +
  'highperformanceformat.com,effectivegatecpm.com,displaycontentnetwork.com,' +
  (process.env.SLIME_AD_HOSTS || '')
).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
function isAdHost(h) {
  if (!h) return false;
  h = h.toLowerCase();
  return AD_HOSTS.some(base => h === base || h.endsWith('.' + base));
}
function isAdUrl(u) {
  let h = ''; try { h = new URL(u).hostname; } catch (e) { return false; }
  return isAdHost(h);
}

// Measurement / tag-manager / verification beacons. These are ad-adjacent (and
// still block the app-side webview via AdBlocker.swift), but during headless
// extraction we must NOT abort them: some providers route player-init logic
// through a GTM container or gate the stream token behind an analytics beacon,
// so killing these can make an anti-bot check fail and starve the resolve. They
// load during extraction (as before this change); only the aggressive ad/pop
// networks are aborted. (SLIME_BLOCK_DECOR does not affect this.)
const EXTRACTION_KEEP_HOSTS = new Set([
  'google-analytics.com', 'googletagmanager.com', 'googletagservices.com',
  'scorecardresearch.com', 'quantserve.com', 'chartbeat.com', 'moatads.com',
  'doubleverify.com', 'adsafeprotected.com', 'mc.yandex.ru',
]);
function abortDuringExtraction(u) {
  let h = ''; try { h = new URL(u).hostname.toLowerCase(); } catch (e) { return false; }
  if (!isAdHost(h)) return false;
  return ![...EXTRACTION_KEEP_HOSTS].some(base => h === base || h.endsWith('.' + base));
}

let browser, ctx;
const sessions = new Map(); // id -> { stream, referer, type, lastAccess }
let nextId = 1;
const SESSION_CAP = 80;
// Concurrency cap on /resolve: each resolve can launch a Chromium page.
const RESOLVE_MAX_INFLIGHT = Number(process.env.SLIME_RESOLVE_MAX || 3);
let resolveInflight = 0;

/// Mark a session as recently used so LRU eviction keeps live playbacks.
function touchSession(id) {
  const s = sessions.get(id);
  if (s) s.lastAccess = Date.now();
  return s;
}

/// Evict the least-recently-used session when over the cap - never the one a
/// long movie is still streaming (the old id-arithmetic eviction could drop a
/// live session and 404 mid-playback).
function evictIfNeeded() {
  if (sessions.size <= SESSION_CAP) return;
  let oldestId = null, oldest = Infinity;
  for (const [id, s] of sessions) {
    const t = s.lastAccess || 0;
    if (t < oldest) { oldest = t; oldestId = id; }
  }
  if (oldestId != null) sessions.delete(oldestId);
}

/// SSRF guard: reject loopback / link-local / private targets so media proxies
/// can never be pointed at the router, localhost, or cloud metadata.
function isPrivateHost(hostname) {
  const h = (hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '0.0.0.0' || h === '::' || h === '::1') return true;
  // Apply IPv6 rules ONLY to strings that actually contain a colon; otherwise
  // public hostnames like fc-cdn.example.com would be wrongly rejected.
  if (h.includes(':')) {
    if (h.startsWith('::ffff:')) {
      const mm = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
      return mm ? isPrivateHost(mm[1]) : true;
    }
    // Link-local fe80::/10 (fe8x-febx) and Unique-Local fc00::/7 (fc.. / fd..).
    return /^fe[89ab]/.test(h) || h.startsWith('fc') || h.startsWith('fd');
  }
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  return a === 10 || a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254);
}

// Host of a session's resolved stream URL ('' if unparseable).
function streamHost(u) {
  try { return new URL(u).hostname; } catch (e) { return ''; }
}

/// A /seg proxy target is allowed only if it is a public host we surfaced while
/// rewriting this session's playlists, never an arbitrary caller-supplied URL.
function allowedProxyTarget(s, u) {
  let h; try { h = new URL(u).hostname; } catch (e) { return false; }
  if (isPrivateHost(h)) return false;
  return !!(s.hosts && s.hosts.has(h));
}

/// The base URL clients should call back for playlists/segments/subtitles.
/// Prefer PUBLIC_BASE when set; otherwise reflect a valid Host that the client
/// already used to reach us, falling back to the socket's local address.
function publicBase(req) {
  if (process.env.PUBLIC_BASE) return process.env.PUBLIC_BASE.replace(/\/+$/, '');
  // Reflect the scheme/host the CLIENT reached us on so nested playlist/segment
  // URLs stay same-origin. A Google Cast receiver (and any browser HLS player)
  // blocks mixed HTTP media inside its HTTPS page, so getting the scheme right
  // matters. Behind a Cloudflare Tunnel the origin hop is plain HTTP but the real
  // client used HTTPS - trust X-Forwarded-Proto/-Host for that case; fall back to
  // the direct socket for native LAN/Tailscale AVPlayer clients (still HTTP).
  // Only trust X-Forwarded-* from the Cloudflare Tunnel, which connects to the
  // local port from loopback - a direct LAN/public client (now reachable) could
  // otherwise spoof these headers to poison the callback host.
  const ra = req.socket.remoteAddress || '';
  const viaTunnel = ra === '::1' || ra.startsWith('127.') || ra.startsWith('::ffff:127.');
  const xfProto = viaTunnel ? (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
  const scheme = xfProto || (req.socket.encrypted ? 'https' : 'http');
  const fwdHost = viaTunnel ? req.headers['x-forwarded-host'] : undefined;
  const raw = (fwdHost || req.headers.host || '').split(',')[0].trim();
  if (/^(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+)(:\d+)?$/.test(raw)) return `${scheme}://${raw}`;
  const local = (req.socket.localAddress || '').replace('::ffff:', '') || '127.0.0.1';
  const port = scheme === 'https' ? (process.env.SLIME_TLS_PORT || 8788) : PORT;
  return `${scheme}://${local}:${port}`;
}

async function ensureBrowser() {
  // Self-heal: if the browser crashed or was closed (e.g. after a long idle),
  // the old handle is stale - relaunch instead of failing every request.
  if (browser && browser.isConnected() && ctx) return;
  try { if (browser) await browser.close(); } catch (e) {}
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--autoplay-policy=no-user-gesture-required',
        // Modern embed players (VidFast, VidSrc.cc, P-Stream, Videasy) fingerprint
        // for automation and refuse to mint the stream token if they detect it.
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
      ],
    });
  } catch (e) {
    if (/Executable doesn't exist|playwright install|browserType.launch/i.test(e.message || '')) {
      console.error('\n[X]  Chromium for Playwright is missing or failed to launch.\n' +
        '   Fix:  run  " npx playwright install chromium "  inside the server/ folder,\n' +
        '         then start again.  (Run  node doctor.js  to double-check everything.)\n');
    }
    throw e;
  }
  browser.on('disconnected', () => { browser = null; ctx = null; });
  ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 720 },
    locale: 'en-US',
  });
  // Mask the tell-tale headless signals before any page script runs.
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  });
  // Ad-block at the network layer: abort requests to ad/tracker/pop hosts. The
  // stream is captured from the request URL (page.on('request') fires before this
  // routing decision), and every request that mints the token - scripts, xhr/fetch,
  // the media itself, documents - is always let through, so this only removes ad
  // noise: faster resolves, less CPU, no hostile ad code run.
  // Decorative image/font blocking is a further speedup but riskier - some anti-bot
  // embeds gate token-minting behind a poster/beacon load - so it's OFF by default
  // and opt-in via SLIME_BLOCK_DECOR=1 once verified against the live providers.
  const blockDecor = process.env.SLIME_BLOCK_DECOR === '1';
  const debugAbort = process.env.SLIME_DEBUG_ABORT === '1';
  if (process.env.SLIME_NO_ADBLOCK !== '1') {   // kill-switch if a provider ever breaks
    await ctx.route('**/*', (route) => {
      try {
        const req = route.request();
        const u = req.url();
        // Aggressive ad/pop networks first - abort even when the URL wears a media
        // extension (VAST/VPAID ad reels are frequently .m3u8/.ts). Measurement/tag
        // hosts are kept (see abortDuringExtraction) so provider bot-checks survive.
        if (abortDuringExtraction(u)) {
          if (debugAbort) { try { console.log('   [adblock] abort', new URL(u).hostname); } catch (_) {} }
          return route.abort();
        }
        // Never touch the actual media/manifest/subtitle - those ARE the payload.
        if (/\.(m3u8|mp4|ts|m4s|vtt|srt|key)([/?&#]|$)/i.test(u)) return route.continue();
        if (blockDecor) {
          const rt = req.resourceType();
          if (rt === 'image' || rt === 'font') return route.abort();
        }
        return route.continue();
      } catch (e) { try { return route.continue(); } catch (_) {} }
    });
  }
}

// Load the embed and capture the stream URL. Prefers HLS (.m3u8) - it carries
// subtitle/quality renditions AVPlayer understands - but accepts a direct MP4
// if no playlist shows up quickly, so mp4-only providers stay fast.
async function extract(embedUrl) {
  await ensureBrowser();
  const page = await ctx.newPage();
  let m3u8 = null, mp4 = null;
  const captured = []; // subtitle files the provider's own player loads
  // Catch manifests on both request and response, and match tokened URLs that
  // carry .m3u8/.mp4 anywhere in the query (not just the path).
  // A stream URL is safe to capture only if its host isn't private/loopback -
  // a hostile embed can inject one to turn /hls or /mp4 into an SSRF proxy.
  const publicStream = (u) => {
    let h = ''; try { h = new URL(u).hostname; } catch (e) {}
    // Reject private/loopback (SSRF) AND known ad hosts - VAST/VPAID ad reels
    // are frequently HLS, so without the ad-host check an ad can be captured
    // as the feature stream.
    return h && !isPrivateHost(h) && !isAdHost(h);
  };
  const seen = (u) => {
    // DEBUG: surface a media URL that was seen but rejected by publicStream, so
    // an over-broad ad-host/SSRF guard eating a real stream is visible in the log.
    if (process.env.SLIME_DEBUG_ABORT === '1' && /\.(m3u8|mp4)([/?&#]|$)/i.test(u) && !publicStream(u)) {
      let dh = ''; try { dh = new URL(u).hostname; } catch (e) {}
      console.log(`   [capture] REJECTED media host=${dh} ad=${isAdHost(dh)} priv=${isPrivateHost(dh)}`);
    }
    if (!m3u8 && /\.m3u8([/?&#]|$)/i.test(u) && publicStream(u)) m3u8 = u;
    if (!mp4 && /\.mp4([/?&#]|$)/i.test(u) && publicStream(u)) mp4 = u;
    if ((/\.vtt([/?&#]|$)/i.test(u) || /\.srt([/?&#]|$)/i.test(u)) && !captured.some(s => s.url === u)) {
      // Don't capture a subtitle pointing at a private/loopback host - a hostile
      // embed page can inject one to turn /vtt into an SSRF proxy.
      let subHost = ''; try { subHost = new URL(u).hostname; } catch (e) {}
      if (subHost && !isPrivateHost(subHost)) {
        const lang = subLangFromUrl(u);
        captured.push({ lang, name: subName(lang), url: u });
      }
    }
  };
  page.on('response', (r) => seen(r.url()));
  page.on('request', (r) => seen(r.url()));
  try {
    await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    const deadline = Date.now() + 30000;
    const preferUntil = Date.now() + 8000; // give HLS a head start, then take mp4
    let tick = 0;
    while (Date.now() < deadline) {
      if (m3u8) break;
      if (mp4 && Date.now() > preferUntil) break;
      // Many players wrap the first click in an ad; the video only starts on a
      // second gesture. Click the middle of the frame, then poke the <video>
      // and any play button. Do this across every (nested) frame.
      for (const f of page.frames()) {
        try {
          await f.evaluate(() => {
            const v = document.querySelector('video');
            if (v) { v.muted = true; v.play && v.play().catch(() => {}); }
            const sel = '[class*="play" i],[aria-label*="play" i],.jw-icon-display,.vjs-big-play-button,#player,.play-button';
            const b = document.querySelector(sel);
            b && b.click && b.click();
          });
        } catch (e) {}
      }
      // A real pointer click at the center dismisses overlay ads that ignore
      // synthetic .click() and unlocks autoplay on gesture-gated players.
      try { await page.mouse.click(640, 360); } catch (e) {}
      if (tick === 2) { try { await page.mouse.click(640, 360); } catch (e) {} } // double-tap past the ad
      tick++;
      await page.waitForTimeout(1000);
    }
  } catch (e) {}
  await page.close().catch(() => {});
  const hit = m3u8 || mp4;
  if (!hit) return null;
  const referer = new URL(embedUrl).origin + '/';
  return { stream: hit, referer, type: /\.m3u8/i.test(hit) ? 'hls' : 'mp4', subs: captured };
}

// Fetch a text body over node http(s), following redirects (best-effort).
function nodeGetText(u, depth = 0, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let mod; try { mod = new URL(u).protocol === 'http:' ? http : https; } catch (e) { return resolve(null); }
    const rq = mod.get(u, { headers: { 'user-agent': UA } }, (r) => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location && depth < 4) {
        r.resume();
        const next = new URL(r.headers.location, u).href;
        // A public subtitle URL must not redirect us into the LAN/loopback.
        try { if (isPrivateHost(new URL(next).hostname)) return resolve(null); } catch (e) { return resolve(null); }
        return nodeGetText(next, depth + 1, timeoutMs).then(resolve);
      }
      if (r.statusCode !== 200) { r.resume(); return resolve(null); }
      let d = ''; r.setEncoding('utf8');
      r.on('data', (c) => d += c);
      r.on('end', () => resolve(d));
    });
    rq.on('error', () => resolve(null));
    rq.setTimeout(timeoutMs, () => { rq.destroy(); resolve(null); });
  });
}

// Fetch a JSON body over node http(s) (best-effort). Picks the module by
// protocol so localhost http resolvers work, not just https APIs.
function nodeGetJSON(u, timeoutMs = 55000) {
  return new Promise((resolve) => {
    let mod; try { mod = new URL(u).protocol === 'http:' ? http : https; } catch (e) { return resolve(null); }
    const rq = mod.get(u, { headers: { 'user-agent': UA, accept: 'application/json' } }, (r) => {
      if (r.statusCode !== 200) { r.resume(); return resolve(null); }
      let d = ''; r.setEncoding('utf8');
      r.on('data', (c) => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
    });
    rq.on('error', () => resolve(null));
    rq.setTimeout(timeoutMs, () => { rq.destroy(); resolve(null); });
  });
}

// Optional subtitle-index key. Without it we rely on subs embedded in the
// stream or loaded by the provider; with a (free) key we can fetch subs for
// any title by TMDB id. Set SLIME_SUBS_KEY in the server env to enable.
const SUBS_KEY = process.env.SLIME_SUBS_KEY || '';

// Best-effort subtitle language from a file URL - providers rarely label the
// tracks their player loads, so without this they all show as "und"/"Subtitles"
// and the viewer can't tell the anime's native sub from an English one.
const LANG_NAMES = { en: 'English', ja: 'Japanese', es: 'Spanish', fr: 'French',
  pt: 'Portuguese', de: 'German', it: 'Italian', ar: 'Arabic', zh: 'Chinese',
  ko: 'Korean', ru: 'Russian', hi: 'Hindi', id: 'Indonesian' };
const LANG_NORM = { english: 'en', eng: 'en', japanese: 'ja', jpn: 'ja', jp: 'ja',
  spanish: 'es', spa: 'es', french: 'fr', fra: 'fr', fre: 'fr', portuguese: 'pt',
  por: 'pt', german: 'de', ger: 'de', italian: 'it', ita: 'it', arabic: 'ar', ara: 'ar',
  chinese: 'zh', chi: 'zh', korean: 'ko', kor: 'ko', russian: 'ru', rus: 'ru',
  hindi: 'hi', hin: 'hi', indonesian: 'id', ind: 'id' };
function subLangFromUrl(u) {
  const s = decodeURIComponent(String(u || '')).toLowerCase();
  const m = s.match(/(?:[\/._\-=]|lang=|language=)(english|eng|en|japanese|jpn|jp|ja|spanish|spa|es|french|fra|fre|fr|portuguese|por|pt|german|ger|de|italian|ita|it|arabic|ara|ar|chinese|chi|zh|korean|kor|ko|russian|rus|ru|hindi|hin|hi|indonesian|ind|id)(?=[\/._\-&?]|\.vtt|\.srt|$)/);
  if (!m) return 'und';
  return LANG_NORM[m[1]] || m[1];
}
function subName(lang) {
  return LANG_NAMES[lang] || (lang && lang !== 'und' ? lang.toUpperCase() : 'Subtitles');
}

// External subtitles by TMDB id (independent of the video provider). The Wyzie
// index (sub.wyzie.io) is free and needs no key, so subtitles are ON by default;
// a SLIME_SUBS_KEY is passed through only if one happens to be set.
async function fetchSubtitles(params) {
  const tmdb = params.get('tmdb');
  if (!tmdb) return [];
  const kind = params.get('kind') || 'movie';
  const season = params.get('season'), episode = params.get('episode');
  let u = `https://sub.wyzie.io/search?id=${encodeURIComponent(tmdb)}&format=srt`;
  if (SUBS_KEY) u += `&key=${encodeURIComponent(SUBS_KEY)}`;
  if (kind !== 'movie' && season && episode) u += `&season=${season}&episode=${episode}`;
  const list = await nodeGetJSON(u, 8000);
  if (!Array.isArray(list)) return [];
  const out = [], seen = new Set();
  for (const s of list) {
    const url = s.url || s.link;
    const lang = (s.language || s.lang || s.display || 'und').toString().slice(0, 8);
    if (!url || seen.has(lang)) continue;
    seen.add(lang);
    out.push({ lang, name: (s.display || lang).toString(), url });
    if (out.length >= 8) break;
  }
  // English first for a sensible default.
  out.sort((a, b) => (a.lang.startsWith('en') ? -1 : 0) - (b.lang.startsWith('en') ? -1 : 0));
  return out;
}

// --- DaddyLive (dlhd) live-sports resolver ----------------------------------
// streamed.st's stream tokens are single-use -> un-proxyable. DaddyLive uses
// time-window expiry tokens that survive re-fetch, so our sniff->proxy model
// works. Resolve flow (pure HTTP, no headless browser needed):
//   stream-{id}.php -> <iframe src> -> the iframe page's Clappr source is
//   base64 inside atob('...') -> decode -> master m3u8. Playback Referer MUST be
//   the IFRAME host (not dlhd). Domains rotate -> try a mirror list; override
//   with SLIME_DADDY_HOSTS (comma-separated).
const DADDY_HOSTS = (process.env.SLIME_DADDY_HOSTS ||
  'dlhd.st,dlhd.click,daddylive.dad,thedaddy.to,dlhd.dad')
  .split(',').map((s) => s.trim()).filter(Boolean);

// GET text with an explicit Referer (dlhd pages 403 without it), following
// redirects across the mirror rotation.
function daddyGet(u, referer, depth = 0, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let mod; try { mod = new URL(u).protocol === 'http:' ? http : https; } catch (e) { return resolve(null); }
    const headers = { 'user-agent': UA };
    if (referer) headers['referer'] = referer;
    const rq = mod.get(u, { headers }, (r) => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location && depth < 4) {
        r.resume();
        const next = new URL(r.headers.location, u).href;
        try { if (isPrivateHost(new URL(next).hostname)) return resolve(null); } catch (e) { return resolve(null); }
        return daddyGet(next, referer, depth + 1, timeoutMs).then(resolve);
      }
      if (r.statusCode !== 200) { r.resume(); return resolve(null); }
      let d = ''; r.setEncoding('utf8');
      r.on('data', (c) => d += c);
      r.on('end', () => resolve(d));
    });
    rq.on('error', () => resolve(null));
    rq.setTimeout(timeoutMs, () => { rq.destroy(); resolve(null); });
  });
}

// Resolve a DaddyLive channel id -> { stream (master m3u8), referer, type }.
async function resolveDaddy(id) {
  const cid = String(id || '').replace(/[^0-9]/g, '');
  if (!cid) return null;
  for (const host of DADDY_HOSTS) {
    const origin = `https://${host}`;
    const page = await daddyGet(`${origin}/stream/stream-${cid}.php`, `${origin}/`);
    if (!page) continue;
    const im = page.match(/<iframe[^>]+src=["']([^"']+)["']/i);
    if (!im) continue;
    let iframe; try { iframe = new URL(im[1], origin).href; } catch (e) { continue; }
    // SSRF guard: the iframe src is scraped from untrusted (rotating, third-party)
    // DaddyLive HTML and the server is now internet-reachable via the tunnel -
    // never let a hijacked mirror point us at loopback/LAN/link-local.
    try { if (isPrivateHost(new URL(iframe).hostname)) continue; } catch (e) { continue; }
    const iframeOrigin = new URL(iframe).origin;
    const inner = await daddyGet(iframe, `${origin}/`);
    if (!inner) continue;
    // Clappr source lives base64-encoded inside window.atob('...') in the raw HTML.
    let m3u8 = null;
    const bm = inner.match(/atob\(["']([A-Za-z0-9+/=]+)["']\)/);
    if (bm) { try { m3u8 = Buffer.from(bm[1], 'base64').toString('utf8').trim(); } catch (e) {} }
    if (!m3u8 || !/^https?:\/\//i.test(m3u8)) {
      const dm = inner.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/i);   // fallback: bare m3u8
      m3u8 = dm ? dm[0] : null;
    }
    if (!m3u8 || !/^https?:\/\//i.test(m3u8)) continue;
    // Same SSRF guard on the resolved stream host before it becomes a proxied session.
    try { if (isPrivateHost(new URL(m3u8).hostname)) continue; } catch (e) { continue; }
    return { stream: m3u8, referer: `${iframeOrigin}/`, type: 'hls', subs: [] };
  }
  return null;
}

// Scrape the DaddyLive 24/7 channel list -> [{ id, name }] (~900 channels).
// Cached briefly; the list is large and changes slowly.
let daddyChanCache = null;
async function daddyChannels() {
  if (daddyChanCache && Date.now() - daddyChanCache.at < 30 * 60 * 1000) return daddyChanCache.list;
  for (const host of DADDY_HOSTS) {
    const html = await daddyGet(`https://${host}/24-7-channels.php`, `https://${host}/`, 0, 15000);
    if (!html) continue;
    const out = [];
    const re = /watch\.php\?id=(\d+)"[^>]*>\s*<div class="card__title">([^<]{1,80})<\/div>/g;
    let m;
    while ((m = re.exec(html))) {
      const name = m[2].replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").trim();
      out.push({ id: m[1], name });
    }
    if (out.length) { daddyChanCache = { at: Date.now(), list: out }; return out; }
  }
  return daddyChanCache ? daddyChanCache.list : [];
}

// -- Strategy #2: direct JSON resolver (no headless browser) -----------------
// Points at a self-hosted resolver that takes a TMDB id and returns a stream
// URL (e.g. Inside4ndroid/TMDB-Embed-API or DivineChile/vidsrc-scraper).
// Set DIRECT_RESOLVER in the env to enable, e.g. "http://127.0.0.1:8181".
// Much faster than booting Chromium, so it's tried FIRST when configured.
const DIRECT_RESOLVER = process.env.DIRECT_RESOLVER || '';

async function resolveDirect(tmdb, kind, season, episode) {
  if (!DIRECT_RESOLVER || !tmdb) return null;
  const base = DIRECT_RESOLVER.replace(/\/+$/, '');
  const isMovie = kind === 'movie';
  // TMDB-Embed-API shape: /api/streams/:type/:id  (TV type is "series").
  let u = `${base}/api/streams/${isMovie ? 'movie' : 'series'}/${tmdb}`;
  if (!isMovie) u += `?season=${season}&episode=${episode}`;
  let j = await nodeGetJSON(u);
  const hasStream = x => x && (x.url || x.results || (Array.isArray(x.streams) && x.streams.length));
  // vidsrc-scraper shape fallback: /extract?tmdb_id=&type=[&season=&episode=]
  if (!hasStream(j)) {
    let v = `${base}/extract?tmdb_id=${tmdb}&type=${isMovie ? 'movie' : 'tv'}`;
    if (!isMovie) v += `&season=${season}&episode=${episode}`;
    const j2 = await nodeGetJSON(v);
    if (hasStream(j2)) j = j2; // only replace if the fallback actually found something
  }
  if (!j) return null;
  // Normalize the known shapes to { stream, type, headers, subs }.
  let streamUrl = null, headers = {}, subs = [];
  if (Array.isArray(j.streams) && j.streams.length) {
    // TMDB-Embed-API: streams[] with url/quality/headers. Prefer 1080p.
    const best = j.streams.find(s => /1080/.test(s.quality || s.name || '')) || j.streams[0];
    streamUrl = best.url;
    headers = best.headers || {};
    subs = (best.subtitles || best.captions || [])
      .map((s, i) => ({ lang: (s.language || s.lang || 'und').toString().slice(0, 8), name: s.label || s.display || `Subtitles ${i + 1}`, url: s.url || s.file || s }))
      .filter(s => typeof s.url === 'string');
  } else if (j.url) {
    streamUrl = j.url; headers = j.headers || {};
  } else if (j.results && typeof j.results === 'object') {
    // vidsrc-scraper: results{ domain: { hls_url, subtitles[] } }.
    for (const k of Object.keys(j.results)) {
      const r = j.results[k];
      if (r && r.hls_url) {
        streamUrl = r.hls_url;
        subs = (r.subtitles || []).map((s) => {
          const url = typeof s === 'string' ? s : (s.url || s.file);
          const lang = (s.language || s.lang || subLangFromUrl(url)).toString().slice(0, 8);
          return { lang, name: s.label || subName(lang), url };
        }).filter(s => typeof s.url === 'string');
        break;
      }
    }
  }
  if (!streamUrl || typeof streamUrl !== 'string') return null;
  const referer = headers.Referer || headers.referer || (headers.Origin ? headers.Origin + '/' : '');
  const isHls = /\.m3u8|\/playlist\/|\/hls\//i.test(streamUrl) || !/\.mp4/i.test(streamUrl);
  return { stream: streamUrl, referer, type: isHls ? 'hls' : 'mp4', subs };
}

// -- Strategy #3: Internet Archive (legal, DRM-free public-domain films) ------
// Given a title (+ year), find a matching movies item and its best MP4. This
// is a real last resort - mostly classics/public-domain - but it's fully legal
// and its files play in AVPlayer directly (range-friendly, no TLS block).
async function resolveArchive(title, year) {
  if (!title) return null;
  const clean = title.replace(/[":()\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  const q = `title:(${clean}) AND mediatype:(movies)`;
  const searchURL = 'https://archive.org/advancedsearch.php?q=' + encodeURIComponent(q) +
    '&fl[]=identifier&fl[]=title&fl[]=year&fl[]=downloads&rows=25&sort[]=downloads+desc&output=json';
  const sr = await nodeGetJSON(searchURL);
  const docs = sr && sr.response && sr.response.docs;
  if (!Array.isArray(docs) || !docs.length) return null;

  const wantYear = year ? parseInt(year, 10) : null;
  const wantTitle = clean.toLowerCase();
  // Rank: exact-ish title match, then year proximity, then popularity (order).
  const ranked = docs.slice().sort((a, b) => {
    const at = (a.title || '').toLowerCase(), bt = (b.title || '').toLowerCase();
    const aExact = at === wantTitle ? 0 : 1, bExact = bt === wantTitle ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    if (wantYear) {
      const ay = Math.abs((parseInt(a.year, 10) || 9999) - wantYear);
      const by = Math.abs((parseInt(b.year, 10) || 9999) - wantYear);
      if (ay !== by) return ay - by;
    }
    return 0;
  });

  for (const d of ranked.slice(0, 6)) {
    // Reject weak matches: require the archive title to contain our title (or
    // vice-versa) so we don't play a random unrelated film.
    const at = (d.title || '').toLowerCase();
    if (!at.includes(wantTitle) && !wantTitle.includes(at)) continue;
    if (wantYear && d.year && Math.abs(parseInt(d.year, 10) - wantYear) > 2) continue;
    const meta = await nodeGetJSON(`https://archive.org/metadata/${encodeURIComponent(d.identifier)}`);
    const files = meta && meta.files;
    if (!Array.isArray(files)) continue;
    // Prefer a real H.264 MP4, largest first.
    const mp4s = files
      .filter(f => /\.mp4$/i.test(f.name || '') && /(h\.264|mpeg4|512kb)/i.test(f.format || 'mp4'))
      .sort((a, b) => (parseInt(b.size, 10) || 0) - (parseInt(a.size, 10) || 0));
    const file = mp4s[0] || files.filter(f => /\.mp4$/i.test(f.name || ''))[0];
    if (!file) continue;
    const url = `https://archive.org/download/${encodeURIComponent(d.identifier)}/${encodeURIComponent(file.name)}`;
    return { stream: url, referer: '', type: 'mp4', subs: [], archive: d.identifier };
  }
  return null;
}

// Stream media bytes straight from the CDN (it authorizes by signed URL, not
// TLS fingerprint - only the provider embed needs the browser). Forwards the
// client's Range verbatim and pipes the response, so AVPlayer gets exactly the
// bytes it asks for (the old 6MB cap broke progressive-MP4 playback). Resolves
// false WITHOUT writing headers if the CDN blocks us (403/401), so the caller
// can fall back to the browser proxy.
function streamProxy(streamUrl, referer, req, res, defaultType = 'video/mp4', depth = 0, patch = null) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let mod;
    try { mod = new URL(streamUrl).protocol === 'http:' ? http : https; } catch (e) { return done(false); }
    const headers = { 'user-agent': UA, referer };
    if (req.headers.range) headers['range'] = req.headers.range;
    const upstream = mod.get(streamUrl, { headers }, (up) => {
      // Follow redirects (some CDNs 302 to a signed edge URL).
      if ([301, 302, 303, 307, 308].includes(up.statusCode) && up.headers.location && depth < 5) {
        up.resume();
        const next = new URL(up.headers.location, streamUrl).href;
        // Re-check each redirect hop: a public CDN URL must not bounce us into
        // the LAN / loopback.
        try { if (isPrivateHost(new URL(next).hostname)) return done(false); } catch (e) { return done(false); }
        return streamProxy(next, referer, req, res, defaultType, depth + 1, patch).then(done);
      }
      // Blocked -> let the caller fall back to the browser proxy (no headers written).
      if (up.statusCode === 403 || up.statusCode === 401) { up.resume(); return done(false); }
      const h = { 'accept-ranges': 'bytes' };
      for (const k of ['content-type', 'content-length', 'content-range']) {
        if (up.headers[k]) h[k] = up.headers[k];
      }
      // Some CDNs disguise HLS segments as images (DaddyLive's R2 serves .ts as
      // image/png). AVPlayer on-device ignores the wrong type, but an AirPlay
      // receiver drops the video track and plays audio only - so relabel a
      // mislabeled/missing segment type with the caller's expected media type.
      if (!h['content-type'] || /^image\//i.test(h['content-type'])) h['content-type'] = defaultType;
      console.log(`   -> CDN ${up.statusCode}  ${h['content-range'] || h['content-length'] || ''}`);
      res.writeHead(up.statusCode, h);
      if (patch && patch.length) {
        // Rewrite hev1->hvc1 fourccs in flight: bytes +1 ('e'->'v') and
        // +2 ('v'->'c'). Map chunk bytes to absolute file offsets via the
        // range start so seeks stay correct.
        const cr = /bytes (\d+)-/.exec(up.headers['content-range'] || '');
        let pos = cr ? parseInt(cr[1], 10) : 0;
        up.on('data', (chunk) => {
          for (const off of patch) {
            for (const [d, b] of [[1, 0x76], [2, 0x63]]) {
              const idx = off + d - pos;
              if (idx >= 0 && idx < chunk.length) chunk[idx] = b;
            }
          }
          pos += chunk.length;
          if (!res.write(chunk)) { up.pause(); res.once('drain', () => up.resume()); }
        });
        up.on('end', () => { try { res.end(); } catch (e) {} done(true); });
      } else {
        up.pipe(res);
        up.on('end', () => done(true));
      }
      up.on('error', () => { try { res.end(); } catch (e) {} done(true); });
    });
    upstream.on('error', (e) => { console.log('   stream upstream err:', e.message); done(false); });
    // AVPlayer opens/aborts many range connections as it seeks - abort the
    // upstream fetch when the client hangs up so we don't keep downloading.
    req.on('close', () => upstream.destroy());
  });
}

// Fallback: browser-context buffered range (capped) for CDNs that block us.
async function browserProxyRange(s, req, res) {
  const CHUNK = 6 * 1024 * 1024;
  const rangeReq = req.headers.range || 'bytes=0-';
  const mm = rangeReq.match(/bytes=(\d+)-(\d*)/);
  const start = mm ? parseInt(mm[1], 10) : 0;
  const reqEnd = mm && mm[2] ? parseInt(mm[2], 10) : start + CHUNK - 1;
  const end = Math.min(reqEnd, start + CHUNK - 1);
  let r;
  try { r = await proxyFetch(s.stream, s.referer, `bytes=${start}-${end}`); }
  catch (e) { if (!res.headersSent) res.writeHead(502); return res.end('upstream error'); }
  const h = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes' };
  if (r.headers['content-range']) h['content-range'] = r.headers['content-range'];
  if (r.headers['content-length']) h['content-length'] = r.headers['content-length'];
  res.writeHead(r.status === 200 ? 206 : r.status, h);
  // Same hev1->hvc1 rename as the direct path (black-video fix).
  if (s.hevcPatch && s.hevcPatch.length && r.body && r.body.length) {
    for (const off of s.hevcPatch) {
      for (const [d, b] of [[1, 0x76], [2, 0x63]]) {
        const idx = off + d - start;
        if (idx >= 0 && idx < r.body.length) r.body[idx] = b;
      }
    }
  }
  res.end(r.body);
}

// Fetch a URL through the browser network stack (valid TLS) with optional Range.
async function proxyFetch(url, referer, range) {
  await ensureBrowser();
  const headers = { referer, 'user-agent': UA };
  if (range) headers['range'] = range;
  const res = await ctx.request.get(url, { headers, timeout: 30000, maxRedirects: 5 });
  const body = await res.body();
  return { status: res.status(), headers: res.headers(), body };
}

// AVPlayer plays 'hev1'-flavored HEVC as audio-only (black screen, working
// sound) - Apple's decoder requires the 'hvc1' sample-entry flavor. The two
// are byte-compatible whenever the parameter sets live in the hvcC box (true
// for these CDNs), so find the fourcc(s) inside the moov once per session and
// rename them on the fly while streaming. Same byte count -> ranges/seeking
// keep working.
async function ensureHevcPatch(s) {
  if (s.hevcPatch !== undefined) return;
  s.hevcPatch = [];
  try {
    const head = await proxyFetch(s.stream, s.referer, 'bytes=0-8388607');
    if (head.status >= 400 || !head.body || !head.body.length) return;
    const total = parseInt((head.headers['content-range'] || '').split('/')[1] || '0', 10);
    let moovBase = -1, moov = null;
    // Walk top-level boxes in the head looking for the moov atom.
    for (let off = 0; off + 8 <= head.body.length;) {
      let size = head.body.readUInt32BE(off);
      const type = head.body.toString('ascii', off + 4, off + 8);
      if (size === 1) {
        if (off + 16 > head.body.length) break;
        size = Number(head.body.readBigUInt64BE(off + 8));
      }
      if (size < 8) break;
      if (type === 'moov') {
        moovBase = off;
        moov = head.body.subarray(off, Math.min(off + size, head.body.length));
        break;
      }
      off += size;
    }
    // moov at the end of the file -> search the tail instead.
    if (!moov && total > head.body.length) {
      const start = Math.max(0, total - 8388608);
      const tail = await proxyFetch(s.stream, s.referer, `bytes=${start}-${total - 1}`);
      if (tail.body && tail.body.length) {
        const at = tail.body.indexOf('moov');
        if (at >= 4) { moovBase = start + at - 4; moov = tail.body.subarray(at - 4); }
      }
    }
    if (!moov || !moov.includes('hvcC')) return; // no HEVC config - nothing to fix
    for (const tag of ['hev1', 'hev2']) {
      let i = 0;
      while ((i = moov.indexOf(tag, i)) !== -1) { s.hevcPatch.push(moovBase + i); i += 4; }
    }
    if (s.hevcPatch.length) {
      console.log(`   hevc: renaming ${s.hevcPatch.length} hev1->hvc1 sample entr${s.hevcPatch.length === 1 ? 'y' : 'ies'} (black-video fix)`);
    }
  } catch (e) {
    console.log('   hevc probe failed:', e.message);
  }
}

// Pick the variant closest to 1080p from an HLS master's parsed variants.
// Prefer an exact 1080-height rendition; else the highest rendition at or
// below 1080; else the lowest rendition above 1080 (client caps it back to
// 1080). Guarantees "as close to 1080p as the source offers".
function pick1080(variants) {
  const withRes = variants.filter(v => v.height > 0);
  if (!withRes.length) return variants.slice().sort((a, b) => b.bw - a.bw)[0];
  const exact = withRes.filter(v => v.height === 1080);
  if (exact.length) return exact.sort((a, b) => b.bw - a.bw)[0];
  const atMost = withRes.filter(v => v.height <= 1080);
  if (atMost.length) return atMost.sort((a, b) => b.height - a.height || b.bw - a.bw)[0];
  return withRes.sort((a, b) => a.height - b.height || a.bw - b.bw)[0];
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  const client = (req.socket.remoteAddress || '?').replace('::ffff:', '');
  // CORS: a Google Cast receiver fetches playlists/segments from the browser and
  // is blocked without these. Harmless for the native AVPlayer clients. Simple
  // media GETs don't preflight, but answer OPTIONS anyway for safety.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Authorization, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
    // Auth gate.
    if (TOKEN && url.searchParams.get('key') !== TOKEN) {
      res.writeHead(401); return res.end('unauthorized');
    }
    // Minimal logging - path + client only, no titles/URLs on disk.
    console.log(`${new Date().toLocaleTimeString()}  ${req.method} ${url.pathname}  <- ${client}`);

    // Live-sports catalog: DaddyLive's 24/7 channel list (id + name). The client
    // filters/categorises; each id plays via /resolve?source=daddy&id=<id>.
    if (url.pathname === '/daddy/channels') {
      const list = await daddyChannels();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ channels: list }));
    }

    // Anime id mapping: TMDB -> AniList/MAL + per-cour episode (for anime sources
    // + dub/sub). Fast, no headless browser. Returns {} when the title isn't anime.
    if (url.pathname === '/animeids') {
      const p = url.searchParams;
      let ids = null;
      try {
        ids = require('./animemap').animeIds(p.get('tmdb'), p.get('kind') || 'tv', p.get('season'), p.get('episode'));
      } catch (e) {}
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      return res.end(JSON.stringify(ids || {}));
    }

    // --- Comics (batcave.biz via the shared headless browser) ---
    // search/browse/detail/pages return JSON; /comic/img proxies a cover/page
    // image with the batcave Referer through a real page nav. Host-locked to
    // batcave so it cannot become an arbitrary image proxy.
    if (url.pathname.startsWith('/comic/')) {
      const p = url.searchParams;
      if (url.pathname === '/comic/img') {
        const u = p.get('u') || '';
        let iu;
        try { iu = new URL(u); } catch (e) { res.writeHead(400); return res.end('bad url'); }
        if (iu.hostname !== 'batcave.biz' && iu.hostname !== 'img.batcave.biz') { res.writeHead(400); return res.end('host not allowed'); }
        // img.batcave.biz TLS-fingerprints non-browser clients; only a real
        // page navigation passes. It also hotlink-gates on the reader Referer.
        let referer = 'https://batcave.biz/';
        const mm = iu.pathname.match(/^\/img\/[^/]+\/(\d+)\/(\d+)\//);
        if (mm) referer = `https://batcave.biz/reader/${mm[1]}/${mm[2]}`;
        let ipage;
        try {
          await ensureBrowser();
          ipage = await ctx.newPage();
          const r = await ipage.goto(u, { referer, timeout: 20000 });
          const ct = (r && r.headers()['content-type']) || '';
          if (!r || r.status() !== 200 || !/^image\//i.test(ct)) { res.writeHead(502); return res.end('image blocked'); }
          const buf = await r.body();
          res.writeHead(200, { 'content-type': ct, 'cache-control': 'public, max-age=86400' });
          return res.end(buf);
        } catch (e) { if (!res.headersSent) res.writeHead(502); return res.end('image error'); }
        finally { if (ipage) await ipage.close().catch(() => {}); }
      }
      const np = { newPage: async () => { await ensureBrowser(); return ctx.newPage(); } };
      const sendJson = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      try {
        if (url.pathname === '/comic/search') return sendJson(await batcave.search(p.get('q') || '', np));
        if (url.pathname === '/comic/browse') return sendJson(await batcave.browse({ publisher: p.get('publisher') || undefined, page: p.get('page') }, np));
        if (url.pathname === '/comic/detail') {
          const slug = p.get('slug') || '';
          if (!slug) { res.writeHead(400); return res.end('missing slug'); }
          return sendJson(await batcave.detail(slug, np));
        }
        if (url.pathname === '/comic/pages') {
          const comic = p.get('comic'), chapter = p.get('chapter');
          if (!comic || !chapter) { res.writeHead(400); return res.end('missing comic/chapter'); }
          return sendJson({ pages: await batcave.pages(comic, chapter, np) });
        }
      } catch (e) { if (!res.headersSent) res.writeHead(502); return res.end('comic error'); }
      res.writeHead(404); return res.end('no such comic route');
    }

    // Resolve an embed URL to a local proxy URL.
    if (url.pathname === '/resolve') {
      const p = url.searchParams;
      const source = p.get('source') || 'embed';
      // Cheap validation before taking a concurrency slot.
      if (source === 'embed') {
        const embed = p.get('embed');
        if (!embed) { res.writeHead(400); return res.end('missing embed'); }
        if (!embedHostAllowed(embed)) { res.writeHead(400); return res.end('embed host not allowed'); }
      }
      if (source === 'daddy' && !/^\d+$/.test(p.get('id') || '')) {
        res.writeHead(400); return res.end('bad daddy id');
      }
      if (resolveInflight >= RESOLVE_MAX_INFLIGHT) { res.writeHead(429); return res.end('busy'); }
      resolveInflight++;
      try {
        let info = null;
        if (source === 'ia') {
          // Strategy #3 - Internet Archive (legal fallback).
          info = await resolveArchive(p.get('title'), p.get('year'));
          console.log(`   resolve[ia]: ${info ? 'hit ' + info.archive : 'miss'} (${Date.now() - t0}ms)`);
        } else if (source === 'rest') {
          // Strategy #2 - direct JSON resolver (no browser).
          info = await resolveDirect(p.get('tmdb'), p.get('kind'), p.get('season'), p.get('episode'));
          console.log(`   resolve[rest]: ${info ? info.type : 'miss'} (${Date.now() - t0}ms)`);
        } else if (source === 'daddy') {
          // Live sports - DaddyLive channel id -> time-window m3u8 (no browser).
          info = await resolveDaddy(p.get('id'));
          console.log(`   resolve[daddy]: ${info ? 'hit' : 'miss'} id=${p.get('id')} (${Date.now() - t0}ms)`);
        } else {
          // Strategy #1 - headless-browser embed extraction (default).
          info = await extract(p.get('embed'));
        }
        if (!info) {
          console.log(`   resolve: no stream (${Date.now() - t0}ms)`);
          res.writeHead(502); return res.end(JSON.stringify({ error: 'no stream found' }));
        }
        // Subtitles = whatever the provider loaded (captured) + the index API.
        info.subs = [...(info.subs || []), ...await fetchSubtitles(url.searchParams)];
        console.log(`   resolve: ${info.type}${info.subs.length ? ` +${info.subs.length} subs` : ''} (${Date.now() - t0}ms)`);
        const id = String(nextId++);
        info.lastAccess = Date.now();
        // Seed the per-session proxy allow-set with the resolved stream's host;
        // it grows as we rewrite nested playlists.
        info.hosts = new Set();
        try { info.hosts.add(new URL(info.stream).hostname); } catch (e) {}
        sessions.set(id, info);
        evictIfNeeded();
        const base = publicBase(req);
        const q = KEY_Q ? `?${KEY_Q}` : '';
        const playUrl = info.type === 'hls' ? `${base}/hls/${id}.m3u8${q}` : `${base}/mp4/${id}${q}`;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id, type: info.type, play: playUrl }));
      } finally {
        resolveInflight--;
      }
    }

    // Progressive MP4 - stream the exact byte range AVPlayer asks for straight
    // from the CDN (falls back to the browser proxy only if the CDN blocks us).
    let m = url.pathname.match(/^\/mp4\/(\d+)$/);
    if (m) {
      const s = touchSession(m[1]);
      if (!s) { res.writeHead(404); return res.end('gone'); }
      if (isPrivateHost(streamHost(s.stream))) { res.writeHead(502); return res.end('blocked'); }
      console.log(`   mp4 range=${req.headers.range || '-'}  (streaming)`);
      await ensureHevcPatch(s); // hev1->hvc1 rename offsets (black-video fix)
      const ok = await streamProxy(s.stream, s.referer, req, res, 'video/mp4', 0, s.hevcPatch);
      if (!ok && !res.headersSent) {
        console.log('   mp4 stream blocked -> browser-buffer fallback');
        await browserProxyRange(s, req, res);
      }
      return;
    }

    // HLS master/playlist proxy - rewrite segments back through us and, when we
    // have external subtitles, inject a native subtitle rendition so AVPlayer
    // shows the subtitle picker.
    m = url.pathname.match(/^\/hls\/(\d+)\.m3u8$/);
    if (m) {
      const id = m[1];
      const s = touchSession(id);
      if (!s) { res.writeHead(404); return res.end('gone'); }
      if (isPrivateHost(streamHost(s.stream))) { res.writeHead(502); return res.end('blocked'); }
      const pub = publicBase(req);
      const amp = KEY_Q ? `&${KEY_Q}` : '';
      const kq = KEY_Q ? `?${KEY_Q}` : '';
      const r = await proxyFetch(s.stream, s.referer);
      const base = new URL(s.stream);
      const src = r.body.toString('utf8');
      const isMaster = /#EXT-X-STREAM-INF/i.test(src);
      const subs = s.subs || [];
      const subLines = subs.map((sub, i) =>
        `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${sub.name.replace(/"/g, '')}",LANGUAGE="${sub.lang}",DEFAULT=${i === 0 ? 'YES' : 'NO'},AUTOSELECT=YES,FORCED=NO,URI="${pub}/subs/${id}/${i}.m3u8${kq}"`);

      const proxySeg = u => {
        const abs = new URL(u, base).href;
        try { s.hosts.add(new URL(abs).hostname); } catch (e) {}
        return `${pub}/seg/${id}?u=${encodeURIComponent(abs)}${amp}`;
      };
      // Pin to ~1080p by default (Apple TV); a client can pass q=auto to get
      // the full adaptive ladder back.
      const forceQuality = url.searchParams.get('q') !== 'auto';

      let out;
      if (isMaster) {
        const rawLines = src.split('\n');
        // Split the master into passthrough header lines (incl. #EXT-X-MEDIA
        // audio/subtitle renditions) and (STREAM-INF, uri) variant pairs.
        const header = [], variants = [];
        for (let i = 0; i < rawLines.length; i++) {
          const t = rawLines[i].trim();
          if (t.startsWith('#EXT-X-STREAM-INF')) {
            let j = i + 1;
            while (j < rawLines.length && (!rawLines[j].trim() || rawLines[j].trim().startsWith('#'))) j++;
            const inf = rawLines[i], uri = j < rawLines.length ? rawLines[j].trim() : '';
            const res = /RESOLUTION=(\d+)x(\d+)/i.exec(inf);
            const bw = /BANDWIDTH=(\d+)/i.exec(inf);
            variants.push({ inf, uri, width: res ? +res[1] : 0, height: res ? +res[2] : 0, bw: bw ? +bw[1] : 0 });
            i = j;
          } else {
            header.push(rawLines[i]);
          }
        }
        // Keep only real video variants (drop audio-only renditions that would
        // let ABR downshift into "sound but black screen").
        const videoRe = /avc1|avc3|hvc1|hev1|dvh1|vp09|av01/i;
        let vids = variants.filter(v => v.height > 0 || videoRe.test(v.inf));
        if (!vids.length) vids = variants;

        // Fold the provider's OWN subtitle renditions into the same "subs" group
        // the variants point at - otherwise they sit in the header declared but
        // orphaned (the #1 reason subbed anime shows no captions: when Wyzie has
        // nothing, the variant got no SUBTITLES tag and the native subs vanished).
        // Everything else in the header (audio renditions, etc.) is proxied as-is.
        const nativeSubLines = [], keptHeader = [];
        for (const l of header) {
          const t = l.trim();
          if (/^#EXT-X-MEDIA:TYPE=SUBTITLES/i.test(t)) {
            nativeSubLines.push(l
              .replace(/GROUP-ID="[^"]*"/i, 'GROUP-ID="subs"')
              .replace(/DEFAULT=(?:YES|NO)/i, 'DEFAULT=NO')
              .replace(/URI="([^"]+)"/g, (_, u) => `URI="${proxySeg(u)}"`));
          } else if (!t || t.startsWith('#')) {
            keptHeader.push(l.replace(/URI="([^"]+)"/g, (_, u) => `URI="${proxySeg(u)}"`));
          }
        }
        if (!keptHeader.some(l => l.trim().startsWith('#EXTM3U'))) keptHeader.unshift('#EXTM3U');
        if (!subLines.length && nativeSubLines.length) {
          nativeSubLines[0] = nativeSubLines[0].replace(/DEFAULT=NO/i, 'DEFAULT=YES');
        }
        const allSubLines = [...subLines, ...nativeSubLines];
        const subTag = allSubLines.length ? ',SUBTITLES="subs"' : '';
        const tagVariant = inf => inf.replace(/\s*$/, '').replace(/,SUBTITLES="[^"]*"/i, '') + subTag;

        if (forceQuality && vids.length) {
          // Serve ONLY the ~1080p variant so AVPlayer can't downshift.
          const pick = pick1080(vids);
          out = [...keptHeader, ...allSubLines, tagVariant(pick.inf), proxySeg(pick.uri)].join('\n');
          console.log(`   master: pinned ${pick.width || '?'}x${pick.height || '?'} (${Math.round((pick.bw || 0) / 1000)}k) of ${variants.length} variants, ${allSubLines.length} sub track(s)`);
        } else {
          // Keep all video variants (adaptive), just proxied + subs attached.
          const body = [];
          for (const v of vids) {
            body.push(tagVariant(v.inf));
            body.push(proxySeg(v.uri));
          }
          out = [...keptHeader, ...allSubLines, ...body].join('\n');
        }
      } else {
        // Media playlist -> wrap in a master so subtitles can attach.
        out = ['#EXTM3U', ...subLines,
          `#EXT-X-STREAM-INF:BANDWIDTH=3000000${subs.length ? ',SUBTITLES="subs"' : ''}`,
          `${pub}/seg/${id}?u=${encodeURIComponent(s.stream)}${amp}`].join('\n');
      }
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(out);
    }

    // WebVTT media playlist wrapping one subtitle track for the whole title.
    m = url.pathname.match(/^\/subs\/(\d+)\/(\d+)\.m3u8$/);
    if (m) {
      const s = sessions.get(m[1]);
      if (!s || !s.subs || !s.subs[m[2]]) { res.writeHead(404); return res.end('gone'); }
      const kq = KEY_Q ? `?${KEY_Q}` : '';
      const pl = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:36000',
        '#EXT-X-PLAYLIST-TYPE:VOD', '#EXTINF:36000.0,',
        `${publicBase(req)}/vtt/${m[1]}/${m[2]}${kq}`, '#EXT-X-ENDLIST'].join('\n');
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(pl);
    }

    // The subtitle file itself, converted to WebVTT for AVPlayer.
    m = url.pathname.match(/^\/vtt\/(\d+)\/(\d+)$/);
    if (m) {
      const s = sessions.get(m[1]);
      const sub = s && s.subs && s.subs[m[2]];
      if (!sub) { res.writeHead(404); return res.end('gone'); }
      // Defense in depth: never fetch a private/loopback subtitle URL.
      let subHost; try { subHost = new URL(sub.url).hostname; } catch (e) { subHost = ''; }
      if (!subHost || isPrivateHost(subHost)) { res.writeHead(400); return res.end('bad sub url'); }
      let body = await nodeGetText(sub.url);
      if (!body) { res.writeHead(502); return res.end('sub fetch failed'); }
      // Normalize to WEBVTT (SRT uses comma decimals) and add the HLS timestamp
      // map so AVPlayer aligns cues to the video timeline instead of drifting.
      const TSMAP = 'X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000';
      if (!/^﻿?WEBVTT/.test(body)) {
        body = body.replace(/\r/g, '').replace(/(\d\d:\d\d:\d\d),(\d{3})/g, '$1.$2');
        body = `WEBVTT\n${TSMAP}\n\n` + body;
      } else if (!/X-TIMESTAMP-MAP/.test(body)) {
        body = body.replace(/^(﻿?WEBVTT[^\n]*\n)/, `$1${TSMAP}\n`);
      }
      res.writeHead(200, { 'content-type': 'text/vtt; charset=utf-8' });
      return res.end(body);
    }

    // HLS segment / nested playlist proxy.
    m = url.pathname.match(/^\/seg\/(\d+)$/);
    if (m) {
      const s = touchSession(m[1]);
      const u = url.searchParams.get('u');
      if (!s || !u) { res.writeHead(404); return res.end('gone'); }
      // SSRF gate: only proxy hosts we surfaced for this session, never a
      // loopback/LAN address a caller injected via ?u=.
      if (!allowedProxyTarget(s, u)) { res.writeHead(403); return res.end('blocked'); }
      // A nested playlist (variant/media .m3u8) must be fetched as text and
      // rewritten; a media segment is streamed straight through.
      if (!/\.m3u8($|\?)/i.test(u)) {
        const ok = await streamProxy(u, s.referer, req, res, 'video/mp2t');
        if (!ok && !res.headersSent) {
          const r = await proxyFetch(u, s.referer, req.headers.range);
          let ct = r.headers['content-type'];
          if (!ct || /^image\//i.test(ct)) ct = 'video/mp2t';   // un-disguise .ts (AirPlay video)
          const h = { 'content-type': ct };
          if (r.headers['content-length']) h['content-length'] = r.headers['content-length'];
          res.writeHead(r.status, h);
          res.end(r.body);
        }
        return;
      }
      const r = await proxyFetch(u, s.referer);
      const base = new URL(u);
      const amp = KEY_Q ? `&${KEY_Q}` : '';
      // Rewrite each entry through us, recording its host as an allowed target
      // so the follow-up /seg fetch for it passes the SSRF gate.
      const seg = x => {
        const abs = new URL(x, base).href;
        try { s.hosts.add(new URL(abs).hostname); } catch (e) {}
        return `${publicBase(req)}/seg/${m[1]}?u=${encodeURIComponent(abs)}${amp}`;
      };
      const rewriteLine = (line) => {
        const t = line.trim();
        if (!t || t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, x) => `URI="${seg(x)}"`);
        return seg(t);
      };
      const raw = r.body.toString('utf8');
      // Strip in-manifest ad pods - but ONLY on VOD playlists (they carry
      // #EXT-X-ENDLIST). A live sliding-window playlist must never have segments
      // removed: an ad break spans refreshes, so a #EXT-X-CUE-OUT may have no
      // #EXT-X-CUE-IN in this window yet (dropping the tail would starve the live
      // edge), and removing mid-list segments desyncs #EXT-X-MEDIA-SEQUENCE.
      // Live (sports/TV) passes through unchanged; only VOD is filtered.
      let out;
      if (!/#EXT-X-ENDLIST/i.test(raw)) {
        out = raw.split('\n').map(rewriteLine).join('\n');
      } else {
        // VOD: drop everything an SCTE-35 marker explicitly brackets (between
        // #EXT-X-CUE-OUT and #EXT-X-CUE-IN). A plain #EXT-X-DISCONTINUITY (also
        // used for legit codec/resolution changes) is left alone. An unterminated
        // CUE-OUT (no matching CUE-IN) does NOT drop the tail - the buffered span
        // is flushed back, so a malformed marker never loses real content.
        let inAd = false, adsCut = 0, pending = [];
        const rewritten = [];
        for (const line of raw.split('\n')) {
          const t = line.trim();
          if (/^#EXT-X-CUE-OUT(?![A-Z-])/i.test(t) || /^#EXT-X-CUE-OUT-CONT/i.test(t)) { inAd = true; pending = [line]; continue; }
          if (/^#EXT-X-CUE-IN/i.test(t)) { inAd = false; pending = []; adsCut++; continue; }
          if (inAd) { pending.push(line); continue; }
          rewritten.push(rewriteLine(line));
        }
        if (pending.length) for (const line of pending) rewritten.push(rewriteLine(line)); // unterminated -> keep
        if (adsCut) console.log(`   /seg: stripped ${adsCut} ad break(s) from VOD playlist`);
        out = rewritten.join('\n');
      }
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(out);
    }

    res.writeHead(404); res.end('not found');
  } catch (e) {
    console.error('   500:', e && e.message);
    if (!res.headersSent) { res.writeHead(500); res.end('internal error'); }
    else { try { res.end(); } catch (_) {} }
  }
});

server.listen(PORT, () => console.log(`SlimeWatch extractor on http://0.0.0.0:${PORT}`));

// Register with a SlimeRelay (if RELAY_URL is set) so the dashboard and app can
// discover this server and see its live load. No-op when running standalone.
try {
  require('./heartbeat').start({ getLoad: () => sessions.size, capacity: SESSION_CAP, port: PORT });
} catch (e) {
  console.warn('[heartbeat] not started:', e.message);
}

// Load the TMDB->AniList/MAL anime mapping (for anime sources + dub/sub). Async;
// anime features stay disabled until it's ready, everything else works meanwhile.
try {
  require('./animemap').init();
} catch (e) {
  console.warn('[animemap] not started:', e.message);
}
