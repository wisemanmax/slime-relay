/* The player overlay: one <video> (debrid / remux / anime / ad-free HLS / live
   TV), one embed <iframe>, a source picker, fullscreen, Picture-in-Picture,
   captions, skip intro and keyboard control.

   Per title the ladder mirrors the apps (session.steps):
     rd:<i>   debrid files the browser plays, best first, then (when the Mac
              is reachable) mkv/avi the extractor's /vt converter remuxes
     anime    a mapped anime: tryembed -> vidnest -> anixo in the preferred
              audio, then the other (anime.js), resolved by the extractor
     adfree   the generic providers' stream, resolved by the extractor
     embed    the provider iframe (ads are the provider's)
   A source that fails (error, fatal HLS error, silent audio, a refused remux)
   moves to the next rung. Every async step carries the title generation
   (session.gen) and drops its result once anything newer started.

   Public surface:
     play(it, kind, s, e, at) start a title (kind 'movie' | 'tv'); `at` = a shared
                              moment's start (s), else omitted: the resume rule
     playLive(id, name)       start a Live TV channel
     closePlayer()            stop + remember position
     selectSource(val)        'rd:<i>' | 'dx:<i>' | a PROVIDERS id
     seekTo(t)                absolute seek (converter-aware); in a Watch Party the
                              binder sees it first (session.party.seekIntent)
     handlePlayerKey(e)       keyboard shortcuts (wired by keys.js); true = handled
     setCaptionsHandler(fn)   the 'c' key hook — fn({ video, ctx, hls })
     initPlayer()             one-time event wiring (main.js) */

import { $, titleOf, esc } from '../util.js';
import { recordContinue, savedPos, saveProgress, getPrefs, setPrefs } from '../state.js';
import { liveResolve, resolveEmbed } from '../api.js';
import { onAction } from '../ui/actions.js';
import { toast } from '../ui/toast.js';
import { session, nextGen, isCurrentGen, setLoading, setHint, setBadge, setAudioBadge, isPlayerOpen, videoVisible, mediaTime, mediaDuration, momentStart, startPoint } from './session.js';
import { playHls, destroyHls, hlsInstance } from './hls.js';
import { resolveDebrid, debridWhy, browserCaps } from './debrid.js';
import { PROVIDERS, sourceOptionsHTML, resolveDirect, streamFromResolve } from './sources.js';
import { hideUpNext, autoNext } from './upnext.js';
import { lookupAnime, animeRungs, audioPref, otherAudio, deliveredAudio, rungBudgetMs, mayTryRung, skipRung, isNoStream } from './anime.js';
import { initSubtitles, resetSubtitles, subtitlesSource, loadIndexSubtitles, setSubtitleTimeBase, forceCaptions, closeSubtitles, watchHls, captionsKey } from './subtitles.js';
import { initSkip, loadSkip, resetSkip, skipNow } from './skip.js';
import { vtOpen, vtSeek, vtClose, vtSeekPlan, vtWindow, vtWhy } from './vt.js';

let progTick = null;
let ladderTok = 0;          // bumps when the ladder restarts within one title (Sub/Dub switch)
let vtOffUntil = 0;         // the Mac didn't answer a remux: don't offer one again until then
const VT_MAX_START = 172800;   // the Worker refuses a converter start past 48 h (worker/player.js vtCreate)

const prefs = () => getPrefs();   // defaults filled in (animeAudio 'dub', …)

