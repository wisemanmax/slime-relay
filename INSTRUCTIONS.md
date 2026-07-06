# SlimeRelay — Setup Instructions

Copy-paste friendly. Three parts: **deploy the relay once**, **run a server on each
machine**, then **point the app at the relay**.

## Tokens first

You need one **fleet token** — the same value on every server and in the app.
Generate it once:

```bash
openssl rand -hex 20
```

Call this value `FLEET_TOKEN`. The relay also gets a separate **admin token** (for
the dashboard + controls); the deploy script generates that for you and prints it.

---

## Part A — Deploy the relay (once, ~5 min)

The relay is a free Cloudflare Worker. You need a (free) Cloudflare account.

### Easiest: one command

```bash
cd relay
./deploy.sh <FLEET_TOKEN>          # Windows: ./deploy.ps1 <FLEET_TOKEN>
```

It installs wrangler, opens the browser to log in, creates the KV store, wires it
into `wrangler.toml`, sets **both** secrets (`USER_TOKEN` = your `FLEET_TOKEN`, and
a generated `ADMIN_TOKEN` it prints — **copy it somewhere safe**), and deploys.

### Or step by step

```bash
cd relay
npm install
npx wrangler login                        # opens your browser, click Allow
npx wrangler kv namespace create SERVERS  # copy the printed id…
#   …paste it into wrangler.toml in place of PASTE_KV_NAMESPACE_ID_HERE
printf '%s' "<FLEET_TOKEN>" | npx wrangler secret put USER_TOKEN
printf '%s' "$(openssl rand -hex 20)" | npx wrangler secret put ADMIN_TOKEN  # save this value!
npm run deploy                            # prints your URL
```

Either way you get a URL like `https://slime-relay.yourname.workers.dev`. Call it
`RELAY`. Open the **admin dashboard** to confirm it's live:

```
https://<RELAY>/?key=<ADMIN_TOKEN>
```

You'll see "0 servers connected" — expected until you start one.

---

## Part B — Run a server (each Mac / Windows / Linux box)

Needs [Node 18+](https://nodejs.org).

```bash
cd server
npm install          # also downloads Chromium for Playwright
npm run setup        # answer a few questions — writes .env for you
npm run doctor       # green-lights Node, Chromium, token, relay, and your address
npm start            # macOS/Linux: ./start.sh   •   Windows: double-click start.bat
```

`setup` asks for your `FLEET_TOKEN`, the `RELAY` URL, a name, and which network
address to advertise (it lists the ones it found). `doctor` then confirms the relay
accepts your token and your address looks reachable — fix anything red before
starting. Within ~30s the machine appears on the dashboard. Repeat on every box;
each just needs the same `FLEET_TOKEN` and `RELAY` URL.

---

## Part C — Point the Apple TV app at the relay

On the Apple TV: **SlimeWatch → Settings → Relay** → enter your `RELAY` URL. Done —
the app streams through whichever server is reachable + least busy and fails over
automatically.

- **Regular users:** leave **Settings → Admin** blank. You're routed to a server;
  the fleet stays private.
- **You (admin):** enter your `ADMIN_TOKEN` under **Settings → Admin** to see every
  server and **Disable / Enable / Prefer** them from the couch. Same controls as the
  web dashboard; changes apply to every device.

The app's fleet token is already baked in — just make sure your `FLEET_TOKEN`
matches it.

---

## Networking: reaching servers across different places

The Apple TV must be able to *reach* each server's advertised address:

- **All on one home network?** Nothing to do — leave `PUBLIC_ADDRESS` blank; each
  server advertises its `10.0.0.x` / `192.168.x` LAN IP.
- **Machines in different places?** Put them all on one overlay network — your
  **NordVPN Meshnet** (or Tailscale) — and set each server's `PUBLIC_ADDRESS` to its
  mesh IP, e.g. `http://100.71.4.9:8787`. `npm run doctor` lists the candidate
  addresses and flags virtual adapters that won't work.

No port-forwarding required.

---

## Troubleshooting

Run **`npm run doctor`** first — it diagnoses most of these automatically.

| Symptom | Fix |
|---|---|
| `SLIME_TOKEN is not set` on start | Run `npm run setup` (or set `SLIME_TOKEN` in `.env`). The server won't run tokenless on purpose. |
| Dashboard shows "Admin access required" | Use `?key=<ADMIN_TOKEN>` (the admin token, **not** the fleet token). |
| Server never appears on the dashboard | `doctor` will say why. Usually: relay rejected the token (**401 → `SLIME_TOKEN` ≠ relay `USER_TOKEN`**), or `RELAY_URL` is wrong/blank. |
| Appears then vanishes | Heartbeats stopped → the server process died or lost network. It auto-drops after 90s. |
| App says "couldn't reach any server" | The advertised address isn't reachable from the Apple TV. `doctor` prints your addresses; pin `PUBLIC_ADDRESS` to the LAN/mesh one (avoid virtual adapters). Test `http://<address>/health` in a browser → should say `ok`. |
| Windows: double-clicking `start.bat` flashes and closes | It now stays open and shows the error. If it says Node is missing, install [Node 18+](https://nodejs.org); if Chromium is missing, run `npx playwright install chromium` in `server/`. |
| `playwright` / Chromium errors | `npx playwright install chromium` inside `server/`. |
| Server runs but a title won't play | The server's reachable but extraction failed for that title — try another title/provider; it's logged in the app under Settings → Missing titles. |

---

## Security

- The fleet token gates every relay route **and** the extractor; the admin token
  gates the dashboard + controls. Keep both secret.
- The extractor refuses to start without a token (never an open proxy).
- `.env` and `.dev.vars` are gitignored — never commit real tokens.
- Reachability comes from your LAN / mesh VPN, not open ports.
