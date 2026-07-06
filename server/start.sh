#!/usr/bin/env bash
# Loads .env and starts the extractor. macOS / Linux.
set -euo pipefail
cd "$(dirname "$0")"
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi
exec node server.js
