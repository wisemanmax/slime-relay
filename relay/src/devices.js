// Per-device tokens on the relay (Wave 8, F1a; roadmap F1, PLAN-TO-9 Phase 8,
// THREAT-MODEL "Open: per-device extractor tokens").
//
// A device enrols ONCE: the owner issues a one-time invite code (dashboard, or
// an admin phone with the admin token), the device presents it with the
// household token and gets its own token, which the apps keep in the Keychain.
// The relay accepts that token wherever it accepts USER_TOKEN; the dashboard
// lists devices with last-seen and Revoke; revoked tokens are refused within a
// minute — here and, through the /register reply, on every extractor.
// Contract: Wave 8 contracts.md §1. The registry is the DeviceRegistry Durable
// Object (strongly consistent; KV is not, ~60 s), bound as DEVICES.
//
// Exports used by worker.js (scaffold lines — keep the names and shapes):
//   userAuth(env, provided, pathname) -> Promise<boolean>   is this the user role?
//   deviceFleetBlock(env, registerBody) -> Promise<{} | { tokens }>   merged into /register's reply
//   handleDevices(request, env, ctx) -> Promise<Response>   /devices/*, /admin/devices*
//   devicesPanelHTML() / devicesPanelScript() -> string     the dashboard's Devices section
//   class DeviceRegistry                                    the Durable Object
//
// TODO(W8-F1a): everything below is today's behaviour (USER_TOKEN only, no
// routes, no panel) so the scaffold changes nothing.

export async function userAuth(env, provided, pathname) {
  void pathname;
  return !!env.USER_TOKEN && provided === env.USER_TOKEN;
}

export async function deviceFleetBlock(env, registerBody) {
  void env; void registerBody;
  return {};
}

export async function handleDevices(request, env, ctx) {
  void request; void env;
  return ctx.json({ error: 'not found' }, 404);
}

export function devicesPanelHTML() { return ''; }
export function devicesPanelScript() { return ''; }

export class DeviceRegistry {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch() {
    return new Response(JSON.stringify({ error: 'not implemented' }), {
      status: 501, headers: { 'content-type': 'application/json' },
    });
  }
}
