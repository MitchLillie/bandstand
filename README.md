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
   `auth.band.us` (captcha/2FA/SSO — not worth scripting). You paste it once. The
   server rotates it via `Set-Cookie` on API responses; the client persists the
   rotation automatically, so it stays fresh on its own.
3. **`secretKey` cookie _is_ the HMAC key.** Every request carries an `md` header:

   ```
   md = base64( HMAC_SHA256( secretKey, extractPath(url) ) )
   ```

   where `extractPath(url)` is the URL minus `scheme://host`. `secretKey` is
   **HttpOnly**, scoped to path `/s/login/`, so it is **not** visible to
   `document.cookie` — you must copy it from the DevTools cookies panel (see below).

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

This opens `https://www.band.us/`. Then, in DevTools:

**Application → Cookies → https://www.band.us**, copy the **values** of two cookies:

- `band_session`
- `secretKey` — **HttpOnly**, so `copy(document.cookie)` in the Console silently
  misses it. Grab it from the cookies panel.

Paste them when prompted, in either form:

```
band_session=<value>; secretKey=<value>
```

Quotes around `secretKey`'s value are fine — they're stripped. Cookies are saved to
`~/.band_session.json` (mode `600`). If a command later hits auth, it re-prompts and
retries once.

## CLI

```
bandstand calendars  --band <band_no>
bandstand members    --band <band_no> [--group <member_group_id>] [--short]
bandstand groups     --band <band_no> [--short]
bandstand events     --band <band_no> [--start YYYYMMDD] [--end YYYYMMDD] [--calendar <id>] [--short]
bandstand search     <term> --band <band_no> [--start ...] [--end ...] [--days N] [--json]
bandstand week       --band <band_no> [--calendar <id>] [--days 7]
bandstand create     --band <band_no> --file event.json [--announce]
bandstand create     --band <band_no> --name "..." \
                     --start 2026-05-01T18:30:00-0700 --end 2026-05-01T20:30:00-0700 \
                     [--desc "..."] [--calendar <id>] [--tz America/Los_Angeles] \
                     [--secret] [--share USER_NO,...] [--group <id>] [--announce]
bandstand copy       <schedule_id> --band <band_no> [--name ...] [--start ...] \
                     [--group <id>] [--add-user ...] [--remove-user ...] [--dry-run]
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
they expand. Find it via `bandstand members --short` (or the entry flagged
`me: true` in the full JSON).

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
  jitterMs: [500, 1500],                  // or null to disable pacing
  warmUp: false,
});
```

## Browser-native traffic posture

To look like a normal browser to BAND, the client:

- sends a browser **User-Agent**, `Origin`/`Referer`, and BAND's app headers;
- **paces** calls with 300–900 ms jitter (configurable via `jitterMs`);
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

All under `https://api-usw.band.us`. Other region shards (`api-ukw`, `api-jpw`,
`api-krw`) exist if your account is routed elsewhere — override with the `apiBase`
option.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # tsup -> dist/ (ESM + .d.ts)
npm run lint        # biome
```

## Limitations

- `get_schedules` is paginated automatically (`paging.next_params`), capped at
  `maxPages` (default 50).
- No `delete_schedule` helper yet.
- No rate-limit backoff beyond jitter.

## Disclaimer

Built for managing your **own** BAND calendar where the official Developer API
doesn't cover events. Use your own account. Don't scrape. This project is not
affiliated with or endorsed by BAND / Naver.

## License

[MIT](./LICENSE) © Mitch Lillie
