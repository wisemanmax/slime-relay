/* Wave 8 (W1, roadmap 8.3): profile locks on the web — the apps' Parent PIN and
   Kids profiles (MaturityPolicy.swift, ParentPIN.swift): a Kids profile sees
   only kids' certifications and no Settings, and leaving it (or opening a locked
   profile) asks for the PIN. Pure rules here, node-tested in test/parity.mjs;
   profiles.js / worker/profiles.js wire them (W1 owns both).
   TODO(W8-W1) — or leave empty if the audit picks other items. */

/** Whether a profile record is a Kids profile. */
export function isKidsProfile(profile) {
  void profile;
  return false;   // TODO(W8-W1)
}
