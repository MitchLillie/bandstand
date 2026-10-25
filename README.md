# bandstand

Unofficial **TypeScript client + CLI** for [BAND](https://www.band.us) — reads and
writes calendar events (`get_schedules`, `create_schedule`, `update_schedule`),
which BAND's official Developer API does not expose.

The core is runtime-agnostic (Web `fetch` + Web Crypto), so `BandClient` runs on
Node, Bun, Deno, and edge runtimes. The CLI and a file-backed cookie store are the
Node-flavored layer on top. Zero runtime dependencies.

> ⚠️ Personal-use tool for your **own** BAND account, built because the official API
> doesn't cover events. Don't scrape, don't automate against bands you don't own.
> See [Disclaimer](#disclaimer).

## How it works

Reverse-engineered from the web client:

1. **Static `akey` header** (`bbc59b0b…`) identifies the web client. It's the same
   value for every user — a public identifier, not a secret.
2. **`band_session` cookie** is an opaque session token from a real login at
   `auth.band.us` (captcha/2FA/SSO — not worth scripting). `bandstand login` grabs
   it from your browser once (see below). The server rotates it via `Set-Cookie` on
   API responses; the client persists the rotation automatically, so it stays fresh
   on its own.
3. **`secretKey` cookie _is_ the HMAC key.** Every request carries an `md` header:

   ```
   md = base64( HMAC_SHA256( secretKey, extractPath(url) ) )
   ```

   where `extractPath(url)` is the URL minus `scheme://host`. `secretKey` is
   **HttpOnly**, scoped to path `/s/login/`, so it is **not** visible to
   `document.cookie`. `bandstand login` gets it either from the Band Tools
   extension (`chrome.cookies`) or from BAND's `auth.band.us/s/login/getKey` JSONP,
   which echoes the cookie back to same-site page scripts.

## Install

Not published to npm yet — build from source:

```bash
git clone <your-fork-url> bandstand && cd bandstand
npm install
npm run build
npm link        # installs two commands: `bandstand` and the short alias `bs`
```

As a library once published:

```bash
npm install bandstand
```

> The CLI installs as both `bandstand` and `bs` — use whichever you prefer. Examples
> below use the full name.

## First-time login

```bash
bandstand login
```

`bandstand login` starts a one-shot listener on `127.0.0.1:7238` and opens a small
landing page. The browser hands the session over from there — you never touch
DevTools. Two ways in:

- **Band Tools extension** (recommended, v0.3.0+): with the landing page open, click
  the Band Tools toolbar icon, then **Send BAND session to bandstand**. The extension
  reads `band_session` + `secretKey` via `chrome.cookies` and posts them to the
  listener with the one-time pairing nonce from the page's URL, so the CLI saves
  them without asking. (Be signed in to band.us in that browser first.)
- **Bookmarklet** (no extension): drag the "bandstand login" link from the landing
  page to your bookmarks bar, then click it on `band.us`. It reads `band_session`
  from `document.cookie` and pulls the HttpOnly `secretKey` out of BAND's own
  `getKey` JSONP, then posts both. The terminal shows a fingerprint to confirm
  before saving.
  `bandstand login --print-bookmarklet` prints the source if you'd rather add it by
  hand.

Cookies are saved to `~/.band_session.json` (mode `600`). Nothing leaves your
machine except the POST to `127.0.0.1`.

**Flags:**

| Flag | Effect |
| ---- | ------ |
| `--port <n>` | Use a different loopback port. Band Tools follows automatically; the bookmarklet has the port baked in, so re-drag it from the landing page. |
| `--paste` | Skip the listener; paste `band_session=<value>; secretKey=<value>` copied from DevTools → Application → Cookies. `secretKey` is HttpOnly, so `copy(document.cookie)` misses it — grab it from the cookies panel. Wrapping quotes are fine. |
| `--session '<pair>'` | Non-interactive: pass the pair directly (CI, scripts). |

Quotes around `secretKey`'s value are fine — they're stripped. Cookies are saved to
`~/.band_session.json` (mode `600`). A session lasts about 40 hours after BAND's web
page last renewed it. BAND won't renew it from outside the browser, so once it
expires, commands exit with `Session expired — run: bandstand login`.

## CLI

```
bandstand whoami     --band <band_no> [--save]
bandstand calendars  --band <band_no>
bandstand members    --band <band_no> [--group <member_group_id>] [--short]
bandstand groups     --band <band_no> [--short]
bandstand events     --band <band_no> [--start YYYYMMDD] [--end YYYYMMDD] [--calendar <id>] [--short]
bandstand rsvp         <schedule_id> --band <band_no> --going|--maybe|--no
bandstand rsvp-report  <schedule_id> --band <band_no> [--json]
bandstand search     <term> --band <band_no> [--start ...] [--end ...] [--days N] [--json]
bandstand week       --band <band_no> [--calendar <id>] [--days 7]
bandstand create     --band <band_no> --file event.json [--announce]
bandstand create     --band <band_no> --name "..." \
                     --start 2026-05-01T18:30:00-0700 --end 2026-05-01T20:30:00-0700 \
                     [--desc "..."] [--calendar <id>] [--tz America/Los_Angeles] \
                     [--secret] [--share USER_NO,...] [--group <id>] [--announce]
bandstand copy       <schedule_id> --band <band_no> [--name ...] [--start ...] \
                     [--group <id>] [--add-user ...] [--remove-user ...] [--dry-run]
bandstand delete     <schedule_id> --band <band_no> [--notify]
bandstand sync-group --band <band_no> --calendar <id> --group <id> [--days 120] [--apply] [--notify]
```

(`bs` is a drop-in alias for `bandstand` in every command above.)

### Config file (optional defaults)

`~/.band_config.json` supplies defaults for `--band`, `--calendar`, and `me`, so you
don't retype them. CLI flags still override. Override the path with `BAND_CONFIG`.

```json
{
  "band": 12345678,
  "calendar": 11,
  "me": 123456789
}
```

`me` is your own `user_no`. BAND rejects the event owner as their own
`secret_sharer`, so `--group` / `sync-group` filter this value out of any roster
they expand. Get it (and optionally write it to config) with
`bandstand whoami --band <band_no> --save`.

### Finding `band_no` and `calendar_id`

- `band_no` is in the URL: `https://www.band.us/band/<band_no>/calendar`.
- `bandstand calendars --band <band_no>` lists calendars (each has `calendar_id`).
- `bandstand members --band <band_no> --short` maps names to `user_no`.

## Library usage

```ts
import { BandClient, FileCookieStore } from "bandstand";

// Loads / persists cookies at ~/.band_session.json (or $BAND_STATE).
const client = await BandClient.create({ store: new FileCookieStore() });

const cals = await client.getCalendars(12345678);
const { items } = await client.getSchedules(12345678, "20260401", "20260601");
await client.createSchedule(12345678, {
  name: "Canvass",
  start_at: "2026-05-01T18:30:00-0700",
  end_at: "2026-05-01T20:30:00-0700",
  // …see the Schedule type for the full shape
});
```

`BandClient.create` is async (it loads the jar and imports the HMAC key). Everything
is injectable for testing or alternate runtimes:

```ts
const client = await BandClient.create({
  cookies: "band_session=…; secretKey=…", // seed instead of a store
  fetch: myImpersonatingFetch,            // swap the transport (see below)
  jitterMs: [500, 1500],                  // gap before writes; null disables pacing
  readJitterMs: [200, 500],               // gap between read starts (default 150–400)
  maxInFlight: 2,                         // concurrent requests (default 3)
  warmUp: false,
});
```

## Browser / extension usage

The core `BandClient` is runtime-agnostic (Web `fetch` + Web Crypto), so it also runs
in a browser extension or service worker. Import the browser-safe entry — `bandstand/browser`,
which omits the Node `FileCookieStore` (and its `node:fs` import) — and use **browser
mode**: the runtime owns the cookie jar, so you only supply `secretKey` (read it via
`chrome.cookies`, since it's HttpOnly) and let `fetch` attach the session cookie.

```ts
import { BandClient, isJwtSession } from "bandstand/browser";

const [{ value: secretKey }] = await chrome.cookies.getAll({ name: "secretKey" });
const [{ value: band_session }] = await chrome.cookies.getAll({ name: "band_session" });
const client = await BandClient.create({
  cookies: { secretKey },
  sendCookieHeader: false, // `Cookie` is a forbidden header in browsers
  credentials: "include",  // let the browser attach band.us session cookies
  // JWT sessions sign with the base64url-decoded secretKey. Node auto-detects this
  // from the jar; in browser mode band_session isn't in the jar, so say which it is.
  jwtSession: isJwtSession({ band_session }),
});
await client.getCalendars(bandNo);
```

## Browser-native traffic posture

To look like a normal browser to BAND, the client:

- sends a browser **User-Agent**, `Origin`/`Referer`, and BAND's app headers;
- **paces** calls through a FIFO gate: reads start 150–400 ms apart with at most 3
  in flight (like a page firing a few XHRs; `readJitterMs`, `maxInFlight`), while
  writes run alone, 300–900 ms after the previous request finishes (`jitterMs`);
- **warms up** before the first write with `touch_band_access` + `get_calendars`,
  the same sequence the calendar page loads;
- persists the **full cookie jar** and any server-rotated cookies.

**What it can't do:** native `fetch` always presents Node's own TLS/JA3 fingerprint
— it cannot forge a browser's the way [curl-impersonate] can. If you need that, pass
your own `fetch` (e.g. one backed by curl-impersonate) via the `fetch` option; the
client treats the transport as pluggable. For personal use at human cadence, plain
`fetch` is fine.

[curl-impersonate]: https://github.com/lwthiker/curl-impersonate

## Environment variables

| Var           | Default                  | Purpose                          |
| ------------- | ------------------------ | -------------------------------- |
| `BAND_STATE`  | `~/.band_session.json`   | Cookie-jar path (`FileCookieStore`) |
| `BAND_CONFIG` | `~/.band_config.json`    | CLI defaults file                |

Pacing, time zone, API base, and impersonation are `BandClient` options rather than
env vars.

## Endpoints in use

- `GET  /v2.0.0/get_calendars`
- `GET  /v2.0.0/get_members_of_band_with_filter`
- `GET  /v2.1.0/get_member_groups`
- `GET  /v2.0.0/touch_band_access` (warm-up)
- `GET  /v1.6.0/get_schedule`, `/v1.6.0/get_schedules`
- `POST /v2.0.0/create_schedule`, `/v2.0.3/update_schedule`
- `GET  /v1/schedule/delete_schedule`
- `GET  /v2.0.0/get_my_band_schedules` (whoami)
- `POST /v2.0.0/set_schedule_rsvp_states` (rsvp)

All under `https://api-usw.band.us`. Other region shards (`api-ukw`, `api-jpw`,
`api-krw`) exist if your account is routed elsewhere — override with the `apiBase`
option.

## Watching for BAND web changes

BAND can change its web signing code without warning. The 2026-10-21 deploy started
base64url-decoding the `secretKey` for JWT sessions, and every call failed with
`result_code 300`. `scripts/check-band-web.mjs` is an early-warning check for that kind of
change. It fetches the public web client with no cookies and no login (about 7 GETs),
pulls out the code bandstand mirrors, and compares it to `scripts/band-web-baseline.json`:

- `BandWebAuthModule` (`makeMd`, the constructor, `needTokenRenewal`, `parseJwtToken`, `now`)
  and the auth-module hash and file list from the `getKey` bootstrap
- `createMd`, `extractPath`, the `md` header hook, the getKey loader, `prepareAuth`, and the
  API host config in `boot.bundle.js`
- the versions the web client uses for every endpoint in `src/client.ts`

Code is compared by a hash taken after normalization (comments, whitespace and local
identifier names are stripped), so a minifier rename or a new deploy id on its own does
not alert.

```bash
npm run check:band-web               # exit 0 = no relevant change, 1 = change, 2 = error
npm run check:band-web -- --update   # accept the current state as the new baseline
```

`.github/workflows/band-web-watch.yml` runs this every day. When it finds a change, it opens
a single issue labelled `band-web-change`, and it only updates that issue when the diff
itself changes. To resolve it, fix bandstand if needed, run `--update`, commit the
baseline, and close the issue.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # tsup -> dist/ (ESM + .d.ts)
npm run lint        # biome
```

### Smoke test (live, read-only)

The unit tests mock `fetch`, so they can't catch BAND changing its request signing.
`npm run smoke` builds the package and then makes about 7 read-only calls against the
real API with your saved session: `get_calendars`, whoami, member groups, one group's
roster, the next 14 days of schedules on the default calendar and on one non-default
calendar (this one sends the JSON `calendars` param), and the detail of one event. It
prints one line per check with its timing and exits 1 if any check fails.

```bash
npm run smoke                     # uses ~/.band_session.json + ~/.band_config.json
npm run smoke -- --band 12345     # override band_no
npm run smoke -- --json           # machine-readable
BAND_STATE=/path/jar.json npm run smoke
```

Each failure gets a classification: missing or expired session (run
`bandstand login`), `result_code 300` (signature/auth: either the session is dead or
`md` signing no longer matches the web client's `makeMd`), `251`/`200` (a param is
missing or invalid), or network. The output also says whether `band_session` is a JWT
and when it expires. Cookie values are never printed, and the session file is never
written: if the server rotates cookies during the run, the new values stay in memory.

It is **not** part of `npm test` or CI because it needs a real logged-in session.

### Releasing

Publishing is automated by `.github/workflows/publish.yml`: cut a GitHub Release and
CI publishes to npm via **Trusted Publishing (OIDC)** with provenance — no token in
the repo. One-time setup: on npmjs.com, add this repo + `publish.yml` as a trusted
publisher for the package.

```bash
npm version patch        # bumps package.json, commits, tags vX.Y.Z
git push --follow-tags
gh release create vX.Y.Z --generate-notes   # -> triggers the publish workflow
```

## Limitations

- `get_schedules` is paginated automatically (`paging.next_params`), capped at
  `maxPages` (default 50).
- No rate-limit backoff beyond jitter.

## Disclaimer

Built for managing your **own** BAND calendar where the official Developer API
doesn't cover events. Use your own account. Don't scrape. This project is not
affiliated with or endorsed by BAND / Naver.

## License

[MIT](./LICENSE) © Mitch Lillie
