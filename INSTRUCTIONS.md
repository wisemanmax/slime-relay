# SlimeRelay — Setup Instructions

Step-by-step, copy-paste friendly. Three parts: **deploy the relay once**, **run
a server on each machine**, then **point the app at the relay**.

Pick ONE secret token up front and use the *same value* everywhere. Generate one:

```bash
openssl rand -hex 20
```

Call this value `TOKEN` below.

---

## Part A — Deploy the relay (once, ~5 min)

The relay is a free Cloudflare Worker. You need a (free) Cloudflare account.

```bash
cd relay
npm install
npx wrangler login                       # opens your browser, click Allow
```

Create the KV store and copy the id it prints:

```bash
npx wrangler kv namespace create SERVERS
# → prints:  id = "abc123..."   ← copy that
```

Open `relay/wrangler.toml` and paste the id in place of `PASTE_KV_NAMESPACE_ID_HERE`.

Set the shared secret (paste your `TOKEN` when prompted):

```bash
npx wrangler secret put RELAY_TOKEN
```

Deploy:

```bash
npm run deploy
# → prints your URL, e.g.  https://slime-relay.yourname.workers.dev
```

Call this URL `RELAY`. Open the dashboard to confirm it's live:

```
https://<RELAY>/?key=<TOKEN>
```

You'll see "0 servers connected" — that's expected until you start one.

---

## Part B — Run a server (each Mac / Windows / Linux box)

Needs [Node 18+](https://nodejs.org).

```bash
cd server
npm install                # also downloads Chromium for Playwright
cp .env.example .env
```

Edit `.env`:

```ini
SLIME_TOKEN=<TOKEN>                       # same token as the relay
PORT=8787
RELAY_URL=https://<RELAY>                 # your relay URL from Part A
PUBLIC_ADDRESS=                           # blank = auto-detect LAN IP (see note)
SERVER_NAME=Living Room Mac               # anything; shows on the dashboard
```

Start it:

| OS            | Command                                             |
|---------------|-----------------------------------------------------|
| macOS / Linux | `./start.sh`  (first time: `chmod +x start.sh`)     |
| Windows       | double-click **`start.bat`** (or `./start.ps1`)     |

Within ~30s it appears on the dashboard. Repeat on every machine you want in the
fleet — each just needs the same `SLIME_TOKEN` and `RELAY_URL`.

---

## Part C — Point the Apple TV app at the relay

On the Apple TV: **SlimeWatch → Settings → Relay** → enter your `RELAY` URL →
**Discover servers**. That's it. The app now streams through whichever server is
**reachable and least busy**, and fails over automatically if one drops.

The app's token is already baked in — just make sure your `TOKEN` matches it
(it's the `token` in `SlimeWatchTV/ExtractorClient.swift`). The single-host field
below the relay is only used when no relay is set or the relay is unreachable.

---

## Networking: reaching servers across different places

The Apple TV must be able to *reach* each server's advertised address:

- **All on one home network?** Nothing to do — leave `PUBLIC_ADDRESS` blank and
  each server advertises its `10.0.0.x` LAN IP.
- **Machines in different places?** Put them all on one overlay network — your
  **NordVPN Meshnet** (or Tailscale) — and set each server's `PUBLIC_ADDRESS` to
  its mesh IP, e.g. `http://100.71.4.9:8787`. The Apple TV (also on the mesh)
  can then reach any of them.

No port-forwarding required.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Dashboard shows "unauthorized" | Add `?key=<TOKEN>` to the URL; make sure it matches `RELAY_TOKEN`. |
| Server never appears | Check the server log for `[heartbeat] … -> <relay>`. If it says "RELAY_URL not set", your `.env` didn't load — run via `start.sh`/`start.bat`, not bare `node`. |
| Appears then vanishes | Heartbeats stop → server crashed or lost network. It auto-drops after 90s. |
| App says "couldn't reach any server" | The advertised `PUBLIC_ADDRESS` isn't reachable from the Apple TV. Confirm same LAN/mesh; test `http://<address>/health` in a browser → should say `ok`. |
| `playwright` errors on Windows | Run `npx playwright install chromium` inside `server/`. |
| Server shows load but nothing plays | The server is reachable but extraction failed for that title — try another title/provider; it's logged under Settings → Missing titles. |

---

## Security

- The token gates every relay route **and** the extractor itself. Keep it secret.
- `.env` and `.dev.vars` are gitignored — never commit real tokens.
- This repo is private; share by adding collaborators.
- Reachability comes from your LAN / mesh VPN, not open ports.
