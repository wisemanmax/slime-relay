// SlimeWatch local extractor + proxy server (runs on your Mac).
// Extracts the real stream from a provider embed using headless Chromium,
// then PROXIES the bytes (the CDNs TLS-fingerprint-block non-browser clients,
// so AVPlayer can't fetch directly — we fetch via the browser's network stack
// and re-serve over your LAN).
const http = require('http');
const https = require('https');
const { chromium } = require('playwright');

const PORT = process.env.PORT || 8787;
// Shared secret — when set, every request (except /health) must carry ?key=…
// so other devices on the LAN can't use this as an open proxy.
const TOKEN = process.env.SLIME_TOKEN || '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
// Appended to URLs the server hands back so AVPlayer's follow-up requests
// (segments, ranges) stay authorized.
const KEY_Q = TOKEN ? `key=${TOKEN}` : '';

let browser, ctx;
const sessions = new Map(); // id -> { stream, referer, type, lastAccess }
let nextId = 1;
const SESSION_CAP = 80;

/// Mark a session as recently used so LRU eviction keeps live playbacks.
function touchSession(id) {
  const s = sessions.get(id);
  if (s) s.lastAccess = Date.now();
  return s;
}

/// Evict the least-recently-used session when over the cap — never the one a
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

async function ensureBrowser() {
  // Self-heal: if the browser crashed or was closed (e.g. after a long idle),
  // the old handle is stale — relaunch instead of failing every request.
  if (browser && browser.isConnected() && ctx) return;
  try { if (browser) await browser.close(); } catch (e) {}
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
}

