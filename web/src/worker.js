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