// ── Ladder ──────────────────────────────────────────────────────────────────────
export function play(it, kind, s, e, at) {
  stopVideo();                         // incl. closing a running converter session
  const gen = nextGen();
  session.ctx = { it, kind, s, e }; session.resumeAt = savedPos(it.id, kind, s, e);
  // A shared moment ('#title/…/t/<n>') starts exactly there on every path that
  // can seek (startPoint); the saved resume stays what Continue Watching keeps.
  // Up Next and every other caller pass no `at`, so nothing inherits it.
  session.momentAt = momentStart(at, 0);
  // A fresh title starts with nothing from the last one: its ad-free list used
  // to survive here and show up (and play) under the new title's picker.
  session.debrid = []; session.direct = []; session.anime = null; session.animeState = null;
  session.steps = []; session.step = 0; session.cur = ''; session.debridWhy = ''; session.vtSkip = false;
  $('ptitle').textContent = titleOf(it) + (kind === 'tv' ? ` · S${s} E${e}` : '');
  recordContinue(it, kind, s, e, session.resumeAt);
  hideUpNext();
  resetSubtitles(gen, session.ctx); resetSkip(); setAudioBadge(''); syncAudioToggle(); showVtBar(false);
  $('psel').innerHTML = '<option>Loading…</option>';
  const f0 = $('pframe'); f0.src = 'about:blank'; f0.style.display = 'none';
  setBadge(false);
  setLoading(true, 'Checking debrid for a clean HD stream…');
  setHint('');
  $('player').classList.add('open');
  syncPipButton();
  // The anime map is asked alongside debrid: the anime rungs, the subtitle
  // index's absolute episode and the skip markers all hang off it.
  session.animeP = lookupAnime(session.ctx).catch(() => ({ anime: false })).then(a => {
    if (isCurrentGen(gen)) { session.anime = a; syncAudioToggle(); if (a.anime) loadSkip(gen, a); }
    return a;
  });
  resolveDebrid(it, kind, s, e, Object.assign({ convert: Date.now() > vtOffUntil }, browserCaps())).then(res => {
    if (!isCurrentGen(gen)) return;    // the viewer moved on while Torrentio answered
    session.debrid = res.streams;
    session.debridWhy = res.streams.length ? '' : debridWhy(res.reason);
    session.steps = [...res.streams.map((_, i) => 'rd:' + i), 'anime', 'adfree', 'embed'];
    session.step = 0;
    buildSources();
    runLadder(gen);
  });
}

function buildSources() {
  const sel = $('psel'); const cur = sel.value;
  sel.innerHTML = sourceOptionsHTML(session.direct, session.debrid);
  if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
}

/** Walk session.steps from session.step until a rung is playing. */
async function runLadder(gen) {
  const lt = ++ladderTok;
  const live = () => isCurrentGen(gen) && lt === ladderTok;
  while (live() && session.step < session.steps.length) {
    const step = session.steps[session.step];
    if (step.startsWith('rd:')) {
      const st = session.debrid[+step.slice(3)];
      if (!st || (st.vt && (session.vtSkip || Date.now() < vtOffUntil))) { session.step++; continue; }
      applySource(step);               // failures come back through onSourceFailed
      return;
    }
    if (step === 'anime') {
      const k = await animeStep(gen, live);
      if (!live()) return;
      if (k >= 0) { applySource('dx:' + k); return; }
      session.step++; continue;
    }
    if (step === 'adfree') {
      // No debrid file played. Try the ad-free extractor tier before an embed,
      // whose ads we provably cannot block from here.
      setLoading(true, 'Trying an ad-free source…');
      setHint((session.debridWhy ? session.debridWhy + ' ' : '') + 'Trying an ad-free source…');
      const st = await resolveDirect(session.ctx);
      if (!live()) return;             // a stale resolve never lands on a new title
      if (st) { st.step = 'adfree'; session.direct.push(st); buildSources(); applySource('dx:' + (session.direct.length - 1)); return; }
      session.step++; continue;
    }
    // embed: the last rung (its failures happen inside another origin's frame).
    applySource(PROVIDERS[0][0]);
    if (session.debridWhy) setHint(session.debridWhy);
    return;
  }
}

/** The anime rungs, resumable: a stream that dies continues from the next rung.
    -> index into session.direct of a resolved stream, or -1 (tier exhausted). */
async function animeStep(gen, live) {
  const a = await session.animeP;
  if (!live() || !a || !a.anime) return -1;
  let A = session.animeState;
  if (!A) A = session.animeState = { rungs: animeRungs(a, audioPref(prefs())), i: 0, noStream: [], t0: Date.now(), started: false };
  while (A.i < A.rungs.length) {
    const r = A.rungs[A.i];
    // Bounded until something plays: another rung only while it still fits
    // in the start budget (AnimeNativeTier.startBudget).
    if (!A.started && !mayTryRung(Date.now() - A.t0, r)) break;
    A.i++;
    if (skipRung(r, A.noStream)) continue;   // the same catalog already said "no stream" for this audio
    setLoading(true, `Finding the ${r.audio === 'dub' ? 'English dub' : 'subbed version'} on ${r.host}…`);
    let j = null;
    try { j = await resolveEmbed(r.url, { signal: AbortSignal.timeout(rungBudgetMs(r)) }); } catch (_) { j = null; }
    if (!live()) return -1;
    if (j && (j.error === 'not-configured' || j.error === 'resolve-unreachable')) break;   // says the same about every rung
    if (isNoStream(j)) { A.noStream.push(r); continue; }
    const st = streamFromResolve(j, r.host);
    if (!st) continue;
    const d = deliveredAudio(r.audio, j);
    st.anime = { requested: r.audio, audio: d.audio, fellBack: d.fellBack, verified: d.verified, host: r.host };
    st.step = 'anime';
    session.direct.push(st); buildSources();
    return session.direct.length - 1;
  }
  return -1;
}

