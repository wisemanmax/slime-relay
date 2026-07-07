#!/usr/bin/env bash
# Build a ready-to-send SlimeWatch server package for a friend joining YOUR fleet.
# It bakes in your relay URL + fleet token, so the friend just double-clicks
# SlimeWatch-Server.cmd and answers NOTHING (address auto-detects on the mesh).
#
# Run this on your Mac/Linux, then send the printed .zip to your friend.
# Usage:  ./make-friend-installer.sh <RELAY_URL> <FLEET_TOKEN> [friend-name]
set -euo pipefail
cd "$(dirname "$0")"

RELAY="${1:-}"; TOKEN="${2:-}"; WHO="${3:-friend}"
if [ -z "$RELAY" ] || [ -z "$TOKEN" ]; then
  echo "Usage: ./make-friend-installer.sh <RELAY_URL> <FLEET_TOKEN> [friend-name]"
  echo "  e.g. ./make-friend-installer.sh https://slime-relay.you.workers.dev 3d9f...aa5f alex"
  exit 1
fi
RELAY="${RELAY%/}"                       # trim trailing slash
SAFE_WHO="$(printf '%s' "$WHO" | tr ' /' '__')"
OUT="SlimeWatch-Server-$SAFE_WHO"
rm -rf "$OUT" "$OUT.zip"
mkdir -p "$OUT"

# Copy just what a server needs to run (no node_modules, no cache, no secrets-in-git).
for f in server.js extract.js heartbeat.js env.js setup.js doctor.js animemap.js \
         package.json SlimeWatch-Server.cmd start.bat start.ps1 start.sh; do
  [ -f "$f" ] && cp "$f" "$OUT/"
done

# Pre-fill .env so the friend answers zero token/URL questions. PUBLIC_ADDRESS is
# left blank on purpose: it auto-detects their mesh IP (preferred) at startup.
cat > "$OUT/.env" <<ENV
# Pre-configured for this fleet - you don't need to edit anything.
SLIME_TOKEN=$TOKEN
PORT=8787
RELAY_URL=$RELAY
PUBLIC_ADDRESS=
SERVER_NAME=$WHO
ENV

# A dead-simple readme for the friend.
cat > "$OUT/READ ME FIRST.txt" <<TXT
SlimeWatch Server - quick start (Windows)

1. Join the mesh network your host invited you to (NordVPN Meshnet or Tailscale),
   so your host's Apple TV can reach this PC. Do this BEFORE step 2.

2. Double-click  SlimeWatch-Server.cmd

That's it. The first run installs everything (a couple of minutes); after that it
just starts. Keep the window open while you want to share - closing it goes offline.

Your server is already configured (token + relay URL are filled in). If it says
"Relay rejected the token (401)", tell your host - their relay token changed.
TXT

if command -v zip >/dev/null 2>&1; then
  zip -rq "$OUT.zip" "$OUT"
  rm -rf "$OUT"
  echo "Built: $OUT.zip"
else
  echo "Built folder: $OUT  (install 'zip' to auto-package, or zip it yourself)"
fi
echo
echo "Send it to $WHO. They: join the mesh, unzip, double-click SlimeWatch-Server.cmd."
echo "No token or URL for them to type."
