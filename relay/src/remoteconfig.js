// Remote config on the relay (Wave 8, F6a; roadmap F6, TELEMETRY-AUTOFIX-SPEC
// phase 3): the owner's dashboard publishes `forceVLCFor` rules under a
// monotonic configVersion, canaries a config to one or a few devices, promotes
// it, and rolls back in one tap; each extractor heartbeat's /register reply
// carries the result as `config`, and the apps read it from the extractor's
// token-gated /manifest (never from the relay). Contract: Wave 8 contracts.md §3.
// Storage: KV key `rc:doc` (not time-critical; KV's ~60 s is fine here).
//
// Exports used by worker.js (scaffold lines — keep the names and shapes):
//   handleRemoteConfig(request, env, ctx) -> Promise<Response>   /admin/config*
//   configFleetBlock(env) -> Promise<{} | { config }>            merged into /register's reply
//   configPanelHTML() / configPanelScript() -> string            the dashboard's Remote fixes section
// Pure helpers exported for the tests: checkBlock / checkEntry / checkRule (the
// closed set), applyAction (the doc transitions), readDoc, blockOf, rcParseRules.
//
// Why so strict: the ONE thing a config can say is "play this debrid stream with
// libVLC". It can never force AVPlayer (that could bring back the HEVC black
// screen), every key and value is checked against the baked enums, and any
// unknown key or bad value rejects the WHOLE block — the readers (extractor,
// apps) then keep what they had. Only the owner publishes; nothing auto-applies.
//
// The KV doc keeps more than the block: lastKnownGood, the counter of issued
// configVersions and a history (≤ 50 lines) for Restore. Extractors get only
// `{v, version, active, canary}`. Doc writes are read-modify-write on KV (not
// atomic): fine for one owner clicking buttons, not for two admins racing.
//
// Never delete `rc:doc` to "reset": versions restart at 1 and every extractor
// and app ignores a version at or below the one it holds. To turn everything
// off, Roll back to the built-in behaviour or publish an empty rule list.

const RC_KEY = 'rc:doc';
const HISTORY_MAX = 50;
const MAX_BODY = 64 * 1024;
const POSTS_PER_MIN = 30;

// ── The closed set (contracts.md §3.2). SlimeWatchExtractor/lib/remoteconfig.js
// and VideoDeck/Player/Ladder/RemoteConfigRules.swift check exactly the same,
// and the shared vectors V1–V10 (test/remoteconfig.mjs) pin it. Error strings
// name fixed keys and indices only — never a value from the payload — so the
// extractor can log them as they are. ──
export const RULE_KEYS = ['title', 'codec', 'container', 'platform'];
export const CODECS = ['h264', 'hevc', 'av1', 'vp9', 'mpeg2', 'mpeg4', 'vc1'];
export const CONTAINERS = ['mp4', 'mkv', 'avi', 'ts', 'm2ts', 'webm', 'mov', 'wmv'];
export const PLATFORMS = ['ios', 'tvos', 'macos'];
export const MAX_RULES = 50;
export const MAX_DEVICES = 10;
export const MAX_NOTE = 120;
const TITLE_RE = /^(movie|tv):[1-9][0-9]{0,8}$/;
const DEVICE_RE = /^[A-Za-z0-9._-]{1,80}$/;   // worker.js's DEVICE_RE (the apps' presence ids)
const BLOCK_KEYS = ['v', 'version', 'active', 'canary'];
const ENTRY_KEYS = ['configVersion', 'forceVLCFor', 'note', 'issuedAt'];
const VALUES = { codec: CODECS, container: CONTAINERS, platform: PLATFORMS };

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const posInt = (x) => Number.isSafeInteger(x) && x > 0;
const clone = (x) => JSON.parse(JSON.stringify(x));
// A JSON object: not null, not an array, not some other class.
function isPlain(x) {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false;
  const p = Object.getPrototypeOf(x);
  return p === Object.prototype || p === null;
}
const onlyKeys = (o, allowed) => Object.keys(o).every((k) => allowed.includes(k));

