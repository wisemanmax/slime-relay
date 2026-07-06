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
  .player iframe{flex:1;width:100%;border:0;background:#000}
  .player .hint{padding:6px 16px;font-size:12px;color:var(--dim2);background:#0a0d0b}

  @media(max-width:640px){
    header{gap:12px;padding:12px 14px}
    .hero .inner{padding:0 20px;bottom:24px} .row h2,.track,.grid{padding-left:20px;padding-right:20px}
    .search-box input{width:96px}
  }
</style>
</head>
<body>
  <header>
    <div class="brand">SLIME<span>WATCH</span></div>
    <nav id="nav"></nav>
    <div class="search-box">
      <span style="color:var(--dim)">⌕</span>
      <input id="q" placeholder="Search…" autocomplete="off">
    </div>
    <span class="logout" onclick="location.href='/logout'">Sign out</span>
  </header>
  <main id="main"></main>

  <div class="modal" id="modal"><div class="sheet" id="sheet"></div></div>
  <div class="player" id="player">
    <div class="bar">
      <span class="pt" id="ptitle"></span>
      <label style="color:var(--dim);font-size:13px">Source</label>
      <select id="psel" onchange="switchProvider()"></select>
      <button class="x" onclick="closePlayer()">✕ Close</button>
    </div>
    <iframe id="pframe" allowfullscreen allow="autoplay; fullscreen; encrypted-media"></iframe>
    <div class="hint">Ads are served by the source — a browser ad blocker (uBlock Origin) makes this ad-free.</div>
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
];

// localStorage watch state
const load = (k,d)=> { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k,v)=> localStorage.setItem(k,JSON.stringify(v));
const myList = ()=> load('sw_list',[]);
const inList = (id,k)=> myList().some(x=>x.id===id && x.kind===k);
function toggleList(it){ const k=kindOf(it),id=it.id; let l=myList();
  if(inList(id,k)) l=l.filter(x=>!(x.id===id&&x.kind===k));
  else l.unshift({id,kind:k,title:titleOf(it),poster:it.poster_path,backdrop:it.backdrop_path});
  save('sw_list',l.slice(0,60)); }
function recordContinue(it,k,s,e){ let c=load('sw_continue',[]).filter(x=>!(x.id===it.id&&x.kind===k));
  c.unshift({id:it.id,kind:k,title:titleOf(it),poster:it.poster_path,backdrop:it.backdrop_path,s,e,ts:Date.now()});
  save('sw_continue',c.slice(0,24)); }

// ── Rendering ──
const NAV = [['home','Home'],['movies','Movies'],['tv','TV'],['anime','Anime'],['list','My List']];
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
    return \`<div class="card" onclick="openDetail(\${it.id},'\${k}')">\`+
      (p?\`<img loading="lazy" src="\${p}">\`:\`<div class="ph">▦</div>\`)+
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

// ── Player ──
let pCtx=null;
function play(it,kind,s,e){ pCtx={it,kind,s,e};
  const sel=document.getElementById('psel');
  sel.innerHTML=PROVIDERS.map(([id,name])=>\`<option value="\${id}">\${name}</option>\`).join('');
  document.getElementById('ptitle').textContent=titleOf(it)+(kind==='tv'?\` · S\${s} E\${e}\`:'');
  recordContinue(it,kind,s,e);
  loadFrame(PROVIDERS[0][0]);
  document.getElementById('player').classList.add('open');
}
function loadFrame(pid){ const p=PROVIDERS.find(x=>x[0]===pid); if(!p||!pCtx) return;
  document.getElementById('pframe').src=p[2](pCtx.it.id,pCtx.kind,pCtx.s,pCtx.e); }
function switchProvider(){ loadFrame(document.getElementById('psel').value); }
function closePlayer(){ document.getElementById('player').classList.remove('open');
  document.getElementById('pframe').src='about:blank'; }

// ── Router ──
function go(hash){ location.hash=hash; }
function route(){ const h=location.hash.slice(1)||'home';
  closeDetail();
  const base=h.split('/')[0];
  renderNav(['home','movies','tv','anime','list'].includes(base)?base:'home');
  if(base==='home') viewHome();
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

document.addEventListener('keydown', e=>{ if(e.key==='Escape'){ closePlayer(); closeDetail(); } });

route();
</script>
</body></html>`;
