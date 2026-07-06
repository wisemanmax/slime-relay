#!/usr/bin/env bash
# One-shot relay deploy: installs wrangler, logs you into Cloudflare, creates the
# KV store, wires it into wrangler.toml, sets the secret, and deploys.
# Usage:  ./deploy.sh [TOKEN]
set -euo pipefail
cd "$(dirname "$0")"

TOKEN="${1:-}"
if [ -z "$TOKEN" ]; then
  read -rp "Shared token (RELAY_TOKEN — same value as your app's SLIME_TOKEN): " TOKEN
fi
[ -z "$TOKEN" ] && { echo "A token is required."; exit 1; }

echo "→ Installing wrangler…"
npm install --silent

echo "→ Logging in to Cloudflare (a browser window will open — click Allow)…"
npx wrangler login

if grep -q "PASTE_KV_NAMESPACE_ID_HERE" wrangler.toml; then
  echo "→ Creating KV namespace SERVERS…"
  OUT="$(npx wrangler kv namespace create SERVERS 2>&1 | tee /dev/tty)"
  ID="$(printf '%s' "$OUT" | grep -oiE '[0-9a-f]{32}' | head -1)"
  [ -z "$ID" ] && { echo "Couldn't read the KV id — paste it into wrangler.toml manually, then rerun."; exit 1; }
  sed -i.bak "s/PASTE_KV_NAMESPACE_ID_HERE/$ID/" wrangler.toml && rm -f wrangler.toml.bak
  echo "→ KV id wired into wrangler.toml: $ID"
else
  echo "→ KV already configured in wrangler.toml — skipping create."
fi

echo "→ Setting RELAY_TOKEN secret…"
printf '%s' "$TOKEN" | npx wrangler secret put RELAY_TOKEN

echo "→ Deploying…"
npx wrangler deploy

echo
echo "✅ Relay deployed."
echo "   Dashboard:  <the workers.dev URL printed above>/?key=$TOKEN"
echo "   Put that base URL (without ?key) into each server's RELAY_URL,"
echo "   and into the Apple TV app under Settings → Relay."
