# SlimeRelay

A tiny fleet system for **SlimeWatch** stream servers. Run the extractor on as
many machines as you like (macOS, Windows, or Linux); each one registers with a
central **relay**, and a live **dashboard** shows every connected machine and its
load. The SlimeWatch app then asks the relay which servers are up and streams
through one of them.

```
  ┌─────────────┐  heartbeat   ┌──────────────────────┐   dashboard
  │  extractor  │ ───────────▶ │      SlimeRelay      │ ◀───────────  you (browser)
  │  (Mac #1)   │              │ (Cloudflare Worker)  │
  └─────────────┘              │   • /register        │   /servers
  ┌─────────────┐  heartbeat   │   • /servers  /pick  │ ◀───────────  SlimeWatch app
  │  extractor  │ ───────────▶ │   • dashboard  (/)   │               (Part 2)
  │ (Windows)   │              └──────────────────────┘
  └─────────────┘
```

Repo layout:

- **`server/`** — the extractor. Node + Playwright, cross-platform. Turns a title
  into a playable stream and (optionally) heartbeats to the relay.
- **`relay/`** — the Cloudflare Worker: registry API + dashboard. Always-on, free.

---

## 1. Run a server (macOS / Windows / Linux)

**Prerequisites:** [Node.js 18+](https://nodejs.org).

```bash
cd server
npm install                 # also downloads the Chromium Playwright needs
cp .env.example .env         # then edit .env (see below)
```

Edit `.env`:

| Key              | What it is                                                                 |
|------------------|---------------------------------------------------------------------------|
| `SLIME_TOKEN`    | Shared secret. **Must match** the relay's `RELAY_TOKEN` and the app token. |
| `PORT`           | Port to listen on (default `8787`).                                        |
| `RELAY_URL`      | Your deployed relay, e.g. `https://slime-relay.you.workers.dev`. Blank = standalone. |
| `PUBLIC_ADDRESS` | How the Apple TV/app reaches this box (`http://LAN-or-mesh-IP:8787`). Blank = auto-detect LAN IPv4. |
| `SERVER_NAME`    | Friendly name on the dashboard (default: hostname).                        |

Start it:

- **macOS / Linux:** `./start.sh`  (or `npm start`)
- **Windows:** double-click **`start.bat`**, or `./start.ps1` in PowerShell

You should see `SlimeWatch extractor on http://0.0.0.0:8787` and, if `RELAY_URL`
is set, `[heartbeat] … -> <relay> every 30s`. The machine now appears on the
dashboard.

> **Reaching servers across networks:** the Apple TV must be able to reach each
> server's `PUBLIC_ADDRESS`. On one LAN that's the plain `10.0.0.x` address. To
> use machines on different networks, put them all on the same overlay
> (NordVPN Meshnet, Tailscale, etc.) and set `PUBLIC_ADDRESS` to the mesh IP.

---

## 2. Deploy the relay (once)

The relay is a Cloudflare Worker — free tier, always-on, reachable everywhere.

```bash
cd relay
npm install
npx wrangler login                         # opens the browser once

# create the KV store and paste the printed id into wrangler.toml (SERVERS binding)
npx wrangler kv namespace create SERVERS

# set the shared secret (same value as SLIME_TOKEN on your servers)
npx wrangler secret put RELAY_TOKEN

npm run deploy
```

Wrangler prints your URL, e.g. `https://slime-relay.<your-subdomain>.workers.dev`.

- **Dashboard:** open `https://…workers.dev/?key=YOUR_RELAY_TOKEN`
- **Server list (JSON):** `GET /servers?key=…`
- **Least-loaded pick:** `GET /pick?key=…`

Put that URL into each server's `RELAY_URL`, restart them, and watch them show up.

---

## 3. Throttling / capacity

Each server advertises `capacity` (its `SESSION_CAP`, default 80) and reports
current `load`. The dashboard draws a load bar per machine, and `/pick` returns
the least-loaded live server — so as you add machines, work spreads out and busy
boxes are skipped. Lower a machine's ceiling by editing `SESSION_CAP` in
`server/server.js`.

---

## Security

- The token gates **every** relay route and the extractor itself — keep it secret.
- `.env` is gitignored; never commit real tokens.
- This repo is **private**; share by adding collaborators.
- Reachability is provided by your LAN / mesh VPN, not by port-forwarding.

## Point the Apple TV app at it

On the Apple TV: **SlimeWatch → Settings → Relay** → paste your relay URL →
**Discover servers**. The app then streams through whichever server is
**reachable and least busy** and fails over automatically if one drops. The
single-host field is only used when no relay is set. (Make sure your token
matches the one baked into the app.)

See **[INSTRUCTIONS.md](INSTRUCTIONS.md)** for the full copy-paste walkthrough
and troubleshooting.

## Status

- ✅ Cross-platform extractor with relay heartbeat (macOS / Windows / Linux)
- ✅ Cloudflare relay + live dashboard
- ✅ **App auto-routes to the best server** (reachable + lowest load, with failover)
