// SlimeRelay — registry + admin control plane for the SlimeWatch server fleet.
// State lives in KV (binding: SERVERS): server heartbeats (srv:<id>, TTL'd) and a
// routing policy (key "policy": { disabled:[ids], preferred:id|null }).
//
// Roles (two secrets):
//   ADMIN_TOKEN  full control — dashboard, /servers (names+addresses+load),
//                /admin/* controls, and server registration.
//   USER_TOKEN   limited — /route only: a bare ranked list of server ADDRESSES
//                to stream through. No names, no load, no fleet, no controls.
// A request is admin if it presents ADMIN_TOKEN; a user if it presents either.
//
// Routes:
//   POST /register        heartbeat (admin) -> { ok }
//   GET  /route           ranked enabled addresses (user|admin) -> { servers:[url] }
//   GET  /servers         full fleet + status (admin) -> { servers:[...] }
//   GET  /pick            single best enabled server (admin) -> { server }
//   POST /admin/action    { action:'disable'|'enable'|'prefer'|'unprefer', id } (admin)
//   GET  /                dashboard (admin) — status + controls

const HEARTBEAT_TTL = 90;
const FRESH_MS = 60_000;

// Current embed-provider domains the apps should use. Streaming sites rotate
// domains constantly; the apps fetch this on launch and override their baked
// defaults, so a rotation is a one-line edit here (or in the KV key "providers")
// instead of a new app build. Edit + redeploy, or set the KV to override live.
const DEFAULT_PROVIDERS = {
  hosts: {
    vidlink: 'vidlink.pro',
    vidfast: 'vidfast.pro',
    vidsrccc: 'vidsrc.cc',
    embedsu: 'embed.su',
    autoembed: 'player.autoembed.cc',
    pstream: 'iframe.pstream.org',
    vidsrcto: 'vidsrc.to',
    vidsrcme: 'vidsrcme.ru',
  },
  animeHosts: {
    vidsrccc: 'vidsrc.cc',
    vidsrcicu: 'vidsrc.icu',
  },
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const provided =
      (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') ||
      url.searchParams.get('key') || '';
    const isAdmin = !!env.ADMIN_TOKEN && provided === env.ADMIN_TOKEN;
    const isUser = isAdmin || (!!env.USER_TOKEN && provided === env.USER_TOKEN);

    // ── Provider domains (PUBLIC — just domain names, no auth). Apps fetch this
    // on launch so a rotated streaming domain is fixed here, not in a new build.
    // Merges the KV "providers" override (if set) over the baked defaults. ──
    if (url.pathname === '/providers') {
      let override = null;
      try { const raw = await env.SERVERS.get('providers'); override = raw ? JSON.parse(raw) : null; } catch {}
      const cfg = {
        hosts: { ...DEFAULT_PROVIDERS.hosts, ...(override?.hosts || {}) },
        animeHosts: { ...DEFAULT_PROVIDERS.animeHosts, ...(override?.animeHosts || {}) },
      };
      return new Response(JSON.stringify(cfg), {
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*',
                   'cache-control': 'public, max-age=300' },
      });
    }

    // ── Server registration (fleet token — servers heartbeat with it) ──
    if (url.pathname === '/register' && request.method === 'POST') {
      if (!isUser) return json({ error: 'unauthorized' }, 401);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      if (!body || !body.id) return json({ error: 'id required' }, 400);
      const cap = (v, n) => String(v ?? '').slice(0, n);
      const safeAddress = (v) => { const s = String(v || ''); return /^https?:\/\//i.test(s) ? s.slice(0, 200) : ''; };
      const record = {
        id: cap(body.id, 128), name: cap(body.name || body.id, 80), os: cap(body.os || 'unknown', 80),
        address: safeAddress(body.address), load: Math.max(0, Number(body.load) || 0),
        capacity: Math.max(0, Number(body.capacity) || 0), version: Number(body.version) || 1, lastSeen: Date.now(),
      };
      await env.SERVERS.put(`srv:${record.id}`, JSON.stringify(record), { expirationTtl: HEARTBEAT_TTL });
      return json({ ok: true });
    }

    // ── User routing: bare, ranked, enabled-only addresses. No metadata. ──
    if (url.pathname === '/route') {
      if (!isUser) return json({ error: 'unauthorized' }, 401);
      const { servers } = await fleet(env);
      const usable = servers.filter((s) => s.enabled && s.address);
      usable.sort(rank);
      return json({ servers: usable.map((s) => s.address) });
    }

    // ── Admin: full fleet with names/addresses/load/status ──
    if (url.pathname === '/servers') {
      if (!isAdmin) return json({ error: 'unauthorized' }, 401);
      const { servers } = await fleet(env);
      return json({ servers: servers.sort(rank) });
    }

    if (url.pathname === '/pick') {
      if (!isAdmin) return json({ error: 'unauthorized' }, 401);
      const { servers } = await fleet(env);
      const usable = servers.filter((s) => s.enabled && s.address).sort(rank);
      return json({ server: usable[0] || null });
    }

    // ── Admin controls: disable / enable / prefer / unprefer ──
    if (url.pathname === '/admin/action' && request.method === 'POST') {
      if (!isAdmin) return json({ error: 'unauthorized' }, 401);
      let body; try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const policy = await getPolicy(env);
      const id = String(body?.id || '');
      switch (body?.action) {
        case 'disable': if (id && !policy.disabled.includes(id)) policy.disabled.push(id); break;
        case 'enable':  policy.disabled = policy.disabled.filter((x) => x !== id); break;
        case 'prefer':  policy.preferred = id || null; break;
        case 'unprefer': policy.preferred = null; break;
        default: return json({ error: 'unknown action' }, 400);
      }
      await env.SERVERS.put('policy', JSON.stringify(policy));
      return json({ ok: true, policy });
    }

    // ── Dashboard (admin) ──
    if (url.pathname === '/') {
      if (!isAdmin) return htmlResponse(gatePage());
      return htmlResponse(dashboardPage(provided));
    }

    return json({ error: 'not found' }, 404);
  },
};

