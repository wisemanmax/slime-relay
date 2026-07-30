/* Guards the two ways this file breaks silently.
 *
 * page.js is ONE giant template literal, so a stray backtick anywhere — even
 * inside a CSS or JS comment — terminates the string and takes the whole site
 * down. `node --check src/page.js` does NOT catch it reliably, and rendering
 * through a pipe that swallows stderr reports success on a stale artifact.
 * Both of those have now bitten twice, so: render it, parse the inner script,
 * and exit non-zero on either failure. */
import { PAGE } from './src/page.js';

let bad = 0;
const fail = m => { console.error('FAIL:', m); bad = 1; };

if (typeof PAGE !== 'string' || PAGE.length < 1000) fail('PAGE did not render to a string');

const scripts = [...String(PAGE).matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (!scripts.length) fail('no inline <script> found in the rendered page');

// Parse each inline script the way a browser would.
for (const [i, src] of scripts.entries()) {
  try { new Function(src); }
  catch (e) { fail(`inline script #${i + 1} does not parse: ${e.message}`); }
}

// Cheap structural smoke tests for the phone layout.
for (const marker of ['id="tabbar"', 'id="pills"', 'max-width:700px', 'stagewrap']) {
  if (!String(PAGE).includes(marker)) fail(`missing expected markup/CSS: ${marker}`);
}

if (!bad) console.log(`ok — ${PAGE.length} bytes, ${scripts.length} inline scripts parsed`);
process.exit(bad);
