/* Wave 7 (P5, roadmap 7.4) — the web's room socket: connect through this
   Worker's /api/party/<code>/ws (the Worker adds the relay token), hello,
   ping/pong clock offset, reconnect with backoff, and the room mirror.
   TODO(W7-P5). */

export function createPartyClient() {
  return { connect() {}, send() {}, close() {} };   // TODO(W7-P5)
}
