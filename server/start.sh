#!/usr/bin/env bash
# Starts the SlimeWatch extractor (macOS / Linux). server.js loads .env itself.
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[X]  Node.js isn't installed. Get it from https://nodejs.org (v18+), then run this again."
  exit 1
fi

# First run? Guide the user through config instead of failing cryptically.
if [ ! -f .env ]; then
  echo "No .env found - launching guided setup..."
  node setup.js || exit 1
fi

exec node server.js
