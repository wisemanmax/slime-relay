// "Ask" — the apps' assistant, for the web. The relay's POST /assist holds the
// model key, the system prompt and the tool list; the browser holds the
// conversation and runs the tools against TMDB (src/app/ask.js). This route is
// only the authenticated hop: it adds the app token (SLIME_TOKEN, the relay's
// USER_TOKEN) server-side, so it never reaches the page.
//
//   POST /api/ask   body { messages:[…], history:bool }   (exactly the relay's /assist body)
//     -> the relay's answer, status passed through:
//        200 { message, finish_reason, prompt_version }
//        400 bad messages · 413 too large · 429 { error:'rate limited' | 'daily limit' }
//        502 assistant error / unreachable · 503 not configured
//     -> 504 { error:'ask-timeout' } after 20 s; 502 { error:'ask-unreachable' }
//     -> 502 { error:'ask-unauthorized' } when the relay refuses the token (never a
//        401: the page must not read it as its own session expiring)
//
// The relay is reached through the RELAY service binding when one is
// configured (Worker-to-Worker, no public hop — a fetch between two workers.dev
// hosts can be refused with error 1042), else by URL (RELAY_BASE).
const RELAY_DEFAULT = 'https://slime-relay.byheirw.workers.dev';
const MAX_BODY = 64000;          // the relay's own cap
const TIMEOUT_MS = 20000;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export async function askRoutes(request, env, url) {
  if (url.pathname !== '/api/ask') return null;
  if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405);
  if (!env.SLIME_TOKEN) return json({ error: 'ask-not-configured' }, 503);

  const text = await request.text();
  if (text.length > MAX_BODY) return json({ error: 'too large' }, 413);
  try { const b = JSON.parse(text); if (!b || !Array.isArray(b.messages)) throw 0; }
  catch { return json({ error: 'bad messages' }, 400); }

  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.SLIME_TOKEN}` },
    body: text,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };
  let r;
  try {
    r = env.RELAY && typeof env.RELAY.fetch === 'function'
      ? await env.RELAY.fetch(new Request('https://relay.internal/assist', init))
      : await fetch(String(env.RELAY_BASE || RELAY_DEFAULT).replace(/\/+$/, '') + '/assist', init);
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return json({ error: timeout ? 'ask-timeout' : 'ask-unreachable' }, timeout ? 504 : 502);
  }
  if (r.status === 401 || r.status === 403) return json({ error: 'ask-unauthorized' }, 502);
  const body = await r.text().catch(() => '');
  let parsed = null;
  try { parsed = JSON.parse(body); } catch {}
  if (!parsed || typeof parsed !== 'object') return json({ error: 'assistant error ' + r.status }, 502);
  return json(parsed, r.status);
}