/** The source `val` failed (error, fatal HLS error, silent audio, refused remux). */
function onSourceFailed(gen, val, note) {
  if (!isCurrentGen(gen) || session.cur !== val) return;   // a late error from a source already left
  if (note) setHint(note);
  carryPosition();                      // the next rung picks up here
  stopVideo();
  if (val.startsWith('dx:')) {
    const st = session.direct[+val.slice(3)];
    const i = session.steps.indexOf(st && st.step === 'anime' ? 'anime' : 'adfree');
    // An anime stream continues with the next anime rung; ad-free moves on.
    session.step = i < 0 ? session.steps.length - 1 : (st && st.step === 'anime' ? i : i + 1);
  } else {
    const i = session.steps.indexOf(val);
    session.step = i >= 0 ? i + 1 : session.steps.indexOf('anime');
  }
  if (session.step < 0) session.step = 0;
  runLadder(gen);
}

/* Silent-stream rescue.
   Screening release names catches the tagged Dolby/DTS files, but plenty of
   uploads simply don't say, and an mp4 with AC-3 inside plays picture with no
   sound (so does a remux whose AC-3 the converter copied). Two signals, both
   cheap: Safari exposes audioTracks (an empty list means nothing decodable)
   and webkitAudioDecodedByteCount (stuck at 0 while playing means no audio is
   being produced). Checked a few seconds IN, because both read zero before
   the first frames decode. */
let silenceTimer = null;
function clearSilenceCheck() { clearTimeout(silenceTimer); silenceTimer = null; }
function scheduleSilenceCheck(gen, val) {
  clearSilenceCheck();
  silenceTimer = setTimeout(() => {
    if (!isCurrentGen(gen) || session.cur !== val) return;
    const vid = $('pvideo');
    if (!vid || vid.paused || vid.muted || vid.volume === 0) return;   // user's own doing, not the file
    const noTrack = vid.audioTracks && vid.audioTracks.length === 0;
    const noBytes = typeof vid.webkitAudioDecodedByteCount === 'number'
                 && vid.webkitAudioDecodedByteCount === 0 && vid.currentTime > 1;
    if (noTrack || noBytes) onSourceFailed(gen, val, 'That debrid file had audio this browser can\'t decode (Dolby/DTS) — trying the next source.');
  }, 4500);
}

/** Tear down whatever the <video> is playing: handlers, hls.js, a converter session. */
function stopVideo() {
  clearSilenceCheck();
  const vid = $('pvideo'); if (!vid) return;
  vid.onerror = null; vid.onloadedmetadata = null; vid.onloadeddata = null; vid.onplaying = null;
  destroyHls();
  closeVt();
  vid.pause(); vid.removeAttribute('src'); vid.load(); vid.style.display = 'none';
}
function closeVt() {
  if (session.vt) { vtClose(session.vt); session.vt = null; }
  clearTimeout(seekTimer); pendingSeek = null; seekSeq++;   // a pending restart belongs to the session just closed
  setSubtitleTimeBase(0); showVtBar(false);
}

/** A rung change (a failed source, the Sub/Dub switch) picks up where the viewer
    is: a moment moves to the playhead once anything has played, so the next
    rung still lands there exactly (a moment past the end that started at the
    top, too); without one the resume point moves, past the first 30 s. */
function carryPosition() {
  const pos = mediaTime();
  if (session.momentAt !== null) { if (pos > 0) session.momentAt = pos; }
  else if (pos > 30) session.resumeAt = pos;
}

/** Start where startPoint says once the length is known: a shared moment
    exactly, else resume where the viewer left off (skipped if basically at the
    start or the very end). Native <video> files and both HLS engines (Safari's,
    hls.js) all come through here. */
function armResume(vid) {
  vid.onloadedmetadata = () => {
    const to = startPoint(session.momentAt, session.resumeAt, vid.duration);
    if (to > 0) { try { vid.currentTime = to; } catch (_) {} }
  };
}

/** Subtitles for the source that just started, plus the index once per title. */
function noteVideoSource(gen, mode, subs) {
  subtitlesSource(gen, { mode, subs });
  session.animeP.then(a => { if (isCurrentGen(gen)) loadIndexSubtitles(gen, session.ctx, a && a.anime ? a.abs : null); });
}

