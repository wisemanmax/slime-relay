// Builds the SPA in src/app/ into the two modules the Worker imports:
//
//   src/generated/page.js    PAGE — the whole app as ONE HTML string: the shell
//                            (src/app/index.html) with the stylesheet and both
//                            scripts inlined (vendored hls.js, then the app bundle)
//   src/generated/static.js  STATIC — the ungated files: /sw.js, the manifest, icons
//
// Both are committed, so `wrangler deploy` needs no build step. `npm run build`
// regenerates them; `npm test` = build + check.mjs, and check.mjs fails if the
// committed files are stale. Output is deterministic (no timestamps): the same
// sources always give byte-identical files.
//
// Usage: node build.mjs            write src/generated/*
//        import { build } ...      build({ write: false }) -> in-memory result (check.mjs)

import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(ROOT, 'src', 'app');
const OUT = path.join(ROOT, 'src', 'generated');

/** Per-request CSP nonce marker; the Worker swaps in a fresh random nonce. */
export const NONCE_PLACEHOLDER = '__SLIMEWATCH_CSP_NONCE__';

const read = (...p) => readFileSync(path.join(...p), 'utf8');
const sha = (...parts) => { const h = createHash('sha256'); for (const p of parts) h.update(p); return h.digest('hex'); };

/** Literal (non-$-pattern) replace of exactly one occurrence. */
function replaceOnce(haystack, marker, value, what) {
  const i = haystack.indexOf(marker);
  if (i < 0 || haystack.indexOf(marker, i + 1) >= 0) throw new Error(`${what}: expected exactly one ${marker}`);
  return haystack.slice(0, i) + value + haystack.slice(i + marker.length);
}

/** Text that will sit inside a raw-text HTML element must not be able to end it early. */
function assertInlineSafe(text, tag, what) {
  if (new RegExp('</' + tag, 'i').test(text)) throw new Error(`${what} contains "</${tag}" — it would end the inline <${tag}> early`);
  if (tag === 'script' && /<!--/.test(text)) throw new Error(`${what} contains "<!--", which changes how browsers parse an inline script`);
  if (text.includes(NONCE_PLACEHOLDER)) throw new Error(`${what} contains the CSP nonce placeholder`);
}

/** Emit a string as a JS array of JSON line literals (line-level diffs, no template-literal traps). */
const asLines = (s) => '[\n' + s.split(/(?<=\n)/).map(l => JSON.stringify(l)).join(',\n') + '\n].join(\'\')';

function vendorHls() {
  const pkg = JSON.parse(read(ROOT, 'node_modules', 'hls.js', 'package.json'));
  if (!/^1\.5\./.test(pkg.version)) throw new Error(`hls.js ${pkg.version} installed; the app is pinned to 1.5.x (npm install)`);
  // Byte-for-byte the published UMD build, minus its source-map pointer (the
  // .map isn't served, and the gate would just bounce the request).
  const src = read(ROOT, 'node_modules', 'hls.js', 'dist', 'hls.min.js').replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '\n');
  return { version: pkg.version, src };
}

export async function build({ write = true } = {}) {
  const common = { absWorkingDir: ROOT, bundle: true, write: false, logLevel: 'silent', legalComments: 'none' };

  const css = (await esbuild.build({ ...common, entryPoints: ['src/app/styles/index.css'] })).outputFiles[0].text;
  const js = (await esbuild.build({
    ...common,
    entryPoints: ['src/app/main.js'],
    format: 'iife',
    target: 'es2020',          // the syntax the single-file app already used (?. ?? etc.)
    charset: 'ascii',          // non-ASCII escaped: the inline script is pure ASCII
  })).outputFiles[0].text;
  const hls = vendorHls();

  assertInlineSafe(css, 'style', 'bundled CSS');
  assertInlineSafe(hls.src, 'script', 'hls.min.js');
  assertInlineSafe(js, 'script', 'app bundle');

  const shell = read(APP, 'index.html');
  if (/<script|<style|\son[a-z]+\s*=/i.test(shell.replace(/<!--[\s\S]*?-->/g, ''))) {
    throw new Error('index.html must stay a shell: no <script>, <style> or inline on* handlers (use data-act)');
  }
  const scriptTag = (body) => `<script nonce="${NONCE_PLACEHOLDER}" data-cfasync="false">${body}</script>`;
  let page = replaceOnce(shell, '<!--BUILD:CSS-->', `<style>\n${css}</style>`, 'index.html');
  page = replaceOnce(page, '<!--BUILD:JS-->', scriptTag(hls.src) + '\n' + scriptTag('\n' + js), 'index.html');

  // Static, ungated files.
  const manifest = read(APP, 'manifest.webmanifest');
  JSON.parse(manifest);   // fail the build on a malformed manifest
  const icons = readdirSync(path.join(APP, 'icons')).filter(f => f.endsWith('.png')).sort()
    .map(f => ({ path: '/icons/' + f, bytes: readFileSync(path.join(APP, 'icons', f)) }));
  const BUILD_ID = sha(page, manifest, ...icons.map(i => i.bytes)).slice(0, 12);
  const shellAssets = ['/manifest.webmanifest', ...icons.map(i => i.path)];
  let sw = read(APP, 'sw.js');
  sw = replaceOnce(sw, "'__BUILD_ID__'", JSON.stringify(BUILD_ID), 'sw.js');
  sw = replaceOnce(sw, '__STATIC_ASSETS__', JSON.stringify(shellAssets), 'sw.js');

  const STATIC = {
    '/sw.js': { type: 'text/javascript; charset=utf-8', cache: 'no-cache', text: sw },
    '/manifest.webmanifest': { type: 'application/manifest+json; charset=utf-8', cache: 'public, max-age=3600', text: manifest },
  };
  for (const i of icons) STATIC[i.path] = { type: 'image/png', cache: 'public, max-age=86400', base64: i.bytes.toString('base64') };

  const banner = '// GENERATED by build.mjs from src/app/ — do not edit. Run `npm run build`.\n';
  const pageJs = banner +
    `// build ${BUILD_ID} · ${page.length} chars · hls.js ${hls.version} vendored\n` +
    `export const BUILD_ID = ${JSON.stringify(BUILD_ID)};\n` +
    `export const NONCE_PLACEHOLDER = ${JSON.stringify(NONCE_PLACEHOLDER)};\n` +
    `export const PAGE = ${asLines(page)};\n`;
  const staticJs = banner +
    `// build ${BUILD_ID}\nexport const STATIC = {\n` +
    Object.entries(STATIC).map(([p, a]) => `  ${JSON.stringify(p)}: { type: ${JSON.stringify(a.type)}, cache: ${JSON.stringify(a.cache)}, ` +
      (a.text != null ? `text: ${asLines(a.text)}` : `base64: ${JSON.stringify(a.base64)}`) + ' },\n').join('') +
    '};\n';

  if (write) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(path.join(OUT, 'page.js'), pageJs);
    writeFileSync(path.join(OUT, 'static.js'), staticJs);
  }
  return { BUILD_ID, page, css, js, hls: hls.src, sw, STATIC, files: { 'page.js': pageJs, 'static.js': staticJs } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await build();
  console.log(`built ${r.BUILD_ID}: page ${(r.page.length / 1024).toFixed(0)} KB (app ${(r.js.length / 1024).toFixed(0)} KB, css ${(r.css.length / 1024).toFixed(0)} KB, hls ${(r.hls.length / 1024).toFixed(0)} KB) -> src/generated/`);
}
