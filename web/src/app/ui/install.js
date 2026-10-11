/* "Install as an app" hints.
   - Chrome / Edge / Android: the browser fires beforeinstallprompt; we keep it
     and offer an Install toast (and an Install row in Settings).
   - iOS / iPadOS: there is no prompt API, so after a few seconds we show the
     Share -> Add to Home Screen instructions once.
   Closing the toast with its x stores installHint='dismissed' (device-only),
   which silences the automatic hint; Settings still offers it. */

import { getState, setState } from '../state.js';
import { toast, closeToast } from './toast.js';
import { onAction } from './actions.js';
import { isPlayerOpen } from '../player/session.js';

let deferred = null;   // the stashed beforeinstallprompt event

export const isStandalone = () => {
  try { if (window.matchMedia('(display-mode: standalone)').matches) return true; } catch (_) {}
  return navigator.standalone === true;
};
// iPadOS reports itself as a Mac; the touch points give it away. (Android is
// excluded outright: emulators/devtools can pair an Android UA with MacIntel.)
export const isIOS = () => !/Android/i.test(navigator.userAgent) &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

/** 'installed' | 'prompt' (installable now) | 'ios' (Share sheet) | 'none' */
export function installMode() {
  if (isStandalone()) return 'installed';
  if (deferred) return 'prompt';
  if (isIOS()) return 'ios';
  return 'none';
}

const IOS_TEXT = 'Install SlimeWatch: tap <b>Share</b>, then <b>Add to Home Screen</b>.';
const dismissHint = () => setState({ installHint: 'dismissed' });

export async function promptInstall() {
  const mode = installMode();
  if (mode === 'prompt') {
    const e = deferred; deferred = null; closeToast('install');
    try { e.prompt(); const c = await e.userChoice; if (c && c.outcome === 'dismissed') dismissHint(); } catch (_) {}
    return;
  }
  if (mode === 'ios') toast(IOS_TEXT, { id: 'install', html: true, timeout: 0 });
}

function maybeHint() {
  if (getState().installHint === 'dismissed' || isPlayerOpen()) return;
  const onClose = (reason) => { if (reason === 'dismiss') dismissHint(); };
  const mode = installMode();
  if (mode === 'prompt') toast('Install <b>SlimeWatch</b> as an app?', { id: 'install', html: true, action: 'Install', onAction: promptInstall, onClose });
  else if (mode === 'ios') toast(IOS_TEXT, { id: 'install', html: true, timeout: 0, onClose });
}

/** The Settings sheet's "Install app" section ('' when there's nothing to offer). */
export function installRowHTML() {
  const mode = installMode();
  if (mode !== 'prompt' && mode !== 'ios') return '';
  return `<div style="margin-top:22px;padding-top:18px;border-top:1px solid var(--line)">
      <h1 style="font-size:18px;margin:0 0 6px">Install app</h1>
      <p class="ov" style="margin:4px 0 12px">${mode === 'ios'
        ? 'Tap <b>Share</b>, then <b>Add to Home Screen</b> — SlimeWatch then opens full-screen, like an app.'
        : 'Add SlimeWatch to your home screen or dock; it opens in its own window.'}</p>
      ${mode === 'prompt' ? '<button class="btn ghost" data-act="install">Install</button>' : ''}
    </div>`;
}

onAction('install', () => promptInstall());

export function initInstall() {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; maybeHint(); });
  window.addEventListener('appinstalled', () => { deferred = null; closeToast('install'); });
  if (isIOS() && !isStandalone()) setTimeout(maybeHint, 4000);
}
