# SlimeWatch Web (private)

A private, password-gated web version of SlimeWatch — a Cloudflare Worker that
serves a single-page app: browse the TMDB catalog (Home / Movies / TV / Anime /
Channels / Genres / Search / My List), Live TV + Sports, a detail sheet with a
season/episode picker, and a player whose ladder mirrors the apps: your own
Real-Debrid HD first, then an ad-free stream pulled by the extractor, then
provider-embed iframes. Each person picks their name ("Who's watching?") and
gets their own My List, Continue Watching and reading progress, synced between
their browsers. The
TMDB token stays server-side (the Worker proxies it), and the whole site sits
behind a password. It installs as an app (PWA) on iPhone, Android and desktop.

## Deploy (once)

```bash
cd web
./deploy.sh                 # prompts for a site password + your TMDB v4 read token
# …or non-interactively:
# ./deploy.sh "your-password" "your-tmdb-v4-token"
```

It installs dependencies, logs you into Cloudflare (browser once), sets three
secrets, builds + checks, and deploys. Later deploys: `npm run deploy` (build →
check → `wrangler deploy`). The generated files are committed, so a bare
`npx wrangler deploy` also works — but `npm run deploy` refuses to ship a stale
or broken build.

### Custom domain: watch.byheir.com
`wrangler.toml` routes the Worker to **https://watch.byheir.com** as a Cloudflare
*custom domain* (`custom_domain = true`). byheir.com is a zone on the same
Cloudflare account, so **the first deploy creates the DNS record and the
certificate itself** — no manual DNS step. It fails if a DNS record named
`watch` already exists in the zone; delete that record and deploy again.
The original `https://slime-web.<account>.workers.dev` URL keeps working
(`workers_dev = true` is explicit, because wrangler turns workers.dev off as
soon as a route exists). Cookies are host-only and every redirect is relative,
so login works on either host — but they are separate sites to the browser:
you sign in once per host, and an installed app belongs to the host it was
installed from. (`slime.byheir.com` is the extractor's tunnel; unrelated.)

### Secrets
| Secret | What |
|---|---|
| `SITE_PASSWORD` | the password you type to get in |
| `SESSION_SECRET` | a random string that signs the login cookie (auto-generated) |
| `TMDB_TOKEN` | your TMDB v4 read token, so the key never ships in the page |
| `SLIME_TOKEN` | the extractor token (same one the apps use) → Live/Sports + the ad-free tier, and the relay token Ask sends to `/assist` |
| `RD_KEY` | optional default Real-Debrid token, handed only to signed-in browsers |

Bindings in `wrangler.toml` (not secrets): the **`STATE`** KV namespace for sync
(`npx wrangler kv namespace create STATE`, paste its id over `PASTE_STATE_KV_ID`)
and the **`RELAY`** service binding to the `slime-relay` Worker for Ask (it must
be on the same Cloudflare account — otherwise delete that block and Ask uses
`RELAY_BASE`).

## Install as an app
- **iPhone / iPad:** open the site in Safari → Share → *Add to Home Screen*. The
  app shows this hint itself the first time (dismiss with ✕ to silence it).
- **Chrome / Edge / Android:** an *Install* toast appears; it's also in Settings (⚙).
- Sign in once inside the installed app (it has its own cookie jar on iOS).
- When a new version is deployed, an **"SlimeWatch updated — Reload"** toast
  appears; nothing reloads under you mid-film until you tap it.
- Offline, the app shell still opens (the catalog needs the network).

## Profiles — "Who's watching?"
Everyone who uses the site has their own history. Names only, no passwords: the
site password stays the one gate, and a name just says whose lists to show (like
the apps' profiles). Before profiles, every browser merged into ONE shared state.

- **Picker** (`src/app/profiles.js`): a full-screen "Who's watching?" overlay with
  a tile per name — the initial on a square in the profile's colour (the iOS
  picker's accents, black or white label by brightness) — and an **Add name** tile
  that becomes an inline field (Enter or Add). Each tile's **⋯** (or a long-press /
  right-click) opens **Delete**, which asks you to type the name; it deletes that
  person's lists and progress on every device. Shown at first visit (it can't be
  dismissed until a name is picked), from the header avatar (desktop) or the round
  icon in the phone header, and from Settings → Profile → **Switch profile**.
  Esc steps back inside it. The current name shows only in Settings and as the avatar.
- **Switching:** the old profile's queued changes are sent first (to the old
  profile); if they can't be (offline), the picker asks "Switch anyway?" and drops
  them. Then `POST /api/profiles/select`, the store's synced keys are emptied (no
  tombstones — nothing is being deleted), and a sync engine for the new profile
  pulls its state; the page re-renders when it lands (up to 4 s, then as it arrives).
  Ask's conversation is reset. The RD key and install hint stay (browser-wide).
