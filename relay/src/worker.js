// SlimeRelay — a Cloudflare Worker that tracks connected extractor servers and
// serves a live dashboard. State lives in KV (binding: SERVERS) with a TTL, so
// a server that stops sending heartbeats simply disappears.
//
// Routes:
//   POST /register   heartbeat from an extractor (auth)         -> { ok: true }
//   GET  /servers    live server list, for the app + dashboard  -> { servers: [...] }
//   GET  /pick       least-loaded live server (Part 2 helper)   -> { server }
//   GET  /           the dashboard (HTML)
//
// Auth: shared secret in `RELAY_TOKEN` (set via `wrangler secret put RELAY_TOKEN`),
// provided as `Authorization: Bearer <token>` or `?key=<token>`.

const HEARTBEAT_TTL = 90; // seconds a server stays "live" after its last beat
const FRESH_MS = 60_000;  // shown as green if seen within this window

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const token = env.RELAY_TOKEN || '';
    const provided =
      (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') ||
      url.searchParams.get('key') ||
      '';
    const authed = token !== '' && provided === token;

    if (url.pathname === '/register' && request.method === 'POST') {
      if (!authed) return json({ error: 'unauthorized' }, 401);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      if (!body || !body.id) return json({ error: 'id required' }, 400);
      const record = {
        id: String(body.id),
        name: String(body.name || body.id),
        os: String(body.os || 'unknown'),
        address: String(body.address || ''),
        load: Number(body.load) || 0,
        capacity: Number(body.capacity) || 0,
        version: body.version || 1,
        lastSeen: Date.now(),
      };
      await env.SERVERS.put(`srv:${record.id}`, JSON.stringify(record), { expirationTtl: HEARTBEAT_TTL });
      return json({ ok: true });
    }

    if (url.pathname === '/servers') {
      if (!authed) return json({ error: 'unauthorized' }, 401);
      return json({ servers: await listServers(env) });
    }

    if (url.pathname === '/pick') {
      if (!authed) return json({ error: 'unauthorized' }, 401);
      const usable = (await listServers(env)).filter((s) => s.address);
      usable.sort((a, b) => loadRatio(a) - loadRatio(b));
      return json({ server: usable[0] || null });
    }

    if (url.pathname === '/') {
      if (!authed) return htmlResponse(loginPage());
      return htmlResponse(dashboardPage(provided));
    }

    return json({ error: 'not found' }, 404);
  },
};

async function listServers(env) {
  const list = await env.SERVERS.list({ prefix: 'srv:' });
  const out = [];
  for (const key of list.keys) {
    const value = await env.SERVERS.get(key.name);
    if (value) out.push(JSON.parse(value));
  }
  return out.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

function loadRatio(s) {
  return s.capacity > 0 ? s.load / s.capacity : (s.load > 0 ? 1 : 0);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  });
}

