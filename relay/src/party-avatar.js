// Wave 7 (P1, roadmap 7.3) — room avatars, PURE (no I/O): the validation the
// reducer runs on `{t:'avatar', jpeg}` and the limits party.js enforces. A
// member sends its avatar once per join: a base64 64 × 64 JPEG of at most
// AVATAR_MAX_BYTES. The room stores it under avatarKey(id) for the room's life
// (Durable Object storage; destroy() deletes it with everything else) and
// hands it to every other member as {t:'avatar', id, rev, jpeg}. The member
// record carries only `avatarRev`, so roster/state frames stay small.
//
// TODO(W7-P1): validAvatar() accepts nothing until P1 lands.

export const AVATAR_MAX_BYTES = 6144;      // decoded JPEG
export const AVATAR_MAX_B64 = 8192;        // 4 · ceil(6144 / 3)
export const AVATAR_FRAME_MAX = 9216;      // a text frame carrying {t:'avatar'} may be this long;
                                           // every other frame keeps party.js MAX_FRAME (4096)
export const avatarKey = (id) => `avatar:${id}`;

/** The avatar's base64 (normalized) when it is one the room accepts, else null. */
export function validAvatar(b64) {
  void b64;
  return null;   // TODO(W7-P1): base64 only, 1..AVATAR_MAX_BYTES decoded, starts FF D8 FF
}