/// One rule → '' when valid, else why. A rule names ≥ 1 key; its keys are ANDed.
export function checkRule(r, at = 'rule') {
  if (!isPlain(r)) return `${at}: not an object`;
  if (!Object.keys(r).length) return `${at}: names no key (use title, codec, container or platform)`;
  if (!onlyKeys(r, RULE_KEYS)) return `${at}: unknown key (allowed: ${RULE_KEYS.join(', ')})`;
  if (has(r, 'title') && !(typeof r.title === 'string' && TITLE_RE.test(r.title))) {
    return `${at}: title must be movie:<id> or tv:<id> (TMDB id)`;
  }
  for (const k of ['codec', 'container', 'platform']) {
    if (has(r, k) && !(typeof r[k] === 'string' && VALUES[k].includes(r[k]))) {
      return `${at}: ${k} must be one of ${VALUES[k].join(', ')}`;
    }
  }
  return '';
}

/// One config (`active`, `canary` or last-known-good) → '' or why. `where`
/// prefixes the messages ('' for a route body). Only a canary has `devices`.
export function checkEntry(e, where = '', canary = false) {
  const at = (k) => (where ? `${where}.${k}` : k);
  if (!isPlain(e)) return `${where || 'config'}: not an object`;
  if (!onlyKeys(e, canary ? [...ENTRY_KEYS, 'devices'] : ENTRY_KEYS)) {
    return `${where || 'config'}: unknown key${canary ? '' : ' (devices is for a canary only)'}`;
  }
  if (!posInt(e.configVersion)) return `${at('configVersion')} must be a positive integer`;
  if (!Array.isArray(e.forceVLCFor) || e.forceVLCFor.length > MAX_RULES) {
    return `${at('forceVLCFor')} must be an array of at most ${MAX_RULES} rules`;
  }
  for (let i = 0; i < e.forceVLCFor.length; i++) {
    const err = checkRule(e.forceVLCFor[i], `${at('forceVLCFor')}[${i}]`);
    if (err) return err;
  }
  if (has(e, 'note') && !(typeof e.note === 'string' && e.note.length <= MAX_NOTE)) {
    return `${at('note')} must be text of at most ${MAX_NOTE} characters`;
  }
  if (has(e, 'issuedAt') && !(Number.isSafeInteger(e.issuedAt) && e.issuedAt >= 0)) {
    return `${at('issuedAt')} must be epoch milliseconds`;
  }
  if (canary) {
    if (!Array.isArray(e.devices) || e.devices.length < 1 || e.devices.length > MAX_DEVICES) {
      return `${at('devices')} must list 1–${MAX_DEVICES} device ids`;
    }
    for (let i = 0; i < e.devices.length; i++) {
      if (!(typeof e.devices[i] === 'string' && DEVICE_RE.test(e.devices[i]))) return `${at('devices')}[${i}] is not a device id`;
    }
  }
  return '';
}

/// The whole block (§3.1) → '' or why. `active` and `canary` may each be absent
/// or null: no active = nothing published (or rolled back past the first
/// publish) — devices outside the canary use their built-in engine choice.
export function checkBlock(b) {
  if (!isPlain(b)) return 'block: not an object';
  if (!onlyKeys(b, BLOCK_KEYS)) return 'block: unknown key';
  if (b.v !== 1) return 'block: v must be 1';
  if (!posInt(b.version)) return 'block: version must be a positive integer';
  for (const k of ['active', 'canary']) {
    if (b[k] === undefined || b[k] === null) continue;
    const err = checkEntry(b[k], k, k === 'canary');
    if (err) return err;
  }
  return '';
}

/// The block every extractor gets: no history, no last-known-good, no counter.
/// An empty slot is left out (readers treat absent and null alike).
export function blockOf(doc) {
  const b = { v: 1, version: doc.version };
  if (doc.active) b.active = doc.active;
  if (doc.canary) b.canary = doc.canary;
  return b;
}

function emptyDoc() {
  return { v: 1, version: 0, lastConfigVersion: 0, active: null, canary: null, lastKnownGood: null, history: [] };
}

const UNREADABLE = 'the stored remote config (KV rc:doc) is unreadable';

