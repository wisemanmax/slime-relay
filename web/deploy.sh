#!/usr/bin/env bash
# One-shot deploy for the private SlimeWatch web app.
# Usage:  ./deploy.sh [SITE_PASSWORD] [TMDB_TOKEN]
set -euo pipefail
cd "$(dirname "$0")"

PW="${1:-}"
TMDB="${2:-}"
[ -z "$PW" ]   && { read -rsp "Choose a site password: " PW; echo; }
[ -z "$TMDB" ] && { read -rsp "TMDB v4 read token: " TMDB; echo; }
[ -z "$PW" ] || [ -z "$TMDB" ] && { echo "Both a password and a TMDB token are required."; exit 1; }

echo "→ Installing dependencies (wrangler, esbuild, hls.js)…"
npm install --silent

echo "→ Logging in to Cloudflare (browser opens once)…"
npx wrangler login

echo "→ Setting secrets…"
printf '%s' "$PW"                       | npx wrangler secret put SITE_PASSWORD
printf '%s' "$(openssl rand -hex 32)"   | npx wrangler secret put SESSION_SECRET
printf '%s' "$TMDB"                      | npx wrangler secret put TMDB_TOKEN

echo "→ Building + checking…"
npm test

echo "→ Deploying…"
npx wrangler deploy

echo
echo "✅ Deployed. Open https://watch.byheir.com (or the printed workers.dev URL) and log in with your password."
echo "   The first deploy with the custom domain creates its DNS record; give it a minute."