- **First pick in a browser with history from before profiles** (`sw_list` /
  `sw_continue` / `sw_reading` not empty and no `sw_profile` ever set): "Bring this
  browser's history into <name>?" **Yes** keeps it and the first pull uploads what
  that profile lacks (the normal sync merge); **No** clears it.
- **Cookie + header:** `/select` sets `sw_profile=<id>` (HttpOnly; Secure;
  SameSite=Lax; Path=/; one year). The page also remembers `{id, name, color}` in
  the store's local `profile` key (`sw_profile` in localStorage) and names that id in
  an `x-sw-profile` header on every `/api/state` call; the Worker uses the cookie and
  refuses a header that disagrees, so a tab still holding someone else's data can
  never write it into the new profile. Another tab switching the browser's profile
  reloads this one.
- **Migration:** the first read of the profile list (or first create/select/delete),
  if the list was never written and the old shared state (`owner-state:v1`) holds
  anything, makes a grey **Shared** profile (id `shared`) and moves that blob to
  `state:shared` — today's merged history is kept, and the owner can delete it from
  the picker. It never overwrites an existing `state:shared`. An empty old state is
  left alone.
- **API** (`src/worker/profiles.js`, behind the gate; 503 without the KV binding —
  the browser then stays local and no picker shows):

  | Call | Answer |
  |---|---|
  | `GET /api/profiles` | `{profiles:[{id,name,color,createdAt,lastUsedAt}], current}` — `current` = the cookie's id if it names a profile |
  | `POST /api/profiles` `{name}` | 201 `{profile, profiles}` · 400 `bad-name` (1–24 characters once trimmed; spaces collapsed, invisible characters dropped) · 409 `name-taken` `{profile}` (any case) · 409 `too-many` (12 max) |
  | `POST /api/profiles/select` `{id}` | `{profile}` + the cookie (stamps `lastUsedAt`) · 404 `no-such-profile` |
  | `DELETE /api/profiles/<id>?confirm=<name>` | `{profiles}`; deletes `state:<id>` too and clears your cookie if it was yours · 400 `confirm-mismatch` (name, any case) · 404 |

  Ids are a slug of the name plus five random characters (`max-k3j9a`). The list
  is one KV value (`profiles`), so two browsers in different Cloudflare locations
  adding names in the same minute can lose one (KV is eventually consistent).

## Sync — the same lists on every browser
The apps sync through iCloud; the web keeps each profile's copy in the Worker's KV
(`STATE`, one JSON value per profile at `state:<profileId>`, behind the password
like everything else). Your My List, Continue Watching, reading progress and viewer
prefs follow you between the laptop, the phone and the installed app once you pick
your name on each. The RD key, the install-hint flag and the picked profile stay in
each browser (`local: true` in `SCHEMA`).