export function selectSource(val) { applySource(val); syncPipButton(); }
function applySource(val) {
  if (!session.ctx) return;
  const gen = session.gen;
  stopVideo();
  session.cur = val;
  const sel = $('psel'); sel.value = val;
  const vid = $('pvideo'), fr = $('pframe');
  setLoading(false);
  if (val.startsWith('dx:')) { const st = session.direct[+val.slice(3)]; if (!st) return;
    fr.style.display = 'none'; fr.src = 'about:blank';
    setBadge(false);
    vid.onerror = () => onSourceFailed(gen, val);
    vid.style.display = '';
    armResume(vid);
    let mode = 'file';
    if (st.type === 'mp4') { vid.src = st.url; vid.play().catch(() => {}); }
    else mode = playHls(vid, st.url, { onFatal: () => onSourceFailed(gen, val), onReady: watchHls });
    const prevLoaded = vid.onloadeddata;
    vid.onloadeddata = (ev) => { if (prevLoaded) prevLoaded(ev); if (st.anime && session.animeState) session.animeState.started = true; };
    noteVideoSource(gen, mode, st.subs);
    if (st.anime) showAnimeAudio(st.anime);
    else { setAudioBadge(''); forceCaptions(false);
      setHint('<b>Ad-free</b> — the stream was pulled straight from ' + esc(st.label) + ' by your own server, so none of that site\'s ads or popups load.'); }
    syncPipButton();
    return;
  }
  if (val.startsWith('rd:')) { const st = session.debrid[+val.slice(3)]; if (!st) return;
    fr.style.display = 'none'; fr.src = 'about:blank';
    setBadge(true); setAudioBadge(''); forceCaptions(false);
    if (st.vt) { startVt(gen, val, st); syncPipButton(); return; }
    vid.onerror = () => onSourceFailed(gen, val);
    // A release name doesn't always admit its audio codec, so verify once
    // playback is actually running (see scheduleSilenceCheck).
    vid.onplaying = () => scheduleSilenceCheck(gen, val);
    armResume(vid);
    vid.style.display = ''; vid.src = st.url; vid.play().catch(() => {});
    noteVideoSource(gen, 'file', []);
    setHint('<b>Debrid HD</b> — direct stream from your Real-Debrid account, no ads. If it won\'t play, pick another source.');
  } else {
    setBadge(false); setAudioBadge('');
    fr.style.display = ''; loadFrame(val);
    subtitlesSource(gen, { embed: true });
    setHint('Ads come from the embed source — a browser ad blocker (uBlock Origin) makes it ad-free.');
  }
  syncPipButton();
}

function showAnimeAudio(a) {
  setAudioBadge(a.audio);
  // SUB is the original audio: captions on in the viewer's language. A dub
  // request that came back as the sub overrides even a title set to "off".
  forceCaptions(a.audio === 'sub', a.fellBack);
  if (a.fellBack) {
    setHint('<b>No English dub yet — playing subbed.</b> Captions are on. Ad-free from ' + esc(a.host) + '.');
    toast('No English dub yet — playing subbed', { id: 'anime-audio' });
  } else if (a.audio === 'dub') {
    setHint('<b>English dub</b> — ad-free from ' + esc(a.host) + ' via your own server.' + (a.verified ? '' : ' (The host didn\'t confirm the dub; switch to Sub if it isn\'t English.)'));
  } else {
    setHint('<b>Subbed</b> — original audio with captions, ad-free from ' + esc(a.host) + ' via your own server.');
  }
}

// ── The converter (/vt) ─────────────────────────────────────────────────────────
async function startVt(gen, val, st) {
  setLoading(true, 'Converting on your Mac — this file is an mkv the browser can\'t open directly…');
  setHint('<b>Debrid HD · converted on your Mac</b> — remuxed for the browser (picture untouched). Seeking far restarts the conversion there.');
  // The conversion starts at the moment, else at the resume point. The probe's
  // duration only comes back WITH the open, so the one bound known up front is
  // the Worker's: a start past 48 h (longer than anything) counts as past the end.
  const m = momentStart(session.momentAt, VT_MAX_START);
  const start = m !== null ? m : (session.resumeAt > 30 ? session.resumeAt : 0);
  const a = session.anime;
  const audio = a && a.anime && audioPref(prefs()) === 'sub' ? 'jpn' : 'eng';
  let r = await vtOpen(st.url, start, audio);
  // A moment past the file's end leaves ffmpeg nothing to write, which the Mac
  // answers 'convert-failed': once, from the top — past the end plays from the
  // start, as on every other path. (A file it truly can't remux says so again.)
  if (!r.ok && r.error === 'convert-failed' && m > 0 && isCurrentGen(gen) && session.cur === val) r = await vtOpen(st.url, 0, audio);
  if (!isCurrentGen(gen) || session.cur !== val) { if (r.ok) vtClose(r.session); return; }
  if (!r.ok) {
    // ONE converter job at a time on the Mac: busy now = busy for every file,
    // so the remaining remuxes are skipped, never retried in a loop.
    if (r.kind === 'busy' || r.kind === 'unavailable') session.vtSkip = true;
    if (r.kind === 'unavailable') vtOffUntil = Date.now() + 120000;
    toast(vtWhy(r.kind) + ' — trying the next source.', { id: 'vt' });
    onSourceFailed(gen, val);
    return;
  }
  session.vt = r.session;
  playVtEpoch(gen, val);
}

