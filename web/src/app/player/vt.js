/* The /vt converter on the web: a debrid mkv/avi the browser can't play is
   remuxed by the extractor (the home Mac) into a rolling fMP4 HLS — H.264
   video copied, audio copied or made AAC — which hls.js / Safari then play.
   Contract: SlimeWatchExtractor/vt.js + docs/DEBRID-CONVERTER-PLAN.md;
   client rules from ConverterClient.swift.

     open   POST /api/player/vt/sessions {url, start, audio} -> {id, play, epoch, duration, actualStart}
            429 = the Mac is already converting (ONE job at a time) — never retried
            502 = this file can't be remuxed (HEVC, 10-bit, no video…) — next source
     seek   POST …/<id>/seek {start} — restarts generation at `start` (a new epoch,
            a new playlist URL); only for targets outside the generated window
     close  DELETE …/<id> — frees the Mac's one slot

   The playlist is LIVE-shaped (no future segments), so the element's own
   clock is local to the epoch: absolute = baseOffset + currentTime, and the
   length is the probe duration. The play URL is on the extractor and carries
   a per-session capability, never the extractor token. */

import { vtOpenRequest, vtSeekRequest, vtCloseRequest } from './playerapi.js';

/** A failed open/seek -> what the ladder does: 'busy' (skip every remux),
    'unsupported' (skip this file), 'unavailable' (no extractor: skip every
    remux), 'failed' (skip this file). Pure. */
export function vtFailure(status) {
  if (status === 429) return 'busy';
  if (status === 502) return 'unsupported';
  // 503 not configured / extractor refused the token, 504 unreachable or timed
  // out, 0 the request itself failed — no point asking for the next file.
  if (status === 503 || status === 504 || status === 0) return 'unavailable';
  return 'failed';   // 422: the extractor refused this source (bad / blocked URL)
}

/** The viewer's words for a failure. */
export function vtWhy(kind) {
  if (kind === 'busy') return 'Your Mac is converting another file right now';
  if (kind === 'unsupported') return 'That file can\'t be converted for the browser (not H.264)';
  if (kind === 'unavailable') return 'Your Mac isn\'t reachable to convert it';
  return 'Converting that file didn\'t work';
}

/** A seek to absolute `target` given the epoch's base offset and the local
    window the element can already reach ({start, end} or null):
    -> {local: t} (just move the playhead) | {server: target} (new epoch). Pure. */
export function vtSeekPlan(target, baseOffset, win) {
  const t = Math.max(0, target);
  const local = t - (baseOffset || 0);
  if (win && local >= win.start - 0.5 && local <= win.end - 0.5) return { local: Math.max(win.start, local) };
  return { server: t };
}

/** The element's reachable window, from its seekable ranges. */
export function vtWindow(v) {
  const sk = v && v.seekable;
  if (!sk || !sk.length) return null;
  return { start: sk.start(0), end: sk.end(sk.length - 1) };
}

/** -> {ok:true, session:{id, play, epoch, duration, baseOffset}} | {ok:false, kind, status} */
export async function vtOpen(url, start, audio) {
  const r = await vtOpenRequest(url, Math.max(0, start || 0), audio);
  const b = r.body || {};
  if (r.ok && b.id && typeof b.play === 'string') {
    return { ok: true, session: { id: b.id, play: b.play, epoch: b.epoch || 1, duration: +b.duration || 0, baseOffset: Number.isFinite(+b.actualStart) ? +b.actualStart : (start || 0) } };
  }
  return { ok: false, kind: vtFailure(r.status), status: r.status, error: b.error || '' };
}

/** -> the new epoch ({play, epoch, baseOffset}) or null (keep playing what's there). */
export async function vtSeek(sess, target) {
  const r = await vtSeekRequest(sess.id, Math.max(0, target));
  const b = r.body || {};
  if (!r.ok || typeof b.play !== 'string') return null;
  return { play: b.play, epoch: b.epoch || sess.epoch + 1, baseOffset: Number.isFinite(+b.actualStart) ? +b.actualStart : target };
}

export function vtClose(sess) { if (sess && sess.id) vtCloseRequest(sess.id); }