- **How:** `src/app/sync.js` pulls `/api/state` at boot, merges it into the
  store, then PUTs local changes back 1.5 s after they stop (a real change is
  never held more than 10 s). Playback position / page-turn ticks are held to
  one PUT a minute — KV writes are metered — and anything queued is sent at once
  when the tab is hidden or closed. Offline, changes queue (persisted, so a
  reload doesn't lose them) and flush on `online`. Another tab's writes are not
  re-sent. Without the KV binding the Worker answers 503 and the browser
  quietly stays local. Settings → Sync shows synced / offline / not set up.
- **Per profile:** an engine syncs one profile (`createSync({ profile })`). The
  offline queue lives in the `sync` key with the profile id it belongs to; an
  engine started for another profile drops it (a switch flushes first). A stopped
  engine's late answers never touch the store, and `flush()` sends the queue now
  and reports whether anything is left.
- **Merge rules** (`mergeData`, shared by client and Worker): every list /
  continue / reading entry carries `updatedAt`, stamped centrally by the store on
  each local write; per entry, the newest wins (the server's copy on a tie). A
  removal leaves a tombstone (`tombs`, kept 90 days) that beats any older copy,
  so a title removed on the laptop isn't resurrected by the phone. The same
  episode in Continue Watching keeps the further position. Each collection is
  re-sorted newest first and capped (list 60, continue 24, reading 300). Prefs
  merge key by key; a device keeps only its own unsent pref edits over the
  server's copy, so a pref removed elsewhere (captions turned off) stays removed.
- **API:** every call needs the profile: the `sw_profile` cookie picks the KV key
  and the `x-sw-profile` header must match it — **428** `{error:'no-profile'}` with
  no cookie, no header, or a deleted profile (the page shows the picker); **409**
  `{error:'profile-mismatch', profile}` when they disagree (the page reloads).
  `GET /api/state` → `{rev, updatedAt, data:{list, continue, prefs,
  reading, tombs}}`. `PUT /api/state` `{baseRev, patch}` (any of those keys) →
  `{rev, updatedAt, data}`, or **409** `{error:'stale', rev, updatedAt, data}` when
  `baseRev` isn't current — the client merges `data` and resends. 413 over 256 KB,
  400 on a malformed patch. A no-op PUT doesn't write. `GET /api/state/health` →
  `{build, sync, ask, extractor:{base, ok, status, ms, error}}` for Settings (no profile needed).
- **Consistency:** KV is eventually consistent across locations (~60 s). Two
  devices writing within a minute through different Cloudflare locations can
  lose one write until that device's next change or boot, which always merges
  its local copy in and uploads the difference — state converges, it doesn't fork.

## Ask
The apps' "Ask" assistant, in Search (`#search/ask`, or "✦ Ask SlimeWatch: …"
above any header-search results): describe a mood, a plot or a half-remembered
title; it looks things up and answers with picks shown as cards that open the
detail sheet. Follow-up chips refine the answer; "New chat" starts over. The
conversation lives in memory only. "Use My List & Continue Watching" (off by
default, `prefs.askHistory`) lets it see those titles — they are sent to the
model.

- The relay's `POST /assist` holds the model key, the system prompt and the
  tool list (`relay/src/assist.js`); `/api/ask` (`src/worker/ask.js`) forwards the
  body unchanged with the app token (`SLIME_TOKEN`) added server-side, 20 s
  timeout, the relay's status passed through (429 included); 504 on timeout,
  502 if the relay refuses the token.
- `src/app/ask.js` is a port of the apps' `AssistantSession` / `AssistantTools` /
  `AssistantLogic`: same request (`{messages, history}`, assistant messages sent
  back verbatim, every tool call answered by a `{role:'tool', tool_call_id,
  content}`), same tools run against `/api/tmdb/*`, same guards (picks must come
  from tool results, one correction for made-up ids, one nudge for 1–2 picks,
  length promises checked against TMDB runtimes, 7 rounds / 12 lookups,
  conversation trimmed under the relay's caps).

## Watch Party
Join an app's Watch Party room from the browser (roadmap Wave 7). A signed-in
visitor opening `watch.byheir.com/p/<CODE>` lands on `#party/<CODE>`: the room's
title, host, members (their room photos, else colour + emoji or initial) and
control mode, then **Join**. Signed out, `/p/<CODE>` goes to the relay's public
page as before (its "Watch in the browser" link comes back through the login);
`?companion=1` (the Apple TV's QR, for the app's chat-only seat) always goes
there, query kept.

- The browser is always an **ordinary member**: platform `web`, never host
  (the relay never hands it the room), never a companion. It follows the
  room's item and clock, sends play / pause / seek only when allowed (the host,
  or anyone in a `control: "shared"` room — refused locally first with "Only
  the host can control playback", then snapped back), chats, reacts and shows
  avatars. Voice clips appear as a chat line and are never played; the web
  never records or sends one, nor `settings` / `transferHost` / `kick` / `end` /
  `role` / `avatar`.
- Sync on the `<video>` (debrid, ad-free HLS, the /vt converter) uses the apps'
  AVPlayer rules: drift < 0.3 s nothing, < 2 s a ±5 % `playbackRate` nudge, else
  a seek with a 0.15 s lead; the converter seeks through `seekTo` and settles
  8 s. The embed iframe can't be driven: it reports `engine: "embed"` and shows
  "Not synced". A joiner starts at the room's clock, never its own resume point.
- The token never reaches the page: `/api/party/<CODE>[?avatars=1]` (peek) and
  `/api/party/<CODE>/ws` (the socket, upgrade forwarded) are proxied by
  `src/worker/party.js` with `SLIME_TOKEN`, through the `RELAY` binding (else
  `RELAY_BASE`), behind the password cookie; a cross-site upgrade is refused.
- Code: `party/rules.js` (pure: control rule, clock, drift, item mapping),
  `party/client.js` (the socket, DOM-free), `party/bind.js` (player glue; the
  player's two hooks are `session.party.seekIntent` and `.holdsEnd`),
  `views/party.js` (join page, lobby, the panel beside the player),
  `styles/party.css`; tests in `test/party.mjs` (incl. the relay's real reducer).
  Protocol: the relay's `party-reducer.js` header and the app repo's
  `docs/WATCH-PARTY.md`.

## Parity (Wave 8)
Roadmap 8.3: the web audited against the iPhone (the app repo's
`docs/WEB-PARITY-2026-10-24.md`, one matrix per area), then the three smallest
high-value gaps built. Staged, not deployed.

**Skip markers for everything** (`player/markers.js`, `player/skip.js`). Every title
asks TheIntroDB (theintrodb.org — community intro / recap / credits / preview windows
keyed by TMDB id; a film without season/episode) as it starts, and the skip button and
`s` key offer them the way they offer AniSkip's. On anime AniSkip wins per kind (its
opening and TheIntroDB's are the same stretch; credits count as its outro). Credits with
no end run to the end of the file: skipping lands 0.5 s short of it, so `ended` starts Up
Next (hidden on a converter session or before the length is known). The browser asks
api.theintrodb.org itself; when it refuses (CORS, a blocker) the page asks
`GET /api/player/markers?tmdb=&kind=&s=&e=` (`src/worker/player.js`: the answer cleaned to
the fields the page reads, `{}` for "not found", kept 6 h per isolate and
`private, max-age=21600` in the browser, failures never kept; 502 / 504) and goes straight
there for the rest of the page. One ask per title per page.

**Kids profiles and the Parent PIN** (`profilelock.js` pure rules, `kids.js` the runtime
gate, `profiles.js`, `src/worker/profiles.js`). The apps'
`MaturityPolicy` / `ParentPIN` / `ProfileLockRules`:
- A profile record may carry `kids: true` + `maturity` (`littleKids` | `olderKids` |
  `teens`, Older Kids by default) and `locked: true`; old records read as ordinary.
  The picker's ⋯ (or a long-press) opens **Edit**: Kids + level, Lock with Parent PIN,
  Delete. The grid's **Parent PIN** sets, changes or removes the household PIN.
- On a Kids profile `api()` runs every TMDB **list** answer through one gate
  (`setTmdbGate`): only titles whose US certification is at or under the cap stay
  (unrated ones go — fail closed); people go. A `discover/movie` carrying TMDB's own
  `certification.lte` ceiling is trusted as it is; anything else is checked per title
  (`movie/<id>/release_dates`, `tv/<id>/content_ratings` through `tmdbRaw`, at most six
  at once, cached in the store's device-only `certs` key — `sw_certs` — 90 days when
  rated, 7 when not; a failed lookup isn't kept). Home is the Kids line-up; the Movies
  pill, channels and genres put the ceiling on their movie queries; My List and Continue
  Watching are thinned; the title sheet asks the rating with the detail
  (`append_to_response`) and shows "Not available on this profile" + the reason; `play()`
  refuses first, for every caller. `#live`, `#read`, `#party` redirect Home and leave the
  bar / nav (`body.kids`, `layout.css`); Search has no Ask; Settings is Profile, Captions,
  About (an allowlist).
- The PIN's digits never leave the browser: it sends `pinProof` = PBKDF2-SHA256(pin,
  salt, 100,000 — the Workers' ceiling), hex. KV `household-pin` = `{v, salt, verifier:
  SHA-256(proof), iterations, updatedAt}`. Asked (`pinProof` in the body or an
  `x-sw-pin` header) by `/select` for a locked target or when the cookie's Kids profile
  leaves, and by every change once a PIN exists. Failures in KV `pin-fails`: three free,
  then 30 s doubling to 15 min (per household).

  | Call | Answer |
  |---|---|
  | `GET /api/profiles` | + `pin: {set:true, salt, iterations[, retryAfter]}` once one is set (never the verifier) |
  | `POST /api/profiles` `{name, kids?, maturity?}` | as before; 403 `pin-required` once a PIN exists without the proof |
  | `PATCH /api/profiles/<id>` `{kids?, maturity?, locked?}` | `{profile, profiles}` · 400 `bad-flags` · 409 `no-pin` (a lock needs a PIN) |
  | `POST /api/profiles/select` `{id, pinProof?}` | as before · 403 `pin-required` / `pin-wrong {failures, retryAfter}` · 429 `pin-locked {retryAfter}` |
  | `DELETE /api/profiles/<id>?confirm=` | as before; the proof in `x-sw-pin` once a PIN exists |
  | `POST /api/profiles/pin` `{salt, newProof, iterations, pinProof?}` | `{pin}` (set, or change with the current proof) · 400 `bad-pin` |
  | `DELETE /api/profiles/pin` | `{profiles}` — the PIN and every lock removed |
  | `POST /api/profiles/pin/check` | `{ok:true}` — the picker's prompt before a change · 409 `no-pin` |

- The site password stays the real gate (clearing cookies signs the browser out too); the
  catalog filter runs in the browser, as in the apps; each load refreshes the remembered
  profile's Kids flags from the server's list.

**My Stuff parity** (`views/mylist.js`, `views/search.js`). My List opens with Continue
Watching, then the list with **✦ Pick one for me** (two or more titles, not on Kids): Ask
with the apps' seed question in its own conversation that sees My List only (first 15, no
history — `AssistantSeed.pickFromList`); "New chat" leaves it, a profile switch clears it.

New actions: `mylist-pick`, `profile-pin`, `profile-pin-ok`, `profile-pin-save`,
`profile-pin-remove`, `profile-save`, `profile-ask-delete`, `profile-flag` (`profile-menu`
now opens Edit). Tests: `test/parity.mjs` (markers + the fallback route, the Kids rules,
the certification store, the gate on the real store, PIN proofs vs `node:crypto`, the
lockout, `/api/profiles` with flags and the PIN over a fake KV, the controller, the
picker's panels, Pick one for me); `test/player.mjs` (TheIntroDB on the real player);
`test/unit.mjs` (the `certs` key).

## Reading
The **Read** tab (fifth on the phone bar; `#read` on desktop): manga and comics,
with Continue Reading + Saved on top, a Manga | Comics switch, search, shelves,
series pages and a full-screen reader.

| Route | What |
|---|---|
| `#read`, `#read/manga`, `#read/comics` | hub (`views/reading.js`) |
| `#read/manga/<source>/<id>` · `#read/r/<source>/<id>/<chapter>` | manga series page · its reader (`views/reading-series.js`) |
| `#read/comic/<source>/<slug>` · `#read/rc/<source>/<slug>/<chapter>` | comic series page · its reader (`views/reading-comic.js`) |
| `#read/comics/<source>[/<publisher>]` | one comic source's grid |

Segments are URI-encoded (`router.routeHash` / `routeArgs`): Mangapill ids hold a `/`.

**Manga sources** — one shape for all (the extractor's `/read/*` contract), in `views/reading-api.js`:
- **MangaDex** — its API admits CORS only from mangadex.org and localhost
  (checked 2026-10-11), so the Worker passes an allowlist of read-only paths
  through (`/api/read/mangadex/{manga, manga/<id>, manga/<id>/feed, chapter, at-home/server/<id>}`)
  and the app maps the JSON. Images load straight from MangaDex with
  `referrerpolicy="no-referrer"`: a third-party Referer gets their "read this at
  mangadex.org" placeholder cover.
- **Mangapill** — scraped by the Worker (`/api/read/mangapill/search|series|pages`,
  regex over the HTML like the iOS `MangapillSource`), images via
  `/api/read/mangapill/img?u=` (its CDN 403s without `Referer: https://mangapill.com/`;
  only Mangapill's hosts are fetched). Works with the Mac off.
- **Engine sources** (MANGA Plus + Suwayomi, needs the Mac) — `/api/read/sources|search|series|pages|img`
  → the extractor's `/read/*` with `SLIME_TOKEN` as a Bearer header. The engine mints
  image URLs as `/read/img?…&key=<token>`; every one is rewritten to
  `/api/read/img?<same params>` without `key` (the signature doesn't cover it), and
  every proxied body is scrubbed of the token as a backstop. `x-read-*` headers are forwarded.
- **"Read from"** on a series page finds the same title on another source by a strict
  title match (`views/reading-match.js`, the iOS `ReadingTitleMatch`: ≥ 75 to accept,
  side titles like "Colored"/"Party" rejected).

**Comics** (needs the Mac) — `/api/comic/sources|search|browse|detail|pages|library|img|file`
→ `/comic/*`; page and cover URLs come back as `/api/comic/img?…` / `/api/comic/file?…`.
GetComics and the Internet Archive download a CBZ to the Mac first: the series page's
download card polls `/api/comic/pages` every 2 s (progress %, the server's `message`,
Try again → `retry=1` when `retryable` isn't false), then opens the reader.

**Reader** (`reader/`) — paged left-to-right / right-to-left (manga default),
vertical, long strip (picked when the source says webtoon or most of the first 4
pages are taller than 2:1; a mode chosen by hand sticks per title). Tap zones
(thirds; the middle shows the bars), swipe, ←/→, space, f fullscreen, Esc back to
the series page; pinch-zoom is the browser's. Next 3 pages prefetched; an
end-of-chapter card offers the next chapter; changing chapter rewrites the hash in
place so Back always lands on the series page.

**Progress** lives in the store's synced `reading` key (`reader/progress.js`), keyed
`<source>:<id>`: `{title, cover, chapter, page, updatedAt, saved}` plus `kind, source,
id, comic, chapterLabel, chapterNum, pages, readAt, savedAt, mode`. Written on every
page turn (debounced 0.7 s), on close and when the tab hides. A finished chapter
resumes at the next one; a title read on another source resumes by chapter number.

Worker deadlines (`src/worker/reading.js` `T`): 15 s for sources/library/MangaDex/Mangapill,
23 s all-sources search, 28 s one-source search, 48 s series, 33 s pages, 25 s comic
lists, 45 s comic pages — each just past the extractor's own (docs/READING-ENGINE.md),
so a slow engine still answers instead of being cut off. Tests: `test/reading.mjs`
(fixtures in `test/fixtures/`, saved 2026-10-11).

## Develop

```bash
npm install
npm test        # build + check.mjs (artifact guards, Worker routes, unit checks)
npm run dev     # build + wrangler dev on http://127.0.0.1:8797
```
To log in locally pass throwaway values, e.g.
`npm run dev -- --var SITE_PASSWORD:dev --var SESSION_SECRET:dev`.
**Don't move dev to port 8787** (wrangler's default): the SlimeWatch extractor
listens on `*:8787` on the home Mac, and a dev server bound to `127.0.0.1:8787`
silently steals its loopback traffic. `[dev] port = 8797` in wrangler.toml.

After changing anything in `src/app/`, run `npm run build` (or `npm test`) and
commit `src/generated/` with it — deploys ship the generated files.

## Structure

```
web/
  src/worker.js            the Worker: password gate, /api/* proxies, PWA files, the page (+ CSP)
  src/app/                 the SPA source (ES modules) — edit here
  src/generated/           build output, committed — never edit
    page.js                  PAGE (the whole app as one HTML string), BUILD_ID, NONCE_PLACEHOLDER
    static.js                STATIC: /sw.js, /manifest.webmanifest, /icons/* (served ungated)
  build.mjs                esbuild bundle -> src/generated/ (deterministic; no timestamps)
  check.mjs                guards + runs test/*.mjs  (npm test = build + check)
  test/unit.mjs            store, router, debrid pickers
  test/sw.mjs              service-worker behaviour (vm sandbox, fake caches/network)
  test/pwa.mjs             page-side update flow (fake DOM + navigator.serviceWorker)
  test/sync.mjs            store stamps/tombstones, merge rules, /api/state (fake KV), the sync
                           engine on a fake clock against the real handler (two devices converge)
  test/ask.mjs             Ask logic + tool loop (fake relay/TMDB), /api/ask proxy, Settings/Search wiring
  test/profiles.mjs        /api/profiles CRUD + validation + cap + dedupe + delete-confirm + legacy migration,
                           /api/state per profile (428, header/cookie guard), the switch flow, the first-pick
                           import both ways and per-profile queues (real engine -> real Worker via a cookie jar)
  test/party.mjs           Watch Party: rules, the room client (fake socket + clock), the binder (fake <video>),
                           /api/party + /p/ redirect, the page over a mini DOM, the relay's real reducer
  test/parity.mjs          Wave 8 parity: TheIntroDB markers + /api/player/markers, Kids rules + the catalog gate,
                           the Parent PIN (proofs, lockout, /api/profiles), Pick one for me
  test/reading.mjs         Read tab: Mangapill parsers + MangaDex mapping on saved answers (test/fixtures/),
                           /api/read + /api/comic routes (scripted upstream), reader rules, progress, tab width
  src/worker/              feature route modules behind the gate (modules.js registers them):
    sync.js                  /api/state, /api/state/health          ask.js   /api/ask -> relay /assist
    profiles.js              /api/profiles (names, select cookie, delete, legacy -> "Shared" migration)
    reading.js               /api/read/*, /api/comic/* (engine + comics proxy, Mangapill, MangaDex passthrough)
    party.js                 /api/party/<CODE> (peek), /api/party/<CODE>/ws (socket) -> the relay
  scripts/icons.mjs        regenerates src/app/icons/*.png (stdlib PNG encoder; `npm run icons`)
```

### `src/app/`
| Path | Owns |
|---|---|
| `index.html` | the shell markup only. No inline JS/CSS/handlers — `<!--BUILD:CSS-->` / `<!--BUILD:JS-->` are replaced by the build |
| `main.js` | boot order + the route → view table (`VIEWS`) |
| `router.js` | pure: `parseRoute(hash)` → `{base, arg, active, nav, tab, pills}`, `KNOWN` routes, `tabFor`, `go(hash)` |
| `api.js` | every call to the Worker: `apiFetch` (login-bounce detection → /login), `api(tmdbPath)`, `rdCheck`, `rdKeyFromSite`, `resolveEmbed`, `liveChannels`, `liveResolve`, `debridFallback` |
| `state.js` | **the store** (below) + domain helpers: My List, Continue Watching, RD key, prefs (`getPrefs`/`setPrefs`), reading entries |
| `sync.js` | personal sync: the merge rules (shared with the Worker) + the client engine (`initSync`, `flushSync`, `stopSync`, `syncStatus`, `onSyncStatus`, `syncNow`) |
| `profiles.js` | who's watching: the controller (`createProfiles`), boot (`initProfiles`), the picker overlay (`openProfiles`), the header avatar |
| `ask.js` | the Ask assistant: tool loop over the relay + TMDB (`askSession`, `createAsk`) |
| `catalog.js` | brand channels, movie genres, `provQ` discover-query builder |
| `util.js` | `IMG`, `kindOf`, `titleOf`, `yearOf`, `esc`, `$` |
| `keys.js` | global keyboard: Esc, `/`, and dispatch to the player shortcuts |
| `pwa.js` | service-worker registration + the "Updated" toast |
| `sw.js` | the service worker (build stamps the version + asset list) |
| `manifest.webmanifest`, `icons/` | PWA metadata and icons |
| `views/home.js` | Home (hero, Continue Watching, My List, shelves), surprise, resume |
| `views/browse.js` | Movies / TV / Anime shelves, Channels grid, one channel, genre browse |
| `views/search.js` | header search (desktop), the Search screen with its Ask mode (`#search/ask`), `openAsk`, `focusSearch` |
| `views/live.js` | Live Sports grid |
| `views/mylist.js` | My List / My Stuff |
| `views/detail.js` | the detail sheet, seasons, episodes |
| `views/reading*.js` | the Read tab: hub, manga/comic series pages, source adapters, title match (see "Reading") |
| `reader/` | the page reader (`reader.js`), its pure rules (`logic.js`) and progress over `reading` (`progress.js`) |
| `player/player.js` | `play`, `playLive`, `closePlayer`, `selectSource`, fullscreen, PiP, `handlePlayerKey`, `setCaptionsHandler` |
| `player/session.js` | shared player state (`session.ctx/debrid/direct/resumeAt`) + `setLoading/setHint/setBadge` |
| `player/debrid.js` | Torrentio + RD tier: stream filters, `resolveDebrid`, `debridWhy` |
| `player/sources.js` | embed `PROVIDERS`, ad-free `resolveDirect`, source `<select>` options |
| `player/hls.js` | `playHls` / `destroyHls` over the vendored hls.js |
| `player/upnext.js` | Up Next banner + auto-next episode |
| `ui/actions.js` | delegated clicks: `onAction(name, fn)` |
| `ui/{hero,row,card,nav,pills,tabbar}.js` | markup builders for shelves, cards, hero, desktop nav, phone pills + tab bar |
| `ui/settings.js` | Settings sheet: Debrid, Captions, Anime audio, Home server, Sync, Install, About |
| `ui/toast.js` | `toast(text, opts)` / `closeToast(id)` |
| `ui/install.js` | install hints (iOS Share sheet / `beforeinstallprompt`) |
| `styles/index.css` | the cascade order: `base, layout, player, phone, overlays, reader, profiles` — add new files at the END |

Modules never touch the DOM at import time (only inside functions), which is
what lets `test/` import the pure ones from node. Import cycles are avoided
(e.g. `upnext.autoNext(play)` takes the player's `play` as an argument).

### The store (`state.js`) — every persisted read/write goes through it

```js
import { getState, setState, subscribe } from './state.js';
getState()                       // frozen snapshot: { list, continue, rdkey, installHint, prefs, reading, tombs, sync, profile }
setState({ list: newList })      // persist + notify; null/undefined deletes the key (-> default)
setState(patch, { source: 'sync' })
const off = subscribe((state, { keys, source }) => { ... })   // source: 'local' | 'storage' (another tab) | yours
```
- Keys map 1:1 to the original localStorage keys (`SCHEMA`): `list`→`sw_list`,
  `continue`→`sw_continue`, `rdkey`→`sw_rdkey`, plus `installHint`→`sw_install_hint`.
  Existing browsers keep their data across the upgrade.
- `local: true` in `SCHEMA` marks device-only keys (`rdkey` — Settings promises it
  stays "only in this browser" — `installHint`, `sync`, the sync engine's
  profile + rev + queue, and `profile`, who's watching). Everything else syncs.
- **Sync stamps are automatic.** On every write whose source isn't `'sync'`, the
  store gives each changed entry of `list` / `continue` / `reading` an
  `updatedAt` (ms) and records each removed entry in `tombs`. Writers just call
  the helpers or `setState` with the new value — never set `updatedAt`
  yourself (a changed entry is restamped anyway), and remove an entry by
  leaving it out (that is what syncs the removal). Identity: `list`/`continue`
  entries by `kind:id`; `reading` entries by their key (values must be objects).
- **Prefs** (`getPrefs()` fills defaults, `setPrefs(patch)` shallow-merges; null
  deletes): `subLang` (auto-on caption language; absent = captions off),
  `subLangs` (preference order, default `['en']`), `subSize` (`S|M|L`, default
  `M`), `subOff` (titles with captions off), `animeAudio` (`sub|dub`, default
  dub), `askHistory`, `readingOldestFirst`. Any module may add a key.
- Snapshots are deep-frozen JSON round-trips of what's stored: build new
  arrays/objects and `setState` them; mutating a snapshot throws.
- Nothing else touches `localStorage`. Add a key = add it to `SCHEMA`.
- Domain helpers (`toggleList`, `recordContinue`, `saveProgress`, `savedPos`,
  `getRdKey`, …) are thin wrappers over the store and take an optional store
  argument for tests (`createStore(memoryStorage())`).
- Views read the store when they render. When sync brings in a change to My
  List / Continue Watching, Home and My List re-render (only when no sheet or
  player is open); other views see it on their next render, or can
  `subscribe` and look for `source === 'sync'`.

### Clicks: `data-act`, never `onclick`
The Worker sends a nonce-based CSP, so inline handlers (`onclick="…"`) are
blocked. Markup declares `data-act="<name>"` (plus `data-*` arguments) and the
owning module registers `onAction('<name>', (el, event) => …)` at top level.
`check.mjs` fails the build on any inline `on*=` handler and on any rendered
`data-act` with no registered handler. Registered: `go`, `logout`, `detail`,
`detail-close`, `detail-play`, `detail-list`, `season`, `episode`, `resume`,
`surprise`, `live`, `settings`, `settings-close`, `debrid-connect`,
`debrid-remove`, `install`, `player-close`, `player-fullscreen`, `player-pip`,
`set-pref`, `caption-lang-up`, `caption-lang-remove`, `server-check`, `sync-now`,
`search-mode`, `ask-open`, `ask-send`, `ask-suggest`, `ask-retry`, `ask-stop`,
`ask-reset`, `ask-history`, `profiles`, `profile-switch`, `profile-pick`,
`profile-menu`, `profile-add`, `profile-create`, `profile-close`, `profile-back`,
`profile-retry`, `profile-import`, `profile-force`, `profile-delete`.

### Adding a route / view
1. Add the name to `KNOWN` in `router.js` (and to `HOME_TAB_ROUTES` /
   `PILL_ROUTES` if it should light Home / show the pills).
2. Write `views/<name>.js` exporting `view<Name>(arg)` that renders into `#main`.
3. Add it to `VIEWS` in `main.js` (boot warns if `KNOWN` and `VIEWS` drift).
4. Link to it with `data-act="go" data-to="#<name>"`.

### Scripts, CSP and the build
- `PAGE` holds two inline scripts: hls.js **1.5.17**, vendored byte-for-byte from
  `node_modules/hls.js/dist/hls.min.js` (not re-bundled: its transmux Web Worker
  is built by stringifying its own UMD wrapper), then the esbuild IIFE of
  `main.js`. No external scripts — add a library by importing it from npm.
- Each `<script>` carries a nonce placeholder; the Worker fills a fresh random
  nonce per response and sends `script-src 'nonce-…' 'self'`,
  `worker-src 'self' blob:`, `object-src 'none'`, `base-uri 'none'`.
  Images, media, frames and fetches are unrestricted (TMDB, RD, extractor, embeds).
- `check.mjs` also fails if `src/generated/` is stale, if an inline script
  doesn't parse or is cut short (e.g. by `</script` in a string), or if a
  manifest/link icon isn't served.

### Player hooks for later features
- `setCaptionsHandler(fn)` — `c` calls `fn({ video, ctx, hls })` (`video` is null
  on an embed). The default toggles any text tracks the stream already exposes.
- Keyboard (player open): space/k play-pause · ←/→ and j/l ±10 s · f fullscreen
  · m mute · c captions · Esc close. `/` focuses search when the player is closed.
  Shortcuts run in the capture phase and take over from a focused `<video>`'s
  native key handling, so nothing fires twice.
- PiP: a bar button on desktop for the `<video>` path (never for embeds); phones
  use their browser's own PiP control.

## Notes
- **Ads:** the embed sources carry their own ads. The debrid and ad-free tiers
  don't load the provider page at all; for embeds use a browser ad blocker.
- **Privacy:** everything past `/login` requires the auth cookie, except the
  static PWA files (`/sw.js`, `/manifest.webmanifest`, `/icons/*`); the TMDB
  token is never exposed to the browser.
- The service worker caches only the app shell; it never caches `/api/*`,
  `/login`, media or anything cross-origin.