function playVtEpoch(gen, val) {
  const vid = $('pvideo');
  vid.onerror = () => onSourceFailed(gen, val);
  vid.onplaying = () => scheduleSilenceCheck(gen, val);
  vid.style.display = '';
  // A rolling, live-shaped playlist: start at its first segment, not hls.js's
  // live edge (which would skip the opening seconds of every epoch).
  const mode = playHls(vid, session.vt.play, { config: { startPosition: 0 }, onFatal: () => onSourceFailed(gen, val), onReady: watchHls });
  if (mode === 'native-hls') vid.onloadedmetadata = () => { const w = vtWindow(vid); if (w && w.start < 1 && vid.currentTime > 1) { try { vid.currentTime = w.start; } catch (_) {} } };
  setSubtitleTimeBase(session.vt.baseOffset);
  noteVideoSource(gen, mode, []);
  showVtBar(true);
  syncPipButton();
}

let seekSeq = 0, seekTimer = null, pendingSeek = null;
/** Absolute seek. On a converter stream a target inside the generated window
    just moves the playhead; anything else restarts generation there (a new
    epoch) — debounced, so held arrow keys cost one restart, and a stale
    answer never replaces a newer one. */
export function seekTo(t) {
  if (!videoVisible()) return;
  // A party in host-only mode refuses a member's seek before anything moves
  // (a converter seek would otherwise restart generation on the Mac first).
  if (session.party && session.party.seekIntent(t) === false) return;
  const v = $('pvideo');
  if (!session.vt) {
    const sk = v.seekable;
    let to = Math.max(0, t);
    if (sk && sk.length) to = Math.min(Math.max(to, sk.start(0)), sk.end(sk.length - 1));
    try { v.currentTime = to; } catch (_) {}
    return;
  }
  const plan = vtSeekPlan(t, session.vt.baseOffset, vtWindow(v));
  if (plan.local != null) { pendingSeek = null; try { v.currentTime = plan.local; } catch (_) {} return; }
  pendingSeek = plan.server; updateVtBar();
  clearTimeout(seekTimer);
  seekTimer = setTimeout(serverSeek, 350);
}
async function serverSeek() {
  const sess = session.vt, gen = session.gen, val = session.cur, seq = ++seekSeq, target = pendingSeek;
  if (!sess || target == null) return;
  setLoading(true, 'Seeking — your Mac is restarting the conversion there…');
  const r = await vtSeek(sess, target);
  if (seq !== seekSeq || !isCurrentGen(gen) || session.vt !== sess || session.cur !== val) return;
  setLoading(false); pendingSeek = null;
  if (!r) { toast('Couldn\'t seek there — still playing where you were.', { id: 'vt-seek' }); updateVtBar(); return; }
  session.vt = Object.assign({}, sess, r);
  playVtEpoch(gen, val);
}

