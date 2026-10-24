/* Wave 7 (P5, roadmap 7.3/7.4) — '#party/<CODE>': the Watch Party join page for
   a signed-in visitor (the room's title, host, members with their avatars,
   control mode, Join), then the party panel (chat, reactions, who's here)
   beside the player. Until P5 lands it renders Home, exactly as the unknown
   route did. */

import { viewHome } from './home.js';

export function viewParty(arg) {
  void arg;
  viewHome();   // TODO(W7-P5)
}
