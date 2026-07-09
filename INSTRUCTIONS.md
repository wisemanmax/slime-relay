# SlimeRelay — Setup Instructions

## ⚠️ First: which setup are you doing?

There are **two roles**, and most people only do the second one:

- **Joining a friend's fleet (almost everyone).** You just **run a server** (Part B)
  and point it at the relay **they** already run. **Do NOT deploy your own relay** —
  you don't need a Cloudflare account, and a separate relay means your machine won't
  show up on their dashboard or feed their app. Ask the fleet owner for **three things**:
  their **relay URL**, the **app token** (stored as `SLIME_TOKEN`), and the
  **`FLEET_TOKEN`** (server-only registration). Then skip straight to **Part B**.

- **Setting up the whole system yourself (the fleet owner / admin).** Do **Part A**
  once to deploy the relay, save the admin token, then do **Part B** on each machine.

The #1 setup mistake is a friend deploying their own relay and generating their own
token — then nothing connects. If you're joining someone, you only need Part B.

## Tokens first (fleet owner only)

You need two values: a `USER_TOKEN` for the app/streaming path, and a distinct
`FLEET_TOKEN` for server-only registration. Generate each with:

```bash
openssl rand -hex 20
```

Use `USER_TOKEN` as the app token and each server's `SLIME_TOKEN`. Use
`FLEET_TOKEN` only on the relay and in each server's `.env` as `FLEET_TOKEN`.
The relay also gets a separate **admin token** (for the dashboard + controls); the
deploy script generates that for you and prints it.

---

## Part A — Deploy the relay (fleet owner only, once, ~5 min)

**Skip this if you're joining someone else's fleet — go to Part B.**

The relay is a free Cloudflare Worker. You need a (free) Cloudflare account.

### Easiest: one command

```bash
cd relay
./deploy.sh <USER_TOKEN> <FLEET_TOKEN>          # Windows: ./deploy.ps1 <USER_TOKEN> <FLEET_TOKEN>
```

> **Windows:** if PowerShell says scripts are disabled, run this once in the same
> window first (session-only, safe): `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`.

It installs wrangler, opens the browser to log in, creates the KV store, wires it
into `wrangler.toml`, sets `USER_TOKEN` (app/streaming), sets `FLEET_TOKEN`
(server-only registration), generates an `ADMIN_TOKEN` it prints — **copy it
somewhere safe** — and deploys.

### Or step by step

```bash
cd relay
npm install
npx wrangler login                        # opens your browser, click Allow
npx wrangler kv namespace create SERVERS  # copy the printed id…
#   …paste it into wrangler.toml in place of PASTE_KV_NAMESPACE_ID_HERE
printf '%s' "<USER_TOKEN>" | npx wrangler secret put USER_TOKEN
printf '%s' "<FLEET_TOKEN>" | npx wrangler secret put FLEET_TOKEN
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

This is the part **everyone** does. Needs [Node 18+](https://nodejs.org).

```bash
cd server
npm install          # also downloads Chromium for Playwright
npm run setup        # answer a few questions — writes .env for you
npm run doctor       # green-lights Node, Chromium, token, relay, and your address
npm start            # macOS/Linux: ./start.sh   •   Windows: double-click start.bat
```

When `setup` asks for the **app token** (`SLIME_TOKEN`), **paste the exact token the
fleet owner gave you** — don't type `new` (that generates a fresh token for a
brand-new fleet of your own, which won't match theirs). Next it asks for the
**`FLEET_TOKEN`** (server-only registration) — paste the owner's value, or leave it
blank to reuse the app token. For the **relay URL**, paste the owner's
`https://slime-relay.THEIR-NAME.workers.dev`. `doctor` then confirms the relay
accepts your tokens (a red "401" means a token doesn't match the fleet's) and your
address looks reachable — fix anything red before starting. Within ~30s the machine
appears on the owner's dashboard. Repeat on every box; each just needs the same
app token, `FLEET_TOKEN`, and relay URL.

> Keep the window open — closing it stops the server. On Windows, `start.bat` now
> stays open and shows any error instead of flashing closed.

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

The app's streaming token is already baked in — just make sure it matches your
`USER_TOKEN`.

---

## Networking: reaching servers across different places (use Tailscale)

The Apple TV must be able to *reach* each server's advertised address:

- **All in one home?** Nothing to do — leave `PUBLIC_ADDRESS` blank; each server
  advertises its `10.0.0.x` / `192.168.x` LAN IP.
- **Machines in different homes?** Put the **Apple TV and every server** on
  **[Tailscale](https://tailscale.com)** — a free mesh network (Personal plan: 6
  users, unlimited devices) with a **native Apple TV app** (tvOS 17+). Everyone
  installs Tailscale, signs in, and the owner adds them to the tailnet (or accepts
  a shared machine). Each server then auto-advertises its Tailscale IP (`100.x.x.x`);
  `npm run doctor` prefers it. No `PUBLIC_ADDRESS` to set by hand, no port-forwarding.

> **Not NordVPN Meshnet** — it was shut down in Dec 2025 and never had an Apple TV
> app, so the TV could never join it. Tailscale is the free, TV-capable replacement.

Traffic is direct device-to-device (WireGuard), so video streams straight from the
server to the Apple TV — it doesn't route through Tailscale's servers.

---

## Troubleshooting

Run **`npm run doctor`** first — it diagnoses most of these automatically.

| Symptom | Fix |
|---|---|
| `SLIME_TOKEN is not set` on start | Run `npm run setup` (or set `SLIME_TOKEN` in `.env`). The server won't run tokenless on purpose. |
| Dashboard shows "Admin access required" | Use `?key=<ADMIN_TOKEN>` (the admin token, **not** the fleet token). |
| Server never appears on the dashboard | `doctor` will say why. Usually: relay rejected registration (**401 → this server's `FLEET_TOKEN` ≠ the relay's `FLEET_TOKEN`**; until the relay sets `FLEET_TOKEN`, it falls back to `SLIME_TOKEN` = `USER_TOKEN`), or `RELAY_URL` is wrong/blank. |
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
