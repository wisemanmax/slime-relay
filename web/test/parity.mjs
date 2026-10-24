// Wave 8 (W8-W1): replace this placeholder with the real checks for the three
// parity items you build (pure rules + the Worker routes they need). Run by
// check.mjs; returns the number of assertions.
import assert from 'node:assert/strict';
import { parseIntroDB } from '../src/app/player/markers.js';
import { isKidsProfile } from '../src/app/profilelock.js';

export async function runParityChecks() {
  let n = 0;
  const ok = (v, m) => { assert.ok(v, m); n++; };
  ok(Array.isArray(parseIntroDB(null)) && parseIntroDB(null).length === 0, 'markers: nothing from nothing');
  ok(isKidsProfile(null) === false, 'profile lock: a missing profile is not Kids');
  return n;
}
