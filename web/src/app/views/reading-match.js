/* "Is this search hit the same series?" — the "Read from" picker's title
   match, ported from the iOS ReadingTitleMatch (pure; unit-checked).

   Strict on purpose: Mangapill lists "One Piece - Digital Colored Comics" and
   "One Piece Party" right after One Piece itself, and opening a side title
   under the right name is worse than finding nothing. Scores:
     exact (normalised) 100 > same letters ignoring spaces 95 > word prefix
     80 − 6 per extra/missing word > word overlap ≤ 60,
     +8 when both years agree (±1), −30 when they're 3+ apart,
     −40 per side-title marker ("colored", "party", "dj"…) the candidate has
     and the query doesn't,
   and only ≥ 75 is accepted. */

export const ACCEPT = 75;

export const SIDE_MARKERS = new Set([
  'colored', 'coloured', 'colour', 'color', 'colors', 'digital', 'party', 'green', 'red', 'blue', 'yellow',
  'dj', 'doujin', 'doujinshi', 'databook', 'novel', 'anthology', 'fanbook', 'guidebook', 'artbook',
  'spinoff', 'gaiden', 'buddy', 'stories', 'omake', 'academy', 'pilot', 'oneshot',
]);

/** Lowercased, accents folded, "&"→"and", "×"→"x", punctuation → spaces, a leading "the" dropped. */
export function normalizeTitle(s) {
  let t = String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/×/g, ' x ')
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  if (t.startsWith('the ')) t = t.slice(4);
  return t;
}
const tokens = (s) => normalizeTitle(s).split(' ').filter(Boolean);
const startsWith = (a, b) => b.length <= a.length && b.every((w, i) => a[i] === w);

/** One query title against one candidate title. */
export function scoreTitle(query, candidate, queryYear = null, candidateYear = null) {
  const q = tokens(query), c = tokens(candidate);
  if (!q.length || !c.length) return 0;
  let base;
  if (q.join(' ') === c.join(' ')) base = 100;
  else if (q.join('') === c.join('')) base = 95;
  else if (startsWith(c, q) || startsWith(q, c)) base = 80 - 6 * Math.abs(c.length - q.length);
  else {
    const qs = new Set(q), cs = new Set(c);
    const inter = [...qs].filter(w => cs.has(w)).length;
    base = 60 * inter / new Set([...qs, ...cs]).size;
  }
  if (queryYear && candidateYear) {
    const d = Math.abs(queryYear - candidateYear);
    if (d <= 1) base += 8; else if (d >= 3) base -= 30;
  }
  const qs = new Set(q);
  base -= 40 * [...new Set(c)].filter(w => !qs.has(w) && SIDE_MARKERS.has(w)).length;
  return Math.min(base, 108);
}

/** The best candidate for any of `titles` (candidates' own altTitles count too),
    or null when nothing reaches ACCEPT. -> { item, score } */
export function bestMatch(titles, year, candidates) {
  let best = null;
  for (const c of candidates || []) {
    const names = [c.title, ...(c.altTitles || [])].filter(Boolean);
    let s = 0;
    for (const t of titles) for (const n of names) s = Math.max(s, scoreTitle(t, n, year, c.year));
    if (!best || s > best.score) best = { item: c, score: s };
  }
  return best && best.score >= ACCEPT ? best : null;
}

/** The search strings worth sending: the title, then up to two distinct Latin alt titles. */
export function matchQueries(title, altTitles = []) {
  const seen = new Set();
  const out = [];
  for (const t of [title, ...altTitles]) {
    const n = normalizeTitle(t);
    if (!n || !/\p{Script=Latin}/u.test(n) || seen.has(n)) continue;
    seen.add(n); out.push(t);
    if (out.length === 3) break;
  }
  return out;
}
