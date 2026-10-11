/* Toasts: small notices stacked at the bottom of the screen (top while the
   player is open, so they never cover the video controls). Used for the
   "Updated" service-worker notice, the install hint and player feedback.

     toast(text, opts) -> { close }
       opts.html      text is trusted HTML (default: plain text)
       opts.id        a toast with the same id replaces the previous one
       opts.action    label for an action button; tapping the toast body runs it too
       opts.onAction  called when the action is taken (the toast then closes)
       opts.onClose   called as onClose(reason): 'dismiss' (the x) | 'action' | 'timeout' | 'replaced' | 'closed'
       opts.timeout   ms before auto-close; 0 = stays until dismissed (default 3500, or 0 with an action) */

import { $ } from '../util.js';

const live = new Map();   // id -> close()

export function toast(text, opts = {}) {
  const host = $('toasts'); if (!host) return { close() {} };
  const id = opts.id || null;
  if (id && live.has(id)) live.get(id)('replaced');

  const el = document.createElement('div');
  el.className = 'toast'; el.setAttribute('role', 'status');
  const tx = document.createElement('span'); tx.className = 'tx';
  if (opts.html) tx.innerHTML = text; else tx.textContent = text;
  el.appendChild(tx);

  let done = false, timer = null;
  const close = (reason = 'closed') => {
    if (done) return; done = true; clearTimeout(timer);
    el.remove(); if (id && live.get(id) === close) live.delete(id);
    if (opts.onClose) opts.onClose(reason);
  };
  if (opts.action) {
    const b = document.createElement('button'); b.className = 'ta'; b.type = 'button'; b.textContent = opts.action;
    el.appendChild(b);
    el.style.cursor = 'pointer';
    el.addEventListener('click', (e) => {
      if (e.target.closest('.tx-close')) return;
      const fn = opts.onAction; close('action'); if (fn) fn();
    });
  }
  const x = document.createElement('button'); x.className = 'tx-close'; x.type = 'button';
  x.setAttribute('aria-label', 'Dismiss'); x.textContent = '✕';
  x.addEventListener('click', (e) => { e.stopPropagation(); close('dismiss'); });
  el.appendChild(x);

  host.appendChild(el);
  if (id) live.set(id, close);
  const ms = opts.timeout != null ? opts.timeout : (opts.action ? 0 : 3500);
  if (ms > 0) timer = setTimeout(() => close('timeout'), ms);
  return { close };
}

/** Close a toast by id, if showing. */
export function closeToast(id, reason = 'closed') { const c = live.get(id); if (c) c(reason); }