/// KV text → { doc } or { error }. A missing doc is the empty one; a doc that
/// doesn't hold together is an error (never silently "empty": that would
/// restart the versions every reader orders by).
export function readDoc(raw) {
  if (raw === null || raw === undefined || raw === '') return { doc: emptyDoc() };
  let j;
  try { j = JSON.parse(raw); } catch { return { error: UNREADABLE }; }
  if (!isPlain(j) || !Number.isSafeInteger(j.version) || j.version < 0) return { error: UNREADABLE };
  const doc = emptyDoc();
  doc.version = j.version;
  for (const k of ['active', 'canary', 'lastKnownGood']) {
    const e = j[k] === undefined ? null : j[k];
    if (e !== null && checkEntry(e, k, k === 'canary')) return { error: UNREADABLE };
    doc[k] = e;
  }
  doc.history = Array.isArray(j.history) ? j.history.filter(isPlain).slice(-HISTORY_MAX) : [];
  // The counter never goes backwards, even if the stored one is missing or low.
  const issued = [doc.active, doc.canary, doc.lastKnownGood].filter(Boolean).map((e) => e.configVersion)
    .concat(doc.history.map((h) => h.configVersion).filter(posInt));
  doc.lastConfigVersion = Math.max(Number.isSafeInteger(j.lastConfigVersion) ? j.lastConfigVersion : 0, 0, ...issued);
  return { doc };
}

// An entry as it goes into `active`: the content only (no canary devices),
// stamped with when it took that place.
function asActive(e, now) {
  const out = { configVersion: e.configVersion, forceVLCFor: clone(e.forceVLCFor) };
  if (e.note) out.note = e.note;
  out.issuedAt = now;
  return out;
}

// The newest content stored under configVersion `cv` (the three slots, then the
// history newest first), or null. A history line must itself pass the closed set.
function findContent(doc, cv) {
  for (const e of [doc.active, doc.canary, doc.lastKnownGood]) if (e && e.configVersion === cv) return e;
  for (let i = doc.history.length - 1; i >= 0; i--) {
    const h = doc.history[i];
    if (h.configVersion !== cv || !Array.isArray(h.forceVLCFor)) continue;
    const e = { configVersion: cv, forceVLCFor: h.forceVLCFor, ...(typeof h.note === 'string' && h.note ? { note: h.note } : {}) };
    if (!checkEntry(e)) return e;
  }
  return null;
}

// A route body's rules/note(/devices) → a new entry under the next configVersion.
function inputEntry(doc, body, now, canary) {
  if (!Array.isArray(body.forceVLCFor)) return { error: 'forceVLCFor must be an array of rules' };
  let note = body.note === undefined || body.note === null ? '' : body.note;
  if (typeof note !== 'string') return { error: 'note must be text' };
  note = note.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();   // display text: one line, no control chars
  const entry = { configVersion: doc.lastConfigVersion + 1, forceVLCFor: body.forceVLCFor };
  if (note) entry.note = note;
  entry.issuedAt = now;
  if (canary) {
    if (!Array.isArray(body.devices)) return { error: `devices must list 1–${MAX_DEVICES} device ids` };
    entry.devices = [...new Set(body.devices)];
  }
  const err = checkEntry(entry, '', canary);
  if (err) return { error: err };
  // Rule keys in one fixed order, so the dashboard and the history read alike.
  entry.forceVLCFor = entry.forceVLCFor.map((r) => Object.fromEntries(RULE_KEYS.filter((k) => has(r, k)).map((k) => [k, r[k]])));
  return { entry: clone(entry) };
}

const contentOf = (e) => ({
  configVersion: e.configVersion, forceVLCFor: clone(e.forceVLCFor),
  ...(e.note ? { note: e.note } : {}), ...(Array.isArray(e.devices) ? { devices: [...e.devices] } : {}),
});
const bad = (error) => ({ error, status: 400 });
const conflict = (error) => ({ error, status: 409 });

// The body fields each action reads (anything else is a mistake: 400); null =
// the action reads no body at all.
const ACTIONS = {
  publish: ['forceVLCFor', 'note'],
  canary: ['forceVLCFor', 'note', 'devices'],
  promote: null,
  rollback: null,
  restore: ['configVersion'],
};

