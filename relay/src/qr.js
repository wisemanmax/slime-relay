// The dashboard's enrolment QR (Wave 8, F1a; imported by devices.js).
//
// A minimal QR Code encoder: byte mode, error correction level M, versions 1–3
// (up to 42 bytes; the enrolment link `slimewatch://enrol?code=K7Q4MZ2P` is 34,
// so it is always version 3, 29×29). Why hand-rolled: the dashboard loads
// nothing from a CDN and the relay has no npm dependencies, and the owner's
// iPhone camera opening the enrol link straight from the dashboard is the
// whole point of drawing one.
//
// devices.js runs it in the Worker when the owner issues an invite and sends
// the rows in the reply (`qr`); the dashboard only paints them. (Shipping this
// function's source to the page instead breaks once deployed: wrangler's
// bundler rewrites function bodies with __name(…) helper calls.) It uses only
// JavaScript built-ins — no TextEncoder — so it runs anywhere unchanged.
//
// After ISO/IEC 18004 (and Project Nayuki's reference implementation): data
// codewords → Reed–Solomon ECC over GF(256) (x^8+x^4+x^3+x^2+1) → function
// patterns → zig-zag placement → the lowest-penalty of the 8 masks → format
// bits. Returns rows of booleans (row-major, true = dark, no quiet zone), or
// null when the text doesn't fit version 3-M.

export function devQR(text) {
  let bytes;
  try {   // UTF-8 without TextEncoder: encodeURIComponent's %XX escapes are the bytes
    bytes = (encodeURIComponent(String(text)).match(/%[0-9A-F]{2}|[^%]/g) || [])
      .map((c) => (c.length === 3 ? parseInt(c.slice(1), 16) : c.charCodeAt(0)));
  } catch (e) { return null; }
  // [size, data codewords, ECC codewords, alignment centres] for level M (one block each).
  const VERSIONS = [[21, 16, 10, []], [25, 28, 16, [6, 18]], [29, 44, 26, [6, 22]]];
  const fit = VERSIONS.find((v) => 4 + 8 + 8 * bytes.length <= v[1] * 8);
  if (!fit) return null;
  const [size, nData, nEc, align] = fit;

  // Bit stream: mode 0100 (byte), an 8-bit count, the bytes, a ≤ 4-bit
  // terminator, zeros to a byte boundary, then the 0xEC/0x11 pad codewords.
  const bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(4, 4); put(bytes.length, 8); bytes.forEach((b) => put(b, 8));
  put(0, Math.min(4, nData * 8 - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xEC; data.length < nData; pad ^= 0xEC ^ 0x11) data.push(pad);

  // Reed–Solomon: the generator ∏(x − α^i), i < nEc, then the remainder of data·x^nEc.
  const mul = (x, y) => {
    let z = 0;
    for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; }
    return z;
  };
  const gen = new Array(nEc).fill(0);
  gen[nEc - 1] = 1;
  for (let i = 0, root = 1; i < nEc; i++, root = mul(root, 2)) {
    for (let j = 0; j < nEc; j++) { gen[j] = mul(gen[j], root); if (j + 1 < nEc) gen[j] ^= gen[j + 1]; }
  }
  const ecc = new Array(nEc).fill(0);
  for (const b of data) {
    const f = b ^ ecc.shift();
    ecc.push(0);
    for (let j = 0; j < nEc; j++) ecc[j] ^= mul(gen[j], f);
  }
  const all = data.concat(ecc);

  // Function patterns: timing lines, three finders (with separators), the
  // alignment pattern, the format areas and the dark module.
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  }
  for (const cx of align) for (const cy of align) {
    if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  // Format: level M (00) + the mask, BCH(15,5) with 0x537, XOR 0x5412; two copies.
  const format = (mask) => {
    let r = mask;
    for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const f = ((mask << 10) | r) ^ 0x5412;
    const bit = (i) => ((f >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  format(0);   // reserves the format areas before the data goes in

  // Zig-zag: two-module columns from the right, alternating up and down,
  // skipping the vertical timing column. Leftover (remainder) modules stay light.
  let k = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!fn[y][x] && k < all.length * 8) { m[y][x] = ((all[k >>> 3] >>> (7 - (k & 7))) & 1) === 1; k++; }
      }
    }
  }

  // Masks (x = column, y = row) and the penalty rules: runs of ≥ 5, 2×2
  // blocks, finder look-alikes (1011101 beside four light modules), balance.
  const MASKS = [
    (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const flip = (mask) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[mask](x, y)) m[y][x] = !m[y][x];
  };
  const penalty = () => {
    let p = 0, dark = 0;
    const line = (get) => {
      let s = '';
      for (let i = 0; i < size; i++) s += get(i) ? '1' : '0';
      for (const run of s.match(/0+|1+/g)) if (run.length >= 5) p += run.length - 2;
      const q = '0000' + s + '0000';
      for (let i = q.indexOf('1011101'); i >= 0; i = q.indexOf('1011101', i + 1)) {
        if (q.slice(i - 4, i) === '0000' || q.slice(i + 7, i + 11) === '0000') p += 40;
      }
    };
    for (let i = 0; i < size; i++) { line((x) => m[i][x]); line((y) => m[y][i]); }
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (m[y][x]) dark++;
      if (x + 1 < size && y + 1 < size && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
    }
    return p + 10 * Math.max(0, Math.ceil(Math.abs(dark * 20 - size * size * 10) / (size * size)) - 1);
  };
  let best = 0, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    flip(mask); format(mask);
    const score = penalty();
    if (score < bestScore) { bestScore = score; best = mask; }
    flip(mask);
  }
  flip(best); format(best);
  return m;
}
