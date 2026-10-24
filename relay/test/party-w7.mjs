// Wave 7 (W7-P1): replace this placeholder with the real cases — companion
// roles, control mode, avatars, the backward-compatibility checks (an old
// client's hello / settings, a room stored before Wave 7). Run: node test/party-w7.mjs
import assert from 'node:assert/strict';
import { AVATAR_MAX_BYTES, AVATAR_MAX_B64, AVATAR_FRAME_MAX, avatarKey, validAvatar } from '../src/party-avatar.js';

assert.equal(AVATAR_MAX_BYTES, 6144);
assert.equal(AVATAR_MAX_B64, 8192);
assert.ok(AVATAR_FRAME_MAX > AVATAR_MAX_B64);
assert.equal(avatarKey('m_ab12'), 'avatar:m_ab12');
assert.equal(validAvatar('not base64 !!'), null);
console.log('party-w7: scaffold placeholder ok (5 checks)');