const clock = (t) => { t = Math.max(0, Math.floor(t || 0)); const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0'); };
let scrubbing = false;
function showVtBar(on) { const b = $('pvtbar'); if (b) b.style.display = on ? '' : 'none'; if (on) updateVtBar(); }
function updateVtBar() {
  const b = $('pvtbar'); if (!b || !session.vt || scrubbing) return;
  const dur = session.vt.duration || 0, pos = pendingSeek != null ? pendingSeek : mediaTime();
  const r = $('pvtseek'); r.max = String(Math.floor(dur)); r.value = String(Math.floor(pos));
  $('pvtpos').textContent = clock(pos); $('pvtdur').textContent = dur ? clock(dur) : '--:--';
}

// ── Sub / Dub ───────────────────────────────────────────────────────────────────
function syncAudioToggle() {
  const b = $('paudiosw'); if (!b) return;
  const on = !!(session.ctx && session.anime && session.anime.anime);
  b.style.display = on ? '' : 'none';
  const p = audioPref(prefs());
  b.innerHTML = `<span class="${p === 'sub' ? 'on' : ''}">Sub</span><span class="${p === 'dub' ? 'on' : ''}">Dub</span>`;
  b.title = 'Anime audio: ' + (p === 'dub' ? 'English dub' : 'Japanese + subtitles') + ' — click to switch';
}
/** Switch the anime audio preference and replay this episode from the anime
    rungs in it, at the same spot. */
function toggleAnimeAudio() {
  const p = prefs(); const next = otherAudio(audioPref(p));
  setPrefs({ animeAudio: next });
  syncAudioToggle();
  toast('Anime audio: ' + (next === 'dub' ? 'Dub (English)' : 'Sub (Japanese + subtitles)'), { id: 'anime-audio' });
  if (!session.ctx || !(session.anime && session.anime.anime)) return;
  const gen = session.gen;
  carryPosition();
  stopVideo();
  session.cur = ''; session.animeState = null;
  session.direct = session.direct.filter(x => x.step !== 'anime');
  buildSources();
  session.steps = ['anime', 'adfree', 'embed']; session.step = 0;
  setLoading(true, 'Switching to ' + (next === 'dub' ? 'the dub' : 'the sub') + '…');
  runLadder(gen);
}
onAction('player-audio', () => toggleAnimeAudio());

// A dead/unsupported link → the next rung (see onSourceFailed).
// Only a moment reaches an embed (VidLink's startAt; the others start at the
// top); a saved resume never has.
function loadFrame(pid) { const p = PROVIDERS.find(x => x[0] === pid); if (!p || !session.ctx) return;
  $('pframe').src = p[2](session.ctx.it.id, session.ctx.kind, session.ctx.s, session.ctx.e, session.momentAt || 0); }
function switchProvider() { selectSource($('psel').value); }

export function closePlayer() {
  const vid = $('pvideo');
  if (session.ctx && mediaTime(vid) > 0) saveProgress(session.ctx, mediaTime(vid), mediaDuration(vid));  // remember where you stopped
  nextGen();          // everything still in flight for this title is now stale
  stopVideo();        // incl. the converter's DELETE and the hls.js engine
  exitPip();
  $('player').classList.remove('open');
  $('pframe').src = 'about:blank'; setBadge(false); setAudioBadge(''); hideUpNext();
  session.ctx = null; session.debrid = []; session.direct = []; session.anime = null; session.animeState = null;
  session.steps = []; session.cur = ''; session.momentAt = null;
  closeSubtitles(); resetSkip(); syncAudioToggle();
  syncPipButton();
}

// ── Live TV + Sports (DaddyLive, proxied through the worker → the extractor) ──
export async function playLive(id, name) {
  stopVideo();
  const gen = nextGen();
  $('ptitle').textContent = name;
  hideUpNext(); setHint(''); setBadge(false); setAudioBadge('');
  session.ctx = null; session.debrid = []; session.direct = []; session.anime = null; session.steps = []; session.cur = 'live'; session.momentAt = null;
  resetSubtitles(gen, null); resetSkip(); syncAudioToggle();
  $('psel').innerHTML = '<option>Live</option>';
  const f0 = $('pframe'); f0.src = 'about:blank'; f0.style.display = 'none';
  const v = $('pvideo'); v.style.display = '';
  $('player').classList.add('open');
  syncPipButton();
  setLoading(true, 'Connecting to ' + name + '…');
  try { const j = await liveResolve(id);
    if (!isCurrentGen(gen)) return;
    if (!j.play) throw 0;
    subtitlesSource(gen, { mode: playHls(v, j.play, { onReady: watchHls }) }); }
  catch { if (isCurrentGen(gen)) { setLoading(false); setHint('Couldn\'t start that channel — try another.'); } }
}

/* ── Fullscreen ───────────────────────────────────────────────────────────────
   There was no fullscreen control of our own, so it depended entirely on
   whichever player happened to be inside: the <video> tag's native controls on
   the debrid/ad-free path, and the provider's own button on the embed path —
   which is unreachable while an embed is still loading or sitting on an ad.

   Fullscreen the STAGE, not the video: the stage holds both the <video> and the
   iframe, so one control covers both paths. iPhone is the exception — it refuses
   fullscreen for arbitrary elements and only allows it on the media element
   itself, so fall back to webkitEnterFullscreen when the video is the visible
   path. If neither exists there is nothing honest to do but say so. */
export function fsActive() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
export function toggleFullscreen() {
  if (fsActive()) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) try { exit.call(document); } catch (_) {}
    return;
  }
  const st = document.querySelector('#player .stage');
  const v = $('pvideo');
  // Only the media element can go fullscreen on iPhone, and only when it is the
  // visible path (the debrid / ad-free tiers) — never for an embed iframe.
  const viaVideo = () => {
    if (v && v.style.display !== 'none' && v.webkitEnterFullscreen) {
      try { v.webkitEnterFullscreen(); return true; } catch (_) {}
    }
    return false;
  };
  const denied = () => { if (!viaVideo()) setHint('This browser blocked fullscreen — use the player\'s own control.'); };

  if (st && st.requestFullscreen) {
    // The rejection MUST be handled, not swallowed. Element fullscreen is
    // refused outright by iPhone Safari and by embedded webviews with no window
    // manager (observed: "TypeError: Permissions check failed" while every
    // capability check — fullscreenEnabled, featurePolicy — still reported
    // true). A bare .catch(()=>{}) turns all of that into a button that looks
    // broken, so fall through to the media element and then say so.
    st.requestFullscreen().catch(denied);
    return;
  }
  if (st && st.webkitRequestFullscreen) { try { st.webkitRequestFullscreen(); return; } catch (_) {} }
  if (viaVideo()) return;
  denied();
}
function syncFsButton() {
  const b = $('pfs'); if (!b) return;
  b.textContent = fsActive() ? '⛶ Exit' : '⛶ Fullscreen';
}

