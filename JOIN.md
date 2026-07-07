# Join a SlimeWatch fleet (friends — start here)

You're **adding your computer as a server** to a friend's SlimeWatch. You do **not**
need a Cloudflare account and you do **not** deploy anything — you just run a small
program that shares your machine with their fleet.

> **Don't want to run a server?** The easiest option is **Debrid** — for about
> $3/month you get the best quality with nothing to install and no computer to keep
> on. See **[DEBRID.md](DEBRID.md)**. You can do both (debrid *and* run a server),
> but many people just do debrid.

## Step 1 — Get on Tailscale (free, one time)

Tailscale is a free app that lets your host's Apple TV reach your PC over the
internet — securely, with no router setup. It's what makes this work across homes.

1. Install **Tailscale** ([tailscale.com/download](https://tailscale.com/download)) and
   **sign in** (Google / Apple / Microsoft — no credit card).
2. Tell your host your Tailscale name/email so they can add you to their network
   (they'll send an invite or accept your shared machine — one click for them).

That's it — free forever for this (their plan covers several people). Do this before step 2.

## Step 2 — Windows (easiest)

1. Your host sends you a **`SlimeWatch-Server-*.zip`** — unzip it anywhere.
2. **Double-click `SlimeWatch-Server.cmd`.**

That's it. The first run installs everything (a couple of minutes); after that it
just starts. **Keep the window open** while you're sharing — closing it goes offline.
Your token and the relay URL are already filled in.

> No zip from your host? Do it yourself: install [Node 18+](https://nodejs.org),
> unzip the `server` folder, double-click `SlimeWatch-Server.cmd`, and when it asks,
> paste the **fleet token** and **relay URL** your host gives you.

## Mac / Linux

```bash
cd server
npm install
npm run setup      # paste the host's fleet token + relay URL
npm run doctor     # should say "Relay reachable and token accepted"
npm start
```

## Is it working?

Ask your host to check their dashboard — your machine should appear by name with
`0` load. If `doctor` says **"Relay rejected the token (401)"**, your token doesn't
match the fleet — double-check it with your host.

## Notes

- **Keep it running** to stay part of the fleet. Closing the window stops sharing.
- Your machine only streams video through your own internet — nothing is installed
  system-wide, and you can stop any time by closing the window.
- Actually in the same house as the host's Apple TV? Tailscale is optional there,
  but it's the easiest way to be sure the TV can reach you — leave it on.
