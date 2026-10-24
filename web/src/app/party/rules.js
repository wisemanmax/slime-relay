/* Wave 7 (P5, roadmap 7.4) — the web's Watch Party rules, PURE: no DOM and no
   WebSocket at import (unit-checked from node by test/party.mjs). The room's
   protocol is the relay's (contracts.md § wire format and § web client):
   only TMDB identity and media time cross the wire, the room's clock is an
   anchor (mediaTime at serverTimeAtUpdate, advancing at rate while playing),
   and the web is always an ordinary member — never host, never a companion.

   TODO(W7-P5): everything below except the code check and expectedTime. */

/** Room codes: six characters, no 0/O/1/I (the relay's alphabet). */
export const PARTY_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;

/** The room clock at relay time `serverNowMs` (party-reducer.js expectedTime). */
export function expectedTime(playback, serverNowMs) {
  if (!playback) return 0;
  return playback.mediaTime + (playback.playing ? Math.max(0, serverNowMs - playback.serverTimeAtUpdate) / 1000 * playback.rate : 0);
}

/** Whether this member's play / pause / seek would move the room. */
export function canControl(room, myId) {
  void room; void myId;
  return false;   // TODO(W7-P5): host, or settings.control === 'shared' for an ordinary member
}
