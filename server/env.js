'use strict';
// Shared, dependency-free helpers used by server.js, heartbeat.js, setup.js and
// doctor.js: load `.env` no matter how the process was launched, and pick a
// reachable LAN/mesh address (the #1 thing people get wrong on Windows, where a
// WSL/Hyper-V/VirtualBox adapter often sorts first and the Apple TV can't reach it).
const fs = require('fs');
const os = require('os');
const path = require('path');

/// Parse `.env` (KEY=VALUE, # comments, optional quotes) into process.env.
/// Does NOT overwrite variables already set in the real environment, so
/// `SLIME_TOKEN=x node server.js` still wins over the file.
function loadEnv(file) {
  const p = file || path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return false;
  for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = val;
  }
  return true;
}

/// Classify an IPv4 by reachability usefulness. Lower rank = better candidate for
/// PUBLIC_ADDRESS. Virtual-adapter names are pushed down so a real LAN/mesh NIC wins.
function classify(address, ifaceName) {
  const name = (ifaceName || '').toLowerCase();
  const virtual = /(vethernet|virtualbox|vmware|hyper-v|wsl|docker|bridge100|loopback|zt|npcap)/.test(name);
  const [a, b] = address.split('.').map(Number);
  let kind = 'other', rank = 5;
  // A Tailscale IP (100.64/10, CGNAT range) ranks ABOVE LAN: it's reachable by
  // remote fleet peers AND locally, whereas a LAN IP only works on the same
  // network - so for a cross-home fleet the Tailscale address is the safer pick.
  if (a === 169 && b === 254) { kind = 'link-local'; rank = 9; }        // never reachable
  else if (a === 100 && b >= 64 && b <= 127) { kind = 'mesh (Tailscale)', rank = 1; }
  else if (a === 10) { kind = 'LAN', rank = 2; }
  else if (a === 192 && b === 168) { kind = 'LAN', rank = 2; }
  else if (a === 172 && b >= 16 && b <= 31) { kind = 'LAN', rank = 2; }
  else { kind = 'public/other', rank = 4; }
  if (virtual) rank += 3;                                                // demote virtual NICs
  return { kind, rank, virtual };
}

/// All usable IPv4 candidates, best first. Each: {address, iface, kind, virtual, url(port)}.
function ipv4Candidates(port) {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const iface of Object.keys(ifaces)) {
    for (const info of ifaces[iface] || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      const c = classify(info.address, iface);
      if (c.kind === 'link-local') continue;                            // drop 169.254.x entirely
      out.push({ address: info.address, iface, kind: c.kind, virtual: c.virtual, rank: c.rank,
                 url: `http://${info.address}:${port || 8787}` });
    }
  }
  out.sort((x, y) => x.rank - y.rank);
  return out;
}

/// The single best auto-detected base URL (or '' if none).
function bestAddress(port) {
  const c = ipv4Candidates(port);
  return c.length ? c[0].url : '';
}

module.exports = { loadEnv, ipv4Candidates, bestAddress };
