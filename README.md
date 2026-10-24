# SlimeRelay

A tiny fleet system for **SlimeWatch** stream servers. Run the extractor on as
many machines as you like (macOS, Windows, or Linux); each one registers with a
central **relay**, and a live **dashboard** shows every connected machine and its
load. The SlimeWatch app asks the relay which servers are up and streams through
the best one — spreading load across the whole fleet and failing over if one drops.

```
  ┌─────────────┐  heartbeat   ┌──────────────────────┐   dashboard + controls
  │  extractor  │ ───────────▶ │      SlimeRelay      │ ◀───────────  you (admin)
  │  (Mac #1)   │              │ (Cloudflare Worker)  │
  └─────────────┘              │   • /register        │   /route (bare list)
  ┌─────────────┐  heartbeat   │   • /route  /servers │ ◀───────────  SlimeWatch app
  │  extractor  │ ───────────▶ │   • dashboard  (/)   │
  │ (Windows)   │              └──────────────────────┘
  └─────────────┘
```

- **`server/`** — the extractor. Node + Playwright, cross-platform. Turns a title
  into a playable stream and heartbeats to the relay.
- **`relay/`** — the Cloudflare Worker: registry, routing, and dashboard. Always-on, free.

---

## Three tokens (roles)

| Token | Who has it | What it unlocks |
|---|---|---|
| **`USER_TOKEN`** (the *app/streaming* token) | every server (as `SLIME_TOKEN`) + the app (baked in) | streaming + routing (`/route`), presence |
| **`FLEET_TOKEN`** (server-only registration) | the relay + every server (never the app) | `/register` — the credential a server uses to join the fleet |
| **`ADMIN_TOKEN`** | just you | the dashboard, the full fleet (names/addresses/load), and routing controls (disable / prefer a server) |

Regular users are routed to a server automatically but never see the fleet.
The **app/streaming token is the same value** as each server's `SLIME_TOKEN`
(`SLIME_TOKEN` = `USER_TOKEN`) — pick it once and reuse it everywhere. The
**registration token is a separate value**: the owner sets it on the relay with
`wrangler secret put FLEET_TOKEN` and shares that SAME value with each server (in
its `.env` as `FLEET_TOKEN`), so the app's baked-in token can't register or
overwrite servers. Generate tokens with `openssl rand -hex 20`.

---

> **Prefer not to run a server at all?** Point users at **Debrid** instead — a
> ~$3/mo debrid account gives the best quality with nothing to install (the app
> tries debrid first and falls back to the fleet). Setup: **[DEBRID.md](DEBRID.md)**.

## 1. Run a server (macOS / Windows / Linux)

> **Just joining a friend's fleet?** You only do this step — see **[JOIN.md](JOIN.md)**.
> On Windows the easiest path is to double-click **`SlimeWatch-Server.cmd`** (it
> installs Node + deps, configures, and starts). Fleet owners can hand friends a
> ready-to-run package with `server/make-friend-installer.sh <RELAY_URL> <APP_TOKEN> <FLEET_TOKEN> <name>`
> — the friend then answers nothing.

