// Route modules behind the password gate. Each feature wave adds ONE line here
// and owns its own file under src/worker/, so three agents never edit worker.js
// at once. A module exports `async function handle(request, env, url, ctx)` and
// returns a Response, or null to pass the request on. Order matters only when
// two modules claim the same path, which they must not.
import { readingRoutes } from './reading.js';   // W4
import { syncRoutes } from './sync.js';         // W3
import { askRoutes } from './ask.js';           // W3
import { playerRoutes } from './player.js';     // W2

export const ROUTE_MODULES = [
  { prefix: '/api/player/', handle: playerRoutes },     // W2
  { prefix: '/api/state',   handle: syncRoutes },     // W3 (/api/state, /api/state/health)
  { prefix: '/api/ask',     handle: askRoutes },      // W3
  { prefix: '/api/read/', handle: readingRoutes }, { prefix: '/api/comic/', handle: readingRoutes },  // W4
];

export async function dispatch(request, env, url, ctx) {
  for (const m of ROUTE_MODULES) {
    if (!url.pathname.startsWith(m.prefix)) continue;
    const r = await m.handle(request, env, url, ctx);
    if (r) return r;
  }
  return null;
}
