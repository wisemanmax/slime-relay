'use strict';
// Periodically registers this extractor with a SlimeRelay so the dashboard and
// the app can discover it. Cross-platform (Node 18+, uses global fetch).
const os = require('os');

const RELAY_URL = (process.env.RELAY_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.SLIME_TOKEN || '';
const NAME = process.env.SERVER_NAME || os.hostname();
const PUBLIC_ADDRESS = process.env.PUBLIC_ADDRESS || '';
const INTERVAL_MS = 30_000;

/// First non-internal IPv4 address, as a reachable base URL.
function localAddress(port) {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return `http://${iface.address}:${port}`;
    }
  }
  return '';
}

function start({ getLoad, capacity, port }) {
  if (!RELAY_URL) {
    console.log('[heartbeat] RELAY_URL not set — running standalone (no relay registration)');
    return;
  }
  const id = `${NAME}-${port}`;
  const address = PUBLIC_ADDRESS || localAddress(port);

  async function beat() {
    try {
      const res = await fetch(`${RELAY_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          id,
          name: NAME,
          os: `${os.platform()} ${os.release()} (${os.arch()})`,
          address,
          load: Number(getLoad()) || 0,
          capacity,
          version: 1,
          ts: Date.now(),
        }),
      });
      if (!res.ok) console.warn('[heartbeat] relay responded', res.status);
    } catch (e) {
      console.warn('[heartbeat] failed:', e.message);
    }
  }

  beat();
  setInterval(beat, INTERVAL_MS);
  console.log(`[heartbeat] "${id}" -> ${RELAY_URL} every ${INTERVAL_MS / 1000}s (address: ${address || 'unknown'})`);
}

module.exports = { start };
