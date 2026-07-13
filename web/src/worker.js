// SlimeWatch web — a private, single-page media app served entirely by this
// Cloudflare Worker. It gates everything behind a password, proxies TMDB so the
// API token never reaches the browser, and serves the SPA which plays titles via
// provider-embed iframes.
import { PAGE } from './page.js';

const COOKIE = 'sw_auth';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── Auth token: a hash of the two secrets. Can't be forged without them. ──
    const expected = await authToken(env);

    // Login
    if (url.pathname === '/login') {
      if (request.method === 'POST') {
        const form = await request.formData();
        const pw = String(form.get('password') || '');
        if (env.SITE_PASSWORD && pw === env.SITE_PASSWORD) {
          return new Response(null, {
            status: 302,
            headers: {
              'location': '/',
              'set-cookie': `${COOKIE}=${expected}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
            },
          });
        }
        return html(loginPage(true), 401);
      }
      return html(loginPage(false));
    }

    if (url.pathname === '/logout') {
      return new Response(null, {
        status: 302,
        headers: { 'location': '/login', 'set-cookie': `${COOKIE}=; HttpOnly; Secure; Path=/; Max-Age=0` },
      });
    }

    // Everything past here requires the cookie.
    if (!authed(request, expected)) {
      return new Response(null, { status: 302, headers: { location: '/login' } });
    }

    // TMDB proxy — /api/tmdb/<path>?<query> → api.themoviedb.org/3/<path>
    if (url.pathname.startsWith('/api/tmdb/')) {
      const path = url.pathname.slice('/api/tmdb/'.length);
      const target = new URL(`https://api.themoviedb.org/3/${path}`);
      target.search = url.search;
      const r = await fetch(target, {
        headers: { authorization: `Bearer ${env.TMDB_TOKEN}`, accept: 'application/json' },
      });
      return new Response(r.body, {
        status: r.status,
        headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=600' },
      });
    }

    // Debrid resolve — Torrentio + Real-Debrid. BYO key: each user's OWN RD token
    // rides in the `x-rd-key` header (entered in the web UI, stored in their browser,
    // like the apps' Keychain), so no shared server key and no cross-user leak. This
    // Worker is just the CORS proxy for the Torrentio JSON call. Returns ranked
    // browser-PLAYABLE streams; mkv/avi are omitted (no browser decodes them).
    // /api/debrid?tmdb=<id>&kind=<movie|tv>&s=<n>&e=<n>   header: x-rd-key
    if (url.pathname === '/api/debrid') return debridResolve(request, url, env);

    // Validate a pasted RD token for the "Connect debrid" UI (RD's API blocks browser
    // CORS, so the Worker checks it). header: x-rd-key
    if (url.pathname === '/api/rdcheck') return rdCheck(request);

    // Live TV + Sports — proxy the extractor's public DaddyLive routes so the
    // token (env.SLIME_TOKEN) stays server-side for the catalog + resolve calls.
    // EXTRACTOR_BASE = https://slime.byheir.com. The resolved play URL still
    // carries the token in its query (the browser's hls.js fetches the m3u8
    // directly, cross-origin — the extractor sends Access-Control-Allow-Origin:*).
    if (url.pathname === '/api/live/channels' || url.pathname === '/api/live/resolve') {
      if (!env.SLIME_TOKEN || !env.EXTRACTOR_BASE) return json({ error: 'live-not-configured' }, 503);
      const base = env.EXTRACTOR_BASE.replace(/\/+$/, '');
      let target;
      if (url.pathname === '/api/live/channels') {
        target = new URL(base + '/daddy/channels');
      } else {
        const id = url.searchParams.get('id') || '';
        if (!/^\d+$/.test(id)) return json({ error: 'bad-id' }, 400);
        target = new URL(base + '/resolve');
        target.searchParams.set('source', 'daddy');
        target.searchParams.set('id', id);
      }
      target.searchParams.set('key', env.SLIME_TOKEN);
      const r = await fetch(target, { headers: { accept: 'application/json' } });
      return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json' } });
    }

    // The app itself.
    return html(PAGE);
  },
};

async function authToken(env) {
  const data = new TextEncoder().encode(`${env.SITE_PASSWORD || ''}:${env.SESSION_SECRET || ''}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function authed(request, expected) {
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(new RegExp(`${COOKIE}=([a-f0-9]{64})`));
  return !!m && m[1] === expected && expected.length === 64;
}

function html(body, status = 200) {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, max-age=120' },
  });
}

// Only containers an HTML5 <video> can decode. mkv/avi/ts play in the apps (libVLC)
// but not in a browser, so they're filtered out and playback falls back to embeds.
const WEB_PLAYABLE = /\.(mp4|webm|mov|m4v)$/i;

function qualityOf(t) {
  t = String(t).toLowerCase();
  if (/2160|\b4k\b|uhd/.test(t)) return 2160;
  if (/1440/.test(t)) return 1440;
  if (/1080/.test(t)) return 1080;
  if (/720/.test(t)) return 720;
  if (/480/.test(t)) return 480;
  return 0;
}
function shortName(fn) {
  return String(fn).replace(/\.[^.]+$/, '').replace(/[._]+/g, ' ').trim().slice(0, 46);
}

async function imdbFor(tmdb, kind, env) {
  try {
    const r = await fetch(`https://api.themoviedb.org/3/${kind}/${tmdb}/external_ids`, {
      headers: { authorization: `Bearer ${env.TMDB_TOKEN}`, accept: 'application/json' },
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j.imdb_id || null;
  } catch {
    return null;
  }
}

// RD API tokens are alphanumeric; validate before putting the value in a URL path so
// a crafted "key" can't inject extra path/config segments into the Torrentio request.
const RD_KEY_RE = /^[A-Za-z0-9]+$/;

async function debridResolve(request, url, env) {
  const rdKey = (request.headers.get('x-rd-key') || '').trim();
  const p = url.searchParams;
  const tmdb = p.get('tmdb');
  const isTv = p.get('kind') === 'tv';
  const type = isTv ? 'series' : 'movie';
  const s = p.get('s') || '1';
  const e = p.get('e') || '1';
  if (!rdKey) return json({ streams: [], reason: 'no-key' });
  if (!RD_KEY_RE.test(rdKey)) return json({ streams: [], reason: 'bad-key' });
  if (!tmdb) return json({ streams: [], reason: 'no-id' });

  const imdb = await imdbFor(tmdb, isTv ? 'tv' : 'movie', env);
  if (!imdb || !imdb.startsWith('tt')) return json({ streams: [], reason: 'no-imdb' });
  const id = isTv ? `${imdb}:${s}:${e}` : imdb;

  // Same Torrentio config the apps use; `%7C` is the pipe separator. The user's own
  // RD key rides in the path (validated alphanumeric above).
  const cfg = `sort=qualitysize%7Cqualityfilter=cam,scr,unknown%7Crealdebrid=${rdKey}`;
  const target = `https://torrentio.strem.fun/${cfg}/stream/${type}/${id}.json`;

  let data;
  try {
    const r = await fetch(target, { headers: { 'user-agent': 'SlimeWatch' } });
    if (!r.ok) return json({ streams: [], reason: 'torrentio-' + r.status });
    data = await r.json();
  } catch {
    return json({ streams: [], reason: 'torrentio-error' });
  }

  const out = [];
  for (const x of data.streams || []) {
    const fn = (x.behaviorHints && x.behaviorHints.filename) || x.title || x.name || '';
    const txt = `${x.name || ''} ${x.title || ''}`;
    if (!x.url || !/^https?:/i.test(x.url)) continue; // not a cached direct link
    if (!WEB_PLAYABLE.test(fn)) continue; // browser can't decode this container
    if (/download/i.test(txt)) continue; // Torrentio marks uncached RD entries "download"
    const q = qualityOf(txt);
    // The URL embeds the caller's OWN key (they entered it in their browser) and 302s
    // to the RD CDN, so the <video> plays it directly — no proxy/masking needed for BYO.
    out.push({ url: x.url, quality: q, label: (q ? q + 'p' : 'SD') + ' · ' + shortName(fn) });
  }
  out.sort((a, b) => b.quality - a.quality);
  return json({ streams: out.slice(0, 10) });
}

// Validate a pasted RD token against Real-Debrid's account endpoint (Worker-side
// because RD's API blocks browser CORS). Stateless — the key is never stored.
async function rdCheck(request) {
  const rdKey = (request.headers.get('x-rd-key') || '').trim();
  if (!rdKey || !RD_KEY_RE.test(rdKey)) return json({ valid: false, reason: 'empty' });
  try {
    const r = await fetch('https://api.real-debrid.com/rest/1.0/user', {
      headers: { authorization: `Bearer ${rdKey}` },
    });
    if (r.status === 401 || r.status === 403) return json({ valid: false, reason: 'invalid' });
    if (!r.ok) return json({ valid: false, reason: 'unreachable' });
    const j = await r.json();
    return json({ valid: true, name: j.username || 'Real-Debrid', premium: !!j.premium });
  } catch {
    return json({ valid: false, reason: 'unreachable' });
  }
}

function loginPage(failed) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>SlimeWatch</title>
<style>
  :root{--bg:#0a0d0b;--accent:#37e29a;--txt:#e8f0ea;--dim:#7d8a82;--panel:#121613;--line:#1f2723}
  *{box-sizing:border-box} html,body{height:100%}
  body{margin:0;background:radial-gradient(1000px 500px at 50% -10%,#12211a,var(--bg));color:var(--txt);
    font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:grid;place-items:center}
  form{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:38px 34px;width:min(90vw,360px);text-align:center}
  .logo{font-weight:900;letter-spacing:2px;font-size:24px;margin-bottom:6px}
  .logo span{color:var(--accent)}
  p{color:var(--dim);font-size:13px;margin:0 0 22px}
  input{width:100%;padding:13px 15px;border-radius:11px;border:1px solid var(--line);background:#0d120f;color:var(--txt);font-size:16px;margin-bottom:14px}
  input:focus{outline:none;border-color:var(--accent)}
  button{width:100%;padding:13px;border:0;border-radius:11px;background:var(--accent);color:#04170e;font-weight:800;font-size:16px;cursor:pointer}
  .err{color:#f4665f;font-size:13px;margin-bottom:12px;${failed ? '' : 'display:none'}}
</style></head><body>
  <form method="post" action="/login">
    <div class="logo">SLIME<span>WATCH</span></div>
    <p>Private access</p>
    <div class="err">Wrong password — try again.</div>
    <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password">
    <button type="submit">Enter</button>
  </form>
</body></html>`;
}