function htmlResponse(body, status = 200) {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function loginPage() {
  return page(`
    <div class="empty">
      <div class="logo">SLIME<span>RELAY</span></div>
      <p>Add your access key to view the dashboard:</p>
      <code>?key=YOUR_RELAY_TOKEN</code>
    </div>
  `);
}

function dashboardPage(key) {
  // Data is fetched client-side (with the key) and re-rendered every few seconds
  // so the board stays live without a full reload.
  const script = `
    const KEY = ${JSON.stringify(key)};
    const FRESH = ${FRESH_MS};
    function ago(ms){const s=Math.max(0,Math.round((Date.now()-ms)/1000));
      if(s<60)return s+'s ago';const m=Math.round(s/60);if(m<60)return m+'m ago';return Math.round(m/60)+'h ago';}
    function osIcon(os){os=(os||'').toLowerCase();
      if(os.includes('darwin')||os.includes('mac'))return '';
      if(os.includes('win'))return '⊞';if(os.includes('linux'))return '🐧';return '●';}
    function card(s){
      const ratio = s.capacity>0 ? Math.min(1, s.load/s.capacity) : 0;
      const fresh = (Date.now()-s.lastSeen) < FRESH;
      const pct = Math.round(ratio*100);
      return \`<div class="card">
        <div class="row1">
          <span class="dot \${fresh?'up':'down'}"></span>
          <span class="name">\${esc(s.name)}</span>
          <span class="os">\${esc(s.os)}</span>
        </div>
        <div class="addr">\${s.address?esc(s.address):'<span class=noaddr>no address advertised</span>'}</div>
        <div class="bar"><div class="fill" style="width:\${pct}%"></div></div>
        <div class="row2">
          <span>\${s.load} / \${s.capacity||'∞'} streams</span>
          <span class="seen">\${ago(s.lastSeen)}</span>
        </div>
      </div>\`;
    }
    function esc(x){return String(x).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
    async function refresh(){
      try{
        const r = await fetch('/servers?key='+encodeURIComponent(KEY));
        const {servers} = await r.json();
        document.getElementById('count').textContent = servers.length;
        const grid = document.getElementById('grid');
        if(!servers.length){grid.innerHTML='<div class="empty small">No servers connected yet. Start an extractor with RELAY_URL set and it\\'ll appear here.</div>';return;}
        grid.innerHTML = servers.map(card).join('');
      }catch(e){/* keep last render */}
    }
    refresh(); setInterval(refresh, 5000);
  `;
  return page(`
    <header>
      <div class="logo">SLIME<span>RELAY</span></div>
      <div class="sub"><span id="count">–</span> server(s) connected · refreshes every 5s</div>
    </header>
    <div id="grid" class="grid"><div class="empty small">Loading…</div></div>
    <script>${script}</script>
  `);
}

function page(inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SlimeRelay</title>
<style>
  :root{--bg:#0a0d0b;--panel:#121613;--line:#1f2723;--txt:#e8f0ea;--dim:#7d8a82;--accent:#37e29a;--red:#f4665f;}
  *{box-sizing:border-box}
  body{margin:0;background:radial-gradient(1200px 600px at 50% -10%,#12211a,var(--bg));color:var(--txt);
    font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;min-height:100vh;padding:28px 20px 60px}
  header{max-width:960px;margin:0 auto 24px;display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:8px}
  .logo{font-weight:900;letter-spacing:2px;font-size:22px}
  .logo span{color:var(--accent)}
  .sub{color:var(--dim);font-size:13px}
  .grid{max-width:960px;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px}
  .row1{display:flex;align-items:center;gap:8px}
  .name{font-weight:700}
  .os{margin-left:auto;color:var(--dim);font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .addr{margin:10px 0 12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--accent);word-break:break-all}
  .noaddr{color:var(--dim)}
  .bar{height:6px;background:#0d120f;border-radius:99px;overflow:hidden}
  .fill{height:100%;background:linear-gradient(90deg,var(--accent),#8be9c0);transition:width .4s}
  .row2{display:flex;justify-content:space-between;margin-top:8px;font-size:12px;color:var(--dim)}
  .dot{width:9px;height:9px;border-radius:99px;flex:none}
  .dot.up{background:var(--accent);box-shadow:0 0 0 0 rgba(55,226,154,.6);animation:pulse 2s infinite}
  .dot.down{background:var(--red)}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(55,226,154,.5)}70%{box-shadow:0 0 0 7px rgba(55,226,154,0)}100%{box-shadow:0 0 0 0 rgba(55,226,154,0)}}
  .empty{max-width:960px;margin:60px auto;text-align:center;color:var(--dim)}
  .empty .logo{font-size:28px;margin-bottom:14px}
  .empty code{display:inline-block;margin-top:10px;background:var(--panel);border:1px solid var(--line);padding:8px 12px;border-radius:8px;color:var(--accent);font-family:ui-monospace,monospace}
  .empty.small{grid-column:1/-1;margin:40px auto}
</style></head><body>${inner}</body></html>`;
}
