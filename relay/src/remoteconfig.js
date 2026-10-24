// Remote config on the relay (Wave 8, F6a; roadmap F6, TELEMETRY-AUTOFIX-SPEC
// phase 3): the owner's dashboard publishes `forceVLCFor` rules under a
// monotonic configVersion, canaries a config to one or a few devices, promotes
// it, and rolls back in one tap; each extractor heartbeat's /register reply
// carries the result as `config`, and the apps read it from the extractor's
// token-gated /manifest (never from the relay). Contract: Wave 8 contracts.md §3.
// Storage: KV key `rc:doc` (not time-critical; KV's ~60 s is fine here).
//
// Exports used by worker.js (scaffold lines — keep the names and shapes):
//   handleRemoteConfig(request, env, ctx) -> Promise<Response>   /admin/config*
//   configFleetBlock(env) -> Promise<{} | { config }>            merged into /register's reply
//   configPanelHTML() / configPanelScript() -> string            the dashboard's Remote fixes section
//
// TODO(W8-F6a): everything below answers "nothing" so the scaffold changes nothing.

export async function handleRemoteConfig(request, env, ctx) {
  void request; void env;
  return ctx.json({ error: 'not found' }, 404);
}

export async function configFleetBlock(env) {
  void env;
  return {};
}

export function configPanelHTML() { return ''; }
export function configPanelScript() { return ''; }
