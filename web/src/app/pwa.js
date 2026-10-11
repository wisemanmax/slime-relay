/* Service worker registration + the "Updated" toast.

   sw.js (src/app/sw.js, served ungated by the Worker) caches the app shell
   under a cache named for the build. A deploy changes the build id inside
   sw.js, the browser installs the new worker in the background, and it WAITS
   (no automatic skipWaiting) until the viewer taps the toast — then it takes
   over and the page reloads onto the new build. Nothing reloads under a
   viewer mid-film without that tap. */

import { toast } from './ui/toast.js';

export function initPwa() {
  if (!('serviceWorker' in navigator)) return;
  let userAsked = false, reloading = false;

  // Fires on first install too (clients.claim) — only reload when asked to.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!userAsked || reloading) return;
    reloading = true; location.reload();
  });

  const offer = (worker) => toast('<b>SlimeWatch updated.</b> Tap to reload.', {
    id: 'sw-update', html: true, action: 'Reload',
    onAction: () => {
      userAsked = true;
      worker.postMessage({ type: 'SKIP_WAITING' });
      // If the takeover never signals (worker already gone), reload anyway.
      setTimeout(() => { if (!reloading) { reloading = true; location.reload(); } }, 3000);
    },
  });

  // Registration is not urgent: let the shell and the first catalog calls go first.
  window.addEventListener('load', async () => {
    let reg;
    try { reg = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }); }
    catch (_) { return; }   // e.g. plain http on a LAN address: the app works without it
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing; if (!w) return;
      w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
      });
    });
    // Hash routing means no navigations, so a long-lived tab or home-screen app
    // would rarely re-check sw.js. Ask again when it comes back to the front.
    let last = Date.now();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < 10 * 60 * 1000) return;
      last = Date.now(); reg.update().catch(() => {});
    });
  });
}
