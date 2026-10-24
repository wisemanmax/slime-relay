// Wave 7 (P5, roadmap 7.4) — Watch Party routes behind the password gate:
//   GET /api/party/<CODE>[?avatars=1]  the relay's peek (GET /party/<CODE>; ?avatars=1
//                                      passes through, so the join page shows photos)
//                                      -> the relay's status + JSON; x-web-build: this build
//   GET /api/party/<CODE>/ws           WebSocket upgrade, proxied to the relay's
//                                      /party/<CODE>/ws with the relay token added;
//                                      the relay's answer (101 + socket) returned as is
// The relay is reached through the RELAY service binding (ask.js's pattern:
// Worker-to-Worker, no public hop), else RELAY_BASE. The token (SLIME_TOKEN, the
// relay's USER_TOKEN) is added here and never reaches the page; the site cookie
// is never forwarded. cf-connecting-ip rides along so the relay's per-IP limits
// see the visitor, not this Worker.
//
// Errors: 400 bad code · 405 method · 426 not an upgrade · 403 a cross-site
// upgrade · 503 not configured · 502 { error:'party-unreachable' |
// 'party-unauthorized' } (never a 401: the page must not read it as its own
// session expiring) · 504 timeout. Everything else is the relay's own status.
import { BUILD_ID } from '../generated/page.js';

const RELAY_DEFAULT = 'https://slime-relay.byheirw.workers.dev';
const PEEK_TIMEOUT_MS = 10000;
const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
// Headers a WebSocket handshake needs end to end; nothing else of the browser's goes on.
const WS_HEADERS = ['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol',
  'sec-websocket-extensions', 'user-agent', 'origin', 'cf-connecting-ip'];

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-web-build': BUILD_ID },
  });
}

/** fetch on the relay: the service binding when there is one, else by URL. */
function relayFetch(env, path, init) {
  if (env.RELAY && typeof env.RELAY.fetch === 'function') return env.RELAY.fetch(new Request('https://relay.internal' + path, init));
  return fetch(String(env.RELAY_BASE || RELAY_DEFAULT).replace(/\/+$/, '') + path, init);
}

export async function partyRoutes(request, env, url) {
  const m = url.pathname.match(/^\/api\/party\/([^/]+)(\/ws)?\/?$/);
  if (!m) return json({ error: 'not-found' }, 404);
  const code = m[1].toUpperCase();
  if (!CODE_RE.test(code)) return json({ error: 'bad-code' }, 400);
  if (request.method !== 'GET') return json({ error: 'method-not-allowed' }, 405);
  if (!env.SLIME_TOKEN) return json({ error: 'party-not-configured' }, 503);
  return m[2] ? socket(request, env, url, code) : peek(request, env, url, code);
}

async function peek(request, env, url, code) {
  const headers = { authorization: `Bearer ${env.SLIME_TOKEN}`, accept: 'application/json' };
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) headers['cf-connecting-ip'] = ip;
  const q = url.searchParams.get('avatars') === '1' ? '?avatars=1' : '';
  let r;
  try {
    r = await relayFetch(env, `/party/${code}${q}`, { headers, signal: AbortSignal.timeout(PEEK_TIMEOUT_MS) });
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return json({ error: timeout ? 'party-timeout' : 'party-unreachable' }, timeout ? 504 : 502);
  }
  if (r.status === 401 || r.status === 403) return json({ error: 'party-unauthorized' }, 502);
  let body = null;
  try { body = JSON.parse(await r.text()); } catch {}
  if (!body || typeof body !== 'object') return json({ error: 'party-unreachable' }, 502);
  return json(body, r.status);
}

function socket(request, env, url, code) {
  if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') return json({ error: 'expected-websocket' }, 426);
  // A WebSocket handshake carries the cookie but no CORS check: refuse another
  // site's page opening this one's room socket (SameSite=Lax already withholds
  // the cookie cross-site; this keeps it true whatever the cookie says).
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return json({ error: 'cross-site' }, 403);
  const headers = new Headers();
  for (const k of WS_HEADERS) { const v = request.headers.get(k); if (v) headers.set(k, v); }
  headers.set('authorization', `Bearer ${env.SLIME_TOKEN}`);
  return relayFetch(env, `/party/${code}/ws`, { method: 'GET', headers })
    .catch(() => json({ error: 'party-unreachable' }, 502));
}