/* ── Picture in Picture ───────────────────────────────────────────────────────
   Only for the <video> path: an embed iframe's video belongs to another origin
   and cannot be put in PiP from here. Standard API first, then Safari's
   presentation-mode API (older iOS). The button is hidden whenever neither
   applies, so it never appears as a control that does nothing — and always on
   phones (overlays.css): the bar has no room, and phone browsers put PiP in
   their own video controls. */
function pipCapable(v) {
  if (!v) return false;
  if (document.pictureInPictureEnabled && typeof v.requestPictureInPicture === 'function' && !v.disablePictureInPicture) return true;
  return typeof v.webkitSupportsPresentationMode === 'function' && v.webkitSupportsPresentationMode('picture-in-picture');
}
function pipActive(v) {
  return !!(document.pictureInPictureElement || (v && v.webkitPresentationMode === 'picture-in-picture'));
}
export function syncPipButton() {
  const b = $('ppip'); if (!b) return;
  const v = $('pvideo');
  b.style.display = (isPlayerOpen() && videoVisible() && pipCapable(v)) ? '' : 'none';
}
export async function togglePip() {
  const v = $('pvideo');
  if (!videoVisible() || !pipCapable(v)) return;
  try {
    if (pipActive(v)) { await exitPip(); return; }
    if (typeof v.requestPictureInPicture === 'function' && document.pictureInPictureEnabled) await v.requestPictureInPicture();
    else v.webkitSetPresentationMode('picture-in-picture');
  } catch (_) {
    // Typically: no frames decoded yet (InvalidStateError), or no user gesture.
    toast('Picture in Picture isn\'t available until the video is playing.', { id: 'pip' });
  }
}
async function exitPip() {
  const v = $('pvideo');
  try {
    if (document.pictureInPictureElement && document.exitPictureInPicture) await document.exitPictureInPicture();
    else if (v && v.webkitPresentationMode === 'picture-in-picture') v.webkitSetPresentationMode('inline');
  } catch (_) {}
}


// ── Keyboard ────────────────────────────────────────────────────────────────────
/* Captions hook: 'c' calls the registered handler with the visible <video>
   (null on an embed, whose captions live inside the provider's player), the
   title context and the hls.js instance. initPlayer registers the captions
   menu (subtitles.js); setCaptionsHandler() can still replace it. The
   fallback just toggles any text tracks the stream already exposes. */
function defaultCaptions({ video }) {
  if (!video) return;
  const tracks = Array.from(video.textTracks || []).filter(t => t.kind === 'subtitles' || t.kind === 'captions');
  if (!tracks.length) { toast('No captions on this source', { id: 'captions' }); return; }
  const on = tracks.some(t => t.mode === 'showing');
  tracks.forEach((t, i) => { t.mode = (!on && i === 0) ? 'showing' : 'disabled'; });
  toast(on ? 'Captions off' : 'Captions on', { id: 'captions' });
}
let captionsHandler = defaultCaptions;
export function setCaptionsHandler(fn) { captionsHandler = typeof fn === 'function' ? fn : defaultCaptions; }

function seekBy(d) { seekTo((pendingSeek != null ? pendingSeek : mediaTime()) + d); }

