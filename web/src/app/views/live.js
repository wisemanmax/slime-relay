// Live TV + Sports (DaddyLive via the extractor): a grid of sports channels.

import { liveChannels } from '../api.js';
import { esc } from '../util.js';
import { onAction } from '../ui/actions.js';
import { playLive } from '../player/player.js';

let liveChans = null;   // fetched once per page load
const SPORTS_KW = ['sport','espn','fs1','fs2','tnt','bein','dazn','nba','nfl','mlb','nhl','ufc','boxing','wwe','f1','formula','motogp','nascar','tennis','golf','cricket','willow','rugby','soccer','laliga','la liga','premier','uefa','eurosport','tsn','sportsnet','supersport','viaplay'];
export function hasWordJS(hay, needle) { let i = 0; while ((i = hay.indexOf(needle, i)) >= 0) { if (i === 0 || !/[a-z]/.test(hay[i - 1])) return true; i += needle.length; } return false; }
export function isSportsCh(name) { const n = name.toLowerCase(); return SPORTS_KW.some(k => hasWordJS(n, k)); }

export async function viewLive() {
  const main = document.getElementById('main');
  main.innerHTML = '<div class="empty">Loading live channels…</div>';
  if (!liveChans) { try { const j = await liveChannels(); liveChans = j.channels || []; } catch { liveChans = []; } }
  const sports = (liveChans || []).filter(x => isSportsCh(x.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (!sports.length) { main.innerHTML = '<div class="empty">No live channels right now.<br><br>The site\'s <b>SLIME_TOKEN</b> / <b>EXTRACTOR_BASE</b> secrets may be unset, or the server is offline.</div>'; return; }
  const cards = sports.map(ch => `<div class="card" data-act="live" data-id="${esc(String(ch.id))}"><div style="height:112px;border-radius:12px;background:linear-gradient(135deg,#1f6feb,#0a0f1c);display:flex;align-items:center;justify-content:center;text-align:center;padding:8px;font-weight:800;font-size:13px;color:#fff;line-height:1.2">${esc(ch.name)}</div><div class="t"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#e5484d;margin-right:5px"></span>LIVE</div></div>`).join('');
  main.innerHTML = `<div class="row"><h2>Live Sports · ${sports.length} channels</h2></div><div class="grid">${cards}</div>`;
}

// The id arrives as a string (data-*), exactly as the old onclick="playLive('<id>')" passed it.
onAction('live', (el) => {
  const id = el.dataset.id;
  const ch = (liveChans || []).find(x => x.id === id);
  playLive(id, ch ? ch.name : 'Live');
});