**Prerequisite:** [Node.js 18+](https://nodejs.org).

```bash
cd server
npm install          # also downloads the Chromium that Playwright needs
npm run setup        # guided: asks for your token + relay URL, writes .env
npm run doctor       # verifies Node, Chromium, token, relay, and your address
npm start            # or ./start.sh   (Windows: double-click start.bat)
```

That's the whole thing. `setup` writes `.env` for you; `doctor` tells you — in
plain English with the exact fix — if anything's off *before* you start. You
should then see `SlimeWatch extractor on http://0.0.0.0:8787` and, if a relay is
configured, `[heartbeat] … -> <relay>` — and the machine appears on the dashboard.

> **Reaching servers across networks — use [Tailscale](https://tailscale.com) (free).**
> The Apple TV must be able to reach each server's advertised address. On one home
> network that's automatic. Across homes, put the **Apple TV and every server** on
> **Tailscale** (free Personal plan: 6 users, unlimited devices; it has a native
> Apple TV app, tvOS 17+). Each server then auto-advertises its Tailscale IP.
> No port-forwarding. (NordVPN Meshnet is *not* an option — it was shut down in
> Dec 2025 and never supported Apple TV.)

---

## 2. Deploy the relay (once)

The relay is a free, always-on Cloudflare Worker. You need a (free) Cloudflare account.

```bash
cd relay
./deploy.sh <USER_TOKEN> <FLEET_TOKEN>        # Windows: ./deploy.ps1 <USER_TOKEN> <FLEET_TOKEN>
```

One command: it installs wrangler, opens the browser to log in, creates the KV
store, sets `USER_TOKEN` (app/streaming), sets `FLEET_TOKEN` (server-only
registration), generates an `ADMIN_TOKEN` it prints — **save it** — and deploys.
It ends by printing your dashboard URL.

- **Admin dashboard:** `https://…workers.dev/?key=<ADMIN_TOKEN>` — see every server,
  and **Disable / Enable / Prefer** any of them. Changes apply to every device at once.
  Under **Now Watching**, each viewer shows the server it's playing through and a
  **Server** picker for that device alone: *Automatic* or one server (the device
  gets only that server while it's up; if it's down or disabled it falls back to
  the normal list), plus
  **Not my Mac** to keep that device off the server named "Home Mac". A device
  that would be left with no server gets the full list anyway. Changes apply on the
  device's next play; a device's rule is dropped after 30 days without it watching.
- Put the base URL (no `?key`) into each server's `RELAY_URL` and into the app.

Prefer to do it by hand? See **[INSTRUCTIONS.md](INSTRUCTIONS.md)**.

---

## 3. Point the app at it

On the Apple TV: **SlimeWatch → Settings → Relay** → paste your relay URL. The app
streams through whichever server is reachable + least busy, and fails over
automatically. Leave **Settings → Admin** blank to stream as a normal user; enter
your `ADMIN_TOKEN` there to see and control the fleet from the app too.

---

## 4. Devices (per-device tokens)

The household token (`USER_TOKEN` = every server's `SLIME_TOKEN`) is compiled
into every app, so a leak used to mean a rebuild for everyone. Each device can
now **enrol once** and get its own token; the dashboard lists every device and
**Revoke** shuts one out within a minute — on the relay and on every server.

**Enrol a device.** Dashboard → **Devices** → *Add a device* (optionally give it
a label, e.g. "Living room TV"). A one-time code appears large, with a QR of
`slimewatch://enrol?code=…`. On the device: Settings → Advanced (iPhone) or
Connection (Apple TV, Mac) → **Enrol** → type the code; the iPhone can scan the
QR with its camera instead. Codes are 8 characters (no 0/O or 1/I, any case,
with or without the dash), work **once**, for **15 minutes**, and at most 5 can
be open. A wrong, used or expired code gets the same "bad code" answer. The
admin iPhone can issue codes too (`POST /admin/devices/invite` with the admin
token). Enrolling the same device again with a fresh code replaces its token.

**The device list** shows each device's name, kind, app, when it enrolled and
when it was last seen (by the relay or by a server). **Revoke** refuses the
device's token at once on that dashboard's relay instance and everywhere within
a minute (relay answers are cached ≤ 30 s; servers get the new list on their
next 30 s heartbeat); the row stays, greyed. **Forget** removes a revoked row.
A revoked device can come back only with a new code.

**What the relay keeps:** only SHA-256 hashes of device tokens and of invite
codes, in the `DeviceRegistry` Durable Object (one instance, strongly
consistent — KV is not, ~60 s). A token is shown exactly once, in the enrol
reply. Servers receive the live hashes in every `/register` reply (`tokens`),
never a token; an old server ignores the field, an old app keeps using the
household token.

**Deploying it:** the first `wrangler deploy` after this change applies the
Durable Object migration `v2-devices` (in `wrangler.toml`) once — nothing to
run by hand, and nothing changes for shipped apps until they carry enrolment.
Check: `GET /admin/devices` with the admin token → `{"devices":[],"invites":[]}`.

**Locking the household token to enrolment (after the rotation):** once every
device is enrolled and the servers' `SLIME_TOKEN` has been rotated, set
`DEVICE_TOKENS_REQUIRED` to `1` (`printf 1 | npx wrangler secret put
DEVICE_TOKENS_REQUIRED`). From then on `USER_TOKEN` opens **only**
`/devices/enroll` (it stays the enrolment credential compiled into the apps);
`/route`, `/presence`, `/assist` and `/party` want a device token or the admin
token. Make sure `FLEET_TOKEN` is set first: without it `/register` falls back
to the user role, which the household token no longer has (a device token is
never accepted there). Undo: `npx wrangler secret delete DEVICE_TOKENS_REQUIRED`.

| Route | Who | What |
|---|---|---|
| `POST /admin/devices/invite` | admin | `{label?}` → `201 {code, display, link, expiresAt}` |
| `POST /devices/enroll` | household token or admin | `{code, deviceId, name, platform, app}` → `{deviceId, token, name, issuedAt}`; `403 bad-code`; `429` past 10/min per IP |
| `GET /devices/me` | the device token | `{deviceId, name, platform, enrolledAt}`; `401` revoked/unknown; `503` registry unreachable |
| `GET /admin/devices` | admin | `{devices:[…], invites:[{hint, label, expiresAt}]}` |
| `POST /admin/devices/revoke` · `/forget` | admin | `{id}` → `{ok:true}` (forget: revoked devices only) |

---

## Capacity

Each server advertises `capacity` (its `SESSION_CAP`, default 80) and reports live
`load`. Routing sends new sessions to the least-loaded enabled server, so work
spreads out as you add machines. Lower a box's ceiling via `SESSION_CAP` in
`server/server.js`.

## Security

- The fleet token gates the relay and the extractor; the admin token gates control.
  Keep both secret. The extractor **refuses to start** without a token (no open proxy).
- `.env` and `.dev.vars` are gitignored — never commit real tokens.
- Reachability comes from your LAN / mesh VPN, not from port-forwarding.

## Status

- ✅ Cross-platform extractor with guided setup + `doctor` self-check
- ✅ Cloudflare relay + live dashboard with admin routing controls
- ✅ App auto-routes across the whole fleet (reachable + least-loaded, with failover)
- ✅ Each server also serves comics at `/comic/*` (batcave) automatically — no extra setup
- ✅ Per-device tokens: one-time enrolment codes, a device list with last seen, revoke within a minute
