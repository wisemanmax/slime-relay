// Where a successful sign-in lands. A link opened while signed out (a shared
// '#title/…' link, say) reaches /login with its hash intact — the gate's 302
// carries no fragment, so the browser keeps the original — but a fragment never
// reaches the server. The login page copies location.hash into a hidden `next`
// field, and only a plain hash route comes back out of it: the redirect is
// always '/' + '#…' on this host — never a scheme, a path, or another origin.
// Anything else (or nothing) lands on '/' as before.

export const NEXT_RE = /^#[A-Za-z0-9/_-]{1,80}$/;

/** The submitted `next` if it is an allowed hash route, else ''. */
export const safeNext = (v) => (typeof v === 'string' && NEXT_RE.test(v) ? v : '');
