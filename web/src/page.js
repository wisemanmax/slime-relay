// The SlimeWatch web SPA, served as one document by the Worker. All catalog
// calls go through /api/tmdb (token stays server-side); playback uses provider
// embed iframes with a source switcher. Watch state lives in localStorage.
export const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>SlimeWatch</title>
<style>
  :root{
    --bg:#0a0d0b; --panel:#121613; --line:#1f2723; --accent:#37e29a;
    --txt:#e9f1ec; --dim:#8b978f; --dim2:#5f6b63;
  }
  *{box-sizing:border-box}
  html,body{margin:0;height:100%}
  body{background:var(--bg);color:var(--txt);
    font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased;overflow-x:hidden}
  a{color:inherit;text-decoration:none}
  img{display:block}
  ::-webkit-scrollbar{height:0;width:0}

  /* Top bar */
  header{position:sticky;top:0;z-index:40;display:flex;align-items:center;gap:22px;
    padding:14px 20px;backdrop-filter:blur(14px);
    background:linear-gradient(to bottom,rgba(10,13,11,.92),rgba(10,13,11,.6),transparent)}
  .brand{font-weight:900;letter-spacing:1.5px;font-size:20px}
  .brand span{color:var(--accent)}
  nav{display:flex;gap:4px;flex:1;flex-wrap:wrap}
  nav a{padding:7px 13px;border-radius:20px;color:var(--dim);font-size:14px;font-weight:600;cursor:pointer}
  nav a.on{background:var(--accent);color:#04170e}
  nav a:hover:not(.on){color:var(--txt)}
  .search-box{display:flex;align-items:center;gap:8px;background:var(--panel);border:1px solid var(--line);
    border-radius:20px;padding:6px 14px}
  .search-box input{background:none;border:0;color:var(--txt);font-size:14px;outline:none;width:150px}
  .logout{color:var(--dim2);font-size:13px;cursor:pointer}

  main{padding-bottom:60px;min-height:60vh}

  /* Hero */
  .hero{position:relative;height:min(62vh,560px);overflow:hidden}
  .hero .bg{position:absolute;inset:0;background-size:cover;background-position:center 20%;
    transition:background-image .6s ease}
  .hero::after{content:"";position:absolute;inset:0;
    background:linear-gradient(90deg,rgba(10,13,11,.92) 0%,rgba(10,13,11,.35) 45%,transparent 70%),
               linear-gradient(0deg,var(--bg) 2%,transparent 55%)}
  .hero .inner{position:absolute;left:0;bottom:34px;z-index:2;max-width:640px;padding:0 40px}
  .eyebrow{color:var(--accent);font-weight:800;letter-spacing:2px;font-size:12px}
  .hero h1{font-size:clamp(30px,5vw,56px);font-weight:900;margin:8px 0 12px;line-height:1.05}
  .pills{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
  .pill{font-size:13px;color:var(--dim);border:1px solid var(--line);background:var(--panel);
    padding:4px 11px;border-radius:20px}
  .pill.rate{color:var(--accent)}
  .hero p.ov{color:#cdd6d0;font-size:15px;max-width:560px;margin:0 0 18px;
    display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
  .btns{display:flex;gap:12px;align-items:center}
  .btn{display:inline-flex;align-items:center;gap:8px;font-weight:800;font-size:15px;cursor:pointer;border:0}
  .btn.play{background:#fff;color:#0a0d0b;padding:11px 26px;border-radius:26px}
  .btn.ghost{background:rgba(255,255,255,.16);color:#fff;padding:11px 20px;border-radius:26px}
  .btn.icon{background:rgba(255,255,255,.16);color:#fff;width:46px;height:46px;border-radius:50%;
    justify-content:center;font-size:20px}
  .dots{position:absolute;right:40px;bottom:40px;z-index:3;display:flex;gap:7px}
  .dots i{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.3);transition:.3s}
  .dots i.on{background:var(--accent);width:22px;border-radius:7px}

  /* Rows */
  .row{margin:26px 0}
  .row h2{font-size:19px;font-weight:800;margin:0 0 12px;padding:0 40px}
  .track{display:flex;gap:12px;overflow-x:auto;padding:0 40px 6px;scroll-padding:40px}
  .card{flex:0 0 auto;width:150px;cursor:pointer;position:relative}
  .card img,.card .ph{width:150px;height:225px;border-radius:10px;object-fit:cover;background:var(--panel);
    border:1px solid var(--line)}
  .card .ph{display:grid;place-items:center;color:var(--dim2);font-size:26px}
  .card .t{font-size:12.5px;color:var(--dim);margin-top:7px;line-height:1.25;
    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .card:hover img{outline:2px solid var(--accent);outline-offset:2px}
  .card .prog{position:absolute;left:6px;right:6px;bottom:34px;height:4px;border-radius:3px;background:rgba(0,0,0,.6)}
  .card .prog i{display:block;height:100%;border-radius:3px;background:var(--accent)}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:16px;padding:20px 40px}

  .empty{color:var(--dim);text-align:center;padding:80px 20px}

  /* Detail modal */
  .modal{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.6);backdrop-filter:blur(6px);
    display:none;overflow-y:auto}
  .modal.open{display:block}
  .sheet{max-width:1000px;margin:40px auto;background:var(--bg);border:1px solid var(--line);
    border-radius:18px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.6)}
  .sheet .back{height:340px;background-size:cover;background-position:center 15%;position:relative}
  .sheet .back::after{content:"";position:absolute;inset:0;background:linear-gradient(0deg,var(--bg),transparent 70%)}
  .sheet .close{position:absolute;top:16px;right:16px;z-index:3;width:38px;height:38px;border-radius:50%;
    background:rgba(0,0,0,.55);color:#fff;border:0;font-size:18px;cursor:pointer}
  .sheet .body{padding:0 32px 34px;margin-top:-70px;position:relative;z-index:2}
  .sheet h1{font-size:34px;font-weight:900;margin:0 0 10px}
  .sheet .ov{color:#cdd6d0;font-size:15px;max-width:720px;margin:14px 0}
  .seasons{display:flex;gap:8px;overflow-x:auto;padding:6px 0 14px}
  .seasons button{flex:0 0 auto;background:var(--panel);border:1px solid var(--line);color:var(--txt);
    padding:8px 16px;border-radius:20px;font-size:14px;cursor:pointer}
  .seasons button.on{background:var(--accent);color:#04170e;border-color:var(--accent)}
  .eps{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
  .ep{display:flex;gap:12px;background:var(--panel);border:1px solid var(--line);border-radius:12px;
    padding:10px;cursor:pointer;align-items:center}
  .ep:hover{border-color:var(--accent)}
  .ep img,.ep .eph{width:110px;height:62px;border-radius:8px;object-fit:cover;background:#0d120f;flex:0 0 auto}
  .ep .en{font-size:14px;font-weight:600}
  .ep .es{font-size:12px;color:var(--dim)}

  /* Player */
  .player{position:fixed;inset:0;z-index:80;background:#000;display:none;flex-direction:column}
  .player.open{display:flex}
  .player .bar{display:flex;align-items:center;gap:14px;padding:10px 16px;background:#0a0d0b;color:var(--txt)}
  .player .bar .pt{font-weight:700;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .player select{background:var(--panel);color:var(--txt);border:1px solid var(--line);border-radius:10px;
    padding:8px 12px;font-size:14px}
  .player .x{background:var(--panel);color:#fff;border:1px solid var(--line);border-radius:10px;
    padding:8px 14px;cursor:pointer;font-weight:700}
  .player .stage{flex:1;position:relative;background:#000;min-height:0}
  .player .stage video,.player .stage iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:#000}
  .player .ploading{position:absolute;inset:0;display:none;place-items:center;text-align:center;
    color:var(--dim);font-size:15px;background:#000;padding:0 24px}
  .player .ploading.on{display:grid}
  .player .hint{padding:6px 16px;font-size:12px;color:var(--dim2);background:#0a0d0b}
  .player .hint b{color:var(--accent)}
  .pbadge{font-size:11px;font-weight:800;letter-spacing:1px;color:var(--accent);
    background:rgba(55,226,154,.14);border:1px solid rgba(55,226,154,.4);padding:3px 9px;border-radius:20px}
  .player .upnext{position:absolute;right:18px;bottom:18px;background:rgba(10,13,11,.92);
    border:1px solid var(--line);border-radius:12px;padding:10px 16px;font-size:14px;font-weight:700;
    color:var(--txt);opacity:0;transform:translateY(8px);transition:.3s;pointer-events:none}
  .player .upnext.on{opacity:1;transform:none}
  .player .upnext b{color:var(--accent)}

  @media(max-width:640px){
    header{gap:12px;padding:12px 14px}
    .hero .inner{padding:0 20px;bottom:24px} .row h2,.track,.grid{padding-left:20px;padding-right:20px}
    .search-box input{width:96px}
  }
</style>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js"></script>
</head>
<body>
  <header>
    <div class="brand">SLIME<span>WATCH</span></div>
    <nav id="nav"></nav>
    <div class="search-box">
      <span style="color:var(--dim)">⌕</span>
      <input id="q" placeholder="Search…" autocomplete="off">
    </div>
    <span class="logout" onclick="openSettings()" title="Debrid settings" style="font-size:18px;line-height:1">⚙</span>
    <span class="logout" onclick="location.href='/logout'">Sign out</span>
  </header>
  <main id="main"></main>

  <div class="modal" id="modal"><div class="sheet" id="sheet"></div></div>
  <div class="modal" id="setmodal"><div class="sheet" id="setsheet" style="max-width:540px;margin-top:70px"></div></div>
  <div class="player" id="player">
    <div class="bar">
      <span class="pt" id="ptitle"></span>
      <span class="pbadge" id="pbadge" style="display:none">⚡ DEBRID</span>
      <label style="color:var(--dim);font-size:13px">Source</label>
      <select id="psel" onchange="switchProvider()"></select>
      <button class="x" onclick="closePlayer()">✕ Close</button>
    </div>
    <div class="stage">
      <video id="pvideo" controls playsinline preload="auto" style="display:none"></video>
      <iframe id="pframe" allowfullscreen allow="autoplay; fullscreen; encrypted-media" style="display:none"></iframe>
      <div class="ploading on" id="ploading">Finding the best source…</div>
      <div class="upnext" id="pupnext"></div>
    </div>
    <div class="hint" id="phint"></div>
  </div>

<script>
const IMG = (p,sz)=> p ? 'https://image.tmdb.org/t/p/'+sz+p : null;
const api = async (path)=> { try { const r = await fetch('/api/tmdb/'+path); return r.ok ? await r.json() : null; } catch { return null; } };
const kindOf = (it)=> it.media_type ? (it.media_type==='tv'?'tv':'movie') : (it.name && !it.title ? 'tv' : 'movie');
const titleOf = (it)=> it.title || it.name || 'Untitled';
const yearOf = (it)=> (it.release_date||it.first_air_date||'').slice(0,4);
const esc = (s)=> String(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

// Provider embed builders (mirror the apps).
const PROVIDERS = [
  ['vidlink','VidLink',(t,k,s,e)=> k==='movie'?\`https://vidlink.pro/movie/\${t}?autoplay=true&title=false&primaryColor=43e048\`:\`https://vidlink.pro/tv/\${t}/\${s}/\${e}?autoplay=true&title=false&primaryColor=43e048\`],
  ['vidsrccc','VidSrc.cc',(t,k,s,e)=> k==='movie'?\`https://vidsrc.cc/v2/embed/movie/\${t}\`:\`https://vidsrc.cc/v2/embed/tv/\${t}/\${s}/\${e}\`],
  ['embedsu','Embed.su',(t,k,s,e)=> k==='movie'?\`https://embed.su/embed/movie/\${t}\`:\`https://embed.su/embed/tv/\${t}/\${s}/\${e}\`],
  ['autoembed','AutoEmbed',(t,k,s,e)=> k==='movie'?\`https://player.autoembed.cc/embed/movie/\${t}\`:\`https://player.autoembed.cc/embed/tv/\${t}/\${s}/\${e}\`],
  ['vidfast','VidFast',(t,k,s,e)=> k==='movie'?\`https://vidfast.pro/movie/\${t}?autoPlay=true\`:\`https://vidfast.pro/tv/\${t}/\${s}/\${e}?autoPlay=true\`],
  ['pstream','P-Stream',(t,k,s,e)=> k==='movie'?\`https://iframe.pstream.org/embed/tmdb-movie-\${t}\`:\`https://iframe.pstream.org/embed/tmdb-tv-\${t}/\${s}/\${e}\`],
];

// localStorage watch state
const load = (k,d)=> { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k,v)=> localStorage.setItem(k,JSON.stringify(v));
const getRdKey = ()=> load('sw_rdkey','');   // BYO Real-Debrid token, this browser only
const myList = ()=> load('sw_list',[]);
const inList = (id,k)=> myList().some(x=>x.id===id && x.kind===k);
function toggleList(it){ const k=kindOf(it),id=it.id; let l=myList();
  if(inList(id,k)) l=l.filter(x=>!(x.id===id&&x.kind===k));
  else l.unshift({id,kind:k,title:titleOf(it),poster:it.poster_path,backdrop:it.backdrop_path});
  save('sw_list',l.slice(0,60)); }
function recordContinue(it,k,s,e,pos){ let c=load('sw_continue',[]).filter(x=>!(x.id===it.id&&x.kind===k));
  c.unshift({id:it.id,kind:k,title:titleOf(it),poster:it.poster_path,backdrop:it.backdrop_path,s,e,pos:pos||0,ts:Date.now()});
  save('sw_continue',c.slice(0,24)); }
// Persisted resume position for the debrid <video> path.
function savedPos(id,kind,s,e){ const r=load('sw_continue',[]).find(x=>x.id===id&&x.kind===kind&&x.s===s&&x.e===e); return (r&&r.pos)||0; }
function saveProgress(pos,dur){ if(!pCtx||!(pos>0)) return; let c=load('sw_continue',[]);
  const i=c.findIndex(x=>x.id===pCtx.it.id&&x.kind===pCtx.kind); if(i<0) return;
  c[i].pos=Math.floor(pos); if(dur) c[i].dur=Math.floor(dur); c[i].s=pCtx.s; c[i].e=pCtx.e; c[i].ts=Date.now();
  save('sw_continue',c); }
function resumeItem(id,kind){ const rec=load('sw_continue',[]).find(x=>x.id===id&&x.kind===kind);
  if(!rec) return openDetail(id,kind);
  play({id,media_type:kind,title:rec.title,poster_path:rec.poster,backdrop_path:rec.backdrop}, kind, rec.s||1, rec.e||1); }

// ── Rendering ──
const NAV = [['home','Home'],['movies','Movies'],['tv','TV'],['live','Live'],['anime','Anime'],['list','My List']];
function renderNav(active){ document.getElementById('nav').innerHTML =
  NAV.map(([r,l])=>\`<a class="\${r===active?'on':''}" onclick="go('#\${r}')">\${l}</a>\`).join(''); }

function card(it){ const k=kindOf(it), p=IMG(it.poster_path,'w342');
  return \`<div class="card" onclick="openDetail(\${it.id},'\${k}')">\`+
    (p?\`<img loading="lazy" src="\${p}" alt="">\`:\`<div class="ph">▦</div>\`)+
    \`<div class="t">\${esc(titleOf(it))}</div></div>\`; }

function row(title, items){ if(!items||!items.length) return '';
  return \`<div class="row"><h2>\${esc(title)}</h2><div class="track">\${items.map(card).join('')}</div></div>\`; }

let heroItems=[], heroI=0, heroTimer=null;
function renderHero(items){ heroItems=items.filter(x=>x.backdrop_path).slice(0,6); heroI=0;
  clearInterval(heroTimer);
  if(!heroItems.length) return '';
  heroTimer=setInterval(()=>{ heroI=(heroI+1)%heroItems.length; paintHero(); },8000);
  return \`<section class="hero" id="hero"><div class="bg" id="herobg"></div>
    <div class="inner" id="heroinner"></div><div class="dots" id="herodots"></div></section>\`; }
function paintHero(){ const it=heroItems[heroI]; if(!it) return; const k=kindOf(it);
  const bg=document.getElementById('herobg'); if(bg) bg.style.backgroundImage=\`url(\${IMG(it.backdrop_path,'w1280')})\`;
  const inner=document.getElementById('heroinner');
  if(inner) inner.innerHTML=\`<div class="eyebrow">FEATURED</div><h1>\${esc(titleOf(it))}</h1>
    <div class="pills"><span class="pill">\${yearOf(it)||''}</span>
      <span class="pill rate">★ \${(it.vote_average||0).toFixed(1)}</span>
      <span class="pill">\${k==='tv'?'Series':'Movie'}</span></div>
    <p class="ov">\${esc(it.overview||'')}</p>
    <div class="btns">
      <button class="btn play" onclick="openDetail(\${it.id},'\${k}')">▶ Play</button>
      <button class="btn icon" title="Surprise" onclick="surprise()">🎲</button>
    </div>\`;
  const dots=document.getElementById('herodots');
  if(dots) dots.innerHTML=heroItems.map((_,i)=>\`<i class="\${i===heroI?'on':''}"></i>\`).join(''); }

async function surprise(){ const pool=heroItems.concat(load('sw_continue',[]));
  const pick=pool[Math.floor(Math.random()*pool.length)]; if(pick) openDetail(pick.id, pick.kind||kindOf(pick)); }

// ── Views ──
async function viewHome(){ const main=document.getElementById('main'); main.innerHTML='<div class="empty">Loading…</div>';
  const [trend, pm, pt, anime, action] = await Promise.all([
    api('trending/all/week'), api('movie/popular'), api('tv/popular'),
    api('discover/tv?with_keywords=210024&sort_by=popularity.desc'),
    api('discover/movie?with_genres=28&sort_by=popularity.desc'),
  ]);
  if(!trend && !pm && !pt){
    main.innerHTML='<div class="empty">Couldn\\'t load the catalog.<br><br>The site\\'s <b>TMDB_TOKEN</b> secret is likely unset or wrong. Re-set it and reload.</div>';
    return;
  }
  const trItems=(trend?.results||[]).filter(x=>x.media_type!=='person');
  let out = renderHero(trItems);
  const cont=load('sw_continue',[]).map(c=>({id:c.id,media_type:c.kind,title:c.title,poster_path:c.poster,backdrop_path:c.backdrop}));
  if(cont.length) out+=rowResume(cont);
  const list=myList().map(c=>({id:c.id,media_type:c.kind,title:c.title,poster_path:c.poster}));
  if(list.length) out+=row('My List', list);
  out+=row('Trending This Week', trItems);
  out+=row('Popular Movies', pm?.results);
  out+=row('Popular TV', pt?.results);
  out+=row('Anime', anime?.results);
  out+=row('Action', action?.results);
  main.innerHTML=out; paintHero();
}
function rowResume(items){ return \`<div class="row"><h2>Continue Watching</h2><div class="track">\`+
  items.map(it=>{ const p=IMG(it.poster_path,'w342'),k=kindOf(it);
    const rec=load('sw_continue',[]).find(x=>x.id===it.id&&x.kind===k);
    const pct=(rec&&rec.dur&&rec.pos)?Math.min(100,Math.round(100*rec.pos/rec.dur)):0;
    return \`<div class="card" onclick="resumeItem(\${it.id},'\${k}')">\`+
      (p?\`<img loading="lazy" src="\${p}">\`:\`<div class="ph">▦</div>\`)+
      (pct>2?\`<div class="prog"><i style="width:\${pct}%"></i></div>\`:'')+
      \`<div class="t">\${esc(titleOf(it))}</div></div>\`; }).join('')+\`</div></div>\`; }

async function viewList(kind, title, endpoints){ const main=document.getElementById('main');
  main.innerHTML='<div class="empty">Loading…</div>';
  const res=await Promise.all(endpoints.map(e=>api(e.path)));
  let out=''; endpoints.forEach((e,i)=>{ out+=row(e.label, (res[i]?.results||[]).map(x=>({...x,media_type:kind}))); });
  main.innerHTML=out||'<div class="empty">Nothing here.</div>';
}
async function viewMyList(){ const main=document.getElementById('main');
  const l=myList().map(c=>({id:c.id,media_type:c.kind,title:c.title,poster_path:c.poster}));
  main.innerHTML = l.length ? \`<div class="grid">\${l.map(card).join('')}</div>\` :
    '<div class="empty">Your list is empty. Add titles from any detail page.</div>';
}
async function viewSearch(q){ const main=document.getElementById('main');
  if(!q||q.length<2){ main.innerHTML='<div class="empty">Type to search movies, shows & anime.</div>'; return; }
  main.innerHTML='<div class="empty">Searching…</div>';
  const r=await api('search/multi?query='+encodeURIComponent(q));
  const items=(r?.results||[]).filter(x=>x.media_type!=='person' && (x.poster_path));
  main.innerHTML = items.length ? \`<div class="grid">\${items.map(card).join('')}</div>\` :
    '<div class="empty">No matches for “'+esc(q)+'”.</div>';
}

// ── Detail ──
let current=null;
async function openDetail(id,kind){ const modal=document.getElementById('modal'), sheet=document.getElementById('sheet');
  modal.classList.add('open'); sheet.innerHTML='<div class="empty">Loading…</div>';
  const d=await api(kind+'/'+id); if(!d){ sheet.innerHTML='<div class="empty">Couldn\\'t load this title.</div>'; return; }
  d._kind=kind; current=d;
  const genres=(d.genres||[]).slice(0,3).map(g=>\`<span class="pill">\${esc(g.name)}</span>\`).join('');
  const rt=d.runtime?\`\${Math.floor(d.runtime/60)}h \${d.runtime%60}m\`:(d.episode_run_time?.[0]?d.episode_run_time[0]+'m':'');
  const inl=inList(id,kind);
  sheet.innerHTML=\`
    <div class="back" style="background-image:url(\${IMG(d.backdrop_path,'w1280')})">
      <button class="close" onclick="closeDetail()">✕</button></div>
    <div class="body">
      <h1>\${esc(titleOf(d))}</h1>
      <div class="pills"><span class="pill">\${yearOf(d)||''}</span>
        <span class="pill rate">★ \${(d.vote_average||0).toFixed(1)}</span>
        \${rt?\`<span class="pill">\${rt}</span>\`:''}\${genres}</div>
      <div class="btns" style="margin:6px 0 4px">
        <button class="btn play" onclick="playFromDetail()">▶ Play</button>
        <button class="btn ghost" onclick="toggleList(current);openDetail(\${id},'\${kind}')">\${inl?'✓ In My List':'+ My List'}</button>
      </div>
      <p class="ov">\${esc(d.overview||'')}</p>
      <div id="epwrap"></div>
    </div>\`;
  if(kind==='tv') renderSeasons(d);
}
function closeDetail(){ document.getElementById('modal').classList.remove('open'); }

// ── Connect Debrid (BYO key, stored in this browser — mirrors the iOS/tvOS flow) ──
function openSettings(){ const m=document.getElementById('setmodal'), sh=document.getElementById('setsheet');
  closeDetail(); m.classList.add('open'); const key=getRdKey();
  sh.innerHTML=\`<div class="body" style="margin-top:0;padding:30px 30px 32px">
    <h1 style="font-size:24px;margin:0 0 6px">Debrid <span style="color:var(--accent)">HD</span></h1>
    <p class="ov" style="margin:6px 0 18px">Play clean, ad-free HD straight from your own Real-Debrid account — tried before the embed sources, just like the iOS &amp; TV apps. Your key is stored <b>only in this browser</b> and sent per request; it's never a shared server secret. <a href="https://real-debrid.com/apitoken" target="_blank" rel="noopener" style="color:var(--accent)">Get your API token ↗</a></p>
    <div style="display:flex;gap:8px;margin-bottom:10px">
      <input id="rdfield" type="password" placeholder="Paste your Real-Debrid API token" value="\${esc(key)}"
        style="flex:1;padding:12px 14px;border-radius:11px;border:1px solid var(--line);background:#0d120f;color:var(--txt);font-size:15px" autocomplete="off" autocapitalize="off" spellcheck="false"
        onkeydown="if(event.key==='Enter')connectDebrid()">
      <button class="btn play" style="padding:0 22px" onclick="connectDebrid()">Connect</button>
    </div>
    <div id="rdstatus" style="font-size:13px;min-height:20px;color:var(--dim)">\${key?'✓ A key is saved on this device.':''}</div>
    <div class="btns" style="margin-top:18px">
      <button class="btn ghost" onclick="closeSettings()">Done</button>
      \${key?'<button class="btn ghost" style="color:#f4665f" onclick="removeDebrid()">Remove key</button>':''}
    </div>
  </div>\`;
}
function closeSettings(){ document.getElementById('setmodal').classList.remove('open'); }
async function connectDebrid(){ const f=document.getElementById('rdfield'), st=document.getElementById('rdstatus');
  const key=(f.value||'').trim(); if(!key){ st.style.color='#f4665f'; st.textContent='Paste your token first.'; return; }
  st.style.color='var(--dim)'; st.textContent='Checking…';
  try{ const r=await fetch('/api/rdcheck',{headers:{'x-rd-key':key}}); const j=await r.json();
    if(j.valid){ save('sw_rdkey',key); st.style.color='var(--accent)';
      st.innerHTML='✓ Connected'+(j.name?' as <b>'+esc(j.name)+'</b>':'')+'. Debrid HD is on — reopen the player to use it.'; }
    else { st.style.color='#f4665f'; st.textContent = j.reason==='invalid'?'Real-Debrid rejected that token — check it and try again.':'Couldn\\'t reach Real-Debrid — try again in a moment.'; }
  } catch { st.style.color='#f4665f'; st.textContent='Network error — try again.'; }
}
function removeDebrid(){ localStorage.removeItem('sw_rdkey'); openSettings(); }

let curSeason=1;
function renderSeasons(d){ const seasons=(d.seasons||[]).filter(s=>s.season_number>0 && s.episode_count>0);
  if(!seasons.length) return; curSeason=seasons[0].season_number;
  const wrap=document.getElementById('epwrap');
  wrap.innerHTML=\`<div class="seasons" id="seasonbar">\${seasons.map(s=>
    \`<button data-s="\${s.season_number}" onclick="loadSeason(\${d.id},\${s.season_number})">\${esc(s.name)}</button>\`).join('')}</div>
    <div class="eps" id="eps"></div>\`;
  loadSeason(d.id, curSeason);
}
async function loadSeason(tvid, n){ curSeason=n;
  document.querySelectorAll('#seasonbar button').forEach(b=>b.classList.toggle('on', +b.dataset.s===n));
  const eps=document.getElementById('eps'); eps.innerHTML='<div class="empty" style="padding:20px">Loading…</div>';
  const s=await api('tv/'+tvid+'/season/'+n);
  eps.innerHTML=(s?.episodes||[]).map(ep=>{ const st=IMG(ep.still_path,'w300');
    return \`<div class="ep" onclick="play(current,'tv',\${n},\${ep.episode_number})">\`+
      (st?\`<img loading="lazy" src="\${st}">\`:\`<div class="eph"></div>\`)+
      \`<div><div class="en">\${ep.episode_number}. \${esc(ep.name||'Episode')}</div>
        <div class="es">\${ep.runtime?ep.runtime+' min':''}</div></div></div>\`; }).join('')
    || '<div class="empty" style="padding:20px">No episodes.</div>';
}
function playFromDetail(){ if(!current) return;
  if(current._kind==='tv'){ play(current,'tv',curSeason,1); } else { play(current,'movie',1,1); } }

// ── Player (debrid HD first, then embed providers — mirrors the apps' ladder) ──
let pCtx=null, pDebrid=[], resumeAt=0, progTick=null;
function play(it,kind,s,e){ pCtx={it,kind,s,e}; resumeAt=savedPos(it.id,kind,s,e);
  document.getElementById('ptitle').textContent=titleOf(it)+(kind==='tv'?\` · S\${s} E\${e}\`:'');
  recordContinue(it,kind,s,e,resumeAt);
  hideUpNext();
  document.getElementById('psel').innerHTML='<option>Loading…</option>';
  const v0=document.getElementById('pvideo'); v0.onerror=null; v0.pause(); v0.removeAttribute('src'); v0.load(); v0.style.display='none';
  const f0=document.getElementById('pframe'); f0.src='about:blank'; f0.style.display='none';
  setLoading(true,'Checking debrid for a clean HD stream…');
  setHint('');
  document.getElementById('player').classList.add('open');
  resolveDebrid(it,kind,s,e).then(res=>{
    // Ignore a resolve that finished after the user moved to a different title/episode.
    if(!pCtx || pCtx.it.id!==it.id || pCtx.s!==s || pCtx.e!==e) return;
    pDebrid=res.streams; buildSources();
    if(pDebrid.length){ selectSource('rd:0'); }
    else { selectSource(PROVIDERS[0][0]); setHint(debridWhy(res.reason)); }  // transparent about why
  });
}
async function resolveDebrid(it,kind,s,e){
  const key=getRdKey(); if(!key) return {streams:[],reason:'no-key'};   // BYO: no key → skip the round-trip
  // Bounded so a slow/hung torrentio can't stall playback — times out → embed.
  try{ const r=await fetch(\`/api/debrid?tmdb=\${it.id}&kind=\${kind}&s=\${s}&e=\${e}\`, { headers:{'x-rd-key':key}, signal: AbortSignal.timeout(6000) });
    if(!r.ok) return {streams:[],reason:'error'}; const j=await r.json(); return {streams:j.streams||[], reason:j.reason||''}; }
  catch{ return {streams:[],reason:'timeout'}; }
}
// Never leave debrid invisible — say why it fell back to embed (and how to fix it).
function debridWhy(reason){
  if(reason==='no-key') return '⚡ Debrid is off — <b onclick="openSettings()" style="cursor:pointer;text-decoration:underline">add your Real-Debrid key</b> to unlock clean HD. Using an embed source for now.';
  if(reason==='bad-key') return 'Your saved Real-Debrid key looks malformed — <b onclick="openSettings()" style="cursor:pointer;text-decoration:underline">re-enter it</b>. Using an embed source.';
  if(reason==='no-imdb') return 'Debrid couldn\\'t match this title — using an embed source.';
  if(reason&&reason.indexOf('torrentio')===0) return 'Debrid source is unreachable right now — using an embed source.';
  return 'No browser-playable debrid file for this title (4K remux / mkv can\\'t play in a browser) — using an embed source. A browser ad blocker makes it ad-free.';
}
function buildSources(){ const sel=document.getElementById('psel');
  const rd=pDebrid.map((st,i)=>\`<option value="rd:\${i}">Debrid · \${esc(st.label)}</option>\`).join('');
  const em=PROVIDERS.map(([id,name])=>\`<option value="\${id}">\${name} (embed)</option>\`).join('');
  sel.innerHTML=rd+em; }
function selectSource(val){ if(!pCtx) return;
  const sel=document.getElementById('psel'); sel.value=val;
  const vid=document.getElementById('pvideo'), fr=document.getElementById('pframe');
  setLoading(false);
  if(val.startsWith('rd:')){ const st=pDebrid[+val.slice(3)]; if(!st) return;
    fr.style.display='none'; fr.src='about:blank';
    setBadge(true);
    vid.onerror=()=>onVideoError(val);
    // Resume where you left off (skip if we're basically at the start or the very end).
    vid.onloadedmetadata=()=>{ if(resumeAt>30 && resumeAt < (vid.duration||1e9)-60){ try{ vid.currentTime=resumeAt; }catch(_){} } };
    vid.style.display=''; vid.src=st.url; vid.play().catch(()=>{});
    setHint('<b>Debrid HD</b> — direct stream from your Real-Debrid account, no ads. If it won\\'t play, pick another source.');
  } else {
    setBadge(false);
    vid.onerror=null; vid.onloadedmetadata=null; vid.pause(); vid.removeAttribute('src'); vid.load(); vid.style.display='none';
    fr.style.display=''; loadFrame(val);
    setHint('Ads come from the embed source — a browser ad blocker (uBlock Origin) makes it ad-free.');
  }
}
function setBadge(on){ document.getElementById('pbadge').style.display=on?'':'none'; }
function showUpNext(html){ const u=document.getElementById('pupnext'); u.innerHTML=html; u.classList.add('on'); }
function hideUpNext(){ document.getElementById('pupnext').classList.remove('on'); }
// Autoplay the next episode when a debrid video ends (TV only; checks the season really has one).
async function autoNext(){ if(!pCtx || pCtx.kind!=='tv') return;
  const it=pCtx.it, s=pCtx.s, e=pCtx.e;
  const sn=await api('tv/'+it.id+'/season/'+s);
  const max=(sn&&sn.episodes||[]).reduce((m,x)=>Math.max(m,x.episode_number),0);
  if(e<max && pCtx && pCtx.it.id===it.id){ showUpNext('▶ <b>Up Next</b> · S'+s+' E'+(e+1)); play(it,'tv',s,e+1); }
}
// A dead/unsupported debrid link → try the next quality, then fall to embeds.
function onVideoError(val){ const i=+val.slice(3);
  if(pDebrid[i+1]) selectSource('rd:'+(i+1)); else selectSource(PROVIDERS[0][0]); }
function loadFrame(pid){ const p=PROVIDERS.find(x=>x[0]===pid); if(!p||!pCtx) return;
  document.getElementById('pframe').src=p[2](pCtx.it.id,pCtx.kind,pCtx.s,pCtx.e); }
function switchProvider(){ selectSource(document.getElementById('psel').value); }
function setLoading(on,msg){ const l=document.getElementById('ploading');
  if(msg) l.textContent=msg; l.classList.toggle('on',!!on); }
function setHint(html){ document.getElementById('phint').innerHTML=html; }
function closePlayer(){ const vid=document.getElementById('pvideo');
  if(pCtx && vid.currentTime>0) saveProgress(vid.currentTime, vid.duration);  // remember where you stopped
  if(hls){ hls.destroy(); hls=null; }   // tear down the live HLS engine
  document.getElementById('player').classList.remove('open');
  vid.onerror=null; vid.onloadedmetadata=null; vid.onloadeddata=null; vid.pause(); vid.removeAttribute('src'); vid.load();
  document.getElementById('pframe').src='about:blank'; setBadge(false); hideUpNext(); pCtx=null; pDebrid=[]; }

// Wire the debrid <video> once: throttled progress saves + autoplay-next at end.
(function(){ const v=document.getElementById('pvideo'); if(!v) return;
  v.addEventListener('timeupdate', ()=>{ if(progTick) return; progTick=setTimeout(()=>{ progTick=null; saveProgress(v.currentTime, v.duration); }, 5000); });
  v.addEventListener('ended', ()=> autoNext());
})();

// ── Live TV + Sports (DaddyLive, proxied through the worker → the extractor) ──
let liveChans=null, hls=null;
const SPORTS_KW=['sport','espn','fs1','fs2','tnt','bein','dazn','nba','nfl','mlb','nhl','ufc','boxing','wwe','f1','formula','motogp','nascar','tennis','golf','cricket','willow','rugby','soccer','laliga','la liga','premier','uefa','eurosport','tsn','sportsnet','supersport','viaplay'];
function hasWordJS(hay,needle){ let i=0; while((i=hay.indexOf(needle,i))>=0){ if(i===0||!/[a-z]/.test(hay[i-1])) return true; i+=needle.length; } return false; }
function isSportsCh(name){ const n=name.toLowerCase(); return SPORTS_KW.some(k=>hasWordJS(n,k)); }
async function viewLive(){
  const main=document.getElementById('main');
  main.innerHTML='<div class="empty">Loading live channels…</div>';
  if(!liveChans){ try{ const r=await fetch('/api/live/channels'); const j=await r.json(); liveChans=j.channels||[]; }catch{ liveChans=[]; } }
  const sports=(liveChans||[]).filter(x=>isSportsCh(x.name)).sort((a,b)=>a.name.localeCompare(b.name));
  if(!sports.length){ main.innerHTML='<div class="empty">No live channels right now.<br><br>The site\\'s <b>SLIME_TOKEN</b> / <b>EXTRACTOR_BASE</b> secrets may be unset, or the server is offline.</div>'; return; }
  const cards=sports.map(ch=>\`<div class="card" onclick="playLive('\${ch.id}')"><div style="height:112px;border-radius:12px;background:linear-gradient(135deg,#1f6feb,#0a0f1c);display:flex;align-items:center;justify-content:center;text-align:center;padding:8px;font-weight:800;font-size:13px;color:#fff;line-height:1.2">\${esc(ch.name)}</div><div class="t"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#e5484d;margin-right:5px"></span>LIVE</div></div>\`).join('');
  main.innerHTML=\`<div class="row"><h2>Live Sports · \${sports.length} channels</h2></div><div class="grid">\${cards}</div>\`;
}
async function playLive(id){
  const ch=(liveChans||[]).find(x=>x.id===id); const name=ch?ch.name:'Live';
  document.getElementById('ptitle').textContent=name;
  hideUpNext(); setHint(''); setBadge(false); pCtx=null;
  document.getElementById('psel').innerHTML='<option>Live</option>';
  const f0=document.getElementById('pframe'); f0.src='about:blank'; f0.style.display='none';
  const v=document.getElementById('pvideo'); v.style.display='';
  document.getElementById('player').classList.add('open');
  setLoading(true,'Connecting to '+name+'…');
  try{ const r=await fetch('/api/live/resolve?id='+encodeURIComponent(id)); const j=await r.json();
    if(!j.play) throw 0; playHls(v,j.play); }
  catch{ setLoading(false); setHint('Couldn\\'t start that channel — try another.'); }
}
function playHls(v,url){
  if(hls){ hls.destroy(); hls=null; }
  v.onloadeddata=()=>setLoading(false);
  if(v.canPlayType('application/vnd.apple.mpegurl')){ v.src=url; v.play().catch(()=>{}); return; }
  if(window.Hls && Hls.isSupported()){
    hls=new Hls(); hls.loadSource(url); hls.attachMedia(v);
    hls.on(Hls.Events.MANIFEST_PARSED,()=>{ setLoading(false); v.play().catch(()=>{}); });
    hls.on(Hls.Events.ERROR,(_,d)=>{ if(d.fatal){ setLoading(false); setHint('Stream error — try another channel.'); } });
  } else { v.src=url; v.play().catch(()=>{}); }
}

// ── Router ──
function go(hash){ location.hash=hash; }
function route(){ const h=location.hash.slice(1)||'home';
  closeDetail();
  const base=h.split('/')[0];
  renderNav(['home','movies','tv','live','anime','list'].includes(base)?base:'home');
  if(base==='home') viewHome();
  else if(base==='live') viewLive();
  else if(base==='movies') viewList('movie','Movies',[
    {path:'movie/popular',label:'Popular'},{path:'movie/top_rated',label:'Top Rated'},
    {path:'movie/now_playing',label:'Now Playing'},{path:'movie/upcoming',label:'Upcoming'}]);
  else if(base==='tv') viewList('tv','TV',[
    {path:'tv/popular',label:'Popular'},{path:'tv/top_rated',label:'Top Rated'},
    {path:'tv/on_the_air',label:'On The Air'}]);
  else if(base==='anime') viewList('tv','Anime',[
    {path:'discover/tv?with_keywords=210024&sort_by=popularity.desc',label:'Popular Anime'},
    {path:'discover/tv?with_keywords=210024&sort_by=vote_average.desc&vote_count.gte=200',label:'Top Rated Anime'}]);
  else if(base==='list') viewMyList();
  else viewHome();
}
window.addEventListener('hashchange', route);

let sTimer=null;
document.getElementById('q').addEventListener('input', e=>{ clearTimeout(sTimer); const q=e.target.value.trim();
  sTimer=setTimeout(()=>{ renderNav(''); viewSearch(q); }, 300); });

document.addEventListener('keydown', e=>{ if(e.key==='Escape'){ closePlayer(); closeDetail(); closeSettings(); } });

route();
</script>
</body></html>`;
