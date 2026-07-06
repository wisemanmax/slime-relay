# SlimeWatch Web (private)

A private, password-gated web version of SlimeWatch — a Cloudflare Worker that
serves a single-page app: browse the TMDB catalog (Home / Movies / TV / Anime /
Search / My List), open a detail page with a season/episode picker, and watch via
provider-embed iframes with a source switcher. Continue Watching + My List live in
your browser. The TMDB token stays server-side (the Worker proxies it), and the
whole site sits behind a password.

## Deploy (once)

```bash
cd web
./deploy.sh                 # prompts for a site password + your TMDB v4 read token
# …or non-interactively:
# ./deploy.sh "your-password" "your-tmdb-v4-token"
```

It installs wrangler, logs you into Cloudflare (browser once), sets three secrets,
and deploys. Wrangler prints your URL, e.g. `https://slime-web.<you>.workers.dev`.
Open it, enter your password, and you're in.

### Secrets it sets
| Secret | What |
|---|---|
| `SITE_PASSWORD` | the password you type to get in |
| `SESSION_SECRET` | a random string that signs the login cookie (auto-generated) |
| `TMDB_TOKEN` | your TMDB v4 read token, so the key never ships in the page |

## Notes
- **Ads:** the embed sources carry their own ads. Use a browser ad blocker
  (uBlock Origin) for an ad-free experience — same as any web streaming site.
- **Privacy:** everything past `/login` requires the auth cookie; the TMDB token
  is never exposed to the browser.
- **No home server needed** — playback is provider-embed based, so it works from
  any network. (This is separate from the relay/extractor the apps use.)
