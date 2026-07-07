# Join a SlimeWatch fleet (friends — start here)

You're **adding your computer as a server** to a friend's SlimeWatch. You do **not**
need a Cloudflare account and you do **not** deploy anything — you just run a small
program that shares your machine with their fleet.

## Windows (easiest)

1. **Join the mesh network** your host invites you to (NordVPN Meshnet or Tailscale).
   This is what lets their Apple TV reach your PC. Do this first.
2. Your host sends you a **`SlimeWatch-Server-*.zip`** — unzip it anywhere.
3. **Double-click `SlimeWatch-Server.cmd`.**

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
- Same network as the host's Apple TV? The mesh step is optional but recommended.