// Load the embed and capture the stream URL. Prefers HLS (.m3u8) — it carries
// subtitle/quality renditions AVPlayer understands — but accepts a direct MP4
// if no playlist shows up quickly, so mp4-only providers stay fast.
async function extract(embedUrl) {
  await ensureBrowser();
  const page = await ctx.newPage();
  let m3u8 = null, mp4 = null;
  const captured = []; // subtitle files the provider's own player loads
  // Catch manifests on both request and response, and match tokened URLs that
  // carry .m3u8/.mp4 anywhere in the query (not just the path).
  const seen = (u) => {
    if (!m3u8 && /\.m3u8([/?&#]|$)/i.test(u)) m3u8 = u;
    if (!mp4 && /\.mp4([/?&#]|$)/i.test(u)) mp4 = u;
    if ((/\.vtt([/?&#]|$)/i.test(u) || /\.srt([/?&#]|$)/i.test(u)) && !captured.some(s => s.url === u)) {
      captured.push({ lang: 'und', name: 'Subtitles', url: u });
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
  await page.close();
  const hit = m3u8 || mp4;
  if (!hit) return null;
  const referer = new URL(embedUrl).origin + '/';
  return { stream: hit, referer, type: /\.m3u8/i.test(hit) ? 'hls' : 'mp4', subs: captured };
}

// Fetch a text body over node http(s), following redirects (best-effort).
function nodeGetText(u, depth = 0) {
  return new Promise((resolve) => {
    let mod; try { mod = new URL(u).protocol === 'http:' ? http : https; } catch (e) { return resolve(null); }
    mod.get(u, { headers: { 'user-agent': UA } }, (r) => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location && depth < 4) {
        r.resume(); return nodeGetText(new URL(r.headers.location, u).href, depth + 1).then(resolve);
      }
      if (r.statusCode !== 200) { r.resume(); return resolve(null); }
      let d = ''; r.setEncoding('utf8');
      r.on('data', (c) => d += c);
      r.on('end', () => resolve(d));
    }).on('error', () => resolve(null));
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

// External subtitles by TMDB id (independent of the video provider). Uses the
// Wyzie subtitle index when a key is configured; degrades to none otherwise.
async function fetchSubtitles(params) {
  const tmdb = params.get('tmdb');
  if (!tmdb || !SUBS_KEY) return [];
  const kind = params.get('kind') || 'movie';
  const season = params.get('season'), episode = params.get('episode');
  let u = `https://sub.wyzie.io/search?id=${encodeURIComponent(tmdb)}&format=srt&key=${encodeURIComponent(SUBS_KEY)}`;
  if (kind !== 'movie' && season && episode) u += `&season=${season}&episode=${episode}`;
  const list = await nodeGetJSON(u);
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

// ── Strategy #2: direct JSON resolver (no headless browser) ─────────────────
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
        subs = (r.subtitles || []).map((s, i) => ({ lang: 'und', name: `Subtitles ${i + 1}`, url: s }));
        break;
      }
    }
  }
  if (!streamUrl || typeof streamUrl !== 'string') return null;
  const referer = headers.Referer || headers.referer || (headers.Origin ? headers.Origin + '/' : '');
  const isHls = /\.m3u8|\/playlist\/|\/hls\//i.test(streamUrl) || !/\.mp4/i.test(streamUrl);
  return { stream: streamUrl, referer, type: isHls ? 'hls' : 'mp4', subs };
}

// ── Strategy #3: Internet Archive (legal, DRM-free public-domain films) ──────
// Given a title (+ year), find a matching movies item and its best MP4. This
// is a real last resort — mostly classics/public-domain — but it's fully legal
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
// TLS fingerprint — only the provider embed needs the browser). Forwards the
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
        return streamProxy(next, referer, req, res, defaultType, depth + 1, patch).then(done);
      }
      // Blocked → let the caller fall back to the browser proxy (no headers written).
      if (up.statusCode === 403 || up.statusCode === 401) { up.resume(); return done(false); }
      const h = { 'accept-ranges': 'bytes' };
      for (const k of ['content-type', 'content-length', 'content-range']) {
        if (up.headers[k]) h[k] = up.headers[k];
      }
      if (!h['content-type']) h['content-type'] = defaultType;
      console.log(`   → CDN ${up.statusCode}  ${h['content-range'] || h['content-length'] || ''}`);
      res.writeHead(up.statusCode, h);
      if (patch && patch.length) {
        // Rewrite hev1→hvc1 fourccs in flight: bytes +1 ('e'→'v') and
        // +2 ('v'→'c'). Map chunk bytes to absolute file offsets via the
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
    // AVPlayer opens/aborts many range connections as it seeks — abort the
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
  // Same hev1→hvc1 rename as the direct path (black-video fix).
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
// sound) — Apple's decoder requires the 'hvc1' sample-entry flavor. The two
// are byte-compatible whenever the parameter sets live in the hvcC box (true
// for these CDNs), so find the fourcc(s) inside the moov once per session and
// rename them on the fly while streaming. Same byte count → ranges/seeking
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
    // moov at the end of the file → search the tail instead.
    if (!moov && total > head.body.length) {
      const start = Math.max(0, total - 8388608);
      const tail = await proxyFetch(s.stream, s.referer, `bytes=${start}-${total - 1}`);
      if (tail.body && tail.body.length) {
        const at = tail.body.indexOf('moov');
        if (at >= 4) { moovBase = start + at - 4; moov = tail.body.subarray(at - 4); }
      }
    }
    if (!moov || !moov.includes('hvcC')) return; // no HEVC config — nothing to fix
    for (const tag of ['hev1', 'hev2']) {
      let i = 0;
      while ((i = moov.indexOf(tag, i)) !== -1) { s.hevcPatch.push(moovBase + i); i += 4; }
    }
    if (s.hevcPatch.length) {
      console.log(`   hevc: renaming ${s.hevcPatch.length} hev1→hvc1 sample entr${s.hevcPatch.length === 1 ? 'y' : 'ies'} (black-video fix)`);
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
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
    // Auth gate.
    if (TOKEN && url.searchParams.get('key') !== TOKEN) {
      res.writeHead(401); return res.end('unauthorized');
    }
    // Minimal logging — path + client only, no titles/URLs on disk.
    console.log(`${new Date().toLocaleTimeString()}  ${req.method} ${url.pathname}  <- ${client}`);

    // Resolve an embed URL to a local proxy URL.
    if (url.pathname === '/resolve') {
      const p = url.searchParams;
      const source = p.get('source') || 'embed';
      let info = null;
      if (source === 'ia') {
        // Strategy #3 — Internet Archive (legal fallback).
        info = await resolveArchive(p.get('title'), p.get('year'));
        console.log(`   resolve[ia]: ${info ? 'hit ' + info.archive : 'miss'} (${Date.now() - t0}ms)`);
      } else if (source === 'rest') {
        // Strategy #2 — direct JSON resolver (no browser).
        info = await resolveDirect(p.get('tmdb'), p.get('kind'), p.get('season'), p.get('episode'));
        console.log(`   resolve[rest]: ${info ? info.type : 'miss'} (${Date.now() - t0}ms)`);
      } else {
        // Strategy #1 — headless-browser embed extraction (default).
        const embed = p.get('embed');
        if (!embed) { res.writeHead(400); return res.end('missing embed'); }
        info = await extract(embed);
      }
      if (!info) {
        console.log(`   resolve: no stream (${Date.now() - t0}ms)`);
        res.writeHead(502); return res.end(JSON.stringify({ error: 'no stream found' }));
      }
      // Subtitles = whatever the provider loaded (captured) + the index API
      // (if a key is configured).
      info.subs = [...(info.subs || []), ...await fetchSubtitles(url.searchParams)];
      console.log(`   resolve: ${info.type}${info.subs.length ? ` +${info.subs.length} subs` : ''} (${Date.now() - t0}ms)`);
      const id = String(nextId++);
      info.lastAccess = Date.now();
      sessions.set(id, info);
      evictIfNeeded();
      const base = `http://${req.headers.host}`;
      const q = KEY_Q ? `?${KEY_Q}` : '';
      const playUrl = info.type === 'hls' ? `${base}/hls/${id}.m3u8${q}` : `${base}/mp4/${id}${q}`;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id, type: info.type, play: playUrl }));
    }

    // Progressive MP4 — stream the exact byte range AVPlayer asks for straight
    // from the CDN (falls back to the browser proxy only if the CDN blocks us).
    let m = url.pathname.match(/^\/mp4\/(\d+)$/);
    if (m) {
      const s = touchSession(m[1]);
      if (!s) { res.writeHead(404); return res.end('gone'); }
      console.log(`   mp4 range=${req.headers.range || '-'}  (streaming)`);
      await ensureHevcPatch(s); // hev1→hvc1 rename offsets (black-video fix)
      const ok = await streamProxy(s.stream, s.referer, req, res, 'video/mp4', 0, s.hevcPatch);
      if (!ok && !res.headersSent) {
        console.log('   mp4 stream blocked → browser-buffer fallback');
        await browserProxyRange(s, req, res);
      }
      return;
    }

    // HLS master/playlist proxy — rewrite segments back through us and, when we
    // have external subtitles, inject a native subtitle rendition so AVPlayer
    // shows the subtitle picker.
    m = url.pathname.match(/^\/hls\/(\d+)\.m3u8$/);
    if (m) {
      const id = m[1];
      const s = touchSession(id);
      if (!s) { res.writeHead(404); return res.end('gone'); }
      const host = req.headers.host;
      const amp = KEY_Q ? `&${KEY_Q}` : '';
      const kq = KEY_Q ? `?${KEY_Q}` : '';
      const r = await proxyFetch(s.stream, s.referer);
      const base = new URL(s.stream);
      const src = r.body.toString('utf8');
      const isMaster = /#EXT-X-STREAM-INF/i.test(src);
      const subs = s.subs || [];
      const subLines = subs.map((sub, i) =>
        `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${sub.name.replace(/"/g, '')}",LANGUAGE="${sub.lang}",DEFAULT=${i === 0 ? 'YES' : 'NO'},AUTOSELECT=YES,FORCED=NO,URI="http://${host}/subs/${id}/${i}.m3u8${kq}"`);

      const proxySeg = u => `http://${host}/seg/${id}?u=${encodeURIComponent(new URL(u, base).href)}${amp}`;
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

        // Rewrite passthrough header (proxy any rendition URIs; attach subs).
        const keptHeader = header
          .filter(l => { const t = l.trim(); return !t || t.startsWith('#'); })
          .map(l => l.replace(/URI="([^"]+)"/g, (_, u) => `URI="${proxySeg(u)}"`));
        if (!keptHeader.some(l => l.trim().startsWith('#EXTM3U'))) keptHeader.unshift('#EXTM3U');

        if (forceQuality && vids.length) {
          // Serve ONLY the ~1080p variant so AVPlayer can't downshift.
          const pick = pick1080(vids);
          const inf = pick.inf.replace(/\s*$/, '') + (subs.length ? ',SUBTITLES="subs"' : '');
          out = [...keptHeader, ...subLines, inf, proxySeg(pick.uri)].join('\n');
          console.log(`   master: pinned ${pick.width || '?'}x${pick.height || '?'} (${Math.round((pick.bw || 0) / 1000)}k) of ${variants.length} variants`);
        } else {
          // Keep all video variants (adaptive), just proxied + subs attached.
          const body = [];
          for (const v of vids) {
            body.push(v.inf.replace(/\s*$/, '') + (subs.length ? ',SUBTITLES="subs"' : ''));
            body.push(proxySeg(v.uri));
          }
          out = [...keptHeader, ...subLines, ...body].join('\n');
        }
      } else {
        // Media playlist → wrap in a master so subtitles can attach.
        out = ['#EXTM3U', ...subLines,
          `#EXT-X-STREAM-INF:BANDWIDTH=3000000${subs.length ? ',SUBTITLES="subs"' : ''}`,
          `http://${host}/seg/${id}?u=${encodeURIComponent(s.stream)}${amp}`].join('\n');
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
        `http://${req.headers.host}/vtt/${m[1]}/${m[2]}${kq}`, '#EXT-X-ENDLIST'].join('\n');
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(pl);
    }

    // The subtitle file itself, converted to WebVTT for AVPlayer.
    m = url.pathname.match(/^\/vtt\/(\d+)\/(\d+)$/);
    if (m) {
      const s = sessions.get(m[1]);
      const sub = s && s.subs && s.subs[m[2]];
      if (!sub) { res.writeHead(404); return res.end('gone'); }
      let body = await nodeGetText(sub.url);
      if (!body) { res.writeHead(502); return res.end('sub fetch failed'); }
      if (!/^﻿?WEBVTT/.test(body)) {
        body = 'WEBVTT\n\n' + body.replace(/\r/g, '').replace(/(\d\d:\d\d:\d\d),(\d{3})/g, '$1.$2');
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
      // A nested playlist (variant/media .m3u8) must be fetched as text and
      // rewritten; a media segment is streamed straight through.
      if (!/\.m3u8($|\?)/i.test(u)) {
        const ok = await streamProxy(u, s.referer, req, res, 'video/mp2t');
        if (!ok && !res.headersSent) {
          const r = await proxyFetch(u, s.referer, req.headers.range);
          const h = { 'content-type': r.headers['content-type'] || 'video/mp2t' };
          if (r.headers['content-length']) h['content-length'] = r.headers['content-length'];
          res.writeHead(r.status, h);
          res.end(r.body);
        }
        return;
      }
      const r = await proxyFetch(u, s.referer);
      const base = new URL(u);
      const amp = KEY_Q ? `&${KEY_Q}` : '';
      const text = r.body.toString('utf8').split('\n').map(line => {
        const t = line.trim();
        if (!t || t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, x) => `URI="http://${req.headers.host}/seg/${m[1]}?u=${encodeURIComponent(new URL(x, base).href)}${amp}"`);
        return `http://${req.headers.host}/seg/${m[1]}?u=${encodeURIComponent(new URL(t, base).href)}${amp}`;
      }).join('\n');
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(text);
    }

    res.writeHead(404); res.end('not found');
  } catch (e) {
    res.writeHead(500); res.end('err: ' + e.message);
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
