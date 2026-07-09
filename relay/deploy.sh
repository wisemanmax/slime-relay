#!/usr/bin/env bash
# One-shot relay deploy: installs wrangler, logs you into Cloudflare, creates the
# KV store, wires it into wrangler.toml, sets all three role tokens, and deploys.
#
# Three roles:
#   USER_TOKEN  = the app/streaming token - SAME value as your app's SLIME_TOKEN
#                 and each server's SLIME_TOKEN. Grants routing (/route).
#   FLEET_TOKEN = the server-only registration token. Set the SAME value as each
#                 server's FLEET_TOKEN. Never bake this into the app.
#   ADMIN_TOKEN = a private admin token - only YOU. Unlocks the dashboard, the full
#                 fleet (names/addresses/load), and routing controls. Auto-generated
#                 if you don't pass one.
#
# Usage:  ./deploy.sh [USER_TOKEN] [FLEET_TOKEN] [ADMIN_TOKEN]
set -euo pipefail
cd "$(dirname "$0")"

USER_TOKEN="${1:-}"
FLEET_TOKEN="${2:-}"
ADMIN_TOKEN="${3:-}"
if [ -z "$USER_TOKEN" ]; then
  read -rp "App/streaming token (USER_TOKEN - same value as your app's SLIME_TOKEN): " USER_TOKEN
fi
[ -z "$USER_TOKEN" ] && { echo "A USER_TOKEN is required."; exit 1; }
if [ -z "$FLEET_TOKEN" ]; then
  read -rp "Server registration token (FLEET_TOKEN - never bake this into the app): " FLEET_TOKEN
fi
[ -z "$FLEET_TOKEN" ] && { echo "A FLEET_TOKEN is required."; exit 1; }
if [ -z "$ADMIN_TOKEN" ]; then
  ADMIN_TOKEN="$(openssl rand -hex 20)"
  echo "-> Generated a new ADMIN_TOKEN (save this - it's your dashboard/admin key):"
  echo "      $ADMIN_TOKEN"
fi

echo "-> Installing wrangler..."
npm install --silent

echo "-> Logging in to Cloudflare (a browser window will open - click Allow)..."
npx wrangler login

if grep -q "PASTE_KV_NAMESPACE_ID_HERE" wrangler.toml; then
  echo "-> Creating KV namespace SERVERS..."
  OUT="$(npx wrangler kv namespace create SERVERS 2>&1 | tee /dev/tty)"
  ID="$(printf '%s' "$OUT" | grep -oiE '[0-9a-f]{32}' | head -1)"
  [ -z "$ID" ] && { echo "Couldn't read the KV id - paste it into wrangler.toml manually, then rerun."; exit 1; }
  sed -i.bak "s/PASTE_KV_NAMESPACE_ID_HERE/$ID/" wrangler.toml && rm -f wrangler.toml.bak
  echo "-> KV id wired into wrangler.toml: $ID"
else
  echo "-> KV already configured in wrangler.toml - skipping create."
fi

echo "-> Setting USER_TOKEN secret..."
printf '%s' "$USER_TOKEN"  | npx wrangler secret put USER_TOKEN
echo "-> Setting FLEET_TOKEN secret..."
printf '%s' "$FLEET_TOKEN" | npx wrangler secret put FLEET_TOKEN
echo "-> Setting ADMIN_TOKEN secret..."
printf '%s' "$ADMIN_TOKEN" | npx wrangler secret put ADMIN_TOKEN

echo "-> Deploying..."
npx wrangler deploy

echo
echo "[OK] Relay deployed."
echo "   Admin dashboard:  <the workers.dev URL printed above>/?key=$ADMIN_TOKEN"
echo "   Put the base URL (without ?key) into each server's RELAY_URL,"
echo "   and into the Apple TV app under Settings -> Relay."
echo "   Enter the ADMIN_TOKEN under Settings -> Admin to manage the fleet in-app."
