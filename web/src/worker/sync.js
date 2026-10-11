// Personal sync — the owner's state in KV, so laptop and phone agree.
//
//   GET  /api/state          -> 200 { rev, updatedAt, data: { list, continue, prefs, reading, tombs } }
//   PUT  /api/state          body { baseRev, patch: { <any of those keys> } }
//                            -> 200 { rev, updatedAt, data }   merged (rev unchanged when nothing changed)
//                            -> 409 { error:'stale', rev, updatedAt, data }   baseRev isn't the current
//                               rev: merge `data` locally and PUT again with the new rev
//                            -> 400 bad-json | bad-patch | bad-<key>    -> 413 too-large (256 KB)
//   GET  /api/state/health   -> 200 { build, sync, ask, extractor: { base, ok, status?, ms, error? } }
//   Without the STATE KV binding /api/state answers 503 { error:'sync-not-configured' } and
//   the client quietly stays local.
//
// Merge rules live in src/app/sync.js (mergeData), shared with the client so
// both sides merge identically. Everything here sits behind the password gate
// (modules dispatch after auth). One owner, one KV key.
//
// KV is eventually consistent across locations (~60 s). The rev check catches
// a stale writer in the same location; across locations a write can be lost
// until that device's next change or boot re-sends it (it always merges its
// local copy in and uploads the difference), so state converges.
import { mergeData, validatePatch, emptyData, sameValue, SYNC_PATH } from '../app/sync.js';
import { BUILD_ID } from '../generated/page.js';

export const STATE_KEY = 'owner-state:v1';
export const MAX_STATE_BYTES = 256 * 1024;
const enc = new TextEncoder();
const bytes = (s) => enc.encode(s).length;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export async function loadState(env) {
  let v = null;
  try { v = await env.STATE.get(STATE_KEY, 'json'); } catch {}
  if (!v || typeof v !== 'object' || !v.data) return { rev: 0, updatedAt: 0, data: emptyData() };
  return { rev: Number(v.rev) || 0, updatedAt: Number(v.updatedAt) || 0, data: mergeData(emptyData(), v.data, { now: Date.now() }) };
}

export async function syncRoutes(request, env, url) {
  if (url.pathname === SYNC_PATH + '/health') {
    if (request.method !== 'GET') return json({ error: 'method-not-allowed' }, 405);
    return health(env);
  }
  if (url.pathname !== SYNC_PATH) return null;
  if (!env.STATE) return json({ error: 'sync-not-configured' }, 503);
  if (request.method === 'GET') return json(await loadState(env));
  if (request.method !== 'PUT') return json({ error: 'method-not-allowed' }, 405);

  if (Number(request.headers.get('content-length') || 0) > MAX_STATE_BYTES) return json({ error: 'too-large', limit: MAX_STATE_BYTES }, 413);
  const text = await request.text();
  if (bytes(text) > MAX_STATE_BYTES) return json({ error: 'too-large', limit: MAX_STATE_BYTES }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return json({ error: 'bad-json' }, 400); }
  const v = validatePatch(body && body.patch);
  if (v.error) return json({ error: v.error }, 400);

  const cur = await loadState(env);
  if (!body || body.baseRev !== cur.rev) return json({ error: 'stale', ...cur }, 409);

  const now = Date.now();
  const data = mergeData(cur.data, v.patch, { now });
  if (sameValue(data, cur.data)) return json(cur);        // nothing new: no KV write (writes are metered)
  const next = { rev: cur.rev + 1, updatedAt: now, data };
  const out = JSON.stringify(next);
  if (bytes(out) > MAX_STATE_BYTES) return json({ error: 'too-large', limit: MAX_STATE_BYTES }, 413);
  await env.STATE.put(STATE_KEY, out);
  return json(next);
}

/* Settings' status block: the deployed build, whether sync/Ask are configured,
   and whether the home extractor answers. /health on the extractor is open and
   answers exactly "ok" (503 + JSON while it drains); no token is sent. */
async function health(env) {
  const base = String(env.EXTRACTOR_BASE || '').replace(/\/+$/, '');
  const out = { build: BUILD_ID, sync: !!env.STATE, ask: !!env.SLIME_TOKEN, extractor: { base, ok: false } };
  if (base) {
    const t0 = Date.now();
    try {
      const r = await fetch(base + '/health', { signal: AbortSignal.timeout(6000), headers: { accept: 'text/plain' } });
      const text = (await r.text()).slice(0, 200).trim();
      out.extractor = { base, ok: r.status === 200 && text === 'ok', status: r.status, ms: Date.now() - t0 };
      if (r.status === 503) out.extractor.error = 'draining';
    } catch (e) {
      out.extractor = { base, ok: false, ms: Date.now() - t0, error: e && e.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
    }
  }
  return json(out);
}
