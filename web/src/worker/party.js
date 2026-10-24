// Wave 7 (P5, roadmap 7.4) — Watch Party routes behind the password gate:
//   GET /api/party/<CODE>            the relay's peek (?avatars=1 passes through)
//   GET /api/party/<CODE>/ws         WebSocket upgrade, proxied to the relay's
//                                    /party/<CODE>/ws with the relay token added
// The relay is reached through the RELAY service binding (ask.js's pattern),
// else RELAY_BASE. The token never reaches the page.
// TODO(W7-P5): returns null (pass) until P5 lands, so /api/party/* falls
// through to the app page exactly as before.

export async function partyRoutes(request, env, url, ctx) {
  void request; void env; void url; void ctx;
  return null;
}
