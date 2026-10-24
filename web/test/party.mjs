// Wave 7 (W7-P5): replace this placeholder with the real checks — the rules,
// the client against a fake socket, the Worker's /api/party routes, the /p/
// redirect for signed-in and signed-out visitors. Run by check.mjs; returns
// the number of assertions.
import assert from 'node:assert/strict';
import { PARTY_CODE_RE, expectedTime, canControl } from '../src/app/party/rules.js';

export async function runPartyChecks() {
  let n = 0;
  const ok = (v, m) => { assert.ok(v, m); n++; };
  ok(PARTY_CODE_RE.test('XK7Q2M') && !PARTY_CODE_RE.test('XK7Q2O'), 'room code alphabet');
  ok(expectedTime({ playing: true, mediaTime: 10, serverTimeAtUpdate: 0, rate: 1 }, 5000) === 15, 'clock extrapolates');
  ok(canControl(null, null) === false, 'stub refuses');
  return n;
}
