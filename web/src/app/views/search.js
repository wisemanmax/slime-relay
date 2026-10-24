// Search: the desktop header field (results over <main>) and the Search screen
// (its own route, like the iOS tab). Both query TMDB search/multi.
//
// The Search screen also has an Ask mode (#search/ask) — the apps' "Ask"
// assistant (ask.js): describe a mood, a plot or a half-remembered title and
// it answers with picks, shown as cards that open the detail sheet. The header
// search offers "Ask SlimeWatch: <query>" above its results, which opens Ask
// with that question. The conversation stays in memory until the page reloads.
//
// Wave 8 (W1): "Pick one for me" (My List, views/mylist.js) opens Ask with the
// apps' seed question in its OWN conversation that sees My List only (the
// apps' AssistantSeed.pickFromList, myListOnly) — asking it to choose from the
// list says nothing about sharing watch history, so the "Use My List &
// Continue Watching" switch doesn't apply to it. "New chat" leaves it. A Kids
// profile has no Ask at all (the apps hide it): no mode switch, no header CTA.

import { api } from '../api.js';
import { esc, $ } from '../util.js';
import { card } from '../ui/card.js';
import { renderNav } from '../ui/nav.js';
import { onAction } from '../ui/actions.js';
import { go } from '../router.js';
import { askSession, createAsk, webLibrary, ASK_SUGGESTIONS, ASK_FOLLOWUPS } from '../ask.js';
import { getPrefs, setPrefs, getState, subscribe } from '../state.js';
import { kidsActive } from '../kids.js';   // W8: the Kids gate

/** The apps' seed question for "Pick one for me" (AssistantSeed.pickFromList). */
export const PICK_FROM_LIST = 'Pick one thing from my list for me to watch tonight, and give me two backups from my list.';
/** What that conversation may see: My List alone (webLibrary's first 15), no history. */
export const listOnlyLibrary = (state) => webLibrary({ list: (state && state.list) || [], continue: [] });

let pickMode = false;    // the Ask screen shows the My-List-only conversation
let pickAsk = null;      // that conversation (made on first use)
function pickSession() {
  if (pickAsk) return pickAsk;
  pickAsk = createAsk({ library: () => listOnlyLibrary(getState()) });
  // Someone else's list must not stay on screen after a profile switch.
  subscribe((st, { keys }) => { if (keys.includes('profile')) { pickAsk.reset(); pickMode = false; } });
  return pickAsk;
}
/** The conversation the Ask screen is showing. */
const activeAsk = () => (pickMode ? pickSession() : askSession());

const HINT = '<div class="empty">Type to search movies, shows &amp; anime.</div>';
let mode = 'search';     // the Search screen's mode: 'search' | 'ask'
let seed = null;         // a question handed to Ask from the header search
let seq = 0;             // newest query wins: a slow earlier response never overwrites a newer one

const askCta = (q) => `<button class="ask-cta" data-act="ask-open" data-q="${esc(q)}">✦ Ask SlimeWatch: “${esc(q)}”</button>`;

async function results(q) {
  const r = await api('search/multi?query=' + encodeURIComponent(q));
  const items = (r?.results || []).filter(x => x.media_type !== 'person' && x.poster_path);
  const kids = kidsActive();
  return (kids ? '' : askCta(q)) + (items.length ? `<div class="grid">${items.map(card).join('')}</div>`
    : '<div class="empty">No matches for “' + esc(q) + '”.' + (kids ? '' : ' Ask might know it from a description.') + '</div>');
}

export async function viewSearch(q) { const main = document.getElementById('main');
  const my = ++seq;
  if (!q || q.length < 2) { main.innerHTML = HINT; return; }
  main.innerHTML = '<div class="empty">Searching…</div>';
  const html = await results(q);
  if (my === seq) main.innerHTML = html;
}

/* Search as its own screen, the way the iOS tab works, rather than a field
   wedged into the header. `arg` 'ask' opens it in Ask mode. */
export function viewSearchScreen(arg) {
  const kids = kidsActive();
  mode = arg === 'ask' && !kids ? 'ask' : 'search';
  const ask = mode === 'ask';
  if (!ask) pickMode = false;
  const main = document.getElementById('main');
  main.innerHTML = `${kids ? '' : `<div class="ask-modes" role="tablist">
      <button role="tab" aria-selected="${!ask}" class="${ask ? '' : 'on'}" data-act="search-mode" data-mode="search">Search</button>
      <button role="tab" aria-selected="${ask}" class="${ask ? 'on' : ''}" data-act="search-mode" data-mode="ask">✦ Ask</button>
    </div>`}
    <div class="m-search">
      <input id="mq" placeholder="${ask ? 'Ask SlimeWatch anything…' : 'Search movies, shows &amp; anime'}" autocomplete="off"
             autocapitalize="${ask ? 'sentences' : 'none'}" enterkeyhint="${ask ? 'send' : 'search'}" maxlength="1000">
      ${ask ? '<button class="ask-go" data-act="ask-send">Ask</button>' : ''}
    </div><div id="mres" data-mode="${mode}">${ask ? '' : HINT}</div>`;
  const input = $('mq'); if (!input) return;
  if (ask) {
    activeAsk().onChange = renderAsk;
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sendAsk(); } });
    renderAsk();
    if (seed) { const q = seed; seed = null; startAsk(q); }
  } else {
    let t = null;
    input.addEventListener('input', e => {
      clearTimeout(t);
      const q = e.target.value.trim();
      t = setTimeout(() => searchInto(q, 'mres'), 280);
    });
  }
  input.focus();
}