/// One owner action on the doc → { doc } (a new object; version +1, one history
/// line) or { error, status } (nothing changes). Pure: the route stores it.
///   publish  lastKnownGood ← active; active ← new configVersion; canary cleared
///   canary   canary ← new configVersion (active untouched)
///   promote  lastKnownGood ← active; active ← canary; canary ← null
///   rollback a canary → dropped; else active ← lastKnownGood (null = built-in)
///   restore  like publish, with the content of an earlier configVersion
export function applyAction(doc, action, body = {}, now = Date.now()) {
  if (!has(ACTIONS, action)) return { error: 'unknown action', status: 404 };
  const fields = ACTIONS[action];
  if (fields && !onlyKeys(body, fields)) return bad(`${action} takes only ${fields.join(', ')}`);
  const d = clone(doc);
  let line;
  if (action === 'publish' || action === 'canary') {
    const r = inputEntry(d, body, now, action === 'canary');
    if (r.error) return bad(r.error);
    d.lastConfigVersion = r.entry.configVersion;
    if (action === 'publish') {
      line = { ...contentOf(r.entry), from: d.active ? d.active.configVersion : null };
      d.lastKnownGood = d.active;
      d.active = r.entry;
      d.canary = null;
    } else {
      line = { ...contentOf(r.entry), from: d.canary ? d.canary.configVersion : null };
      d.canary = r.entry;
    }
  } else if (action === 'promote') {
    if (!d.canary) return conflict('there is no canary to promote');
    const next = asActive(d.canary, now);
    line = { ...contentOf(next), from: d.active ? d.active.configVersion : null };
    d.lastKnownGood = d.active;
    d.active = next;
    d.canary = null;
  } else if (action === 'rollback') {
    if (d.canary) {
      line = { target: 'canary', from: d.canary.configVersion, configVersion: null };
      d.canary = null;
    } else {
      if (!d.active) return conflict('nothing to roll back: every device already uses its built-in engine choice');
      if (d.lastKnownGood && d.lastKnownGood.configVersion === d.active.configVersion) {
        return conflict('already on the last known good config; use Restore to go further back');
      }
      line = { target: 'active', from: d.active.configVersion, configVersion: null };
      d.active = d.lastKnownGood ? asActive(d.lastKnownGood, now) : null;
      if (d.active) Object.assign(line, contentOf(d.active));
    }
  } else {   // restore
    const cv = body.configVersion;
    if (!posInt(cv)) return bad('configVersion must be a positive integer');
    const src = findContent(d, cv);
    if (!src) return bad(`configVersion ${cv} is not in the history`);
    if (d.active && d.active.configVersion === cv) return conflict(`v${cv} is already active`);
    const next = asActive(src, now);
    line = { ...contentOf(next), from: d.active ? d.active.configVersion : null };
    d.lastKnownGood = d.active;
    d.active = next;
    d.canary = null;
  }
  d.version += 1;
  d.history.push({ version: d.version, at: now, action, ...line });
  if (d.history.length > HISTORY_MAX) d.history.splice(0, d.history.length - HISTORY_MAX);
  // Belt and braces: what we would hand the fleet must pass the closed set.
  const err = checkBlock(blockOf(d));
  if (err) return { error: `internal: ${err}`, status: 500 };
  return { doc: d };
}

async function loadDoc(env) {
  try { return readDoc(await env.SERVERS.get(RC_KEY)); } catch { return { error: 'relay storage unavailable', status: 503 }; }
}
const publicDoc = (d) => ({ version: d.version, active: d.active, canary: d.canary, lastKnownGood: d.lastKnownGood, history: d.history });

async function readBody(request) {
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY) return { error: 'body too large', status: 413 };
  let text;
  try { text = await request.text(); } catch { return bad('bad json'); }
  if (text.length > MAX_BODY) return { error: 'body too large', status: 413 };
  if (!text.trim()) return { body: {} };
  let body;
  try { body = JSON.parse(text); } catch { return bad('bad json'); }
  if (!isPlain(body)) return bad('the body must be a JSON object');
  return { body };
}

/// /admin/config (GET: the doc) and /admin/config/<action> (POST). Admin only.
export async function handleRemoteConfig(request, env, ctx) {
  const { json } = ctx;
  if (!ctx.isAdmin) return json({ error: 'unauthorized' }, 401);
  const path = new URL(request.url).pathname.replace(/\/+$/, '');
  if (path === '/admin/config') {
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    const { doc, error, status } = await loadDoc(env);
    if (error) return json({ error }, status || 500);
    return json({ doc: publicDoc(doc) });
  }
  const action = path.startsWith('/admin/config/') ? path.slice('/admin/config/'.length) : '';
  if (!has(ACTIONS, action)) return json({ error: 'not found' }, 404);
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  // Writes only: the dashboard polls GET every 5 s, and a limiter bucket is a
  // KV write per call.
  if (await ctx.rateLimited(env, `rc:${ctx.clientIP}`, POSTS_PER_MIN)) return json({ error: 'rate limited' }, 429);
  let body = {};
  if (ACTIONS[action]) {
    const r = await readBody(request);
    if (r.error) return json({ error: r.error }, r.status);
    body = r.body;
  }
  const loaded = await loadDoc(env);
  if (loaded.error) return json({ error: loaded.error }, loaded.status || 500);
  const res = applyAction(loaded.doc, action, body, Date.now());
  if (res.error) return json({ error: res.error }, res.status);
  try { await env.SERVERS.put(RC_KEY, JSON.stringify(res.doc)); } catch { return json({ error: 'relay storage unavailable' }, 503); }
  return json({ ok: true, doc: publicDoc(res.doc) });
}

