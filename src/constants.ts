export const DEFAULT_API_BASE = "https://api-usw.band.us";

/**
 * The web client's `akey` header. It identifies the BAND web client and is the
 * same value for every user — a public identifier, not a secret.
 */
export const DEFAULT_AKEY = "bbc59b0b5f7a1c6efe950f6236ccda35";

/**
 * Native `fetch` can't forge a browser's TLS/JA3 fingerprint the way curl-impersonate
 * can, so the best we can do is present a browser User-Agent.
 */
export const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:135.0) Gecko/20100101 Firefox/135.0";

export const DEFAULT_TIME_ZONE_ID = "America/Los_Angeles";
export const DEFAULT_TIME_ZONE_OFFSET_MS = -25_200_000;

/** Inclusive [min, max] human-ish gap between API calls, in milliseconds. */
export const DEFAULT_JITTER_MS = [300, 900] as const;

export const COOKIE_INSTRUCTIONS = `BAND session is missing or expired. To grab a fresh one:

  1. Open  https://www.band.us/   (log in if needed)
  2. DevTools → Application → Cookies → https://www.band.us
  3. Click any row, select all (Cmd/Ctrl-A) and copy (Cmd/Ctrl-C) — the whole table.
     band_session and secretKey are required; ai, as, rt, SESSION, JSESSIONID, BBC
     and di come along for free and keep the session looking browser-native. Both
     required cookies are HttpOnly, so copy(document.cookie) silently misses them.
  4. Paste at the prompt, then press Enter on a blank line (or Ctrl-D).

     The format is auto-detected: the DevTools table with or without its header,
     one name=value or name<TAB>value per line, a single "a=1; b=2" line, exported
     JSON, or a whole "Copy as cURL" command. Extra columns, quotes and unrelated
     cookies are handled. You can also pipe it in:  pbpaste | bandstand login`;
