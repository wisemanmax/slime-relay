/* HLS playback for the ad-free / anime tier, the /vt converter and Live TV.

   hls.js 1.5.17 is VENDORED: build.mjs inlines node_modules/hls.js/dist/
   hls.min.js byte-for-byte as its own <script> ahead of the app bundle (it
   used to come from jsdelivr). It is deliberately not re-bundled through
   esbuild: the UMD build spawns its transmux Web Worker by stringifying its
   own outer function, which re-minification would break, and the ESM build
   has no worker at all. So it is read here as window.Hls. */

import { setLoading, setHint } from './session.js';

let hls = null;

/** The live hls.js instance, if the current source is playing through it. */
export const hlsInstance = () => hls;

export function destroyHls() { if (hls) { hls.destroy(); hls = null; } }

/** Which engine playHls would use for `v`: Safari's own ('native') or hls.js. */
export function hlsMode(v) {
  if (v && v.canPlayType && v.canPlayType('application/vnd.apple.mpegurl')) return 'native-hls';
  const Hls = typeof window !== 'undefined' && window.Hls;
  return Hls && Hls.isSupported() ? 'hls.js' : 'native-hls';
}

/** Play an HLS URL in `v`.
      opts.config   extra hls.js config (e.g. { startPosition: 0 } for a rolling playlist)
      opts.onFatal  (details) => void — a fatal hls.js error; default: the Live TV hint
      opts.onReady  (hls) => void — the hls.js instance, before the manifest loads
    Returns the engine used: 'native-hls' | 'hls.js'. */
export function playHls(v, url, opts = {}) {
  destroyHls();
  v.onloadeddata = () => setLoading(false);
  const mode = hlsMode(v);
  if (mode === 'native-hls') { v.src = url; v.play().catch(() => {}); return mode; }
  const Hls = window.Hls;
  hls = new Hls(Object.assign({}, opts.config || {}));
  const mine = hls;
  if (opts.onReady) opts.onReady(hls);
  hls.loadSource(url); hls.attachMedia(v);
  hls.on(Hls.Events.MANIFEST_PARSED, () => { setLoading(false); v.play().catch(() => {}); });
  hls.on(Hls.Events.ERROR, (_, d) => {
    if (!d.fatal || hls !== mine) return;
    setLoading(false);
    if (opts.onFatal) opts.onFatal(d); else setHint('Stream error — try another channel.');
  });
  return mode;
}
