/* Global keyboard handling.
     Esc   close player / detail / settings (but an Esc that leaves fullscreen
           only leaves fullscreen — the browser consumes it for that)
     /     focus search (header field on desktop, the Search screen on phones)
     + the player shortcuts in player/player.js handlePlayerKey()
   Nothing fires while typing in a field, and keys held with Ctrl/Cmd/Alt are
   left to the browser (Cmd+F is find, not fullscreen). */

import { closePlayer, fsActive, handlePlayerKey } from './player/player.js';
import { isPlayerOpen } from './player/session.js';
import { closeDetail } from './views/detail.js';
import { closeSettings, isSettingsOpen } from './ui/settings.js';
import { focusSearch } from './views/search.js';

/* A focused <video controls> has its own keyboard handling (Chrome acts on
   space/arrows at the video, on keyup), which would double-toggle with ours —
   observed: space did play+pause, i.e. nothing. So shortcuts run in the window
   CAPTURE phase, and a key we handle while the video has focus is stopped
   there, together with its keyup, before the native controls see it. */
const swallowKeyup = new Set();

export function initKeys() {
  window.addEventListener('keyup', e => {
    if (swallowKeyup.delete(e.key)) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  window.addEventListener('keydown', e => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '') || (e.target && e.target.isContentEditable);
    if (e.key === 'Escape') {
      // The browser exits fullscreen on Escape by itself. Closing the player in
      // the same keystroke would end playback when all the viewer asked for was
      // the window back, so let that Escape be consumed by leaving fullscreen.
      if (fsActive()) return;
      closePlayer(); closeDetail(); closeSettings(); return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isPlayerOpen()) {
      if (handlePlayerKey(e)) {
        e.preventDefault();
        const tag = e.target && e.target.tagName;
        if (tag === 'VIDEO') { e.stopPropagation(); swallowKeyup.add(e.key); }
        // A bar button keeps focus after a click; drop it so Space doesn't also "click" it.
        if (tag === 'BUTTON') e.target.blur();
      }
      return;
    }
    if (e.key === '/' && !isSettingsOpen()) { e.preventDefault(); closeDetail(); focusSearch(); }
  }, true);
}
