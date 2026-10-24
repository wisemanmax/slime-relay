# SlimeWatch Fleet — Owner Setup Runbook (Tailscale)

Get your Apple TV + every stream server onto one private **Tailscale** network so the
relay can route clients to servers by their **private 100.x IPs** (no public IP disclosure),
and onboard friends painlessly. Do these once, in order. Nothing here exposes a secret
publicly. Values in `<angle brackets>` are yours (keep them in your secure notes — do NOT
commit them).

**Why Tailscale (not NordVPN Meshnet):** Meshnet was discontinued Dec 2025 and never had an
Apple TV app. Tailscale is free (Personal: 6 users, unlimited devices), has a native tvOS 17+
app, and is direct P2P WireGuard (no bandwidth middleman — good for video). The relay only does
*discovery*; it never proxies the stream.

Your relay: `https://slime-relay.byheirw.workers.dev`. Your tokens (from your notes):
`FLEET_TOKEN` (servers register with it), `ADMIN_TOKEN` (dashboard + fleet control).

---

## 1. Create the tailnet + add your own devices  *(task #62)*
1. Make a free **Tailscale** account (tailscale.com) — Personal plan.
2. Install + sign in on:
   - **This home Mac** (the always-on extractor). `brew install --cask tailscale` or the app; sign in; run it.
   - **The Apple TV** — App Store → Tailscale → sign in with the same account (tvOS 17+).
   - (Later) any other Mac/PC you run a server on.
3. In the Tailscale admin console, confirm each device shows a **100.x.y.z** address.

## 2. Re-point the home Mac server at its Tailscale IP  *(task #62)*
The server's `env.js` already ranks mesh 100.64–127 IPs **above** LAN, so once Tailscale is up it
auto-advertises the right address on the next heartbeat.
1. Restart the extractor so it re-reads its address:
   `launchctl kickstart -k gui/$UID/com.bwise.slimewatch.extractor`
   (prefer **kickstart** over bootout+bootstrap — the latter races and can leave it down.)
2. Verify it registered with its private IP:
   `curl -s "https://slime-relay.byheirw.workers.dev/route?key=<FLEET_TOKEN>"` → the address should now be a **100.x** (or `.ts.net`), not your public/LAN IP.

