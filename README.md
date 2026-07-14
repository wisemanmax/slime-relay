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
- Put the base URL (no `?key`) into each server's `RELAY_URL` and into the app.

Prefer to do it by hand? See **[INSTRUCTIONS.md](INSTRUCTIONS.md)**.

---

## 3. Point the app at it

On the Apple TV: **SlimeWatch → Settings → Relay** → paste your relay URL. The app
streams through whichever server is reachable + least busy, and fails over
automatically. Leave **Settings → Admin** blank to stream as a normal user; enter
your `ADMIN_TOKEN` there to see and control the fleet from the app too.

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