/* Same query as viewSearch, rendered into a container instead of over main, so
   the search field stays put while results change. */
export async function searchInto(q, targetID) {
  const box = $(targetID); if (!box) return;
  const my = ++seq;
  if (!q || q.length < 2) { box.innerHTML = HINT; return; }
  box.innerHTML = '<div class="empty">Searching…</div>';
  const html = await results(q);
  if (my === seq && $(targetID) === box) box.innerHTML = html;
}

/** Desktop header field: debounced search over <main>, nav un-highlighted. */
export function initHeaderSearch() {
  let sTimer = null;
  $('q').addEventListener('input', e => { clearTimeout(sTimer); const q = e.target.value.trim();
    sTimer = setTimeout(() => { renderNav(''); viewSearch(q); }, 300); });
}

/** The "/" shortcut: the header field where it's shown (desktop), else the Search screen. */
export function focusSearch() {
  const q = $('q');
  if (q && q.offsetParent !== null) { q.focus(); q.select(); return; }
  const mq = $('mq');
  if (mq) { mq.focus(); return; }
  go('#search');   // viewSearchScreen focuses its field once rendered
}

// ── Ask ───────────────────────────────────────────────────────────────────────

const chip = (q) => `<button class="ask-chip" data-act="ask-suggest" data-q="${esc(q)}">${esc(q)}</button>`;

function renderAsk() {
  const box = $('mres');
  if (!box || box.dataset.mode !== 'ask') return;
  const s = activeAsk(), turns = s.turns;
  let html = '';
  if (!turns.length) {
    html += `<div class="ask-intro"><p>Describe a mood, a plot, an actor or a half-remembered title — Ask looks it up and picks something to watch.</p>
      <div class="ask-chips">${ASK_SUGGESTIONS.map(chip).join('')}</div></div>`;
  }
  turns.forEach((t, i) => {
    const last = i === turns.length - 1;
    html += `<div class="ask-turn"><div class="ask-q">${esc(t.question)}</div>`;
    if (last && s.working) {
      html += `<div class="ask-status" role="status"><span class="ask-dot"></span>${esc(s.status)}<button class="ask-chip" data-act="ask-stop">Stop</button></div>`;
    } else {
      html += `<div class="ask-a${t.failed ? ' failed' : ''}">${esc(t.reply)}</div>`;
      if (t.failed && last) html += '<div class="ask-chips"><button class="ask-chip" data-act="ask-retry">Try again</button></div>';
      if (t.picks.length) {
        html += `<div class="grid ask-picks">${t.picks.map(p =>
          `<div class="ask-pick">${card(p.item)}${p.reason ? `<p class="ask-why">${esc(p.reason)}</p>` : ''}</div>`).join('')}</div>`;
      }
    }
    html += '</div>';
  });
  if (turns.length && !s.working && !turns[turns.length - 1].failed) html += `<div class="ask-chips ask-more">${ASK_FOLLOWUPS.map(chip).join('')}</div>`;
  html += `<div class="ask-foot">
      ${pickMode ? '<span class="ask-opt">Choosing from My List <span>(its titles are sent to the assistant)</span></span>'
        : `<label class="ask-opt"><input type="checkbox" data-act="ask-history" ${getPrefs().askHistory ? 'checked' : ''}>
        Use My List &amp; Continue Watching <span>(those titles are sent to the assistant)</span></label>`}
      ${turns.length ? '<button class="ask-chip" data-act="ask-reset">New chat</button>' : ''}
    </div>`;
  box.innerHTML = html;
}

function startAsk(q) {
  const s = activeAsk();
  if (!String(q || '').trim() || s.working) return;
  s.onChange = renderAsk;
  s.ask(q);
  const turns = document.querySelectorAll('#mres .ask-turn');
  const last = turns[turns.length - 1];
  if (last && last.scrollIntoView) last.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function sendAsk() {
  const input = $('mq'); if (!input) return;
  const q = input.value.trim();
  if (!q || activeAsk().working) return;
  input.value = '';
  startAsk(q);
}

/** Open Ask with a question (the header search's "Ask SlimeWatch: …").
    opts.myListOnly: a fresh conversation that sees My List only ("Pick one for me"). */
export function openAsk(q, opts = {}) {
  if (kidsActive()) return;
  pickMode = !!opts.myListOnly;
  if (pickMode) pickSession().reset();
  seed = String(q || '').trim() || null;
  const field = $('q'); if (field) field.value = '';
  if (location.hash === '#search/ask') viewSearchScreen('ask'); else go('#search/ask');
}

onAction('search-mode', (el) => go(el.dataset.mode === 'ask' ? '#search/ask' : '#search'));
onAction('ask-open', (el) => openAsk(el.dataset.q));
onAction('ask-send', () => sendAsk());
onAction('ask-suggest', (el) => startAsk(el.dataset.q));
onAction('ask-retry', () => { activeAsk().onChange = renderAsk; activeAsk().retry(); });
onAction('ask-stop', () => activeAsk().cancel());
onAction('ask-reset', () => {
  // "New chat" from a pick goes back to the ordinary conversation, empty.
  if (pickMode) { pickSession().reset(); pickMode = false; askSession().onChange = renderAsk; }
  askSession().reset(); const f = $('mq'); if (f) f.focus();
});
onAction('ask-history', (el) => setPrefs({ askHistory: !!el.checked }));
