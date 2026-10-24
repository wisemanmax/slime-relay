/* Wave 8 (W1, roadmap 8.3): skip markers for everything that isn't anime —
   intro / recap / credits windows from TheIntroDB (keyed by TMDB id, films and
   series; the apps' TheIntroDB.swift + SkipMarkers.swift), shown the way
   skip.js shows AniSkip's. Pure parsing here, node-tested in test/parity.mjs;
   the player wires it (W1 owns player.js and skip.js this wave).
   TODO(W8-W1). */

/** TheIntroDB v3 /media answer -> [{start, end, kind:'intro'|'recap'|'credits'|'preview', label}]. */
export function parseIntroDB(json) {
  void json;
  return [];   // TODO(W8-W1)
}