/// Merged into every /register reply: { config: block } once something was
/// published, else {} — so an old-style reply is byte-for-byte unchanged. One KV
/// read per heartbeat; never fails the heartbeat (a broken doc sends nothing,
/// and the extractors keep what they hold).
export async function configFleetBlock(env) {
  try {
    const { doc } = readDoc(await env.SERVERS.get(RC_KEY));
    if (!doc || !doc.version) return {};
    const block = blockOf(doc);
    return checkBlock(block) ? {} : { config: block };
  } catch { return {}; }
}

/// The dashboard's rules textarea → { rules, lines } or { error }. One rule per
/// line (`title=tv:1399 platform=tvos`), `#` starts a comment, blank lines are
/// skipped. Syntax only — the route checks keys and values against the closed
/// set; `lines[i]` is rule i's line number, for its messages. Self-contained on
/// purpose: configPanelScript() ships this function's own source to the page.
export function rcParseRules(text) {
  const rules = [], lines = [];
  const src = String(text === null || text === undefined ? '' : text).split(/\r?\n/);
  for (let i = 0; i < src.length; i++) {
    const line = src[i].replace(/#.*$/, '').trim();
    if (!line) continue;
    const rule = {};
    for (const tok of line.split(/[\s,;]+/)) {
      if (!tok) continue;
      const m = /^([A-Za-z]+)=(\S+)$/.exec(tok);
      if (!m) return { error: 'line ' + (i + 1) + ': write key=value pairs, e.g. title=tv:1399 platform=tvos' };
      if (Object.prototype.hasOwnProperty.call(rule, m[1])) return { error: 'line ' + (i + 1) + ': ' + m[1] + ' appears twice' };
      rule[m[1]] = m[2];
    }
    rules.push(rule);
    lines.push(i + 1);
  }
  return { rules, lines };
}

/// The "Remote fixes" section, after the Servers grid. Static: the script only
/// re-renders #rcState and #rcHistory, so the form is never clobbered mid-typing.
export function configPanelHTML() {
  return `
    <h2 class="sec" id="rcTop">Remote fixes</h2>
    <p class="note">Send matching <b>debrid</b> streams to libVLC — never to AVPlayer — without an app build.
      Servers pick a change up on their next heartbeat (≤ ~1 min); a device applies it at its next manifest
      refresh (launch or foreground) and its next play.</p>
    <div id="rc" class="rc">
      <div id="rcState" class="grid"><div class="empty small">Loading…</div></div>
      <div class="rcform">
        <label class="rcl" for="rcRules">Rules — one per line; every key on a line must match, any line forces</label>
        <textarea id="rcRules" rows="4" spellcheck="false" placeholder="title=tv:1399 platform=tvos&#10;codec=hevc container=mp4"></textarea>
        <div class="rckeys">title=movie:&lt;id&gt;|tv:&lt;id&gt; · codec=${CODECS.join('|')} · container=${CONTAINERS.join('|')} · platform=${PLATFORMS.join('|')}</div>
        <label class="rcl" for="rcNote">Note (shown in the apps' Settings)</label>
        <input id="rcNote" maxlength="${MAX_NOTE}" placeholder="why — e.g. GoT S1: black frames on AVPlayer">
        <label class="rcl" for="rcDevices">Canary devices</label>
        <input id="rcDevices" spellcheck="false" placeholder="device ids, comma-separated — or “Canary here” on a Now Watching card">
        <div class="ctl rcbtns">
          <button class="pri" data-rc="publish">Publish</button>
          <button data-rc="canary">Canary</button>
          <button id="rcPromote" data-rc="promote">Promote</button>
          <button id="rcRollback" data-rc="rollback">Roll back</button>
        </div>
        <div id="rcMsg" class="rcmsg" role="status"></div>
      </div>
      <h3 class="rcl rch">History</h3>
      <div id="rcHistory" class="rchist"><div class="rcempty">Loading…</div></div>
    </div>
    <style>
      .rc{max-width:980px;margin:0 auto}
      #rcState{margin-bottom:14px}
      .rccard .rcv{color:var(--accent);font:12px ui-monospace,Menlo,monospace}
      .rccard.canary{border-color:#2f6b52}
      .rcnote{font-size:13px;margin:6px 0;word-break:break-word}
      .rcrules{margin:8px 0 0;padding-left:18px;font:12px/1.6 ui-monospace,Menlo,monospace;color:var(--accent);word-break:break-all}
      .rcrules .rcnone{color:var(--dim);list-style:none;margin-left:-18px}
      .rcdev{margin-top:6px;font-size:12px;color:var(--dim);word-break:break-all}
      .rcempty{color:var(--dim);font-size:12px;margin:8px 0}
      .rcform{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:8px}
      .rcl{color:var(--dim);text-transform:uppercase;letter-spacing:1px;font-size:10px;font-weight:700}
      .rcform textarea,.rcform input{width:100%;background:#0d120f;border:1px solid var(--line);color:var(--txt);border-radius:9px;padding:8px;font:13px/1.4 ui-monospace,Menlo,monospace}
      .rcform textarea:focus,.rcform input:focus{outline:none;border-color:var(--accent)}
      .rckeys{color:var(--dim);font:11px ui-monospace,Menlo,monospace;word-break:break-word}
      .rcbtns button:disabled{opacity:.4;cursor:default}
      .rcmsg{color:var(--accent);font-size:12px;min-height:16px}
      .rch{margin:18px 0 8px}
      .rchist{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:4px 16px}
      .rch1{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:8px 0;border-bottom:1px solid var(--line);font-size:13px}
      .rch1:last-child{border-bottom:0}
      .rch1 .rcvn{color:var(--dim);font:11px ui-monospace,Menlo,monospace}
      .rch1 .seen{margin-left:auto;color:var(--dim);font-size:12px}
      .rch1 button{background:#0d120f;border:1px solid var(--line);color:var(--dim);border-radius:9px;padding:4px 10px;font-size:12px;cursor:pointer}
      .rch1 button:hover{border-color:var(--accent);color:var(--txt)}
      .rctag{color:var(--accent);font-size:11px}
    </style>`;
}

/// The panel's script. It shares the page's one inline script (KEY, esc, ago,
/// flash, own, DEV_RE), so everything here sits in an IIFE with rc names. Its
/// clicks are listened for on #rc and #watchers — not on document, where the
/// page's own delegated listener lives (and its buttons say data-rc, never
/// data-act, so that listener ignores them). "Canary here" rides on the Now
/// Watching cards by wrapping the page's watcher(): the only place a card's
/// device id is known. String.raw keeps the regexes' backslashes as written.
export function configPanelScript() {
  return String.raw`
;(function(){
  var RC_KEYS=${JSON.stringify(RULE_KEYS)}, RC_MAX_DEVICES=${MAX_DEVICES}, RC_SLOTS=['active','canary','lastKnownGood'];
  var rcDoc=null, rcLines=[];
  function rc$(id){return document.getElementById(id);}
  // An expression, so the page never depends on the name the bundler kept.
  var rcParse=(${rcParseRules.toString()});
  function rcRuleLine(r){return RC_KEYS.filter(function(k){return own(r,k);}).map(function(k){return k+'='+r[k];}).join(' ');}
  function rcAgo(ms){return ms?ago(ms):'';}
  function rcMsg(t){var m=rc$('rcMsg');if(m)m.textContent=t||'';}
  function rcCard(label,slot,e,empty){
    if(!e)return '<div class="card rccard dim"><div class="row1"><span class="name">'+esc(label)+'</span><span class="os">none</span></div><div class="rcempty">'+esc(empty)+'</div></div>';
    var rules=Array.isArray(e.forceVLCFor)?e.forceVLCFor:[];
    var list=rules.length?rules.map(function(r){return '<li>'+esc(rcRuleLine(r))+'</li>';}).join(''):'<li class="rcnone">forces nothing</li>';
    var devs=Array.isArray(e.devices)?'<div class="rcdev">devices: '+e.devices.map(esc).join(', ')+'</div>':'';
    return '<div class="card rccard '+esc(slot)+'"><div class="row1"><span class="name">'+esc(label)+'</span><span class="rcv">v'+esc(e.configVersion)+'</span><span class="os">'+esc(rcAgo(e.issuedAt))+'</span></div>'
      +(e.note?'<div class="rcnote">'+esc(e.note)+'</div>':'')+'<ul class="rcrules">'+list+'</ul>'+devs
      +'<div class="rt"><button data-rc="edit" data-rc-slot="'+esc(slot)+'">Edit a copy</button></div></div>';
  }
  function rcHist(h){
    var v=function(x){return x?'v'+x:'built-in';}, what;
    switch(h.action){
      case 'publish': what='published '+v(h.configVersion); break;
      case 'canary': what='canary '+v(h.configVersion)+' on '+(Array.isArray(h.devices)?h.devices.length:0)+' device(s)'; break;
      case 'promote': what='promoted '+v(h.configVersion)+' to every device'; break;
      case 'rollback': what=h.target==='canary'?'dropped canary '+v(h.from):'rolled back '+v(h.from)+' → '+v(h.configVersion); break;
      case 'restore': what='restored '+v(h.configVersion); break;
      default: what=String(h.action||'?');
    }
    if(Array.isArray(h.forceVLCFor))what+=' · '+h.forceVLCFor.length+' rule(s)';
    var canRestore=Array.isArray(h.forceVLCFor)&&h.configVersion&&!(rcDoc&&rcDoc.active&&rcDoc.active.configVersion===h.configVersion);
    return '<div class="rch1"><span class="rcvn">#'+esc(h.version)+'</span><span>'+esc(what)+'</span>'
      +(h.note?'<span class="rcnote">'+esc(h.note)+'</span>':'')+'<span class="seen">'+esc(rcAgo(h.at))+'</span>'
      +(canRestore?'<button data-rc="restore" data-rc-cv="'+esc(h.configVersion)+'">Restore</button>':'')+'</div>';
  }
  function rcRender(){
    var d=rcDoc;if(!d)return;
    var s=rc$('rcState');
    if(s)s.innerHTML=rcCard('Active','active',d.active,'Nothing published: every device uses its built-in engine choice.')
      +rcCard('Canary','canary',d.canary,'No canary running.')
      +rcCard('Last known good','lastKnownGood',d.lastKnownGood,'Rolling back the active config goes to the built-in engine choice.');
    var h=rc$('rcHistory'), list=Array.isArray(d.history)?d.history.slice(-10).reverse():[];
    if(h)h.innerHTML=list.length?list.map(rcHist).join(''):'<div class="rcempty">No changes yet.</div>';
    var p=rc$('rcPromote');if(p)p.disabled=!d.canary;
    var b=rc$('rcRollback');if(b)b.disabled=!d.canary&&!d.active;
  }
  async function rcRefresh(){
    try{var r=await fetch('/admin/config?key='+encodeURIComponent(KEY));if(!r.ok)return;
      var j=await r.json();if(j&&j.doc){rcDoc=j.doc;rcRender();}}catch(e){}
  }
  // A route error about rule i names the textarea line it came from.
  function rcLineOf(m){return String(m).replace(/^forceVLCFor\[(\d+)\]/,function(_,i){return rcLines[+i]?'line '+rcLines[+i]:'rule '+(+i+1);});}
  async function rcPost(act,body,done){
    try{
      var r=await fetch('/admin/config/'+act+'?key='+encodeURIComponent(KEY),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});
      var j=null;try{j=await r.json();}catch(e){}
      if(!r.ok){flash(rcLineOf((j&&j.error)||('HTTP '+r.status)));return false;}
      if(j&&j.doc){rcDoc=j.doc;rcRender();}
      rcMsg(done);return true;
    }catch(e){flash('network error');return false;}
  }
  function rcVal(id){var el=rc$(id);return String((el&&el.value)||'');}
  function rcDevices(){return rcVal('rcDevices').split(/[\s,]+/).filter(Boolean);}
  function rcRules(){var p=rcParse(rcVal('rcRules'));if(p.error){flash(p.error);return null;}rcLines=p.lines;return p.rules;}
  function rcCount(rules){return rules.length?rules.length+' rule(s)':'an empty rule list (forces nothing)';}
  async function rcAct(d){
    var act=d.rc, doc=rcDoc||{}, rules, devs;
    if(act==='publish'){
      if(!(rules=rcRules()))return;
      if(!confirm('Publish '+rcCount(rules)+' to EVERY device?'+(doc.active?' It replaces v'+doc.active.configVersion+'.':'')+(doc.canary?' The canary is cleared.':'')))return;
      await rcPost('publish',{forceVLCFor:rules,note:rcVal('rcNote').trim()},'Published.');
    }else if(act==='canary'){
      if(!(rules=rcRules()))return;
      devs=rcDevices();
      if(!devs.length){flash('add at least one device id (Now Watching → Canary here)');return;}
      if(!confirm('Canary '+rcCount(rules)+' on '+devs.length+' device(s): '+devs.join(', ')+'?'))return;
      await rcPost('canary',{forceVLCFor:rules,note:rcVal('rcNote').trim(),devices:devs},'Canary started.');
    }else if(act==='promote'){
      if(!doc.canary){flash('there is no canary to promote');return;}
      if(!confirm('Promote canary v'+doc.canary.configVersion+' to EVERY device?'))return;
      await rcPost('promote',{},'Promoted.');
    }else if(act==='rollback'){
      var q=doc.canary?'Drop canary v'+doc.canary.configVersion+'? Its devices go back to '+(doc.active?'v'+doc.active.configVersion:'the built-in engine choice')+'.'
        :doc.active?'Roll EVERY device back from v'+doc.active.configVersion+' to '+(doc.lastKnownGood?'v'+doc.lastKnownGood.configVersion+' (last known good)':'the built-in engine choice')+'?':'';
      if(!q){flash('nothing to roll back');return;}
      if(!confirm(q))return;
      await rcPost('rollback',{},'Rolled back.');
    }else if(act==='restore'){
      var cv=Number(d.rcCv);if(!(cv>0))return;
      if(!confirm('Make v'+cv+' the config for EVERY device again?'))return;
      await rcPost('restore',{configVersion:cv},'Restored v'+cv+'.');
    }else if(act==='edit'){
      if(RC_SLOTS.indexOf(d.rcSlot)<0)return;
      var e=doc[d.rcSlot];if(!e)return;
      var t=rc$('rcRules');if(t)t.value=(e.forceVLCFor||[]).map(rcRuleLine).join('\n');
      var n=rc$('rcNote');if(n)n.value=e.note||'';
      if(Array.isArray(e.devices)){var dv=rc$('rcDevices');if(dv)dv.value=e.devices.join(', ');}
      rcMsg('Copied v'+e.configVersion+' into the editor.');
    }else if(act==='here'){
      var id=String(d.rcDevice||''), el=rc$('rcDevices');if(!DEV_RE.test(id)||!el)return;
      devs=rcDevices();
      if(devs.indexOf(id)<0){if(devs.length>=RC_MAX_DEVICES){flash('a canary takes at most '+RC_MAX_DEVICES+' devices');return;}devs.push(id);}
      el.value=devs.join(', ');
      rcMsg('Canary devices: '+devs.length+'. Write the rules, then press Canary.');
      var top=rc$('rcTop');if(top&&top.scrollIntoView)top.scrollIntoView({behavior:'smooth',block:'start'});
    }
  }
  function rcClick(e){var b=e.target&&e.target.closest&&e.target.closest('button[data-rc]');if(!b||b.disabled)return;rcAct(b.dataset);}
  function rcOn(el){if(el&&typeof el.addEventListener==='function')el.addEventListener('click',rcClick);}
  rcOn(rc$('rc'));rcOn(rc$('watchers'));
  if(typeof watcher==='function'){
    var rcWatcher0=watcher;
    watcher=function(w){
      var h=rcWatcher0(w), id=String((w&&w.id)||'');
      if(!DEV_RE.test(id))return h;
      var c=rcDoc&&rcDoc.canary, inC=!!(c&&Array.isArray(c.devices)&&c.devices.indexOf(id)>=0);
      var x='<div class="rt">'+(inC?'<span class="rctag">in canary v'+esc(c.configVersion)+'</span>':'')
        +'<button data-rc="here" data-rc-device="'+esc(id)+'">Canary here</button></div>';
      var i=h.lastIndexOf('</div>');
      return i<0?h:h.slice(0,i)+x+h.slice(i);
    };
  }
  rcRefresh();setInterval(rcRefresh,5000);
})();`;
}
