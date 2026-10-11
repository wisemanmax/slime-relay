// Generates the PWA icon set into src/app/icons/ — node stdlib only (zlib for
// deflate, a hand-rolled CRC32 + PNG chunk writer). Deterministic: running it
// again produces byte-identical files, so the PNGs are committed and
// `npm run build` just embeds them; re-run this (`npm run icons`) only when
// changing the artwork.
//
// The mark: a green slime blob (a circle smooth-unioned with three drips) with
// a dark "S" cut into it, on the app's near-black. Drawn with signed distance
// functions, so edges are anti-aliased analytically at every size.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app', 'icons');

// ── PNG encoding ─────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;   // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Shapes (unit square, y down) ─────────────────────────────────────────────────
const BG = [10, 13, 11];          // #0a0d0b
const GREEN_TOP = [94, 230, 128]; // lighter at the top of the blob
const GREEN_BOT = [40, 178, 76];  // ~#35C759 through the middle
const INK = [10, 13, 11];

const len = (x, y) => Math.hypot(x, y);
function sdSegment(px, py, ax, ay, bx, by, r) {
  const pax = px - ax, pay = py - ay, bax = bx - ax, bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return len(pax - bax * h, pay - bay * h) - r;
}
function smin(a, b, k) {   // polynomial smooth minimum: the "goo" between blob and drips
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
function sdBlob(x, y) {
  let d = len(x - 0.5, y - 0.45) - 0.30;
  d = smin(d, sdSegment(x, y, 0.33, 0.62, 0.33, 0.80, 0.050), 0.07);
  d = smin(d, sdSegment(x, y, 0.52, 0.66, 0.52, 0.87, 0.060), 0.07);
  d = smin(d, sdSegment(x, y, 0.69, 0.60, 0.69, 0.75, 0.042), 0.07);
  return d;
}
// The "S": two 3/4 arcs meeting in the middle, round caps.
const SC = [0.5, 0.45], SR = 0.083, SW = 0.036;
const DEG = Math.PI / 180;
function sdArc(x, y, cx, cy, r, inRange, a0, a1) {
  const dx = x - cx, dy = y - cy;
  const ang = Math.atan2(dy, dx) / DEG;
  if (inRange(ang)) return Math.abs(len(dx, dy) - r);
  const e0 = len(x - (cx + r * Math.cos(a0 * DEG)), y - (cy + r * Math.sin(a0 * DEG)));
  const e1 = len(x - (cx + r * Math.cos(a1 * DEG)), y - (cy + r * Math.sin(a1 * DEG)));
  return Math.min(e0, e1);
}
function sdS(x, y) {
  // Top bowl: from upper-right (-35deg) back over the top and left, down to the junction (90deg).
  const top = sdArc(x, y, SC[0], SC[1] - SR, SR, a => a <= -35 || a >= 90, -35, 90);
  // Bottom bowl: from the junction (-90deg) round the right and bottom to lower-left (145deg).
  const bot = sdArc(x, y, SC[0], SC[1] + SR, SR, a => a >= -90 && a <= 145, -90, 145);
  return Math.min(top, bot) - SW;
}
function sdRoundBox(x, y, half, r) {
  const qx = Math.abs(x - 0.5) - half + r, qy = Math.abs(y - 0.5) - half + r;
  return len(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
function over(dst, src, a) {   // straight-alpha "source over"
  const outA = a + dst[3] * (1 - a);
  if (outA <= 0) return [0, 0, 0, 0];
  const c = [0, 1, 2].map(i => (src[i] * a + dst[i] * dst[3] * (1 - a)) / outA);
  return [...c, outA];
}

/** shape: 'rounded' (transparent corners) | 'full' (opaque square). scale: glyph size. */
function render(size, { shape, scale }) {
  const px = 1 / size;
  const cov = (d) => Math.max(0, Math.min(1, 0.5 - d / px));   // analytic AA, ~1px ramp
  const buf = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = (i + 0.5) / size, y = (j + 0.5) / size;
      let c = [0, 0, 0, 0];
      const bgA = shape === 'full' ? 1 : cov(sdRoundBox(x, y, 0.5, 0.225));
      c = over(c, BG, bgA);
      // Glyph space: scaled about the centre.
      const gx = 0.5 + (x - 0.5) / scale, gy = 0.5 + (y - 0.5) / scale;
      const gpx = px / scale;
      const gcov = (d) => Math.max(0, Math.min(1, 0.5 - d / gpx));
      const blobA = gcov(sdBlob(gx, gy)) * bgA;
      if (blobA > 0) {
        const t = Math.max(0, Math.min(1, (gy - 0.15) / 0.72));
        c = over(c, mix(GREEN_TOP, GREEN_BOT, t), blobA);
        // A soft highlight, top-left, for the wet look.
        const hl = gcov(len(gx - 0.335, gy - 0.31) - 0.038) * 0.35;
        if (hl > 0) c = over(c, [255, 255, 255], hl * blobA);
        const sA = gcov(sdS(gx, gy)) * blobA;
        if (sA > 0) c = over(c, INK, sA);
      }
      const o = (j * size + i) * 4;
      buf[o] = Math.round(c[0]); buf[o + 1] = Math.round(c[1]); buf[o + 2] = Math.round(c[2]);
      buf[o + 3] = Math.round(c[3] * 255);
    }
  }
  return encodePNG(size, buf);
}

const SET = [
  ['favicon-32.png',         32,  { shape: 'rounded', scale: 1.08 }],
  ['apple-touch-icon.png',   180, { shape: 'full',    scale: 0.86 }],  // iOS masks it itself; must be opaque
  ['icon-192.png',           192, { shape: 'rounded', scale: 0.92 }],
  ['icon-512.png',           512, { shape: 'rounded', scale: 0.92 }],
  ['icon-maskable-512.png',  512, { shape: 'full',    scale: 0.74 }],  // glyph inside the 80% safe zone
];

mkdirSync(OUT, { recursive: true });
for (const [name, size, opts] of SET) {
  const png = render(size, opts);
  writeFileSync(path.join(OUT, name), png);
  console.log(`${name.padEnd(24)} ${size}x${size}  ${png.length} bytes`);
}
