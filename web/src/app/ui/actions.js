/* Delegated click actions.

   Markup declares WHAT a click does — data-act="detail" data-id="550"
   data-kind="movie" — and one listener on document finds the closest
   [data-act] and calls the handler registered under that name with
   (element, event). This replaces the old inline onclick="..." attributes,
   which needed every function to be a global and which the Worker's
   Content-Security-Policy now blocks. Never add an inline on* handler:
   register an action instead (check.mjs fails the build on inline handlers).

   Handlers are registered at module top level by the module that owns the
   behaviour (views/detail.js registers 'detail', player/player.js registers
   'player-close', ...). Names are global — onAction throws on a duplicate. */

const handlers = Object.create(null);

export function onAction(name, fn) {
  if (handlers[name]) throw new Error('duplicate action "' + name + '"');
  handlers[name] = fn;
}

/** The registered action names (for checks/debugging). */
export const actionNames = () => Object.keys(handlers);

export function initActions(root = document) {
  root.addEventListener('click', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!el) return;
    const fn = handlers[el.dataset.act];
    if (fn) fn(el, e);
    else console.warn('no handler for data-act="' + el.dataset.act + '"');
  });
}