async function getPolicy(env) {
  const raw = await env.SERVERS.get('policy');
  const p = raw ? JSON.parse(raw) : {};
  return { disabled: Array.isArray(p.disabled) ? p.disabled : [], preferred: p.preferred || null };
}

async function fleet(env) {
  const policy = await getPolicy(env);
  const list = await env.SERVERS.list({ prefix: 'srv:' });
  const servers = [];
  for (const k of list.keys) {
    const v = await env.SERVERS.get(k.name);
    if (!v) continue;
    const s = JSON.parse(v);
    s.enabled = !policy.disabled.includes(s.id);
    s.preferred = policy.preferred === s.id;
    servers.push(s);
  }
  return { servers, policy };
}

// Preferred first, then least-loaded.
function rank(a, b) {
  if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
  return loadRatio(a) - loadRatio(b);
}
function loadRatio(s) { return s.capacity > 0 ? s.load / s.capacity : (s.load > 0 ? 1 : 0); }

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  });
}
function htmlResponse(body, status = 200) {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function gatePage() {
  return page(`<div class="empty"><div class="logo">SLIME<span>RELAY</span></div>
    <p>Admin access required. Append <code>?key=YOUR_ADMIN_TOKEN</code>.</p></div>`);
}

function dashboardPage(key) {
  const script = `
    const KEY=${JSON.stringify(key)};
    const FRESH=${FRESH_MS};
    function ago(ms){const s=Math.max(0,Math.round((Date.now()-ms)/1000));if(s<60)return s+'s ago';const m=Math.round(s/60);return m<60?m+'m ago':Math.round(m/60)+'h ago';}
    function esc(x){return String(x).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
    async function action(act,id){await fetch('/admin/action?key='+encodeURIComponent(KEY),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:act,id})});refresh();}
    function card(s){
      const ratio=s.capacity>0?Math.min(1,s.load/s.capacity):0, pct=Math.round(ratio*100), fresh=(Date.now()-s.lastSeen)<FRESH;
      const cls=!s.enabled?'off':(fresh?'up':'down');
      return \`<div class="card \${s.enabled?'':'dim'}">
        <div class="row1"><span class="dot \${cls}"></span><span class="name">\${esc(s.name)}</span>
          \${s.preferred?'<span class="star">★ preferred</span>':''}
          \${!s.enabled?'<span class="badge">disabled</span>':''}<span class="os">\${esc(s.os)}</span></div>
        <div class="addr">\${s.address?esc(s.address):'<span class=noaddr>no address</span>'}</div>
        <div class="bar"><div class="fill" style="width:\${pct}%"></div></div>
        <div class="row2"><span>\${s.load} / \${s.capacity||'∞'} streams</span><span class="seen">\${ago(s.lastSeen)}</span></div>
        <div class="ctl">
          \${s.enabled?\`<button onclick="action('disable','\${s.id}')">Disable</button>\`:\`<button class="pri" onclick="action('enable','\${s.id}')">Enable</button>\`}
          \${s.preferred?\`<button onclick="action('unprefer','\${s.id}')">Unprefer</button>\`:\`<button onclick="action('prefer','\${s.id}')">Prefer</button>\`}
        </div>
      </div>\`;
    }
    async function refresh(){
      try{const r=await fetch('/servers?key='+encodeURIComponent(KEY));const {servers}=await r.json();
        document.getElementById('count').textContent=servers.length;
        const g=document.getElementById('grid');
        g.innerHTML=servers.length?servers.map(card).join(''):'<div class="empty small">No servers connected. Start one with RELAY_URL set.</div>';
      }catch(e){}
    }
    refresh();setInterval(refresh,5000);`;
  return page(`<header><div class="logo">SLIME<span>RELAY</span></div>
    <div class="sub"><span id="count">–</span> server(s) · admin · refreshes every 5s</div></header>
    <div id="grid" class="grid"><div class="empty small">Loading…</div></div><script>${script}</script>`);
}

function page(inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>SlimeRelay</title>
<style>
  :root{--bg:#0a0d0b;--panel:#121613;--line:#1f2723;--txt:#e8f0ea;--dim:#7d8a82;--accent:#37e29a;--red:#f4665f}
  *{box-sizing:border-box} body{margin:0;background:radial-gradient(1200px 600px at 50% -10%,#12211a,var(--bg));color:var(--txt);
    font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;min-height:100vh;padding:28px 20px 60px}
  header{max-width:980px;margin:0 auto 24px;display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap}
  .logo{font-weight:900;letter-spacing:2px;font-size:22px}.logo span{color:var(--accent)}.sub{color:var(--dim);font-size:13px}
  .grid{max-width:980px;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px}
  .card.dim{opacity:.6}
  .row1{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.name{font-weight:700}
  .star{color:var(--accent);font-size:11px}.badge{color:var(--red);font-size:11px;border:1px solid var(--red);border-radius:8px;padding:1px 6px}
  .os{margin-left:auto;color:var(--dim);font-size:11px;font-family:ui-monospace,Menlo,monospace}
  .addr{margin:10px 0 12px;font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--accent);word-break:break-all}.noaddr{color:var(--dim)}
  .bar{height:6px;background:#0d120f;border-radius:99px;overflow:hidden}.fill{height:100%;background:linear-gradient(90deg,var(--accent),#8be9c0)}
  .row2{display:flex;justify-content:space-between;margin-top:8px;font-size:12px;color:var(--dim)}
  .dot{width:9px;height:9px;border-radius:99px;flex:none}.dot.up{background:var(--accent)}.dot.down{background:var(--red)}.dot.off{background:var(--dim)}
  .ctl{display:flex;gap:8px;margin-top:12px}
  .ctl button{flex:1;background:#0d120f;border:1px solid var(--line);color:var(--txt);border-radius:9px;padding:8px;font-size:13px;cursor:pointer}
  .ctl button:hover{border-color:var(--accent)}.ctl button.pri{background:var(--accent);color:#04170e;border-color:var(--accent);font-weight:700}
  .empty{max-width:980px;margin:60px auto;text-align:center;color:var(--dim)}.empty .logo{font-size:28px;margin-bottom:14px}
  .empty code{display:inline-block;margin-top:10px;background:var(--panel);border:1px solid var(--line);padding:8px 12px;border-radius:8px;color:var(--accent);font-family:ui-monospace,monospace}
  .empty.small{grid-column:1/-1;margin:40px auto}
</style></head><body>${inner}</body></html>`;
}