/** Player shortcuts. Called by keys.js only while the player is open and focus
    is not in a text field. Returns true when the key was handled.
      space / k  play-pause        ← / j  back 10 s      → / l  forward 10 s
      f  fullscreen                m  mute               c  captions menu
      s  skip intro / outro
    (Esc is global: see keys.js.) Embeds get only f and c — their playback lives
    in another origin's frame. */
export function handlePlayerKey(e) {
  const k = e.key;
  if (k === 'f' || k === 'F') { if (!e.repeat) toggleFullscreen(); return true; }
  if (k === 'c' || k === 'C') {
    if (!e.repeat) captionsHandler({ video: videoVisible() ? $('pvideo') : null, ctx: session.ctx, hls: hlsInstance() });
    return true;
  }
  if (!videoVisible()) return false;
  const v = $('pvideo');
  switch (k) {
    case ' ': case 'Spacebar': case 'k': case 'K':
      if (!e.repeat) { if (v.paused || v.ended) v.play().catch(() => {}); else v.pause(); }
      return true;
    case 'ArrowLeft': case 'j': case 'J': seekBy(-10); return true;
    case 'ArrowRight': case 'l': case 'L': seekBy(10); return true;
    case 'm': case 'M': if (!e.repeat) v.muted = !v.muted; return true;
    case 's': case 'S': return e.repeat ? true : skipNow();
  }
  return false;
}

// ── Wiring ──────────────────────────────────────────────────────────────────────
onAction('player-close', () => closePlayer());
onAction('player-fullscreen', () => toggleFullscreen());
onAction('player-pip', () => togglePip());

/* The controls this wave added are created here rather than in index.html
   (a shared file): the SUB/DUB badge and the Sub|Dub switch in the bar; the
   CC button, its menu, the caption overlay and the skip button on the stage
   (so they stay reachable in stage fullscreen); the converter's position bar
   under it. */
function ensureChrome() {
  if ($('pcc')) return;
  const badge = $('pbadge');
  if (badge) badge.insertAdjacentHTML('afterend',
    '<span class="pbadge paudio" id="paudio" style="display:none"></span>' +
    '<button class="x paudiosw" id="paudiosw" data-act="player-audio" style="display:none"></button>');
  const stage = document.querySelector('#player .stage');
  if (stage) {
    stage.insertAdjacentHTML('beforeend',
      '<div class="psubs" id="psubs"></div>' +
      '<button class="pcc" id="pcc" data-act="player-cc" title="Subtitles (c)" style="display:none">CC</button>' +
      '<div class="pccmenu" id="pccmenu" role="menu" aria-label="Subtitles"></div>' +
      '<button class="pskip" id="pskip" data-act="player-skip" title="Skip (s)"></button>');
    stage.insertAdjacentHTML('afterend',
      '<div class="pvtbar" id="pvtbar" style="display:none"><span id="pvtpos">0:00</span>' +
      '<input type="range" id="pvtseek" min="0" max="0" step="1" value="0" aria-label="Position">' +
      '<span id="pvtdur">--:--</span></div>');
  }
}

export function initPlayer() {
  ensureChrome();
  initSubtitles();
  initSkip(seekTo);
  setCaptionsHandler(captionsKey);
  document.addEventListener('fullscreenchange', syncFsButton);
  document.addEventListener('webkitfullscreenchange', syncFsButton);
  // Wire the <video> once: throttled progress saves + autoplay-next at end.
  const v = $('pvideo');
  if (v) {
    v.addEventListener('timeupdate', () => {
      if (session.vt) updateVtBar();
      if (progTick) return;
      progTick = setTimeout(() => { progTick = null; saveProgress(session.ctx, mediaTime(v), mediaDuration(v)); }, 5000);
    });
    // In a Watch Party the room picks what's next (party/bind.js holdsEnd).
    v.addEventListener('ended', () => { if (!(session.party && session.party.holdsEnd())) autoNext(play); });
    // PiP can also be entered/left from the browser's own controls.
    v.addEventListener('enterpictureinpicture', syncPipButton);
    v.addEventListener('leavepictureinpicture', syncPipButton);
  }
  const r = $('pvtseek');
  if (r) {
    r.addEventListener('input', () => { scrubbing = true; $('pvtpos').textContent = clock(+r.value); });
    r.addEventListener('change', () => { scrubbing = false; seekTo(+r.value); });
  }
  $('psel').addEventListener('change', switchProvider);
  // Leaving the page mid-remux frees the Mac's one converter slot.
  window.addEventListener('pagehide', () => { if (session.vt) vtClose(session.vt); });
}
