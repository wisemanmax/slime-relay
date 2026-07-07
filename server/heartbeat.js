'use strict';
// Periodically registers this extractor with a SlimeRelay so the dashboard and
// the app can discover it. Cross-platform (Node 18+, uses global fetch).
const os = require('os');
const { ipv4Candidates } = require('./env');

const RELAY_URL = (process.env.RELAY_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.SLIME_TOKEN || '';
const NAME = process.env.SERVER_NAME || os.hostname();
const PUBLIC_ADDRESS = process.env.PUBLIC_ADDRESS || '';
const INTERVAL_MS = 30_000;

function start({ getLoad, capacity, port }) {
  if (!RELAY_URL) {
    console.log('[heartbeat] RELAY_URL not set - running standalone (no relay registration).');
    console.log('            To join the fleet, set RELAY_URL in .env (or run  node setup.js ).');
    return;
  }
  const id = `${NAME}-${port}`;
  let address = PUBLIC_ADDRESS;
  if (!address) {
    const candidates = ipv4Candidates(port);
    address = candidates.length ? candidates[0].url : '';
    // Several reachable-looking IPs -> auto-pick is a guess. Tell the user how to
    // lock it down so the Apple TV isn't handed a dead (e.g. virtual-adapter) IP.
    if (candidates.length > 1) {
      console.log('[heartbeat] Multiple network addresses found - auto-picked the most likely one.');
      console.log('            If the app can\'t reach this server, set PUBLIC_ADDRESS in .env to one of:');
      for (const c of candidates) {
        console.log(`              ${c.url}   (${c.iface}, ${c.kind}${c.virtual ? ', virtual - usually NOT reachable' : ''})`);
      }
    }
  }

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
      if (!res.ok) {
        if (res.status === 401) {
          console.warn('[heartbeat] relay rejected us (401): this server\'s SLIME_TOKEN does not match');
          console.warn('            the relay\'s USER_TOKEN. Make them identical, then restart.');
        } else {
          console.warn('[heartbeat] relay responded', res.status, '- is RELAY_URL correct?');
        }
      }
    } catch (e) {
      console.warn('[heartbeat] could not reach the relay:', e.message, '(check RELAY_URL / your connection)');
    }
  }

  beat();
  setInterval(beat, INTERVAL_MS);
  console.log(`[heartbeat] "${id}" -> ${RELAY_URL} every ${INTERVAL_MS / 1000}s (address: ${address || 'unknown'})`);
}

module.exports = { start };