## 3. Point the Apple TV at the relay + become admin  *(task #63)*
On the Apple TV (needs the shipped tvOS build with the Relay settings):
1. **Settings → Relay → URL** = `https://slime-relay.byheirw.workers.dev`
2. **Settings → Admin → token** = `<ADMIN_TOKEN>` (unlocks the fleet list + Disable/Enable/Prefer; leave blank on friends' TVs so the fleet stays private to them).
3. Settings → **Discover servers** → you should see "Home Mac" reachable. Play something to confirm it routes through the fleet.

## 4. Lock the relay to private addresses  *(task #63, after everyone's on Tailscale)*
Once all servers advertise 100.x/`.ts.net`, reject public IPs at the relay (owner-run):
```sh
cd slime-relay/relay
printf '1' | npx wrangler secret put ADDR_PRIVATE_ONLY
npx wrangler deploy
```
`/register` will then refuse public-IP servers (allows Tailscale/RFC1918/.local) — closes the IP-disclosure hole.

## 5. Onboard a friend (Alex)  *(task #64)*
1. In Tailscale admin → **Settings → Keys → Generate auth key** (reusable, optionally ephemeral/pre-approved). Send Alex the key.
2. Alex installs **Tailscale**, signs in **with the auth key** (joins *your* tailnet — he does NOT need his own account/relay).
3. You generate his ready-to-run server package (token + relay URL pre-baked, so he answers nothing):
   ```sh
   cd slime-relay/server
   ./make-friend-installer.sh https://slime-relay.byheirw.workers.dev <FLEET_TOKEN> "Alex"
   ```
   Send him the generated `.zip` (it's gitignored — carries the token).
4. Alex: unzip → double-click **SlimeWatch-Server.cmd** (Win) / `./start.sh` (Mac). It installs Node+Chromium, then runs. `npm run doctor` if anything's off.
5. Verify: his server appears on your dashboard (`https://slime-relay.byheirw.workers.dev/?key=<ADMIN_TOKEN>`) advertising his **100.x** IP, and `/route` now returns two ranked addresses.

**Friend rules:** JOIN, don't OWN — Alex must NOT deploy his own relay or mint a new token; he uses *your* relay URL + *your* FLEET_TOKEN (baked into his installer). Leave the admin token off his devices.

## 6. Remote fixes — force libVLC without an app build  *(Wave 8)*
The dashboard's **Remote fixes** section sends matching **debrid** streams to libVLC on chosen devices,
with no app build (the fix for "this title plays black on the Apple TV's AVPlayer"). It can only ever
move a stream **to libVLC — never to AVPlayer** — and only debrid streams: embeds and HLS are untouched,
and a device never forces libVLC under AirPlay or while a Watch Party skips libVLC streams.

It needs all three pieces deployed: the relay (the panel appears), each server's extractor (it carries
the config into its token-gated `/manifest` — the apps never read this from the relay), and app builds
with Wave 8's remote-config support. Until then nothing reaches a device.

**Rules** — one per line, `key=value`; every key on a line must match (AND), any line forces (OR):

| Key | Values (lowercase, exact) |
|---|---|
| `title` | `movie:<TMDB id>` or `tv:<TMDB id>` — e.g. `title=tv:1399` |
| `codec` | `h264` `hevc` `av1` `vp9` `mpeg2` `mpeg4` `vc1` |
| `container` | `mp4` `mkv` `avi` `ts` `m2ts` `webm` `mov` `wmv` |
| `platform` | `ios` `tvos` `macos` |

`title=tv:1399 platform=tvos` = Game of Thrones on Apple TVs only; `codec=hevc container=mp4` = every
HEVC-in-MP4 stream. At most 50 rules; `#` starts a comment. Anything else is refused with its line
number. The **note** (≤ 120 characters) is what the apps show in Settings → Remote fixes.

**Buttons** (each asks once):
- **Publish** — the rules become the config for every device. The previous one becomes *Last known
  good*; a running canary is cleared. Publishing an empty box = force nothing.
- **Canary** — try the rules on 1–10 devices only; everyone else stays on *Active*. **Canary here** on a
  Now Watching card fills in that device's id (the id the app reports with presence).
- **Promote** — the canary becomes *Active* for every device (*Active* becomes *Last known good*).
- **Roll back** — with a canary running: drops it. Otherwise: *Last known good* becomes *Active* again
  (or, if there was none, every device goes back to its built-in engine choice).
- **Restore** (on a history line) — makes that earlier config *Active* again. **Edit a copy** (on a
  card) loads its rules into the editor.

**How a canary (or a rollback) reaches a TV, and how long it takes:**
1. The click is stored in the relay (KV `rc:doc`) under a new `version`.
2. Every server picks it up from its next heartbeat reply (every 30 s; KV can take up to ~60 s to be
   visible everywhere) — so **≤ ~1½ minutes** to reach a server. The server log says
   `[remote-config] now v<n> (…)`; its `/manifest` (with the token) shows `remoteConfig.version`.
3. The app reads it at its next manifest refresh: launch, coming back to the foreground, or a server
   change. So after a canary, **relaunch the TV app** (or leave it and come back).
4. The next debrid play that matches uses libVLC; the device log shows
   `remote-config v<configVersion>: libVLC forced (…)`.

A rollback travels the same road — it is a newer `version` re-issuing the older config — so it is
never faster than step 2 + step 3. For an immediate escape on one device, use that device's own
**Settings → Remote fixes → Use previous**. A device also backs off by itself: a forced libVLC start
that fails marks that config bad on that device, and its next try runs unforced.

**Why it is safe to leave on:** servers and apps check every key and value against a fixed list and
refuse the *whole* config if anything is off (they keep what they had), and they ignore any `version`
that isn't newer than the one they hold, so a stale copy can never roll a device back. Only the admin
token can change it, and nothing is ever applied automatically.

**If it doesn't arrive:** no `remoteConfig` in `/manifest` → nothing published yet, or that server's
extractor predates Wave 8 (redeploy it); `[remote-config] rejected …` in the server log → the relay
sent something outside the list (the reason is in the line). **Never delete `rc:doc`** to reset: the
versions would restart at 1 and every server and app would ignore them as older. To switch everything
off, **Roll back** to the built-in engine choice or **Publish** an empty box.

---

## Verify the whole fleet
- Dashboard: `https://slime-relay.byheirw.workers.dev/?key=<ADMIN_TOKEN>` — every server green, private IPs, load bars.
- Client view: `curl -s ".../route?key=<FLEET_TOKEN>"` — bare ranked list of **private** addresses (no names/load — friends can't see the fleet).
- Apple TV (admin): Settings → Fleet → Disable/Enable/Prefer a server; changes apply to every device via the relay's KV `policy`.

## Troubleshooting
- Extractor down after a restart → `launchctl kickstart -k gui/$UID/com.bwise.slimewatch.extractor`.
- `/route` returns 401 → the server's `SLIME_TOKEN`/`FLEET_TOKEN` ≠ the relay's `FLEET_TOKEN`.
- A server advertises a LAN/public IP instead of 100.x → Tailscale not running on it, or restart it so `env.js` re-picks (mesh IPs rank first).
- Apple TV can't reach a server → confirm both are on the tailnet (Tailscale admin shows both online).
</content>
