// Wave 7 (P1, roadmap 7.3) — room avatars, PURE (no I/O): the validation the
// reducer runs on `{t:'avatar', jpeg}` and the limits party.js enforces. A
// member sends its avatar once per join: a base64 64 × 64 JPEG of at most
// AVATAR_MAX_BYTES. The room stores it under avatarKey(id) for the room's life
// (Durable Object storage; destroy() deletes it with everything else) and
// hands it to every other member as {t:'avatar', id, rev, jpeg}. The member
// record carries only `avatarRev`, so roster/state frames stay small.

export const AVATAR_MAX_BYTES = 6144;      // decoded JPEG
export const AVATAR_MAX_B64 = 8192;        // 4 · ceil(6144 / 3)
export const AVATAR_FRAME_MAX = 9216;      // a text frame carrying {t:'avatar'} may be this long;
                                           // every other frame keeps party.js MAX_FRAME (4096)
export const avatarKey = (id) => `avatar:${id}`;

// Standard base64 (RFC 4648 §4, what Swift's base64EncodedString() writes).
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// Accepted: standard base64 — line breaks and spaces are dropped, missing
// padding is added (the normalized form is what gets stored and fanned out) —
// of 1..AVATAR_MAX_BYTES bytes that start with the JPEG SOI marker FF D8 FF.
// Only the first 3 bytes are decoded: the size follows from the length.
/** The avatar's base64 (normalized) when it is one the room accepts, else null. */
export function validAvatar(b64) {
  if (typeof b64 !== 'string' || !b64 || b64.length > AVATAR_FRAME_MAX) return null;
  let s = b64.replace(/[\r\n\t ]/g, '');
  if (!B64_RE.test(s)) return null;
  if (!s.includes('=') && s.length % 4 > 1) s += '='.repeat(4 - (s.length % 4));
  if (s.length % 4 || s.length > AVATAR_MAX_B64) return null;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const bytes = (s.length / 4) * 3 - pad;
  if (bytes < 3 || bytes > AVATAR_MAX_BYTES) return null;
  let head;
  try { head = atob(s.slice(0, 4)); } catch { return null; }
  return head.charCodeAt(0) === 0xff && head.charCodeAt(1) === 0xd8 && head.charCodeAt(2) === 0xff ? s : null;
}
